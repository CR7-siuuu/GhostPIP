using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe class Program
{
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint WM_HOTKEY = 0x0312;

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

    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenElevation = 20;

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
            }
        }
    }

    private static bool IsHoldDown()
    {
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

    private static nint OnLowLevelMouse(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && (uint)wParam == WM_MOUSEWHEEL && lParam != IntPtr.Zero)
        {
            var info = *(MSLLHOOKSTRUCT*)lParam;
            int delta = (short)(info.mouseData >> 16);
            bool holdDown = IsHoldDown();
            if (delta != 0 && HandleMouseWheel(info.pt.X, info.pt.Y, delta, holdDown) && holdDown)
                return (nint)1;
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

        DodgePoint? cursor = GetVisibleCursor();
        bool cursorInWindow = cursor is DodgePoint wp &&
            wp.X >= rc.Left && wp.X <= rc.Right &&
            wp.Y >= rc.Top && wp.Y <= rc.Bottom;
        bool effectiveClickThrough = _settings.ClickThrough && !holdDown;
        _ghostStyle.Apply(pipHwnd, next, effectiveClickThrough, hideHeader: !holdDown && !cursorInWindow);
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
            _hotkeys?.UnregisterAll();
            _pipTracker?.ClearAll();
            _ghostStyle.RestoreAll();
            return;
        }

        if ((hotkeysChanged || enabledChanged) && _hotkeys is not null)
        {
            string[] hotkeyErrors = _hotkeys.Apply(_settings.Hotkeys);
            _nativeHost?.Send(new HelloMessage(Protocol.EngineVersion, IsElevated(), hotkeyErrors));
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

        if (pipHwnd != _lastBoundHwnd)
        {
            _lastBoundHwnd = pipHwnd;
            _lastPipHovered = false;
            _wasInteractive = false;
            _waitCursorLeave = false;
            _customPos = false;
            _wheelPreview = false;
            _dodgeState = DodgeSolver.InitialState(_settings.Dodge.Home);
            SnapWindowToCorner(pipHwnd, _settings.Dodge.Home);
        }

        bool holdDown = IsHoldDown();
        bool lButton = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

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

            if (dist <= CORNER_SNAP_PX)
            {
                _customPos = false;
                _ghostStyle.MoveLogicalWindow(pipHwnd, targetRect.L, targetRect.T);
            }
            else
            {
                _customPos = true;
            }

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
        bool cursorInHeader = false;
        if (cursorInWindow && curPt is DodgePoint hp && _ghostStyle.TryGetContentRelRect(pipHwnd, out var contentRel))
        {
            cursorInHeader = hp.Y >= winRect.T && hp.Y < winRect.T + contentRel.Top + 44;
        }

        bool hideHeader = !holdRes.IsInteractive && !cursorInWindow;
        bool pipHovered = !hideHeader;
        if (pipHovered != _lastPipHovered)
        {
            _lastPipHovered = pipHovered;
            if (_pipTracker is { BoundTabId: >= 0 } tracker)
                _nativeHost?.Send(new PipHoverMessage(tracker.BoundTabId, pipHovered));
        }

        double effectiveOpacity = (holdRes.IsInteractive && !_wheelPreview)
            ? 1.0
            : _dodgeState.Faded
                ? 0.1
                : _settings.Opacity;
        bool effectiveClickThrough = _settings.ClickThrough &&
            !holdRes.IsInteractive &&
            !(cursorInHeader && (!_settings.Dodge.Enabled || _waitCursorLeave));

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

        try { if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; } } catch { }
        try { if (_hwnd != IntPtr.Zero) KillTimer(_hwnd, TIMER_ID_TICK); } catch { }
        try { _pipTracker?.Dispose(); } catch { }
        try { _hotkeys?.Dispose(); } catch { }
        try { _trayIcon?.Dispose(); } catch { }
        try { _ghostStyle.RestoreAll(); } catch { }
    }
}
