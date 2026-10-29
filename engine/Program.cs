using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe class Program
{
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_HOTKEY = 0x0312;

    private const nuint TIMER_ID_TICK = 1;
    private const uint TICK_INTERVAL_MS = 30;

    private const int VK_LBUTTON = 0x01;
    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;

    private const uint CURSOR_SHOWING = 0x00000001;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenElevation = 20;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public uint cbSize;
        public uint flags;
        public nint hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public uint cbSize;
        public PipTracker.RECT rcMonitor;
        public PipTracker.RECT rcWork;
        public uint dwFlags;
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

    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint hwnd, uint dwFlags);

    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    private static extern bool GetMonitorInfoW(nint hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(nint ProcessHandle, uint DesiredAccess, out nint TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        nint TokenHandle,
        int TokenInformationClass,
        out int TokenInformation,
        int TokenInformationLength,
        out int ReturnLength);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint hObject);

    private static WndProcDelegate? _wndProcDelegate;
    private static nint _hwnd;
    private static readonly Stopwatch _clock = Stopwatch.StartNew();

    private static Settings _settings = Settings.Defaults;
    private static DodgeState _dodgeState = DodgeSolver.InitialState(Settings.Defaults.Dodge.Home);
    private static readonly HoldStateMachine _holdMachine = new();
    private static readonly GhostStyle _ghostStyle = new();
    private static Hotkeys? _hotkeys;
    private static TrayIcon? _trayIcon;
    private static NativeMessagingHost? _nativeHost;
    private static PipTracker? _pipTracker;
    private static nint _lastBoundHwnd;
    private static bool _hasTestCursor;
    private static DodgePoint? _testCursor;
    private static bool _cleanedUp;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
            return SelfTest.Run(args);

        AppDomain.CurrentDomain.ProcessExit += (_, _) => Cleanup();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => Cleanup();

        try
        {
            _hwnd = CreateHiddenMessageWindow();
            if (_hwnd == IntPtr.Zero)
                return 1;

            _hotkeys = new Hotkeys(_hwnd);
            string[] hotkeyErrors = _hotkeys.Apply(_settings.Hotkeys);

            _trayIcon = new TrayIcon(_hwnd);
            _nativeHost = new NativeMessagingHost(_hwnd);
            _pipTracker = new PipTracker(_hwnd, _ghostStyle, msg => _nativeHost.Send(msg));

            SetTimer(_hwnd, TIMER_ID_TICK, TICK_INTERVAL_MS, IntPtr.Zero);
            _nativeHost.Start();

            _nativeHost.Send(new HelloMessage(
                Protocol.EngineVersion,
                IsElevated(),
                hotkeyErrors));

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

    private static nint CreateHiddenMessageWindow()
    {
        const string className = "GhostPiPEngineMessageWindow";
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
        switch (msg)
        {
            case WM_TIMER:
                if ((nuint)wParam == TIMER_ID_TICK)
                    OnTick();
                return IntPtr.Zero;

            case WM_HOTKEY:
                OnHotkey((int)wParam);
                return IntPtr.Zero;

            case NativeMessagingHost.WM_APP_MESSAGE:
                DrainIncomingMessages();
                return IntPtr.Zero;

            case NativeMessagingHost.WM_APP_EOF:
                Cleanup();
                PostQuitMessage(0);
                return IntPtr.Zero;

            case TrayIcon.WM_APP_TRAY:
                if (_trayIcon is not null)
                {
                    var action = _trayIcon.HandleMessage(lParam);
                    if (action == TrayAction.EmergencyDisableClickThrough)
                    {
                        _settings = _settings with { ClickThrough = false };
                        if (_pipTracker?.BoundHwnd is nint bound && bound != IntPtr.Zero)
                            _ghostStyle.Apply(bound, _settings.Opacity, clickThrough: false);
                        _nativeHost?.Send(new IntentMessage("TOGGLE_CLICK_THROUGH"));
                    }
                    else if (action == TrayAction.Exit)
                    {
                        Cleanup();
                        PostQuitMessage(0);
                    }
                }
                return IntPtr.Zero;

            case WM_CLOSE:
                Cleanup();
                DestroyWindow(hWnd);
                return IntPtr.Zero;

            case WM_DESTROY:
                Cleanup();
                PostQuitMessage(0);
                return IntPtr.Zero;
        }

        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private static void DrainIncomingMessages()
    {
        if (_nativeHost is null)
            return;

        while (_nativeHost.TryDequeue(out var msg) && msg is not null)
        {
            switch (msg)
            {
                case StateMessage stateMsg:
                    ApplyStateMessage(stateMsg.Settings);
                    break;

                case PipOpenedMessage openedMsg:
                    _pipTracker?.OnPipOpened(openedMsg, _clock.ElapsedMilliseconds);
                    break;

                case PipClosedMessage closedMsg:
                    _pipTracker?.OnPipClosed(closedMsg.TabId);
                    break;

                case PingMessage:
                    _nativeHost.Send(new PongMessage());
                    break;

                case TestCursorMessage cursorMsg:
                    _hasTestCursor = true;
                    _testCursor = cursorMsg.Cursor;
                    break;
            }
        }
    }

    private static void SnapWindowToCorner(nint hwnd, string corner)
    {
        if (hwnd == IntPtr.Zero || !PipTracker.GetWindowRect(hwnd, out var rc))
            return;

        var winSize = new DodgeSize(rc.Right - rc.Left, rc.Bottom - rc.Top);
        var area = GetWorkArea(hwnd);
        var targetRect = DodgeSolver.CornerRect(corner, winSize, area, _settings.Dodge.EdgeInsetPx);
        GhostStyle.SetWindowPos(
            hwnd,
            IntPtr.Zero,
            targetRect.L,
            targetRect.T,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
    }

    private static void ApplyStateMessage(Settings next)
    {
        bool hotkeysChanged = _settings.Hotkeys != next.Hotkeys;
        bool homeChanged = _settings.Dodge.Home != next.Dodge.Home;
        _settings = next;

        if (hotkeysChanged && _hotkeys is not null)
            _hotkeys.Apply(_settings.Hotkeys);

        if (homeChanged || Array.IndexOf(DodgeSolver.CORNERS, _dodgeState.Corner) < 0)
        {
            _dodgeState = DodgeSolver.InitialState(_settings.Dodge.Home);
            if (_pipTracker?.BoundHwnd is nint bound && bound != IntPtr.Zero)
                SnapWindowToCorner(bound, _settings.Dodge.Home);
        }
    }

    private static void OnHotkey(int id)
    {
        switch (id)
        {
            case Hotkeys.ID_CLICK_THROUGH:
                _settings = _settings with { ClickThrough = !_settings.ClickThrough };
                _nativeHost?.Send(new IntentMessage("TOGGLE_CLICK_THROUGH"));
                break;

            case Hotkeys.ID_DODGE:
                _settings = _settings with
                {
                    Dodge = _settings.Dodge with { Enabled = !_settings.Dodge.Enabled }
                };
                _nativeHost?.Send(new IntentMessage("TOGGLE_DODGE"));
                break;

            case Hotkeys.ID_MUTE:
                _nativeHost?.Send(new IntentMessage("TOGGLE_MUTE"));
                break;
        }
    }

    private static void OnTick()
    {
        long nowMs = _clock.ElapsedMilliseconds;
        _pipTracker?.Tick(nowMs);

        nint pipHwnd = _pipTracker?.BoundHwnd ?? IntPtr.Zero;
        if (pipHwnd == IntPtr.Zero)
        {
            _lastBoundHwnd = IntPtr.Zero;
            _holdMachine.Reset();
            return;
        }

        if (pipHwnd != _lastBoundHwnd)
        {
            _lastBoundHwnd = pipHwnd;
            _dodgeState = DodgeSolver.InitialState(_settings.Dodge.Home);
            SnapWindowToCorner(pipHwnd, _settings.Dodge.Home);
        }

        bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        bool lButton = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

        bool holdDown = _settings.Hotkeys.Hold == "Ctrl+Shift"
            ? (ctrl && shift)
            : (ctrl && alt);

        var holdRes = _holdMachine.Step(holdDown, lButton);

        if (!PipTracker.GetWindowRect(pipHwnd, out var rc))
            return;

        var winRect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
        var winSize = new DodgeSize(winRect.W, winRect.H);
        var area = GetWorkArea(pipHwnd);

        if (holdRes.DragEnded)
        {
            string nearest = DodgeSolver.NearestCorner(winRect, area);
            var targetRect = DodgeSolver.CornerRect(nearest, winSize, area, _settings.Dodge.EdgeInsetPx);
            GhostStyle.SetWindowPos(
                pipHwnd,
                IntPtr.Zero,
                targetRect.L,
                targetRect.T,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);

            _dodgeState = DodgeSolver.InitialState(nearest);

            if (Array.IndexOf(_settings.Dodge.Allowed, nearest) >= 0 && nearest != _settings.Dodge.Home)
            {
                _settings = _settings with
                {
                    Dodge = _settings.Dodge with { Home = nearest }
                };
                _nativeHost?.Send(new IntentMessage("SET_HOME", nearest));
            }
        }
        else if (!holdRes.IsInteractive)
        {
            DodgePoint? cursor = GetVisibleCursor();
            var stepRes = DodgeSolver.Step(
                _dodgeState,
                new DodgeInput(nowMs, cursor, winSize, area),
                _settings.Dodge);
            _dodgeState = stepRes.State;

            if (stepRes.Action.Type == "move" && stepRes.Action.Corner is string targetCorner)
            {
                var targetRect = DodgeSolver.CornerRect(targetCorner, winSize, area, _settings.Dodge.EdgeInsetPx);
                GhostStyle.SetWindowPos(
                    pipHwnd,
                    IntPtr.Zero,
                    targetRect.L,
                    targetRect.T,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
            }
        }

        double effectiveOpacity = holdRes.IsInteractive
            ? 1.0
            : _dodgeState.Faded
                ? 0.1
                : _settings.Opacity;
        bool effectiveClickThrough = _settings.ClickThrough && !holdRes.IsInteractive;

        _ghostStyle.Apply(pipHwnd, effectiveOpacity, effectiveClickThrough);
    }

    private static DodgePoint? GetVisibleCursor()
    {
        if (_hasTestCursor)
            return _testCursor;

        var ci = new CURSORINFO { cbSize = (uint)sizeof(CURSORINFO) };
        if (!GetCursorInfo(ref ci) || (ci.flags & CURSOR_SHOWING) == 0)
            return null;

        return new DodgePoint(ci.ptScreenPos.X, ci.ptScreenPos.Y);
    }

    private static DodgeRect GetWorkArea(nint hwnd)
    {
        nint hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        var mi = new MONITORINFO { cbSize = (uint)sizeof(MONITORINFO) };
        if (hMon == IntPtr.Zero || !GetMonitorInfoW(hMon, ref mi))
            return new DodgeRect(0, 0, 1920, 1080);

        nint fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && fg != hwnd && PipTracker.GetWindowRect(fg, out var fgRc))
        {
            if (fgRc.Left <= mi.rcMonitor.Left &&
                fgRc.Top <= mi.rcMonitor.Top &&
                fgRc.Right >= mi.rcMonitor.Right &&
                fgRc.Bottom >= mi.rcMonitor.Bottom)
            {
                return new DodgeRect(
                    mi.rcMonitor.Left,
                    mi.rcMonitor.Top,
                    mi.rcMonitor.Right,
                    mi.rcMonitor.Bottom);
            }
        }

        return new DodgeRect(
            mi.rcWork.Left,
            mi.rcWork.Top,
            mi.rcWork.Right,
            mi.rcWork.Bottom);
    }

    private static bool IsElevated()
    {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out nint token))
            return false;

        try
        {
            if (GetTokenInformation(token, TokenElevation, out int elevated, sizeof(int), out _))
                return elevated != 0;
            return false;
        }
        finally
        {
            CloseHandle(token);
        }
    }

    private static void Cleanup()
    {
        if (_cleanedUp)
            return;
        _cleanedUp = true;

        try { if (_hwnd != IntPtr.Zero) KillTimer(_hwnd, TIMER_ID_TICK); } catch { }
        try { _pipTracker?.Dispose(); } catch { }
        try { _hotkeys?.Dispose(); } catch { }
        try { _trayIcon?.Dispose(); } catch { }
        try { _ghostStyle.RestoreAll(); } catch { }
    }
}
