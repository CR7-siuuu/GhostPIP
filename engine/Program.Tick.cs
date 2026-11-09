using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public static unsafe partial class Program
{
    private const int VK_LBUTTON = 0x01;
    private const int VK_XBUTTON1 = 0x05;
    private const int VK_XBUTTON2 = 0x06;
    private const int VK_OEM_3 = 0xC0;
    private const uint CURSOR_SHOWING = 0x00000001;

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

    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    private static extern nint MonitorFromRect(ref PipTracker.RECT lprc, uint dwFlags);

    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    private static extern bool GetMonitorInfoW(nint hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

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

    private static bool SyncSessionAndPeekState()
    {
        ApplyHotkeys();

        bool hasSession = _settings.Enabled && HasActiveMediaSession();
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
            UpdateSubtitleFromWindow(pip, effectiveOpacity);
        }
    }

    private static void UpdateSubtitleFromWindow(TrackedPip pip, double effectiveOpacity)
    {
        if (string.Equals(pip.Kind, "native", StringComparison.Ordinal) &&
            pip.Subtitle is not null &&
            TryGetLogicalRect(pip.Hwnd, out var rect))
        {
            pip.Subtitle.Update(pip.SubtitleText, rect, effectiveOpacity, _ghostStyle.GetLogicalTopHwnd(pip.Hwnd), GetMonitor(pip.Hwnd).Scale);
        }
    }

    private static bool TryGetLogicalRect(nint hwnd, out DodgeRect rect)
    {
        if (_ghostStyle.TryGetLogicalWindowRect(hwnd, out var rc))
        {
            rect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);
            return true;
        }
        rect = default;
        return false;
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

    private static string PickUnoccupiedCorner(TrackedPip current, MonitorContext mon)
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
                    mon.Area,
                    mon.Px(_settings.Dodge.EdgeInsetPx));
                if (Math.Abs(other.LastKnownRect.L - cr.L) < 80 && Math.Abs(other.LastKnownRect.T - cr.T) < 80)
                    occupied.Add(other.DodgeState.Corner);
            }
        }

        return ChooseUnoccupiedCorner(_settings.Dodge, occupied);
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
            _holdDrag = null;
            _holdMachine.Reset();
            RefreshHookSnapshot();
            return;
        }

        bool holdDown = IsHoldDown();
        bool lButton = _lButtonDown || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

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

            if (_holdDrag is HoldDrag hd)
            {
                if (!hd.Moved && TryGetLogicalRect(hd.Pip.Hwnd, out var dragRect) && dragRect != hd.Pip.MouseDownRect)
                    _holdDrag = hd with { Moved = true };
            }
            else
            {
                for (int i = 0; i < activeCount; i++)
                {
                    var p = tracked[i];
                    if (TryGetLogicalRect(p.Hwnd, out var curRect) && curRect != p.LastKnownRect)
                    {
                        _holdDrag = new HoldDrag(p, Moved: true);
                        break;
                    }
                }
            }
        }
        _wasInteractive = holdRes.IsInteractive;

        if (holdRes.DragEnded)
        {
            if (_holdDrag is { Moved: true } ended)
                FinalizePipDrag(ended.Pip, lButton);
            _holdDrag = null;
        }

        DodgePoint? cursor = GetVisibleCursor();

        bool isPeekHidden = _settings.EffectivePeek.Enabled && !peekNow;
        bool skipDodgeForPeek = isPeekHidden && _settings.EffectivePeek.IdleOpacity <= 0.05;
        bool allowZeroAlpha = _settings.EffectivePeek.Enabled;

        for (int i = 0; i < activeCount; i++)
        {
            var pip = tracked[i];
            if (!TryGetLogicalRect(pip.Hwnd, out var winRect))
                continue;

            var winSize = new DodgeSize(winRect.W, winRect.H);
            var mon = GetMonitor(pip.Hwnd);
            var dodgeCfg = mon.Scaled(_settings.Dodge);

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
                    string nearest = DodgeSolver.NearestCorner(winRect, mon.Area);
                    var targetRect = DodgeSolver.CornerRect(nearest, winSize, mon.Area, dodgeCfg.EdgeInsetPx);
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
                int m = dodgeCfg.MarginPx;
                bool cursorInCurrent = cursor is DodgePoint p &&
                    p.X >= winRect.L - m && p.X < winRect.R + m &&
                    p.Y >= winRect.T - m && p.Y < winRect.B + m;

                if (pip.WaitCursorLeave)
                {
                    if (cursorInCurrent)
                        pip.DodgeState = pip.DodgeState with { HoverSince = null, Faded = false };
                    else
                        pip.WaitCursorLeave = false;
                }

                if (!pip.WaitCursorLeave)
                {
                    var stepCfg = dodgeCfg;
                    if (pip.CustomPos && stepCfg.AutoReturn)
                    {
                        stepCfg = stepCfg with { AutoReturn = false };
                    }
                    else if (activeCount > 1 &&
                             !string.Equals(pip.HomeCorner, stepCfg.Home, StringComparison.Ordinal) &&
                             Array.IndexOf(stepCfg.Allowed, pip.HomeCorner) >= 0)
                    {
                        stepCfg = stepCfg with { Home = pip.HomeCorner };
                    }

                    var stepRes = DodgeSolver.Step(
                        pip.DodgeState,
                        new DodgeInput(nowMs, cursor, winSize, mon.Area, winRect),
                        stepCfg);
                    pip.DodgeState = stepRes.State;

                    if (stepRes.Action.Type == "move" && stepRes.Action.Corner is string targetCorner)
                    {
                        pip.CustomPos = false;
                        var targetRect = DodgeSolver.CornerRect(targetCorner, winSize, mon.Area, dodgeCfg.EdgeInsetPx);
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
                pip.Subtitle?.Update(pip.SubtitleText, winRect, effectiveOpacity, _ghostStyle.GetLogicalTopHwnd(pip.Hwnd), mon.Scale);
            }
            else
            {
                pip.Subtitle?.Hide();
            }
        }

        RefreshHookSnapshot();
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

    private static MonitorContext GetMonitor(nint hwnd) =>
        ContextOf(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), hwnd);

    private static MonitorContext GetMonitorForRect(PipRect r)
    {
        var placed = Dpi.ClampSavedBounds(r, new DodgeRect(int.MinValue / 2, int.MinValue / 2, int.MaxValue / 2, int.MaxValue / 2), 1.0, 1, 1);
        var rc = new PipTracker.RECT { Left = placed.L, Top = placed.T, Right = placed.R, Bottom = placed.B };
        return ContextOf(MonitorFromRect(ref rc, MONITOR_DEFAULTTONEAREST), IntPtr.Zero);
    }

    /// <summary>
    /// Work area of a monitor, or the full monitor when a non-GhostPiP fullscreen window is in front
    /// (a game owns the screen edges), plus that monitor's DPI scale.
    /// </summary>
    private static MonitorContext ContextOf(nint hMon, nint selfHwnd)
    {
        var mi = new MONITORINFO { cbSize = (uint)sizeof(MONITORINFO) };
        if (hMon == IntPtr.Zero || !GetMonitorInfoW(hMon, ref mi))
            return new MonitorContext(new DodgeRect(0, 0, 1920, 1080), 1.0);

        double scale = Dpi.ForMonitor(hMon);
        nint fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && fg != selfHwnd && !_ghostStyle.IsManagedWindow(fg) && PipTracker.GetWindowRect(fg, out var fgRc) &&
            fgRc.Left <= mi.rcMonitor.Left &&
            fgRc.Top <= mi.rcMonitor.Top &&
            fgRc.Right >= mi.rcMonitor.Right &&
            fgRc.Bottom >= mi.rcMonitor.Bottom)
        {
            return new MonitorContext(
                new DodgeRect(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom),
                scale);
        }

        return new MonitorContext(
            new DodgeRect(mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom),
            scale);
    }
}
