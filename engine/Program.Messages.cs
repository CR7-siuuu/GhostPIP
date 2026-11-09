namespace GhostPiP.Engine;

public static unsafe partial class Program
{
    private static void SendHello(string[] hotkeyErrors) =>
        _nativeHost?.Send(new HelloMessage(Protocol.EngineVersion, hotkeyErrors, Environment.IsPrivilegedProcess));

    /// <summary>Gives the user their mouse back without waiting on the extension, then tells it why.</summary>
    private static void EmergencyRelease()
    {
        _settings = _settings with
        {
            ClickThrough = false,
            Opacity = 1.0,
            Peek = _settings.EffectivePeek with { Enabled = false }
        };
        ClearTrackedFade();
        RefreshTrackedPeekStyles(SyncSessionAndPeekState());
        RefreshHookSnapshot();
        _nativeHost?.Send(new IntentMessage("EMERGENCY_RELEASE"));
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
                    SyncSessionAndPeekState();
                    break;

                case PipClosedMessage closedMsg:
                    _pipTracker?.OnPipClosed(closedMsg.TabId);
                    SyncSessionAndPeekState();
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
                    RefreshHookSnapshot();
                    if (wheelMsg.AltOnly)
                    {
                        if (_hookSnapshot.VolumeWheel)
                            HandleVolumeWheel(wheelMsg.X, wheelMsg.Y, wheelMsg.Delta);
                    }
                    else if (_hookSnapshot.CanAdjustOpacity(wheelMsg.X, wheelMsg.Y, wheelMsg.Hold))
                    {
                        HandleOpacityWheel(wheelMsg.Delta, wheelMsg.Hold);
                    }
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
                    {
                        RefreshHookSnapshot();
                        DecideHookEvent(mappedMsg, mouseMsg.X, mouseMsg.Y, mouseData: 0);
                        DrainHookEvents();
                    }
                    break;
            }
        }

        RefreshHookSnapshot();
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

        if (!TryGetLogicalRect(target.Hwnd, out var rc))
            return;

        target.SuppressBoundsSaveUntilMs = _clock.ElapsedMilliseconds + 800;

        int physDelta = (int)Math.Round(
            Math.Clamp(deltaH * dpr, -Protocol.MaxAbsDeltaH * Protocol.MaxDpr, Protocol.MaxAbsDeltaH * Protocol.MaxDpr),
            MidpointRounding.AwayFromZero);
        if (Math.Abs(physDelta) > 4)
        {
            int minH = GetMonitor(target.Hwnd).Px(150);
            int nextH = Math.Clamp(rc.H + physDelta, minH, Math.Max(minH, (int)Protocol.MaxSize));
            _ghostStyle.ResizeLogicalWindow(target.Hwnd, rc.W, nextH);
        }

        if (!target.CustomPos)
            SnapWindowToCorner(target.Hwnd, target.DodgeState.Corner);

        if (TryGetLogicalRect(target.Hwnd, out var updated))
        {
            target.LastKnownRect = updated;
            target.MouseDownRect = updated;
        }
    }

    private static void HandlePipSubtitle(int tabId, string text)
    {
        if (_pipTracker is null)
            return;

        TrackedPip? target = tabId >= 0 ? _pipTracker.FindByTabId(tabId) : FirstNativePip();
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

            bool isPeeking = _settings.EffectivePeek.Enabled && HasActiveMediaSession() && IsPeekDown();
            UpdateSubtitleFromWindow(target, ComputeEffectiveOpacity(target, _wasInteractive, isPeeking));
        }
        else
        {
            target.Subtitle?.Hide();
        }
    }

    private static TrackedPip? FirstNativePip()
    {
        if (_pipTracker is null)
            return null;
        foreach (var pip in _pipTracker.Tracked)
        {
            if (string.Equals(pip.Kind, "native", StringComparison.Ordinal))
                return pip;
        }
        return null;
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
            _hotkeys.UnregisterAll();
            SendHello(ApplyHotkeys());
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
                if (TryGetLogicalRect(pip.Hwnd, out var rect))
                {
                    pip.LastKnownRect = rect;
                    pip.MouseDownRect = rect;
                }
            }
        }

        RefreshTrackedPeekStyles(peekNow);
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

        if (!TryGetLogicalRect(pip.Hwnd, out var initRc))
            return;

        if (activeCount == 1 && pip.PendingSavedBounds is PipRect sb)
        {
            pip.PendingSavedBounds = null;
            var savedMon = GetMonitorForRect(sb);
            var placed = Dpi.ClampSavedBounds(sb, savedMon.Area, savedMon.Scale, initRc.W, initRc.H);
            if (Dpi.HasSize(sb))
                _ghostStyle.MoveAndResizeLogicalWindow(pip.Hwnd, placed.L, placed.T, placed.W, placed.H);
            else
                _ghostStyle.MoveLogicalWindow(pip.Hwnd, placed.L, placed.T);

            if (TryGetLogicalRect(pip.Hwnd, out var rect))
            {
                var mon = GetMonitor(pip.Hwnd);
                var size = new DodgeSize(rect.W, rect.H);
                string nearest = DodgeSolver.NearestCorner(rect, mon.Area);
                var cornerRect = DodgeSolver.CornerRect(nearest, size, mon.Area, mon.Px(_settings.Dodge.EdgeInsetPx));
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
                int m = mon.Px(_settings.Dodge.MarginPx);
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
                : PickUnoccupiedCorner(pip, GetMonitor(pip.Hwnd));

            pip.CustomPos = false;
            pip.HomeCorner = chosenCorner;
            pip.DodgeState = DodgeSolver.InitialState(chosenCorner);
            SnapWindowToCorner(pip.Hwnd, chosenCorner);

            if (TryGetLogicalRect(pip.Hwnd, out var snapped))
            {
                pip.LastKnownRect = snapped;
                pip.MouseDownRect = snapped;
            }
        }

        pip.WasMouseDown = lButtonDown;
    }
}
