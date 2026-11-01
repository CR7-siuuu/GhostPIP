using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe class Program
{
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_RBUTTONDOWN = 0x0204;
    private const uint WM_RBUTTONUP = 0x0205;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint WM_HOTKEY = 0x0312;
    private const uint WM_APP_PIP_MOUSEMOVE = 0x8010;

    private const nint MK_LBUTTON = 0x0001;
    private const nint MK_RBUTTON = 0x0002;

    private const int WH_MOUSE_LL = 14;
    private const int CORNER_SNAP_PX = 24;
    private const double WHEEL_OPACITY_STEP = 0.05;

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

    private delegate nint WndProcDelegate(nint hWnd, uint msg, nint wParam, nint lParam);
    private delegate nint LowLevelMouseProc(int nCode, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public nuint dwExtraInfo;
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

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
    private static extern bool PostMessageW(nint hWnd, uint Msg, nint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static extern nint SetWindowsHookExW(int idHook, LowLevelMouseProc lpfn, nint hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(nint hhk);

    [DllImport("user32.dll")]
    private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

    private static WndProcDelegate? _wndProcDelegate;
    private static LowLevelMouseProc? _mouseHookDelegate;
    private static nint _mouseHook;
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
    private static bool _lastPipHovered;
    private static bool _wasInteractive;
    private static bool _waitCursorLeave;
    private static bool _customPos;
    private static bool _wheelPreview;
    private static bool _hasTestCursor;
    private static DodgePoint? _testCursor;
    private static bool? _testHold;
    private static bool _swallowNextLButtonUp;
    private static bool _swallowNextRButtonUp;
    private static bool _hookLButtonDown;
    private static bool _pipMouseDown;
    private static bool _pipDragActive;
    private static string? _pipResizeDir;
    private static bool _justResized;
    private static PipTracker.RECT _pipDownRect;
    private static POINT _pipDownPt;
    private static int _pipDownWinL;
    private static int _pipDownWinT;
    private static bool _pipDownHold;
    private static nint _pipDownHwnd;
    private static int _pipDownClipT;
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

            _mouseHookDelegate = OnLowLevelMouse;
            _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, _mouseHookDelegate, GetModuleHandleW(null), 0);

            SetTimer(_hwnd, TIMER_ID_TICK, TICK_INTERVAL_MS, IntPtr.Zero);
            _nativeHost.Start();

            _nativeHost.Send(new HelloMessage(Protocol.EngineVersion, hotkeyErrors));

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

            case WM_APP_PIP_MOUSEMOVE:
                if (_pipTracker?.BoundHwnd is nint hoverHwnd && hoverHwnd != IntPtr.Zero && GhostStyle.IsWindow(hoverHwnd))
                    PostMessageW(hoverHwnd, WM_MOUSEMOVE, wParam, lParam);
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

                case PipResizeMessage resizeMsg:
                    HandlePipResize(resizeMsg.DeltaH, resizeMsg.Dpr);
                    break;

                case PingMessage:
                    _nativeHost.Send(new PongMessage());
                    break;

                case TestCursorMessage cursorMsg:
                    _hasTestCursor = true;
                    _testCursor = cursorMsg.Cursor;
                    break;

                case TestWheelMessage wheelMsg:
                    HandleMouseWheel(wheelMsg.X, wheelMsg.Y, wheelMsg.Delta, wheelMsg.Hold);
                    break;

                case TestHoldMessage holdMsg:
                    _testHold = holdMsg.Hold;
                    break;
            }
        }
    }

    private static bool IsHoldDown()
    {
        if (_testHold is bool th)
            return th;

        bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        return _settings.Hotkeys.Hold switch
        {
            "Ctrl+Shift" => ctrl && shift,
            "Alt+Shift" => alt && shift,
            "Ctrl" => ctrl,
            "Alt" => alt,
            "Shift" => shift,
            _ => ctrl && alt
        };
    }

    private static nint MakeLParam(int lo, int hi) =>
        (nint)(((hi & 0xFFFF) << 16) | (lo & 0xFFFF));

    private static string? GetResizeBorderDir(int x, int y, PipTracker.RECT rc, int clipT)
    {
        int visL = clipT > 0 ? rc.Left + 8 : rc.Left;
        int visT = rc.Top;
        int visR = clipT > 0 ? Math.Max(visL + 40, rc.Right - 8) : rc.Right;
        int visB = clipT > 0 ? Math.Max(visT + 40, rc.Bottom - 8 - clipT) : rc.Bottom;

        if (x < visL - 6 || x > visR + 6 || y < visT - 6 || y > visB + 6)
            return null;

        bool cornerW = x >= visL - 6 && x <= visL + 16;
        bool cornerE = x >= visR - 16 && x <= visR + 6;
        bool cornerN = y >= visT - 6 && y <= visT + 16;
        bool cornerS = y >= visB - 16 && y <= visB + 6;

        if (cornerN && cornerW) return "nw";
        if (cornerN && cornerE) return "ne";
        if (cornerS && cornerW) return "sw";
        if (cornerS && cornerE) return "se";

        bool nearW = x >= visL - 6 && x <= visL + 8;
        bool nearE = x >= visR - 8 && x <= visR + 6;
        bool nearN = y >= visT - 6 && y <= visT + 8;
        bool nearS = y >= visB - 8 && y <= visB + 6;

        if (nearW) return "w";
        if (nearE) return "e";
        if (nearS) return "s";
        if (nearN) return "n";
        return null;
    }

    private static bool TryGetInteractiveDocPipTarget(
        int x,
        int y,
        out nint pipHwnd,
        out PipTracker.RECT rc,
        out int clipT,
        out nint translatedLParam)
    {
        pipHwnd = IntPtr.Zero;
        rc = default;
        clipT = 0;
        translatedLParam = IntPtr.Zero;

        if (!_settings.Enabled)
            return false;

        if (_settings.ClickThrough && !IsHoldDown())
            return false;

        pipHwnd = _pipTracker?.BoundHwnd ?? IntPtr.Zero;
        if (pipHwnd == IntPtr.Zero || _pipTracker?.BoundKind != "document" || !_ghostStyle.TryGetLogicalWindowRect(pipHwnd, out rc))
            return false;

        if (x < rc.Left - 6 || x > rc.Right + 6 || y < rc.Top - 6 || y > rc.Bottom + 6)
            return false;

        clipT = _ghostStyle.GetHeaderShift(pipHwnd);
        int relX = x - rc.Left;
        int relY = y - rc.Top;
        translatedLParam = MakeLParam(relX, relY + clipT);
        return true;
    }

    private static nint OnLowLevelMouse(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && lParam != IntPtr.Zero)
        {
            uint msg = (uint)wParam;
            var info = *(MSLLHOOKSTRUCT*)lParam;
            if (msg == WM_LBUTTONDOWN)
                _hookLButtonDown = true;
            else if (msg == WM_LBUTTONUP)
                _hookLButtonDown = false;

            if (msg == WM_MOUSEWHEEL)
            {
                int delta = (short)(info.mouseData >> 16);
                bool holdDown = IsHoldDown();
                if (delta != 0 && HandleMouseWheel(info.pt.X, info.pt.Y, delta, holdDown) && holdDown)
                    return (nint)1;
            }
            else if (msg == WM_LBUTTONUP)
            {
                if (_swallowNextLButtonUp)
                {
                    _swallowNextLButtonUp = false;
                    return (nint)1;
                }
                if (_pipMouseDown)
                {
                    if (_pipResizeDir is not null)
                    {
                        _pipResizeDir = null;
                        _pipMouseDown = false;
                        _pipDragActive = false;
                        _customPos = true;
                        _justResized = true;
                        _waitCursorLeave = true;
                        return (nint)1;
                    }
                    bool wasHold = _pipDownHold;
                    bool wasDrag = _pipDragActive;
                    nint downHwnd = _pipDownHwnd;
                    int downClipT = _pipDownClipT;
                    _pipMouseDown = false;
                    _pipDragActive = false;
                    if (downHwnd != IntPtr.Zero && GhostStyle.IsWindow(downHwnd) && _ghostStyle.TryGetLogicalWindowRect(downHwnd, out var upRc))
                    {
                        int relX = info.pt.X - upRc.Left;
                        int relY = info.pt.Y - upRc.Top;
                        nint translated = MakeLParam(relX, relY + downClipT);
                        nint inputTarget = _ghostStyle.GetInputTargetHwnd(downHwnd);
                        if (wasHold && !wasDrag)
                        {
                            SetForegroundWindow(downHwnd);
                            PostMessageW(inputTarget, WM_MOUSEMOVE, IntPtr.Zero, translated);
                            PostMessageW(inputTarget, WM_LBUTTONDOWN, MK_LBUTTON, translated);
                            PostMessageW(inputTarget, WM_LBUTTONUP, IntPtr.Zero, translated);
                        }
                        else if (!wasHold && downClipT > 0)
                        {
                            PostMessageW(inputTarget, WM_LBUTTONUP, IntPtr.Zero, translated);
                        }
                    }
                    return (nint)1;
                }
            }
            else if (msg == WM_MOUSEMOVE)
            {
                if (_pipMouseDown)
                {
                    if (_pipResizeDir is string resizeDir)
                    {
                        if (!_pipDragActive && (Math.Abs(info.pt.X - _pipDownPt.X) >= 2 || Math.Abs(info.pt.Y - _pipDownPt.Y) >= 2))
                            _pipDragActive = true;
                        if (_pipDragActive && _pipDownHwnd != IntPtr.Zero && GhostStyle.IsWindow(_pipDownHwnd))
                        {
                            int dx = info.pt.X - _pipDownPt.X;
                            int dy = info.pt.Y - _pipDownPt.Y;
                            int startW = _pipDownRect.Right - _pipDownRect.Left;
                            int startH = _pipDownRect.Bottom - _pipDownRect.Top;
                            int minW = 200;
                            int minH = 130 + _pipDownClipT;
                            int nextW = resizeDir.Contains('e') ? Math.Max(minW, startW + dx) : resizeDir.Contains('w') ? Math.Max(minW, startW - dx) : startW;
                            int nextH = resizeDir.Contains('s') ? Math.Max(minH, startH + dy) : resizeDir.Contains('n') ? Math.Max(minH, startH - dy) : startH;
                            int nextL = resizeDir.Contains('w') ? _pipDownRect.Right - nextW : _pipDownRect.Left;
                            int nextT = resizeDir.Contains('n') ? _pipDownRect.Bottom - nextH : _pipDownRect.Top;
                            _customPos = true;
                            _justResized = true;
                            _waitCursorLeave = true;
                            _ghostStyle.MoveAndResizeLogicalWindow(_pipDownHwnd, nextL, nextT, nextW, nextH);
                        }
                    }
                    else if (_pipDownHold)
                    {
                        if (!_pipDragActive && (Math.Abs(info.pt.X - _pipDownPt.X) >= 5 || Math.Abs(info.pt.Y - _pipDownPt.Y) >= 5))
                            _pipDragActive = true;
                        if (_pipDragActive && _pipDownHwnd != IntPtr.Zero && GhostStyle.IsWindow(_pipDownHwnd))
                        {
                            int nextL = _pipDownWinL + (info.pt.X - _pipDownPt.X);
                            int nextT = _pipDownWinT + (info.pt.Y - _pipDownPt.Y);
                            _ghostStyle.MoveLogicalWindow(_pipDownHwnd, nextL, nextT);
                        }
                    }
                    else if (_pipDownClipT > 0 && _pipDownHwnd != IntPtr.Zero && _ghostStyle.TryGetLogicalWindowRect(_pipDownHwnd, out var moveRc))
                    {
                        int relX = info.pt.X - moveRc.Left;
                        int relY = info.pt.Y - moveRc.Top;
                        PostMessageW(_hwnd, WM_APP_PIP_MOUSEMOVE, MK_LBUTTON, MakeLParam(relX, relY + _pipDownClipT));
                    }
                }
                else if (TryGetInteractiveDocPipTarget(info.pt.X, info.pt.Y, out _, out _, out int clipT, out nint translated) && clipT > 0)
                {
                    PostMessageW(_hwnd, WM_APP_PIP_MOUSEMOVE, IntPtr.Zero, translated);
                }
            }
            else if (msg == WM_LBUTTONDOWN)
            {
                if (TryGetInteractiveDocPipTarget(info.pt.X, info.pt.Y, out nint pipHwnd, out var rc, out int clipT, out nint translated))
                {
                    bool holdDown = IsHoldDown();
                    string? resizeDir = GetResizeBorderDir(info.pt.X, info.pt.Y, rc, clipT);
                    if (resizeDir is not null)
                    {
                        _pipMouseDown = true;
                        _pipDragActive = false;
                        _pipResizeDir = resizeDir;
                        _pipDownPt = info.pt;
                        _pipDownRect = rc;
                        _pipDownWinL = rc.Left;
                        _pipDownWinT = rc.Top;
                        _pipDownHold = holdDown;
                        _pipDownHwnd = pipHwnd;
                        _pipDownClipT = clipT;
                        return (nint)1;
                    }
                    if (holdDown || clipT > 0)
                    {
                        _pipMouseDown = true;
                        _pipDragActive = false;
                        _pipResizeDir = null;
                        _pipDownPt = info.pt;
                        _pipDownRect = rc;
                        _pipDownWinL = rc.Left;
                        _pipDownWinT = rc.Top;
                        _pipDownHold = holdDown;
                        _pipDownHwnd = pipHwnd;
                        _pipDownClipT = clipT;
                        if (!holdDown && clipT > 0)
                        {
                            SetForegroundWindow(pipHwnd);
                            PostMessageW(pipHwnd, WM_MOUSEMOVE, IntPtr.Zero, translated);
                            PostMessageW(pipHwnd, WM_LBUTTONDOWN, MK_LBUTTON, translated);
                        }
                        return (nint)1;
                    }
                }
            }
            else if (msg == WM_RBUTTONDOWN)
            {
                if (TryGetInteractiveDocPipTarget(info.pt.X, info.pt.Y, out nint pipHwnd, out _, out int clipT, out nint translated) && clipT > 0)
                {
                    SetForegroundWindow(pipHwnd);
                    PostMessageW(pipHwnd, WM_MOUSEMOVE, IntPtr.Zero, translated);
                    PostMessageW(pipHwnd, WM_RBUTTONDOWN, MK_RBUTTON, translated);
                    _swallowNextRButtonUp = true;
                    return (nint)1;
                }
            }
            else if (msg == WM_RBUTTONUP && _swallowNextRButtonUp)
            {
                _swallowNextRButtonUp = false;
                if (TryGetInteractiveDocPipTarget(info.pt.X, info.pt.Y, out nint pipHwnd, out _, out int clipT, out nint translated) && clipT > 0)
                    PostMessageW(pipHwnd, WM_RBUTTONUP, IntPtr.Zero, translated);
                return (nint)1;
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private static bool HandleMouseWheel(int x, int y, int delta, bool holdDown)
    {
        if (delta == 0 || !_settings.Enabled)
            return false;

        nint pipHwnd = _pipTracker?.BoundHwnd ?? IntPtr.Zero;
        if (pipHwnd == IntPtr.Zero || !_ghostStyle.TryGetLogicalWindowRect(pipHwnd, out var rc))
            return false;

        if (x < rc.Left || x > rc.Right || y < rc.Top || y > rc.Bottom)
            return false;

        bool canAdjust = holdDown || (!_settings.ClickThrough && _pipTracker?.BoundKind == "native");
        if (!canAdjust)
            return false;

        double step = delta > 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP;
        double next = Math.Round(Math.Clamp(_settings.Opacity + step, 0.1, 1.0), 2, MidpointRounding.AwayFromZero);
        _settings = _settings with { Opacity = next };
        _waitCursorLeave = true;
        _wheelPreview = true;
        _dodgeState = _dodgeState with { HoverSince = null };

        bool effectiveClickThrough = _settings.ClickThrough && !holdDown;
        _ghostStyle.Apply(pipHwnd, next, effectiveClickThrough, hideHeader: true);
        _nativeHost?.Send(new IntentMessage("SET_OPACITY", Opacity: next));
        return true;
    }

    private static void SnapWindowToCorner(nint hwnd, string corner)
    {
        if (hwnd == IntPtr.Zero || !_ghostStyle.TryGetLogicalWindowRect(hwnd, out var rc))
            return;

        var winSize = new DodgeSize(rc.Right - rc.Left, rc.Bottom - rc.Top);
        var area = GetWorkArea(hwnd);
        var targetRect = DodgeSolver.CornerRect(corner, winSize, area, _settings.Dodge.EdgeInsetPx);
        _ghostStyle.MoveLogicalWindow(hwnd, targetRect.L, targetRect.T);
    }

    private static void HandlePipResize(int deltaH, double dpr)
    {
        nint pipHwnd = _pipTracker?.BoundHwnd ?? IntPtr.Zero;
        if (pipHwnd == IntPtr.Zero || !_ghostStyle.TryGetLogicalWindowRect(pipHwnd, out var rc))
            return;

        int curW = rc.Right - rc.Left;
        int curH = rc.Bottom - rc.Top;
        int physDelta = (int)Math.Round(deltaH * dpr, MidpointRounding.AwayFromZero);
        if (Math.Abs(physDelta) > 4)
        {
            int nextH = Math.Max(150, curH + physDelta);
            _ghostStyle.ResizeLogicalWindow(pipHwnd, curW, nextH);
        }

        if (!_customPos)
            SnapWindowToCorner(pipHwnd, _dodgeState.Corner);
    }

    private static void ApplyStateMessage(Settings next)
    {
        bool enabledChanged = _settings.Enabled != next.Enabled;
        bool hotkeysChanged = _settings.Hotkeys != next.Hotkeys;
        bool homeChanged = _settings.Dodge.Home != next.Dodge.Home;
        _settings = next;

        if (!_settings.Enabled)
        {
            Cleanup();
            PostQuitMessage(0);
            return;
        }

        if ((hotkeysChanged || enabledChanged) && _hotkeys is not null)
        {
            string[] hotkeyErrors = _hotkeys.Apply(_settings.Hotkeys);
            _nativeHost?.Send(new HelloMessage(Protocol.EngineVersion, hotkeyErrors));
        }

        if (homeChanged || Array.IndexOf(DodgeSolver.CORNERS, _dodgeState.Corner) < 0)
        {
            _customPos = false;
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
        if (!_settings.Enabled)
            return;

        long nowMs = _clock.ElapsedMilliseconds;
        _pipTracker?.Tick(nowMs);

        nint pipHwnd = _pipTracker?.BoundHwnd ?? IntPtr.Zero;
        if (pipHwnd == IntPtr.Zero)
        {
            _lastBoundHwnd = IntPtr.Zero;
            _lastPipHovered = false;
            _wasInteractive = false;
            _waitCursorLeave = false;
            _customPos = false;
            _wheelPreview = false;
            _holdMachine.Reset();
            return;
        }

        bool justBound = pipHwnd != _lastBoundHwnd;
        if (justBound)
        {
            _lastBoundHwnd = pipHwnd;
            _lastPipHovered = false;
            _wasInteractive = false;
            _waitCursorLeave = false;
            _customPos = false;
            _wheelPreview = false;
            _dodgeState = DodgeSolver.InitialState(_settings.Dodge.Home);
            _ghostStyle.Apply(pipHwnd, _settings.Opacity, _settings.ClickThrough, hideHeader: true);
            SnapWindowToCorner(pipHwnd, _settings.Dodge.Home);
        }

        bool holdDown = IsHoldDown();
        bool lButton = _hookLButtonDown || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

        var holdRes = _holdMachine.Step(holdDown, lButton);
        if (_wasInteractive && !holdRes.IsInteractive)
        {
            _waitCursorLeave = true;
            _wheelPreview = false;
            _dodgeState = _dodgeState with { HoverSince = null };
        }
        if (holdRes.State == HoldState.Dragging)
            _wheelPreview = false;
        _wasInteractive = holdRes.IsInteractive;

        if (!_ghostStyle.TryGetLogicalWindowRect(pipHwnd, out var rc))
            return;

        var winRect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
        var winSize = new DodgeSize(winRect.W, winRect.H);
        var area = GetWorkArea(pipHwnd);

        if (holdRes.DragEnded)
        {
            _waitCursorLeave = true;
            string nearest = DodgeSolver.NearestCorner(winRect, area);
            var targetRect = DodgeSolver.CornerRect(nearest, winSize, area, _settings.Dodge.EdgeInsetPx);
            double dist = Math.Sqrt(
                (double)(winRect.L - targetRect.L) * (winRect.L - targetRect.L) +
                (double)(winRect.T - targetRect.T) * (winRect.T - targetRect.T));

            if (!_justResized && dist <= CORNER_SNAP_PX)
            {
                _customPos = false;
                _ghostStyle.MoveLogicalWindow(pipHwnd, targetRect.L, targetRect.T);
            }
            else
            {
                _customPos = true;
            }
            _justResized = false;

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
        else if (!holdRes.IsInteractive && _settings.ClickThrough)
        {
            DodgePoint? cursor = GetVisibleCursor();
            int m = _settings.Dodge.MarginPx;
            bool cursorInCurrent = cursor is DodgePoint p &&
                p.X >= winRect.L - m && p.X < winRect.R + m &&
                p.Y >= winRect.T - m && p.Y < winRect.B + m;

            if (_waitCursorLeave)
            {
                if (cursorInCurrent)
                {
                    _dodgeState = _dodgeState with { HoverSince = null };
                }
                else
                {
                    _waitCursorLeave = false;
                }
            }

            if (!_waitCursorLeave)
            {
                DodgePoint? stepCursor = cursor;
                if (_customPos)
                {
                    if (cursorInCurrent)
                    {
                        var cr = DodgeSolver.CornerRect(_dodgeState.Corner, winSize, area, _settings.Dodge.EdgeInsetPx);
                        stepCursor = new DodgePoint((cr.L + cr.R) / 2, (cr.T + cr.B) / 2);
                    }
                    else
                    {
                        stepCursor = null;
                    }
                }

                var stepRes = DodgeSolver.Step(
                    _dodgeState,
                    new DodgeInput(nowMs, stepCursor, winSize, area),
                    _settings.Dodge);
                _dodgeState = stepRes.State;

                if (stepRes.Action.Type == "move" && stepRes.Action.Corner is string targetCorner)
                {
                    _customPos = false;
                    var targetRect = DodgeSolver.CornerRect(targetCorner, winSize, area, _settings.Dodge.EdgeInsetPx);
                    winRect = targetRect;
                    _ghostStyle.MoveLogicalWindow(pipHwnd, targetRect.L, targetRect.T);
                }
            }
        }

        DodgePoint? curPt = GetVisibleCursor();
        bool cursorInWindow = curPt is DodgePoint wp &&
            wp.X >= winRect.L && wp.X <= winRect.R &&
            wp.Y >= winRect.T && wp.Y <= winRect.B;

        bool hideHeader = true;
        bool pipHovered = holdRes.IsInteractive || (!_settings.ClickThrough && cursorInWindow);
        if (justBound || pipHovered != _lastPipHovered)
        {
            _lastPipHovered = pipHovered;
            _nativeHost?.Send(new PipHoverMessage(_pipTracker?.BoundTabId ?? -1, pipHovered));
        }

        double effectiveOpacity = (holdRes.IsInteractive && !_wheelPreview)
            ? 1.0
            : _dodgeState.Faded
                ? 0.1
                : _settings.Opacity;
        bool effectiveClickThrough = _settings.ClickThrough && !holdRes.IsInteractive;

        _ghostStyle.Apply(pipHwnd, effectiveOpacity, effectiveClickThrough, hideHeader);
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

    private static void Cleanup()
    {
        if (_cleanedUp)
            return;
        _cleanedUp = true;

        try { if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; } } catch { }
        try { if (_hwnd != IntPtr.Zero) KillTimer(_hwnd, TIMER_ID_TICK); } catch { }
        try { _pipTracker?.Dispose(); } catch { }
        try { _hotkeys?.Dispose(); } catch { }
        try { _trayIcon?.Dispose(); } catch { }
        try { _ghostStyle.RestoreAll(); } catch { }
    }
}
