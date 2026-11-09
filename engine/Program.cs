using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe partial class Program
{
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint WM_HOTKEY = 0x0312;
    private const uint WM_APP_POINTER = 0x8010;
    private const uint WM_APP_SHUTDOWN = 0x8011;

    private const int CORNER_SNAP_PX = 24;
    private const long SEEK_REPEAT_GUARD_MS = 110;
    private const nuint TIMER_ID_TICK = 1;
    private const uint TICK_INTERVAL_MS = 30;

    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    private delegate nint WndProcDelegate(nint hWnd, uint msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public uint message;
        public nuint wParam;
        public nint lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        public nint lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public nint hInstance;
        public nint hIcon;
        public nint hCursor;
        public nint hbrBackground;
        public char* lpszMenuName;
        public char* lpszClassName;
        public nint hIconSm;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint GetModuleHandleW(string? lpModuleName);

    [DllImport("user32.dll", EntryPoint = "RegisterClassExW", SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowExW(
        uint dwExStyle,
        string lpClassName,
        string lpWindowName,
        uint dwStyle,
        int x,
        int y,
        int nWidth,
        int nHeight,
        nint hWndParent,
        nint hMenu,
        nint hInstance,
        nint lpParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(nint hWnd);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")]
    private static extern nint DefWindowProcW(nint hWnd, uint uMsg, nint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "GetMessageW")]
    private static extern int GetMessageW(out MSG lpMsg, nint hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll", EntryPoint = "DispatchMessageW")]
    private static extern nint DispatchMessageW(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nuint SetTimer(nint hWnd, nuint nIDEvent, uint uElapse, nint lpTimerFunc);

    [DllImport("user32.dll")]
    private static extern bool KillTimer(nint hWnd, nuint uIDEvent);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
    private static extern bool PostMessageW(nint hWnd, uint Msg, nint wParam, nint lParam);

    private static WndProcDelegate? _wndProcDelegate;
    private static nint _hwnd;
    private static int _uiThreadId;
    private static readonly Stopwatch _clock = Stopwatch.StartNew();

    private static Settings _settings = Settings.Defaults;
    private static readonly HoldStateMachine _holdMachine = new();
    private static readonly GhostStyle _ghostStyle = new();
    private static Hotkeys? _hotkeys;
    private static TrayIcon? _trayIcon;
    private static NativeMessagingHost? _nativeHost;
    private static PipTracker? _pipTracker;
    private static bool _wasInteractive;
    private static bool _webSessionActive;
    private static bool _lastPeekEmitted;
    private static long _lastSeekBackAtMs = -1000;
    private static long _lastSeekForwardAtMs = -1000;

    private static bool _hasTestCursor;
    private static DodgePoint? _testCursor;
    private static bool? _testHold;
    private static bool? _testPeek;

    private static int _cleanedUp;
    private static readonly ManualResetEventSlim _cleanupDone = new(false);

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
            return SelfTest.Run(args);

        _uiThreadId = Environment.CurrentManagedThreadId;
        AppDomain.CurrentDomain.ProcessExit += (_, _) => CleanupFromAnyThread();
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            LogError("unhandled exception", e.ExceptionObject as Exception);
            CleanupFromAnyThread();
        };

        try
        {
            _hwnd = CreateHiddenMessageWindow();
            if (_hwnd == IntPtr.Zero)
                return 1;

            _hotkeys = new Hotkeys(_hwnd);
            string[] hotkeyErrors = ApplyHotkeys();

            _trayIcon = new TrayIcon(_hwnd);
            _nativeHost = new NativeMessagingHost(_hwnd);
            _pipTracker = new PipTracker(_hwnd, _ghostStyle, msg => _nativeHost.Send(msg), () => _clock.ElapsedMilliseconds, OnPipUnbound);
            _pipTracker.SetDefaultCorner(_settings.Dodge.Home);

            _mouseHookDelegate = OnLowLevelMouse;
            _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, _mouseHookDelegate, GetModuleHandleW(null), 0);

            SetTimer(_hwnd, TIMER_ID_TICK, TICK_INTERVAL_MS, IntPtr.Zero);
            _nativeHost.Start();
            SendHello(hotkeyErrors);

            while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessageW(ref msg);
            }

            return 0;
        }
        finally
        {
            Cleanup();
        }
    }

    private static void OnPipUnbound(TrackedPip pip)
    {
        _pointer.Forget(pip.Hwnd);
        if (_holdDrag?.Pip == pip)
            _holdDrag = null;
        ApplyHotkeys();
        RefreshHookSnapshot();
    }

    private static nint CreateHiddenMessageWindow()
    {
        const string className = "GhostPiP.Engine.MessageWindow";
        _wndProcDelegate = WndProc;
        nint hInstance = GetModuleHandleW(null);

        fixed (char* clsPtr = className)
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProcDelegate),
                hInstance = hInstance,
                lpszClassName = clsPtr
            };
            RegisterClassExW(ref wc);
        }

        return CreateWindowExW(
            0,
            className,
            "GhostPiP Engine",
            0,
            0, 0, 0, 0,
            IntPtr.Zero,
            IntPtr.Zero,
            hInstance,
            IntPtr.Zero);
    }

    private static nint WndProc(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        try
        {
            if (TryDispatch(hWnd, msg, wParam, lParam))
                return IntPtr.Zero;
        }
        catch (Exception ex)
        {
            LogError($"message 0x{msg:X4}", ex);
            return IntPtr.Zero;
        }

        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private static bool TryDispatch(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        switch (msg)
        {
            case WM_TIMER:
                if ((nuint)wParam == TIMER_ID_TICK)
                    OnTick();
                return true;

            case WM_HOTKEY:
                OnHotkey((int)wParam);
                return true;

            case NativeMessagingHost.WM_APP_MESSAGE:
                DrainIncomingMessages();
                return true;

            case WM_APP_POINTER:
                DrainHookEvents();
                return true;

            case TrayIcon.WM_APP_TRAY:
                OnTray(lParam);
                return true;

            case NativeMessagingHost.WM_APP_EOF:
            case WM_APP_SHUTDOWN:
                Cleanup();
                PostQuitMessage(0);
                return true;

            case WM_CLOSE:
                Cleanup();
                DestroyWindow(hWnd);
                return true;

            case WM_DESTROY:
                Cleanup();
                PostQuitMessage(0);
                return true;

            default:
                return false;
        }
    }

    private static void OnTray(nint lParam)
    {
        if (_trayIcon is null)
            return;

        var action = _trayIcon.HandleMessage(lParam, _settings.Hotkeys.ClickThrough);
        if (action == TrayAction.EmergencyRelease)
        {
            EmergencyRelease();
        }
        else if (action == TrayAction.Exit)
        {
            Cleanup();
            PostQuitMessage(0);
        }
    }

    private static bool HasActiveMediaSession() =>
        (_pipTracker is not null && _pipTracker.Tracked.Count > 0) || _webSessionActive;

    private static bool MediaHotkeysWanted() =>
        _settings.Enabled &&
        _settings.EffectiveMedia.Enabled &&
        _webSessionActive &&
        _pipTracker is { Tracked.Count: > 0 };

    private static string[] ApplyHotkeys() =>
        _hotkeys?.Apply(_settings.Hotkeys, peek: _settings.EffectivePeek.Enabled, media: MediaHotkeysWanted()) ?? [];

    private static bool IsPassThroughActive() =>
        _settings.ClickThrough || _settings.EffectivePeek.Enabled;

    private static void OnHotkey(int id)
    {
        switch (id)
        {
            case Hotkeys.ID_CLICK_THROUGH:
                _settings = _settings with { ClickThrough = !_settings.ClickThrough };
                if (!IsPassThroughActive())
                    ClearTrackedFade();
                _nativeHost?.Send(new IntentMessage("TOGGLE_CLICK_THROUGH"));
                RefreshTrackedPeekStyles(SyncSessionAndPeekState());
                break;

            case Hotkeys.ID_DODGE:
                _settings = _settings with
                {
                    Dodge = _settings.Dodge with { Enabled = !_settings.Dodge.Enabled }
                };
                if (!_settings.Dodge.Enabled)
                    ClearTrackedFade();
                _nativeHost?.Send(new IntentMessage("TOGGLE_DODGE"));
                RefreshTrackedPeekStyles(SyncSessionAndPeekState());
                break;

            case Hotkeys.ID_MUTE:
                _nativeHost?.Send(new IntentMessage("TOGGLE_MUTE"));
                break;

            case Hotkeys.ID_PEEK:
                _settings = _settings with
                {
                    Peek = _settings.EffectivePeek with { Enabled = !_settings.EffectivePeek.Enabled }
                };
                ClearTrackedFade();
                _nativeHost?.Send(new IntentMessage("TOGGLE_PEEK"));
                RefreshTrackedPeekStyles(SyncSessionAndPeekState());
                break;

            case Hotkeys.ID_PLAY_PAUSE:
                if (_settings.EffectiveMedia.Enabled && HasActiveMediaSession())
                    _nativeHost?.Send(new IntentMessage("MEDIA_PLAY_PAUSE"));
                break;

            case Hotkeys.ID_SEEK_BACK:
            {
                long nowMs = _clock.ElapsedMilliseconds;
                if (nowMs - _lastSeekBackAtMs >= SEEK_REPEAT_GUARD_MS &&
                    _settings.EffectiveMedia.Enabled &&
                    HasActiveMediaSession())
                {
                    _lastSeekBackAtMs = nowMs;
                    _nativeHost?.Send(new IntentMessage("MEDIA_SEEK_BACK"));
                }
                break;
            }

            case Hotkeys.ID_SEEK_FORWARD:
            {
                long nowMs = _clock.ElapsedMilliseconds;
                if (nowMs - _lastSeekForwardAtMs >= SEEK_REPEAT_GUARD_MS &&
                    _settings.EffectiveMedia.Enabled &&
                    HasActiveMediaSession())
                {
                    _lastSeekForwardAtMs = nowMs;
                    _nativeHost?.Send(new IntentMessage("MEDIA_SEEK_FORWARD"));
                }
                break;
            }
        }
        RefreshHookSnapshot();
    }

    private static void LogError(string where, Exception? ex)
    {
        try
        {
            Console.Error.WriteLine($"[GhostPiP] {where}: {ex}");
        }
        catch
        {
        }
    }

    /// <summary>
    /// Hooks, timers and the host windows belong to the UI thread, so cleanup is marshalled there.
    /// Falls back to running here only if the UI thread does not answer in time.
    /// </summary>
    private static void CleanupFromAnyThread()
    {
        if (Volatile.Read(ref _cleanedUp) != 0)
            return;

        if (Environment.CurrentManagedThreadId == _uiThreadId || _hwnd == IntPtr.Zero)
        {
            Cleanup();
            return;
        }

        if (PostMessageW(_hwnd, WM_APP_SHUTDOWN, IntPtr.Zero, IntPtr.Zero) && _cleanupDone.Wait(1000))
            return;

        Cleanup();
    }

    private static void Cleanup()
    {
        if (Interlocked.Exchange(ref _cleanedUp, 1) != 0)
            return;

        try { if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; } } catch { }
        try { if (_hwnd != IntPtr.Zero) KillTimer(_hwnd, TIMER_ID_TICK); } catch { }
        try { _ghostStyle.RestoreAll(); } catch { }
        try { _pipTracker?.Dispose(); } catch { }
        try { _hotkeys?.Dispose(); } catch { }
        try { _trayIcon?.Dispose(); } catch { }
        try { _nativeHost?.Flush(200); } catch { }
        _cleanupDone.Set();
    }
}
