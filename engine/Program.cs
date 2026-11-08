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
    private const double WHEEL_VOLUME_STEP = 0.05;
    private const long SEEK_REPEAT_GUARD_MS = 110;

    private const nuint TIMER_ID_TICK = 1;
    private const uint TICK_INTERVAL_MS = 30;

    private const int VK_LBUTTON = 0x01;
    private const int VK_XBUTTON1 = 0x05;
    private const int VK_XBUTTON2 = 0x06;
    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_OEM_3 = 0xC0;

    private const uint CURSOR_SHOWING = 0x00000001;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
    private const uint GW_HWNDNEXT = 2;

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

    [DllImport("user32.dll")]
    private static extern nint GetWindow(nint hWnd, uint uCmd);

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
    private static readonly HoldStateMachine _holdMachine = new();
    private static readonly GhostStyle _ghostStyle = new();
    private static Hotkeys? _hotkeys;
    private static TrayIcon? _trayIcon;
    private static NativeMessagingHost? _nativeHost;
    private static PipTracker? _pipTracker;
    private static bool _wasInteractive;
    private static bool _hasTestCursor;
    private static DodgePoint? _testCursor;
    private static bool? _testHold;
    private static bool? _testPeek;
    private static bool _webSessionActive;
    private static bool _lastPeekEmitted;
    private static bool _lastMediaHotkeysActive;
    private static long _lastSeekBackAtMs = -1000;
    private static long _lastSeekForwardAtMs = -1000;
    private static bool _swallowNextLButtonUp;
    private static bool _swallowNextRButtonUp;
    private static bool _hookLButtonDown;
    private static bool _pipMouseDown;
    private static bool _pipDragActive;
    private static string? _pipResizeDir;
    private static PipTracker.RECT _pipDownRect;
    private static POINT _pipDownPt;
    private static int _pipDownWinL;
    private static int _pipDownWinT;
    private static bool _pipDownHold;
    private static nint _pipDownHwnd;
    private static int _pipDownClipT;
    private static TrackedPip? _pipDownPip;
    private static TrackedPip? _dragPip;
    private static bool _dragPipMoved;
    private static TrackedPip? _resizePip;
    private static nint _hoverTargetHwnd;
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
            _pipTracker = new PipTracker(_hwnd, _ghostStyle, msg => _nativeHost.Send(msg), OnPipUnbound);
            _pipTracker.SetDefaultCorner(_settings.Dodge.Home);

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

    private static void OnPipUnbound(TrackedPip pip)
    {
        if (_dragPip == pip)
        {
            _dragPip = null;
            _dragPipMoved = false;
        }
        if (_resizePip == pip)
        {
            _resizePip = null;
            _pipResizeDir = null;
            _pipMouseDown = false;
            _pipDragActive = false;
        }
        if (_pipDownPip == pip)
        {
            _pipDownPip = null;
            _pipDownHwnd = IntPtr.Zero;
            _pipMouseDown = false;
            _pipDragActive = false;
        }
        if (_hoverTargetHwnd == pip.Hwnd)
            _hoverTargetHwnd = IntPtr.Zero;
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
                if (_hoverTargetHwnd != IntPtr.Zero && GhostStyle.IsWindow(_hoverTargetHwnd))
                    PostMessageW(_hoverTargetHwnd, WM_MOUSEMOVE, wParam, lParam);
                return IntPtr.Zero;

            case NativeMessagingHost.WM_APP_EOF:
                Cleanup();
                PostQuitMessage(0);
                return IntPtr.Zero;

            case TrayIcon.WM_APP_TRAY:
                if (_trayIcon is not null)
                {
                    var action = _trayIcon.HandleMessage(lParam, _settings.Hotkeys.ClickThrough);
                        if (action == TrayAction.EmergencyDisableClickThrough)
                        {
                            _settings = _settings with { ClickThrough = false };
                            if (_pipTracker is not null)
                            {
                                for (int i = 0; i < _pipTracker.Tracked.Count; i++)
                                {
                                    var p = _pipTracker.Tracked[i];
                                    p.DodgeState = p.DodgeState with { HoverSince = null, Faded = false };
                                    _ghostStyle.Apply(p.Hwnd, _settings.Opacity, clickThrough: false, hideHeader: true);
                                }
                            }
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
                    HandlePipResize(resizeMsg.DeltaH, resizeMsg.Dpr, resizeMsg.TabId);
                    break;

                case PipSubtitleMessage subtitleMsg:
                    HandlePipSubtitle(subtitleMsg.TabId, subtitleMsg.Text);
                    break;

                case SessionStateMessage sessionMsg:
                    _webSessionActive = sessionMsg.Active;
                    SyncSessionAndPeekState();
                    break;

                case PingMessage:
                    _nativeHost.Send(new PongMessage());
                    break;

                case LocaleMessage localeMsg:
                    _trayIcon?.SetStrings(localeMsg.Tray);
                    break;

                case TestCursorMessage cursorMsg:
                    _hasTestCursor = true;
                    _testCursor = cursorMsg.Cursor;
                    break;

                case TestWheelMessage wheelMsg:
                    if (wheelMsg.AltOnly)
                        HandleVolumeWheel(wheelMsg.X, wheelMsg.Y, wheelMsg.Delta);
                    else
                        HandleMouseWheel(wheelMsg.X, wheelMsg.Y, wheelMsg.Delta, wheelMsg.Hold);
                    break;

                case TestHoldMessage holdMsg:
                    _testHold = holdMsg.Hold;
                    break;

                case TestPeekMessage peekMsg:
                    _testPeek = peekMsg.Peek;
                    RefreshTrackedPeekStyles(SyncSessionAndPeekState());
                    break;

                case TestHotkeyMessage hkMsg:
                    int hkId = hkMsg.Action switch
                    {
                        "clickThrough" => Hotkeys.ID_CLICK_THROUGH,
                        "dodge" => Hotkeys.ID_DODGE,
                        "mute" => Hotkeys.ID_MUTE,
                        "peek" => Hotkeys.ID_PEEK,
                        "playPause" => Hotkeys.ID_PLAY_PAUSE,
                        "seekBack" => Hotkeys.ID_SEEK_BACK,
                        "seekForward" => Hotkeys.ID_SEEK_FORWARD,
                        _ => 0
                    };
                    if (hkId != 0)
                        OnHotkey(hkId);
                    break;

                case TestMouseMessage mouseMsg:
                    uint mappedMsg = mouseMsg.Event switch
                    {
                        "down" => WM_LBUTTONDOWN,
                        "move" => WM_MOUSEMOVE,
                        "up" => WM_LBUTTONUP,
                        _ => 0
                    };
                    if (mappedMsg != 0)
                        HandlePointerEvent(mappedMsg, mouseMsg.X, mouseMsg.Y);
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

    private static bool HasActiveMediaSession() =>
        (_pipTracker is not null && _pipTracker.Tracked.Count > 0) || _webSessionActive;

    private static bool IsPeekDown()
    {
        if (_testPeek is bool tp)
            return tp;

        return _settings.EffectivePeek.Key switch
        {
            "Alt" => (GetAsyncKeyState(VK_MENU) & 0x8000) != 0,
            "Mouse4" => (GetAsyncKeyState(VK_XBUTTON1) & 0x8000) != 0,
            "Mouse5" => (GetAsyncKeyState(VK_XBUTTON2) & 0x8000) != 0,
            "Backquote" => (GetAsyncKeyState(VK_OEM_3) & 0x8000) != 0,
            "Ctrl" => (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0,
            "Shift" => (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0,
            "Ctrl+Alt" => (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 && (GetAsyncKeyState(VK_MENU) & 0x8000) != 0,
            _ => (GetAsyncKeyState(VK_MENU) & 0x8000) != 0
        };
    }

    private static bool IsPassThroughActive() =>
        _settings.ClickThrough || _settings.EffectivePeek.Enabled;

    private static bool IsAltOnlyDown()
    {
        bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        return alt && !ctrl && !shift;
    }

    private static bool SyncSessionAndPeekState()
    {
        bool hasSession = _settings.Enabled && HasActiveMediaSession();
        bool wantMediaHk = hasSession && _settings.EffectiveMedia.Enabled;
        if (wantMediaHk != _lastMediaHotkeysActive)
        {
            _lastMediaHotkeysActive = wantMediaHk;
            _hotkeys?.SetMediaActive(_settings.Hotkeys, wantMediaHk);
        }

        bool peekNow = hasSession && _settings.EffectivePeek.Enabled && IsPeekDown();
        if (peekNow != _lastPeekEmitted)
        {
            _lastPeekEmitted = peekNow;
            _nativeHost?.Send(new PeekStateMessage(peekNow));
        }

        return peekNow;
    }

    private static void RefreshTrackedPeekStyles(bool peekNow)
    {
        if (_pipTracker is null || _pipTracker.Tracked.Count == 0)
            return;

        bool effectiveClickThrough = IsPassThroughActive() && !_wasInteractive;
        bool allowZero = _settings.EffectivePeek.Enabled;

        for (int i = 0; i < _pipTracker.Tracked.Count; i++)
        {
            var pip = _pipTracker.Tracked[i];
            if (!pip.Initialized)
                continue;

            double effectiveOpacity = ComputeEffectiveOpacity(pip, _wasInteractive, peekNow);
            _ghostStyle.Apply(pip.Hwnd, effectiveOpacity, effectiveClickThrough, hideHeader: true, allowZeroAlpha: allowZero);
            if (string.Equals(pip.Kind, "native", StringComparison.Ordinal) &&
                pip.Subtitle is not null &&
                _ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var rc))
            {
                pip.Subtitle.Update(pip.SubtitleText, new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom), effectiveOpacity);
            }
        }
    }

    private static nint MakeLParam(int lo, int hi) =>
        (nint)(((hi & 0xFFFF) << 16) | (lo & 0xFFFF));

    private static bool IsAboveInZOrder(nint candidateTop, nint currentTop)
    {
        if (candidateTop == IntPtr.Zero || currentTop == IntPtr.Zero || candidateTop == currentTop)
            return false;

        nint cur = GetWindow(candidateTop, GW_HWNDNEXT);
        int guard = 0;
        while (cur != IntPtr.Zero && guard++ < 256)
        {
            if (cur == currentTop)
                return true;
            cur = GetWindow(cur, GW_HWNDNEXT);
        }
        return false;
    }

    private static bool TryFindHitPip(
        int x,
        int y,
        int expandPx,
        bool hostedKindsOnly,
        out TrackedPip? hitPip,
        out PipTracker.RECT hitRc)
    {
        hitPip = null;
        hitRc = default;
        if (_pipTracker is null || _pipTracker.Tracked.Count == 0)
            return false;

        var tracked = _pipTracker.Tracked;
        for (int i = 0; i < tracked.Count; i++)
        {
            var pip = tracked[i];
            if (hostedKindsOnly && pip.Kind is not ("document" or "popup"))
                continue;
            if (!_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var rc))
                continue;
            if (x < rc.Left - expandPx || x > rc.Right + expandPx || y < rc.Top - expandPx || y > rc.Bottom + expandPx)
                continue;

            if (hitPip is null || IsAboveInZOrder(_ghostStyle.GetLogicalTopHwnd(pip.Hwnd), _ghostStyle.GetLogicalTopHwnd(hitPip.Hwnd)))
            {
                hitPip = pip;
                hitRc = rc;
            }
        }

        return hitPip is not null;
    }

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
        out TrackedPip? targetPip,
        out PipTracker.RECT rc,
        out int clipT,
        out nint translatedLParam)
    {
        targetPip = null;
        rc = default;
        clipT = 0;
        translatedLParam = IntPtr.Zero;

        if (!_settings.Enabled)
            return false;

        if (IsPassThroughActive() && !IsHoldDown())
            return false;

        if (!TryFindHitPip(x, y, expandPx: 6, hostedKindsOnly: true, out targetPip, out rc) || targetPip is null)
            return false;

        clipT = _ghostStyle.GetHeaderShift(targetPip.Hwnd);
        int relX = x - rc.Left;
        int relY = y - rc.Top;
        translatedLParam = MakeLParam(relX, relY + clipT);
        return true;
    }

    private static void EmitPipBounds(TrackedPip pip, DodgeRect rc)
    {
        if (rc.W <= 0 || rc.H <= 0)
            return;
        _nativeHost?.Send(new PipBoundsMessage(pip.TabId, pip.Kind, rc.L, rc.T, rc.W, rc.H));
    }

    private static void FinalizePipDrag(TrackedPip dragged, bool lButton)
    {
        if (!_ghostStyle.TryGetLogicalWindowRect(dragged.Hwnd, out var dragRc))
            return;

        var winRect = new DodgeRect(dragRc.Left, dragRc.Top, dragRc.Right, dragRc.Bottom);
        var winSize = new DodgeSize(winRect.W, winRect.H);
        var area = GetWorkArea(dragged.Hwnd);

        dragged.WaitCursorLeave = true;
        string nearest = DodgeSolver.NearestCorner(winRect, area);
        var targetRect = DodgeSolver.CornerRect(nearest, winSize, area, _settings.Dodge.EdgeInsetPx);
        double dist = Math.Sqrt(
            (double)(winRect.L - targetRect.L) * (winRect.L - targetRect.L) +
            (double)(winRect.T - targetRect.T) * (winRect.T - targetRect.T));

        if (!dragged.JustResized && dist <= CORNER_SNAP_PX)
        {
            dragged.CustomPos = false;
            _ghostStyle.MoveLogicalWindow(dragged.Hwnd, targetRect.L, targetRect.T);
            winRect = targetRect;
        }
        else
        {
            dragged.CustomPos = true;
        }
        dragged.JustResized = false;

        dragged.HomeCorner = nearest;
        dragged.DodgeState = DodgeSolver.InitialState(nearest);
        dragged.LastKnownRect = winRect;
        dragged.MouseDownRect = winRect;
        dragged.WasMouseDown = lButton;

        if (Array.IndexOf(_settings.Dodge.Allowed, nearest) >= 0 &&
            !string.Equals(nearest, _settings.Dodge.Home, StringComparison.Ordinal))
        {
            _settings = _settings with
            {
                Dodge = _settings.Dodge with { Home = nearest }
            };
            _pipTracker?.SetDefaultCorner(nearest);
            _nativeHost?.Send(new IntentMessage("SET_HOME", nearest));
        }

        EmitPipBounds(dragged, winRect);
    }

    private static bool HandlePointerEvent(uint msg, int x, int y)
    {
        if (msg == WM_LBUTTONDOWN)
            _hookLButtonDown = true;
        else if (msg == WM_LBUTTONUP)
            _hookLButtonDown = false;

        if (msg == WM_LBUTTONUP)
        {
            if (_swallowNextLButtonUp)
            {
                _swallowNextLButtonUp = false;
                return true;
            }
            if (_pipMouseDown)
            {
                if (_pipResizeDir is not null)
                {
                    var resizedPip = _resizePip;
                    bool didResize = _pipDragActive;
                    _pipResizeDir = null;
                    _resizePip = null;
                    _pipMouseDown = false;
                    _pipDragActive = false;
                    if (_dragPip == resizedPip)
                    {
                        _dragPip = null;
                        _dragPipMoved = false;
                    }
                    if (resizedPip is not null)
                    {
                        resizedPip.CustomPos = true;
                        resizedPip.JustResized = true;
                        resizedPip.WaitCursorLeave = true;
                        resizedPip.DodgeState = resizedPip.DodgeState with { HoverSince = null, Faded = false };
                        if (didResize && _ghostStyle.TryGetLogicalWindowRect(resizedPip.Hwnd, out var rRc))
                        {
                            var newRect = new DodgeRect(rRc.Left, rRc.Top, rRc.Right, rRc.Bottom);
                            resizedPip.LastKnownRect = newRect;
                            resizedPip.MouseDownRect = newRect;
                            resizedPip.WasMouseDown = false;
                            EmitPipBounds(resizedPip, newRect);
                        }
                    }
                    return true;
                }

                bool wasHold = _pipDownHold;
                bool wasDrag = _pipDragActive;
                nint downHwnd = _pipDownHwnd;
                int downClipT = _pipDownClipT;
                var downPip = _pipDownPip;
                _pipMouseDown = false;
                _pipDragActive = false;
                _pipDownPip = null;
                if (wasHold && wasDrag && downPip is not null)
                {
                    if (_dragPip == downPip)
                    {
                        _dragPip = null;
                        _dragPipMoved = false;
                    }
                    FinalizePipDrag(downPip, lButton: false);
                }
                else if (downHwnd != IntPtr.Zero && GhostStyle.IsWindow(downHwnd) && _ghostStyle.TryGetLogicalWindowRect(downHwnd, out var upRc))
                {
                    int relX = x - upRc.Left;
                    int relY = y - upRc.Top;
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
                return true;
            }
        }
        else if (msg == WM_MOUSEMOVE)
        {
            if (_pipMouseDown)
            {
                if (_pipResizeDir is string resizeDir && _resizePip is not null)
                {
                    if (!_pipDragActive && (Math.Abs(x - _pipDownPt.X) >= 2 || Math.Abs(y - _pipDownPt.Y) >= 2))
                        _pipDragActive = true;
                    if (_pipDragActive && _pipDownHwnd != IntPtr.Zero && GhostStyle.IsWindow(_pipDownHwnd))
                    {
                        int dx = x - _pipDownPt.X;
                        int dy = y - _pipDownPt.Y;
                        int startW = _pipDownRect.Right - _pipDownRect.Left;
                        int startH = _pipDownRect.Bottom - _pipDownRect.Top;
                        int minW = 200;
                        int minH = 130 + _pipDownClipT;
                        int nextW = resizeDir.Contains('e') ? Math.Max(minW, startW + dx) : resizeDir.Contains('w') ? Math.Max(minW, startW - dx) : startW;
                        int nextH = resizeDir.Contains('s') ? Math.Max(minH, startH + dy) : resizeDir.Contains('n') ? Math.Max(minH, startH - dy) : startH;
                        int nextL = resizeDir.Contains('w') ? _pipDownRect.Right - nextW : _pipDownRect.Left;
                        int nextT = resizeDir.Contains('n') ? _pipDownRect.Bottom - nextH : _pipDownRect.Top;
                        _resizePip.CustomPos = true;
                        _resizePip.JustResized = true;
                        _resizePip.WaitCursorLeave = true;
                        _ghostStyle.MoveAndResizeLogicalWindow(_pipDownHwnd, nextL, nextT, nextW, nextH);
                    }
                }
                else if (_pipDownHold)
                {
                    if (!_pipDragActive && (Math.Abs(x - _pipDownPt.X) >= 5 || Math.Abs(y - _pipDownPt.Y) >= 5))
                        _pipDragActive = true;
                    if (_pipDragActive && _pipDownHwnd != IntPtr.Zero && GhostStyle.IsWindow(_pipDownHwnd))
                    {
                        int nextL = _pipDownWinL + (x - _pipDownPt.X);
                        int nextT = _pipDownWinT + (y - _pipDownPt.Y);
                        if (_pipDownPip is not null)
                        {
                            _dragPip = _pipDownPip;
                            _dragPipMoved = true;
                        }
                        _ghostStyle.MoveLogicalWindow(_pipDownHwnd, nextL, nextT);
                    }
                }
                else if (_pipDownClipT > 0 && _pipDownHwnd != IntPtr.Zero && _ghostStyle.TryGetLogicalWindowRect(_pipDownHwnd, out var moveRc))
                {
                    int relX = x - moveRc.Left;
                    int relY = y - moveRc.Top;
                    _hoverTargetHwnd = _pipDownHwnd;
                    PostMessageW(_hwnd, WM_APP_PIP_MOUSEMOVE, MK_LBUTTON, MakeLParam(relX, relY + _pipDownClipT));
                }
            }
            else if (TryGetInteractiveDocPipTarget(x, y, out var hoverPip, out _, out int clipT, out nint translated) && clipT > 0 && hoverPip is not null)
            {
                _hoverTargetHwnd = hoverPip.Hwnd;
                PostMessageW(_hwnd, WM_APP_PIP_MOUSEMOVE, IntPtr.Zero, translated);
            }
        }
        else if (msg == WM_LBUTTONDOWN)
        {
            bool holdDown = IsHoldDown();
            if ((!IsPassThroughActive() || holdDown) &&
                TryFindHitPip(x, y, expandPx: 6, hostedKindsOnly: false, out var anyHitPip, out var anyHitRc) &&
                anyHitPip is not null)
            {
                _dragPip = anyHitPip;
                _dragPipMoved = false;
                anyHitPip.MouseDownRect = new DodgeRect(anyHitRc.Left, anyHitRc.Top, anyHitRc.Right, anyHitRc.Bottom);
            }

            if (TryGetInteractiveDocPipTarget(x, y, out var docPip, out var rc, out int clipT, out nint translated) && docPip is not null)
            {
                nint pipHwnd = docPip.Hwnd;
                string? resizeDir = GetResizeBorderDir(x, y, rc, clipT);
                if (resizeDir is not null)
                {
                    _pipMouseDown = true;
                    _pipDragActive = false;
                    _pipResizeDir = resizeDir;
                    _resizePip = docPip;
                    _pipDownPip = docPip;
                    _pipDownPt = new POINT { X = x, Y = y };
                    _pipDownRect = rc;
                    _pipDownWinL = rc.Left;
                    _pipDownWinT = rc.Top;
                    _pipDownHold = holdDown;
                    _pipDownHwnd = pipHwnd;
                    _pipDownClipT = clipT;
                    return true;
                }
                if (holdDown || clipT > 0)
                {
                    _pipMouseDown = true;
                    _pipDragActive = false;
                    _pipResizeDir = null;
                    _resizePip = null;
                    _pipDownPip = docPip;
                    _pipDownPt = new POINT { X = x, Y = y };
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
                    return true;
                }
            }
        }
        else if (msg == WM_RBUTTONDOWN)
        {
            if (TryGetInteractiveDocPipTarget(x, y, out var docPip, out _, out int clipT, out nint translated) && clipT > 0 && docPip is not null)
            {
                SetForegroundWindow(docPip.Hwnd);
                PostMessageW(docPip.Hwnd, WM_MOUSEMOVE, IntPtr.Zero, translated);
                PostMessageW(docPip.Hwnd, WM_RBUTTONDOWN, MK_RBUTTON, translated);
                _swallowNextRButtonUp = true;
                return true;
            }
        }
        else if (msg == WM_RBUTTONUP && _swallowNextRButtonUp)
        {
            _swallowNextRButtonUp = false;
            if (TryGetInteractiveDocPipTarget(x, y, out var docPip, out _, out int clipT, out nint translated) && clipT > 0 && docPip is not null)
                PostMessageW(docPip.Hwnd, WM_RBUTTONUP, IntPtr.Zero, translated);
            return true;
        }

        return false;
    }

    private static nint OnLowLevelMouse(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && lParam != IntPtr.Zero)
        {
            uint msg = (uint)wParam;
            var info = *(MSLLHOOKSTRUCT*)lParam;
            if (msg == WM_MOUSEWHEEL)
            {
                int delta = (short)(info.mouseData >> 16);
                if (delta != 0)
                {
                    bool holdDown = IsHoldDown();
                    bool altOnly = IsAltOnlyDown();
                    if (altOnly && !holdDown && HandleVolumeWheel(info.pt.X, info.pt.Y, delta))
                        return (nint)1;
                    if (HandleMouseWheel(info.pt.X, info.pt.Y, delta, holdDown))
                    {
                        if (holdDown)
                            return (nint)1;
                    }
                    else if (altOnly && HandleVolumeWheel(info.pt.X, info.pt.Y, delta))
                    {
                        return (nint)1;
                    }
                }
            }
            else if (HandlePointerEvent(msg, info.pt.X, info.pt.Y))
            {
                return (nint)1;
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private static double ComputeEffectiveOpacity(TrackedPip pip, bool isInteractive, bool isPeeking)
    {
        if (isInteractive && !pip.WheelPreview)
            return 1.0;

        if (_settings.EffectivePeek.Enabled)
        {
            return isPeeking
                ? (pip.DodgeState.Faded ? Math.Min(0.1, _settings.EffectivePeek.ActiveOpacity) : _settings.EffectivePeek.ActiveOpacity)
                : _settings.EffectivePeek.IdleOpacity;
        }

        return pip.DodgeState.Faded ? 0.1 : _settings.Opacity;
    }

    private static bool HandleVolumeWheel(int x, int y, int delta)
    {
        if (delta == 0 ||
            !_settings.Enabled ||
            !_settings.EffectiveMedia.Enabled ||
            !_settings.EffectiveMedia.WheelVolume ||
            !HasActiveMediaSession())
        {
            return false;
        }

        double step = delta > 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP;
        int? targetTabId = null;
        if (TryFindHitPip(x, y, expandPx: 0, hostedKindsOnly: false, out var hitPip, out _) &&
            hitPip is not null &&
            hitPip.TabId >= 0)
        {
            targetTabId = hitPip.TabId;
        }

        _nativeHost?.Send(new IntentMessage("MEDIA_VOLUME", Delta: step, TabId: targetTabId));
        return true;
    }

    private static bool HandleMouseWheel(int x, int y, int delta, bool holdDown)
    {
        if (delta == 0 || !_settings.Enabled || _pipTracker is null)
            return false;

        if (!TryFindHitPip(x, y, expandPx: 0, hostedKindsOnly: false, out var hitPip, out _) || hitPip is null)
            return false;

        bool canAdjust = holdDown || (!IsPassThroughActive() && string.Equals(hitPip.Kind, "native", StringComparison.Ordinal));
        if (!canAdjust)
            return false;

        double step = delta > 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP;
        double next = Math.Round(Math.Clamp(_settings.Opacity + step, 0.1, 1.0), 2, MidpointRounding.AwayFromZero);
        _settings = _settings with { Opacity = next };

        bool effectiveClickThrough = IsPassThroughActive() && !holdDown;
        bool allowZero = _settings.EffectivePeek.Enabled;
        var tracked = _pipTracker.Tracked;
        for (int i = 0; i < tracked.Count; i++)
        {
            var pip = tracked[i];
            pip.WaitCursorLeave = true;
            pip.WheelPreview = true;
            pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
            _ghostStyle.Apply(pip.Hwnd, next, effectiveClickThrough, hideHeader: true, allowZeroAlpha: allowZero);
            if (string.Equals(pip.Kind, "native", StringComparison.Ordinal) && pip.Subtitle is not null &&
                _ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var subRc))
            {
                pip.Subtitle.Update(pip.SubtitleText, new DodgeRect(subRc.Left, subRc.Top, subRc.Right, subRc.Bottom), next);
            }
        }

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

    public static string ChooseUnoccupiedCorner(DodgeConfig cfg, IReadOnlyList<string> occupiedCorners)
    {
        static bool IsOccupied(IReadOnlyList<string> occupied, string corner)
        {
            for (int i = 0; i < occupied.Count; i++)
            {
                if (string.Equals(occupied[i], corner, StringComparison.Ordinal))
                    return true;
            }
            return false;
        }

        if (!IsOccupied(occupiedCorners, cfg.Home))
            return cfg.Home;

        for (int i = 0; i < cfg.Allowed.Length; i++)
        {
            string c = cfg.Allowed[i];
            if (!IsOccupied(occupiedCorners, c))
                return c;
        }

        for (int i = 0; i < DodgeSolver.CORNERS.Length; i++)
        {
            string c = DodgeSolver.CORNERS[i];
            if (!IsOccupied(occupiedCorners, c))
                return c;
        }

        return cfg.Home;
    }

    private static string PickUnoccupiedCorner(TrackedPip current, DodgeRect area)
    {
        if (_pipTracker is null)
            return _settings.Dodge.Home;

        var occupied = new List<string>(4);
        var tracked = _pipTracker.Tracked;
        for (int i = 0; i < tracked.Count; i++)
        {
            var other = tracked[i];
            if (other == current || !other.Initialized)
                continue;

            if (!other.CustomPos)
            {
                occupied.Add(other.DodgeState.Corner);
            }
            else if (other.LastKnownRect.W > 0 && other.LastKnownRect.H > 0)
            {
                var cr = DodgeSolver.CornerRect(
                    other.DodgeState.Corner,
                    new DodgeSize(other.LastKnownRect.W, other.LastKnownRect.H),
                    area,
                    _settings.Dodge.EdgeInsetPx);
                if (Math.Abs(other.LastKnownRect.L - cr.L) < 80 && Math.Abs(other.LastKnownRect.T - cr.T) < 80)
                    occupied.Add(other.DodgeState.Corner);
            }
        }

        return ChooseUnoccupiedCorner(_settings.Dodge, occupied);
    }

    private static void HandlePipResize(int deltaH, double dpr, int tabId)
    {
        if (_pipTracker is null || _pipTracker.Tracked.Count == 0)
            return;

        TrackedPip? target = tabId >= 0 ? _pipTracker.FindByTabId(tabId) : null;
        if (target is null)
        {
            for (int i = 0; i < _pipTracker.Tracked.Count; i++)
            {
                if (_pipTracker.Tracked[i].Kind is "document" or "popup")
                {
                    target = _pipTracker.Tracked[i];
                    break;
                }
            }
            target ??= _pipTracker.Tracked[0];
        }

        if (!_ghostStyle.TryGetLogicalWindowRect(target.Hwnd, out var rc))
            return;

        target.SuppressBoundsSaveUntilMs = _clock.ElapsedMilliseconds + 800;

        int curW = rc.Right - rc.Left;
        int curH = rc.Bottom - rc.Top;
        int physDelta = (int)Math.Round(deltaH * dpr, MidpointRounding.AwayFromZero);
        if (Math.Abs(physDelta) > 4)
        {
            int nextH = Math.Max(150, curH + physDelta);
            _ghostStyle.ResizeLogicalWindow(target.Hwnd, curW, nextH);
        }

        if (!target.CustomPos)
            SnapWindowToCorner(target.Hwnd, target.DodgeState.Corner);

        if (_ghostStyle.TryGetLogicalWindowRect(target.Hwnd, out var updatedRc))
        {
            var rect = new DodgeRect(updatedRc.Left, updatedRc.Top, updatedRc.Right, updatedRc.Bottom);
            target.LastKnownRect = rect;
            target.MouseDownRect = rect;
        }
    }

    private static void HandlePipSubtitle(int tabId, string text)
    {
        if (_pipTracker is null)
            return;

        TrackedPip? target = tabId >= 0 ? _pipTracker.FindByTabId(tabId) : null;
        if (target is null)
        {
            for (int i = 0; i < _pipTracker.Tracked.Count; i++)
            {
                var p = _pipTracker.Tracked[i];
                if (p.TabId < 0 && string.Equals(p.Kind, "native", StringComparison.Ordinal))
                {
                    target = p;
                    break;
                }
            }
            if (target is null && tabId < 0)
            {
                for (int i = 0; i < _pipTracker.Tracked.Count; i++)
                {
                    if (string.Equals(_pipTracker.Tracked[i].Kind, "native", StringComparison.Ordinal))
                    {
                        target = _pipTracker.Tracked[i];
                        break;
                    }
                }
            }
        }

        if (target is null)
        {
            if (tabId >= 0)
                _pipTracker.SetPendingSubtitle(tabId, text);
            return;
        }

        target.SubtitleText = text;
        if (string.Equals(target.Kind, "native", StringComparison.Ordinal))
        {
            if (!string.IsNullOrWhiteSpace(text) && target.Subtitle is null)
                target.Subtitle = new SubtitleOverlay();

            if (target.Subtitle is not null && _ghostStyle.TryGetLogicalWindowRect(target.Hwnd, out var rc))
            {
                var pipRect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
                bool isPeeking = _settings.EffectivePeek.Enabled && HasActiveMediaSession() && IsPeekDown();
                target.Subtitle.Update(target.SubtitleText, pipRect, ComputeEffectiveOpacity(target, _wasInteractive, isPeeking));
            }
        }
        else
        {
            target.Subtitle?.Hide();
        }
    }

    private static void ClearTrackedFade()
    {
        if (_pipTracker is null)
            return;
        for (int i = 0; i < _pipTracker.Tracked.Count; i++)
        {
            var pip = _pipTracker.Tracked[i];
            if (pip.DodgeState.Faded || pip.DodgeState.HoverSince.HasValue)
                pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
        }
    }

    private static void ApplyStateMessage(Settings next)
    {
        bool enabledChanged = _settings.Enabled != next.Enabled;
        bool hotkeysChanged = _settings.Hotkeys != next.Hotkeys;
        bool homeChanged = !string.Equals(_settings.Dodge.Home, next.Dodge.Home, StringComparison.Ordinal);
        bool styleChanged = !string.Equals(_settings.Dodge.Style, next.Dodge.Style, StringComparison.Ordinal);
        _settings = next;
        _pipTracker?.SetDefaultCorner(_settings.Dodge.Home);

        if (!_settings.Enabled)
        {
            Cleanup();
            PostQuitMessage(0);
            return;
        }

        if ((hotkeysChanged || enabledChanged) && _hotkeys is not null)
        {
            bool wantMediaHk = _settings.Enabled && _settings.EffectiveMedia.Enabled && HasActiveMediaSession();
            string[] hotkeyErrors = _hotkeys.Apply(_settings.Hotkeys, registerMedia: wantMediaHk);
            _lastMediaHotkeysActive = wantMediaHk;
            _nativeHost?.Send(new HelloMessage(Protocol.EngineVersion, hotkeyErrors));
        }

        bool peekNow = SyncSessionAndPeekState();

        if (!IsPassThroughActive() || !_settings.Dodge.Enabled || styleChanged)
            ClearTrackedFade();

        if (homeChanged && _pipTracker is not null && _pipTracker.Tracked.Count > 0)
        {
            long nowMs = _clock.ElapsedMilliseconds;
            var occupied = new List<string>(4);
            for (int i = 0; i < _pipTracker.Tracked.Count; i++)
            {
                var pip = _pipTracker.Tracked[i];
                string corner = i == 0 ? _settings.Dodge.Home : ChooseUnoccupiedCorner(_settings.Dodge, occupied);
                occupied.Add(corner);
                pip.CustomPos = false;
                pip.HomeCorner = corner;
                pip.DodgeState = DodgeSolver.InitialState(corner);
                pip.SuppressBoundsSaveUntilMs = nowMs + 800;
                SnapWindowToCorner(pip.Hwnd, corner);
                if (_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var rc))
                {
                    var rect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
                    pip.LastKnownRect = rect;
                    pip.MouseDownRect = rect;
                }
            }
        }

        RefreshTrackedPeekStyles(peekNow);
    }

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
    }

    private static void InitializeTrackedPip(TrackedPip pip, int activeCount, long nowMs, bool lButtonDown, bool peekNow)
    {
        pip.Initialized = true;
        pip.HoverInitialized = false;
        pip.WaitCursorLeave = false;
        pip.WheelPreview = false;
        pip.JustResized = false;
        pip.SuppressBoundsSaveUntilMs = nowMs + 800;

        double initOpacity = ComputeEffectiveOpacity(pip, isInteractive: false, isPeeking: peekNow);
        bool initClickThrough = IsPassThroughActive();
        _ghostStyle.Apply(pip.Hwnd, initOpacity, initClickThrough, hideHeader: true, allowZeroAlpha: _settings.EffectivePeek.Enabled);

        if (!_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var initRc))
            return;

        var area = GetWorkArea(pip.Hwnd);

        if (activeCount == 1 && pip.PendingSavedBounds is PipRect sb)
        {
            pip.PendingSavedBounds = null;
            int curW = Math.Max(1, initRc.Right - initRc.Left);
            int curH = Math.Max(1, initRc.Bottom - initRc.Top);
            int rawX = (int)Math.Round(sb.X, MidpointRounding.AwayFromZero);
            int rawY = (int)Math.Round(sb.Y, MidpointRounding.AwayFromZero);
            int rawW = (int)Math.Round(sb.W, MidpointRounding.AwayFromZero);
            int rawH = (int)Math.Round(sb.H, MidpointRounding.AwayFromZero);

            if (rawW > 0 && rawH > 0)
            {
                int w = Math.Clamp(rawW, 180, Math.Max(180, area.W));
                int h = Math.Clamp(rawH, 120, Math.Max(120, area.H));
                int x = Math.Clamp(rawX, area.L, Math.Max(area.L, area.R - w));
                int y = Math.Clamp(rawY, area.T, Math.Max(area.T, area.B - h));
                _ghostStyle.MoveAndResizeLogicalWindow(pip.Hwnd, x, y, w, h);
            }
            else
            {
                int x = Math.Clamp(rawX, area.L, Math.Max(area.L, area.R - curW));
                int y = Math.Clamp(rawY, area.T, Math.Max(area.T, area.B - curH));
                _ghostStyle.MoveLogicalWindow(pip.Hwnd, x, y);
            }

            if (_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var placedRc))
            {
                var rect = new DodgeRect(placedRc.Left, placedRc.Top, placedRc.Right, placedRc.Bottom);
                var size = new DodgeSize(rect.W, rect.H);
                string nearest = DodgeSolver.NearestCorner(rect, area);
                var cornerRect = DodgeSolver.CornerRect(nearest, size, area, _settings.Dodge.EdgeInsetPx);
                if (Math.Abs(rect.L - cornerRect.L) <= CORNER_SNAP_PX &&
                    Math.Abs(rect.T - cornerRect.T) <= CORNER_SNAP_PX)
                {
                    _ghostStyle.MoveLogicalWindow(pip.Hwnd, cornerRect.L, cornerRect.T);
                    rect = cornerRect;
                    pip.CustomPos = false;
                }
                else
                {
                    pip.CustomPos = true;
                }

                pip.HomeCorner = nearest;
                pip.DodgeState = DodgeSolver.InitialState(nearest);

                DodgePoint? cursor = GetVisibleCursor();
                int m = _settings.Dodge.MarginPx;
                if (cursor is DodgePoint cp &&
                    cp.X >= rect.L - m && cp.X < rect.R + m &&
                    cp.Y >= rect.T - m && cp.Y < rect.B + m)
                {
                    pip.WaitCursorLeave = true;
                }

                pip.LastKnownRect = rect;
                pip.MouseDownRect = rect;
            }
        }
        else
        {
            pip.PendingSavedBounds = null;
            string chosenCorner = activeCount == 1
                ? _settings.Dodge.Home
                : PickUnoccupiedCorner(pip, area);

            pip.CustomPos = false;
            pip.HomeCorner = chosenCorner;
            pip.DodgeState = DodgeSolver.InitialState(chosenCorner);
            SnapWindowToCorner(pip.Hwnd, chosenCorner);

            if (_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var snappedRc))
            {
                var rect = new DodgeRect(snappedRc.Left, snappedRc.Top, snappedRc.Right, snappedRc.Bottom);
                pip.LastKnownRect = rect;
                pip.MouseDownRect = rect;
            }
        }

        pip.WasMouseDown = lButtonDown;
    }

    private static void OnTick()
    {
        if (!_settings.Enabled || _pipTracker is null)
            return;

        long nowMs = _clock.ElapsedMilliseconds;
        _pipTracker.Tick(nowMs);

        bool peekNow = SyncSessionAndPeekState();

        var tracked = _pipTracker.Tracked;
        if (tracked.Count == 0)
        {
            _wasInteractive = false;
            _dragPip = null;
            _dragPipMoved = false;
            _resizePip = null;
            _holdMachine.Reset();
            return;
        }

        bool holdDown = IsHoldDown();
        bool lButton = _hookLButtonDown || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

        int activeCount = tracked.Count;
        for (int i = 0; i < activeCount; i++)
        {
            if (!tracked[i].Initialized)
                InitializeTrackedPip(tracked[i], activeCount, nowMs, lButton, peekNow);
        }

        var holdRes = _holdMachine.Step(holdDown, lButton);
        if (_wasInteractive && !holdRes.IsInteractive)
        {
            for (int i = 0; i < activeCount; i++)
            {
                var p = tracked[i];
                p.WaitCursorLeave = true;
                p.WheelPreview = false;
                p.DodgeState = p.DodgeState with { HoverSince = null, Faded = false };
            }
        }
        if (holdRes.State == HoldState.Dragging)
        {
            for (int i = 0; i < activeCount; i++)
                tracked[i].WheelPreview = false;

            if (_dragPip is not null && _ghostStyle.TryGetLogicalWindowRect(_dragPip.Hwnd, out var dRc))
            {
                var curDragRect = new DodgeRect(dRc.Left, dRc.Top, dRc.Right, dRc.Bottom);
                if (curDragRect != _dragPip.MouseDownRect)
                    _dragPipMoved = true;
            }
            else if (_dragPip is null)
            {
                for (int i = 0; i < activeCount; i++)
                {
                    var p = tracked[i];
                    if (_ghostStyle.TryGetLogicalWindowRect(p.Hwnd, out var pRc))
                    {
                        var curRect = new DodgeRect(pRc.Left, pRc.Top, pRc.Right, pRc.Bottom);
                        if (curRect != p.LastKnownRect)
                        {
                            _dragPip = p;
                            _dragPipMoved = true;
                            break;
                        }
                    }
                }
            }
        }
        _wasInteractive = holdRes.IsInteractive;

        if (holdRes.DragEnded)
        {
            if (_dragPip is TrackedPip dragged && _dragPipMoved)
                FinalizePipDrag(dragged, lButton);
            _dragPip = null;
            _dragPipMoved = false;
        }

        DodgePoint? cursor = GetVisibleCursor();

        bool isPeekHidden = _settings.EffectivePeek.Enabled && !peekNow;
        bool skipDodgeForPeek = isPeekHidden && _settings.EffectivePeek.IdleOpacity <= 0.05;
        bool allowZeroAlpha = _settings.EffectivePeek.Enabled;

        for (int i = 0; i < activeCount; i++)
        {
            var pip = tracked[i];
            if (!_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var rc))
                continue;

            var winRect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
            var winSize = new DodgeSize(winRect.W, winRect.H);
            var area = GetWorkArea(pip.Hwnd);

            if (!pip.WasMouseDown && lButton)
            {
                pip.MouseDownRect = winRect;
            }
            else if (pip.WasMouseDown && !lButton)
            {
                if (!holdRes.IsInteractive &&
                    !holdRes.DragEnded &&
                    !IsPassThroughActive() &&
                    !pip.DodgeState.Faded &&
                    nowMs > pip.SuppressBoundsSaveUntilMs &&
                    winRect != pip.MouseDownRect)
                {
                    string nearest = DodgeSolver.NearestCorner(winRect, area);
                    var targetRect = DodgeSolver.CornerRect(nearest, winSize, area, _settings.Dodge.EdgeInsetPx);
                    double dist = Math.Sqrt(
                        (double)(winRect.L - targetRect.L) * (winRect.L - targetRect.L) +
                        (double)(winRect.T - targetRect.T) * (winRect.T - targetRect.T));
                    pip.CustomPos = dist > CORNER_SNAP_PX;
                    pip.HomeCorner = nearest;
                    pip.DodgeState = DodgeSolver.InitialState(nearest);
                    pip.MouseDownRect = winRect;
                    EmitPipBounds(pip, winRect);
                }
            }
            pip.WasMouseDown = lButton;

            if (!holdRes.IsInteractive && !holdRes.DragEnded && IsPassThroughActive() && !skipDodgeForPeek)
            {
                int m = _settings.Dodge.MarginPx;
                bool cursorInCurrent = cursor is DodgePoint p &&
                    p.X >= winRect.L - m && p.X < winRect.R + m &&
                    p.Y >= winRect.T - m && p.Y < winRect.B + m;

                if (pip.WaitCursorLeave)
                {
                    if (cursorInCurrent)
                    {
                        pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
                    }
                    else
                    {
                        pip.WaitCursorLeave = false;
                    }
                }

                if (!pip.WaitCursorLeave)
                {
                    var dodgeCfg = _settings.Dodge;
                    if (pip.CustomPos && dodgeCfg.AutoReturn)
                    {
                        dodgeCfg = dodgeCfg with { AutoReturn = false };
                    }
                    else if (activeCount > 1 &&
                             !string.Equals(pip.HomeCorner, dodgeCfg.Home, StringComparison.Ordinal) &&
                             Array.IndexOf(dodgeCfg.Allowed, pip.HomeCorner) >= 0)
                    {
                        dodgeCfg = dodgeCfg with { Home = pip.HomeCorner };
                    }

                    var stepRes = DodgeSolver.Step(
                        pip.DodgeState,
                        new DodgeInput(nowMs, cursor, winSize, area, winRect),
                        dodgeCfg);
                    pip.DodgeState = stepRes.State;

                    if (stepRes.Action.Type == "move" && stepRes.Action.Corner is string targetCorner)
                    {
                        pip.CustomPos = false;
                        var targetRect = DodgeSolver.CornerRect(targetCorner, winSize, area, _settings.Dodge.EdgeInsetPx);
                        winRect = targetRect;
                        _ghostStyle.MoveLogicalWindow(pip.Hwnd, targetRect.L, targetRect.T);
                    }
                }
            }
            else if (pip.DodgeState.Faded || pip.DodgeState.HoverSince.HasValue)
            {
                pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
            }

            pip.LastKnownRect = winRect;

            bool cursorInWindow = cursor is DodgePoint wp &&
                wp.X >= winRect.L && wp.X <= winRect.R &&
                wp.Y >= winRect.T && wp.Y <= winRect.B;

            bool effectiveClickThrough = IsPassThroughActive() && !holdRes.IsInteractive;
            bool pipHovered = holdRes.IsInteractive || (!effectiveClickThrough && cursorInWindow);
            if (!pip.HoverInitialized || pipHovered != pip.LastHovered)
            {
                pip.HoverInitialized = true;
                pip.LastHovered = pipHovered;
                _nativeHost?.Send(new PipHoverMessage(pip.TabId, pipHovered));
            }

            double effectiveOpacity = ComputeEffectiveOpacity(pip, holdRes.IsInteractive, peekNow);

            _ghostStyle.Apply(pip.Hwnd, effectiveOpacity, effectiveClickThrough, hideHeader: true, allowZeroAlpha: allowZeroAlpha);

            if (string.Equals(pip.Kind, "native", StringComparison.Ordinal))
            {
                if (!string.IsNullOrWhiteSpace(pip.SubtitleText) && pip.Subtitle is null)
                    pip.Subtitle = new SubtitleOverlay();
                pip.Subtitle?.Update(pip.SubtitleText, winRect, effectiveOpacity);
            }
            else
            {
                pip.Subtitle?.Hide();
            }
        }
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
        if (fg != IntPtr.Zero && fg != hwnd && !_ghostStyle.IsManagedWindow(fg) && PipTracker.GetWindowRect(fg, out var fgRc))
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
