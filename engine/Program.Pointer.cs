using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe partial class Program
{
    private const int WH_MOUSE_LL = 14;
    private const nint MK_LBUTTON = 0x0001;
    private const double WHEEL_OPACITY_STEP = 0.05;
    private const double WHEEL_VOLUME_STEP = 0.05;
    private const int Z_ORDER_SCAN_STEPS = 256;

    private delegate nint LowLevelMouseProc(int nCode, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public nuint dwExtraInfo;
    }

    private enum HookEventKind
    {
        DownObserved,
        Moved,
        Ended,
        Wheel
    }

    /// <summary>Work the hook decided on and deferred to the UI thread.</summary>
    private readonly record struct HookEvent(
        HookEventKind Kind,
        int X,
        int Y,
        int Delta = 0,
        bool Hold = false,
        WheelAction Wheel = WheelAction.None,
        HitTarget Target = default,
        PointerEnd End = default);

    /// <summary>The PiP being moved while the hold modifier is down (by Chrome or by the engine).</summary>
    private readonly record struct HoldDrag(TrackedPip Pip, bool Moved);

    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static extern nint SetWindowsHookExW(int idHook, LowLevelMouseProc lpfn, nint hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(nint hhk);

    [DllImport("user32.dll")]
    private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    private static LowLevelMouseProc? _mouseHookDelegate;
    private static nint _mouseHook;

    // The low-level hook runs on this (UI) thread, so these need no locking; the hook only reads the
    // snapshot, steps the pointer session and queues events.
    private static readonly PointerSession _pointer = new();
    private static HookSnapshot _hookSnapshot = HookSnapshot.Empty;
    private static readonly Queue<HookEvent> _hookEvents = new();
    private static bool _hookPosted;
    private static PointerAction _pendingAction;
    private static bool _actionQueued;
    private static bool _lButtonDown;
    private static HoldDrag? _holdDrag;

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

    private static bool IsAltOnlyDown()
    {
        bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        return alt && !ctrl && !shift;
    }

    private static nint MakeLParam(int lo, int hi) =>
        (nint)(((hi & 0xFFFF) << 16) | (lo & 0xFFFF));

    /// <summary>Rebuilds what the mouse hook may read: PiP rects in z-order and the gating flags.</summary>
    private static void RefreshHookSnapshot()
    {
        if (_pipTracker is null || !_settings.Enabled)
        {
            _hookSnapshot = HookSnapshot.Empty;
            return;
        }

        var tracked = _pipTracker.Tracked;
        var targets = new HitTarget[tracked.Count];
        int n = 0;
        for (int i = 0; i < tracked.Count; i++)
        {
            var pip = tracked[i];
            if (!TryGetLogicalRect(pip.Hwnd, out var rect))
                continue;
            targets[n++] = new HitTarget(
                pip.Hwnd,
                rect,
                Hosted: pip.Kind is "document" or "popup",
                Native: string.Equals(pip.Kind, "native", StringComparison.Ordinal),
                pip.TabId,
                Dpi.ForMonitor(MonitorFromWindow(pip.Hwnd, MONITOR_DEFAULTTONEAREST)));
        }
        Array.Resize(ref targets, n);

        for (int i = 1; i < n; i++)
        {
            for (int j = i; j > 0 && IsAboveTarget(targets[j], targets[j - 1]); j--)
                (targets[j], targets[j - 1]) = (targets[j - 1], targets[j]);
        }

        bool volumeWheel = _settings.EffectiveMedia.Enabled && _settings.EffectiveMedia.WheelVolume && HasActiveMediaSession();
        _hookSnapshot = new HookSnapshot(targets, Enabled: true, IsPassThroughActive(), volumeWheel);
    }

    private static bool IsAboveTarget(HitTarget a, HitTarget b) =>
        GhostStyle.IsAbove(_ghostStyle.GetLogicalTopHwnd(a.Hwnd), _ghostStyle.GetLogicalTopHwnd(b.Hwnd), Z_ORDER_SCAN_STEPS);

    private static nint OnLowLevelMouse(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && lParam != IntPtr.Zero)
        {
            try
            {
                var info = (MSLLHOOKSTRUCT*)lParam;
                if (DecideHookEvent((uint)wParam, info->pt.X, info->pt.Y, info->mouseData))
                    return (nint)1;
            }
            catch (Exception ex)
            {
                LogError("mouse hook", ex);
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    /// <summary>
    /// Runs inside the low-level hook: decides whether to swallow from the cached snapshot and the
    /// pointer session, and queues the real work. No window queries, no SetWindowPos, no stdout.
    /// </summary>
    private static bool DecideHookEvent(uint msg, int x, int y, uint mouseData)
    {
        switch (msg)
        {
            case WM_MOUSEWHEEL:
            {
                int delta = (short)(mouseData >> 16);
                if (delta == 0)
                    return false;
                bool hold = IsHoldDown();
                var (action, swallow) = _hookSnapshot.DecideWheel(x, y, hold, IsAltOnlyDown());
                if (action != WheelAction.None)
                    QueueHookEvent(new HookEvent(HookEventKind.Wheel, x, y, delta, hold, action));
                return swallow;
            }

            case WM_LBUTTONDOWN:
            {
                _lButtonDown = true;
                bool swallow = _pointer.OnButtonDown(_hookSnapshot, x, y, IsHoldDown(), out var observed);
                if (observed is HitTarget target)
                    QueueHookEvent(new HookEvent(HookEventKind.DownObserved, x, y, Target: target));
                return swallow;
            }

            case WM_MOUSEMOVE:
            {
                if (_pointer.Phase == PointerPhase.Idle)
                    return false;
                var action = _pointer.OnMove(x, y);
                if (action.Kind == PointerActionKind.None)
                    return false;
                _pendingAction = action;
                if (!_actionQueued)
                {
                    _actionQueued = true;
                    QueueHookEvent(new HookEvent(HookEventKind.Moved, x, y));
                }
                return false;
            }

            case WM_LBUTTONUP:
            {
                _lButtonDown = false;
                var end = _pointer.OnButtonUp(x, y);
                if (end.Kind == PointerEndKind.None)
                    return false;
                QueueHookEvent(new HookEvent(HookEventKind.Ended, x, y, End: end));
                return true;
            }

            default:
                return false;
        }
    }

    private static void QueueHookEvent(HookEvent e)
    {
        _hookEvents.Enqueue(e);
        if (_hookPosted)
            return;
        _hookPosted = true;
        PostMessageW(_hwnd, WM_APP_POINTER, IntPtr.Zero, IntPtr.Zero);
    }

    private static void DrainHookEvents()
    {
        _hookPosted = false;
        while (_hookEvents.TryDequeue(out var e))
        {
            switch (e.Kind)
            {
                case HookEventKind.DownObserved:
                    if (_pipTracker?.FindByHwnd(e.Target.Hwnd) is TrackedPip downPip)
                    {
                        _holdDrag = new HoldDrag(downPip, Moved: false);
                        downPip.MouseDownRect = e.Target.Rect;
                    }
                    break;

                case HookEventKind.Moved:
                    if (_actionQueued)
                    {
                        _actionQueued = false;
                        ApplyPointerAction(_pendingAction);
                    }
                    break;

                case HookEventKind.Ended:
                    FinishPointer(e.End);
                    break;

                case HookEventKind.Wheel:
                    if (e.Wheel == WheelAction.Volume)
                        HandleVolumeWheel(e.X, e.Y, e.Delta);
                    else
                        HandleOpacityWheel(e.Delta, e.Hold);
                    break;
            }
        }
        RefreshHookSnapshot();
    }

    private static void ApplyPointerAction(PointerAction action)
    {
        if (_pipTracker?.FindByHwnd(action.Hwnd) is not TrackedPip pip)
            return;

        if (action.Kind == PointerActionKind.Move)
        {
            _holdDrag = new HoldDrag(pip, Moved: true);
            _ghostStyle.MoveLogicalWindow(pip.Hwnd, action.L, action.T);
        }
        else if (action.Kind == PointerActionKind.Resize)
        {
            pip.CustomPos = true;
            pip.JustResized = true;
            pip.WaitCursorLeave = true;
            _ghostStyle.MoveAndResizeLogicalWindow(pip.Hwnd, action.L, action.T, action.W, action.H);
        }
    }

    private static void FinishPointer(PointerEnd end)
    {
        if (_pipTracker?.FindByHwnd(end.Hwnd) is not TrackedPip pip)
            return;

        switch (end.Kind)
        {
            case PointerEndKind.Resize:
                if (_holdDrag?.Pip == pip)
                    _holdDrag = null;
                pip.CustomPos = true;
                pip.JustResized = true;
                pip.WaitCursorLeave = true;
                pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
                if (end.Resized && TryGetLogicalRect(pip.Hwnd, out var resized))
                {
                    pip.LastKnownRect = resized;
                    pip.MouseDownRect = resized;
                    pip.WasMouseDown = false;
                    EmitPipBounds(pip, resized);
                }
                break;

            case PointerEndKind.Drag:
                if (_holdDrag?.Pip == pip)
                    _holdDrag = null;
                FinalizePipDrag(pip, lButton: false);
                break;

            case PointerEndKind.Click:
                if (_ghostStyle.TryGetLogicalWindowRect(pip.Hwnd, out var rc))
                {
                    nint translated = MakeLParam(end.X - rc.Left, end.Y - rc.Top);
                    nint inputTarget = _ghostStyle.GetInputTargetHwnd(pip.Hwnd);
                    SetForegroundWindow(pip.Hwnd);
                    PostMessageW(inputTarget, WM_MOUSEMOVE, IntPtr.Zero, translated);
                    PostMessageW(inputTarget, WM_LBUTTONDOWN, MK_LBUTTON, translated);
                    PostMessageW(inputTarget, WM_LBUTTONUP, IntPtr.Zero, translated);
                }
                break;
        }
    }

    private static void EmitPipBounds(TrackedPip pip, DodgeRect rc)
    {
        if (rc.W <= 0 || rc.H <= 0)
            return;
        _nativeHost?.Send(new PipBoundsMessage(pip.TabId, pip.Kind, rc.L, rc.T, rc.W, rc.H));
    }

    private static void FinalizePipDrag(TrackedPip dragged, bool lButton)
    {
        if (!TryGetLogicalRect(dragged.Hwnd, out var winRect))
            return;

        var winSize = new DodgeSize(winRect.W, winRect.H);
        var mon = GetMonitor(dragged.Hwnd);

        dragged.WaitCursorLeave = true;
        string nearest = DodgeSolver.NearestCorner(winRect, mon.Area);
        var targetRect = DodgeSolver.CornerRect(nearest, winSize, mon.Area, mon.Px(_settings.Dodge.EdgeInsetPx));
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

    private static void HandleVolumeWheel(int x, int y, int delta)
    {
        double step = delta > 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP;
        int? targetTabId = _hookSnapshot.Hit(x, y, 0, hostedOnly: false) is HitTarget hit && hit.TabId >= 0 ? hit.TabId : null;
        _nativeHost?.Send(new IntentMessage("MEDIA_VOLUME", Delta: step, TabId: targetTabId));
    }

    private static void HandleOpacityWheel(int delta, bool holdDown)
    {
        if (delta == 0 || !_settings.Enabled || _pipTracker is null)
            return;

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
            UpdateSubtitleFromWindow(pip, next);
        }

        _nativeHost?.Send(new IntentMessage("SET_OPACITY", Opacity: next));
    }

    private static void SnapWindowToCorner(nint hwnd, string corner)
    {
        if (hwnd == IntPtr.Zero || !TryGetLogicalRect(hwnd, out var rc))
            return;

        var mon = GetMonitor(hwnd);
        var targetRect = DodgeSolver.CornerRect(corner, new DodgeSize(rc.W, rc.H), mon.Area, mon.Px(_settings.Dodge.EdgeInsetPx));
        _ghostStyle.MoveLogicalWindow(hwnd, targetRect.L, targetRect.T);
    }
}
