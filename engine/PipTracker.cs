using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed class TrackedPip : IDisposable
{
    public int TabId { get; }
    public nint Hwnd { get; }
    public string Kind { get; }
    public DodgeState DodgeState { get; set; }
    public string HomeCorner { get; set; }
    public bool Initialized { get; set; }
    public bool CustomPos { get; set; }
    public bool WaitCursorLeave { get; set; }
    public bool WheelPreview { get; set; }
    public bool LastHovered { get; set; }
    public bool HoverInitialized { get; set; }
    public bool JustResized { get; set; }
    public bool WasMouseDown { get; set; }
    public DodgeRect MouseDownRect { get; set; }
    public DodgeRect LastKnownRect { get; set; }
    public long SuppressBoundsSaveUntilMs { get; set; }
    public PipRect? PendingSavedBounds { get; set; }
    public string SubtitleText { get; set; } = string.Empty;
    public SubtitleOverlay? Subtitle { get; set; }

    public TrackedPip(int tabId, nint hwnd, string kind, string initialCorner, PipRect? savedBounds = null)
    {
        TabId = tabId;
        Hwnd = hwnd;
        Kind = kind;
        HomeCorner = initialCorner;
        DodgeState = DodgeSolver.InitialState(initialCorner);
        PendingSavedBounds = savedBounds;
    }

    public void Dispose()
    {
        Subtitle?.Dispose();
        Subtitle = null;
    }
}

public sealed record PendingOpen(int TabId, string Kind, PipRect Rect, double Dpr, PipRect? SavedBounds, long StartedAtMs);

public readonly record struct WindowCandidate(nint Hwnd, DodgeRect Rect, bool Topmost);

/// <summary>
/// Binds browser PiP windows to extension tabs. A window is bound only while the extension has an
/// open request (PIP_OPENED) pending for it; nothing is ever adopted unsolicited.
/// </summary>
public sealed unsafe class PipTracker : IDisposable
{
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint WM_GETTEXTLENGTH = 0x000E;
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const nint WS_EX_TOOLWINDOW = 0x00000080;
    private const long OpenRetryTimeoutMs = 3000;
    private const long MinEnumIntervalMs = 100;
    private const int MinCandidateW = 140;
    private const int MinCandidateH = 110;

    private static readonly string[] BrowserExes =
    [
        "chrome.exe",
        "msedge.exe",
        "whale.exe",
        "brave.exe"
    ];

    private static readonly string? TestWindowClass = NullIfEmpty(Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS"));
    private static readonly bool AllowAnyTopmost = Environment.GetEnvironmentVariable("GHOSTPIP_ALLOW_ANY_TOPMOST") == "1";

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(nint hWnd, nint lParam);
    private delegate void WinEventDelegate(
        nint hWinEventHook,
        uint eventType,
        nint hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(nint hWnd, out RECT lpRect);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(nint hWnd, char* lpClassName, int nMaxCount);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern nint SendMessageTimeoutW(nint hWnd, uint msg, nint wParam, nint lParam, uint flags, uint timeoutMs, out nint result);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(nint hProcess, uint dwFlags, char* lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint hObject);

    [DllImport("user32.dll")]
    private static extern nint SetWinEventHook(
        uint eventMin,
        uint eventMax,
        nint hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc,
        uint idProcess,
        uint idThread,
        uint dwFlags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(nint hWinEventHook);

    private readonly nint _ownHwnd;
    private readonly GhostStyle _ghostStyle;
    private readonly Action<OutgoingMessage> _send;
    private readonly Action<TrackedPip>? _onUnbound;
    private readonly Func<long> _nowMs;
    private readonly WinEventDelegate _winEventDelegate;
    private readonly EnumWindowsProc _enumDelegate;
    private readonly List<WindowCandidate> _enumBuffer = new(16);
    private readonly Dictionary<int, PendingOpen> _pendingByTab = new();
    private readonly Dictionary<int, string> _pendingSubtitles = new();
    private readonly List<TrackedPip> _tracked = new(4);
    private nint _showHook;
    private bool _enumIncludeNonTopmost;
    private long _lastEnumMs = -MinEnumIntervalMs;
    private string _defaultCorner = Settings.Defaults.Dodge.Home;

    public IReadOnlyList<TrackedPip> Tracked => _tracked;

    public PipTracker(
        nint ownHwnd,
        GhostStyle ghostStyle,
        Action<OutgoingMessage> send,
        Func<long> nowMs,
        Action<TrackedPip>? onUnbound = null)
    {
        _ownHwnd = ownHwnd;
        _ghostStyle = ghostStyle;
        _send = send;
        _nowMs = nowMs;
        _onUnbound = onUnbound;
        _winEventDelegate = OnWinEvent;
        _enumDelegate = OnEnumWindow;
    }

    public void SetDefaultCorner(string corner)
    {
        if (!string.IsNullOrEmpty(corner))
            _defaultCorner = corner;
    }

    public TrackedPip? FindByTabId(int tabId)
    {
        for (int i = 0; i < _tracked.Count; i++)
        {
            if (_tracked[i].TabId == tabId)
                return _tracked[i];
        }
        return null;
    }

    public TrackedPip? FindByHwnd(nint hwnd)
    {
        if (hwnd == IntPtr.Zero)
            return null;
        for (int i = 0; i < _tracked.Count; i++)
        {
            if (_tracked[i].Hwnd == hwnd)
                return _tracked[i];
        }
        return null;
    }

    public void SetPendingSubtitle(int tabId, string text)
    {
        if (tabId < 0)
            return;
        if (string.IsNullOrWhiteSpace(text))
            _pendingSubtitles.Remove(tabId);
        else
            _pendingSubtitles[tabId] = text;
    }

    public void OnPipOpened(PipOpenedMessage msg, long nowMs)
    {
        var existing = FindByTabId(msg.TabId);
        if (existing is not null)
        {
            if (GhostStyle.IsWindow(existing.Hwnd) && IsWindowVisible(existing.Hwnd))
            {
                var probe = new PendingOpen(msg.TabId, msg.Kind, msg.Rect, msg.Dpr, msg.SavedBounds, nowMs);
                var matches = MatchPending([probe], CollectCandidates(includeNonTopmost: msg.Kind == "popup"));
                if (matches.Count == 1 && matches[0].Hwnd != existing.Hwnd)
                {
                    Unbind(existing, sendLost: false);
                    _pendingByTab.Remove(msg.TabId);
                    BindNew(probe, matches[0].Hwnd);
                    SyncShowHook();
                    return;
                }

                if (string.Equals(existing.Kind, msg.Kind, StringComparison.Ordinal))
                {
                    _pendingByTab.Remove(msg.TabId);
                    if (msg.SavedBounds is not null)
                    {
                        existing.PendingSavedBounds = msg.SavedBounds;
                        existing.Initialized = false;
                    }
                    _send(new PipBoundMessage(msg.TabId));
                    SyncShowHook();
                    return;
                }
            }

            Unbind(existing, sendLost: false);
        }

        _pendingByTab[msg.TabId] = new PendingOpen(msg.TabId, msg.Kind, msg.Rect, msg.Dpr, msg.SavedBounds, nowMs);
        TryResolvePending(nowMs);
        SyncShowHook();
    }

    public void OnPipClosed(int tabId)
    {
        _pendingByTab.Remove(tabId);
        _pendingSubtitles.Remove(tabId);
        SyncShowHook();

        var exact = FindByTabId(tabId);
        if (exact is not null)
            Unbind(exact, sendLost: false);
    }

    public void ClearAll()
    {
        _pendingByTab.Clear();
        _pendingSubtitles.Clear();
        SyncShowHook();
        for (int i = _tracked.Count - 1; i >= 0; i--)
            Unbind(_tracked[i], sendLost: false);
    }

    public void Tick(long nowMs)
    {
        for (int i = _tracked.Count - 1; i >= 0; i--)
        {
            var pip = _tracked[i];
            if (!GhostStyle.IsWindow(pip.Hwnd) || !IsWindowVisible(pip.Hwnd))
                Unbind(pip, sendLost: true);
        }

        if (_pendingByTab.Count == 0)
            return;

        TryResolvePending(nowMs);

        int[] keys = [.. _pendingByTab.Keys];
        foreach (int key in keys)
        {
            if (_pendingByTab.TryGetValue(key, out var p) && nowMs - p.StartedAtMs >= OpenRetryTimeoutMs)
            {
                _pendingByTab.Remove(key);
                _pendingSubtitles.Remove(key);
                _send(new PipLostMessage(p.TabId, "not_found"));
            }
        }
        SyncShowHook();
    }

    private void OnWinEvent(
        nint hWinEventHook,
        uint eventType,
        nint hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime)
    {
        if (idObject != 0 || hwnd == IntPtr.Zero || _pendingByTab.Count == 0)
            return;
        TryResolvePending(_nowMs());
        SyncShowHook();
    }

    // EVENT_OBJECT_SHOW only matters while a request is pending, so the system-wide hook exists only then.
    private void SyncShowHook()
    {
        bool want = _pendingByTab.Count > 0;
        if (want && _showHook == IntPtr.Zero)
        {
            _showHook = SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                IntPtr.Zero,
                _winEventDelegate,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        }
        else if (!want && _showHook != IntPtr.Zero)
        {
            UnhookWinEvent(_showHook);
            _showHook = IntPtr.Zero;
        }
    }

    private void TryResolvePending(long nowMs)
    {
        if (_pendingByTab.Count == 0 || nowMs - _lastEnumMs < MinEnumIntervalMs)
            return;
        _lastEnumMs = nowMs;

        bool anyPopup = false;
        foreach (var p in _pendingByTab.Values)
            anyPopup |= p.Kind == "popup";

        var candidates = CollectCandidates(includeNonTopmost: anyPopup);
        if (candidates.Count == 0)
            return;

        var pending = new List<PendingOpen>(_pendingByTab.Values);
        pending.Sort((a, b) => a.StartedAtMs.CompareTo(b.StartedAtMs));
        foreach (var (tabId, hwnd) in MatchPending(pending, candidates))
        {
            if (_pendingByTab.Remove(tabId, out var p))
                BindNew(p, hwnd);
        }
    }

    /// <summary>
    /// Pairs pending open requests with candidate windows by rect. Non-popup requests consider only
    /// topmost windows. A candidate binds at most once, and no request means no binding.
    /// </summary>
    public static List<(int TabId, nint Hwnd)> MatchPending(IReadOnlyList<PendingOpen> pending, IReadOnlyList<WindowCandidate> candidates)
    {
        var result = new List<(int TabId, nint Hwnd)>();
        if (pending.Count == 0 || candidates.Count == 0)
            return result;

        var taken = new HashSet<nint>();
        var pool = new List<(nint Hwnd, DodgeRect Rect)>(candidates.Count);
        foreach (var p in pending)
        {
            bool isPopup = string.Equals(p.Kind, "popup", StringComparison.Ordinal);
            pool.Clear();
            foreach (var c in candidates)
            {
                if (!taken.Contains(c.Hwnd) && (isPopup || c.Topmost))
                    pool.Add((c.Hwnd, c.Rect));
            }

            nint matched = FindBestMatch(pool, p.Kind, p.Rect, p.Dpr);
            if (matched == IntPtr.Zero)
                continue;
            taken.Add(matched);
            result.Add((p.TabId, matched));
        }
        return result;
    }

    private void BindNew(PendingOpen p, nint hwnd)
    {
        var pip = new TrackedPip(p.TabId, hwnd, p.Kind, _defaultCorner, p.SavedBounds);
        ApplyPendingSubtitleIfAny(pip);
        _tracked.Add(pip);
        _send(new PipBoundMessage(p.TabId));
    }

    private void ApplyPendingSubtitleIfAny(TrackedPip pip)
    {
        if (_pendingSubtitles.Remove(pip.TabId, out string? sub))
            pip.SubtitleText = sub;
    }

    private void Unbind(TrackedPip pip, bool sendLost)
    {
        _tracked.Remove(pip);
        pip.Dispose();
        _onUnbound?.Invoke(pip);
        _ghostStyle.Restore(pip.Hwnd);
        if (sendLost)
            _send(new PipLostMessage(pip.TabId, "closed"));
    }

    public static nint FindBestMatch(List<(nint Hwnd, DodgeRect Rect)> candidates, string kind, PipRect target, double dpr)
    {
        bool isPopup = string.Equals(kind, "popup", StringComparison.Ordinal);
        (double X, double Y, double W, double H)[] variants =
        [
            (target.X, target.Y, target.W, target.H),
            (target.X * dpr, target.Y * dpr, target.W * dpr, target.H * dpr)
        ];

        nint bestExact = IntPtr.Zero;
        double bestExactScore = double.MaxValue;
        foreach (var (hwnd, rc) in candidates)
        {
            foreach (var v in variants)
            {
                double dx = Math.Abs(rc.L - v.X);
                double dy = Math.Abs(rc.T - v.Y);
                double dw = Math.Abs(rc.W - v.W);
                double dh = Math.Abs(rc.H - v.H);
                if (dx <= 12 && dy <= 12 && dw <= 12 && dh <= 12)
                {
                    double score = dx + dy + dw + dh;
                    if (score < bestExactScore)
                    {
                        bestExactScore = score;
                        bestExact = hwnd;
                    }
                }
            }
        }
        if (bestExact != IntPtr.Zero)
            return bestExact;

        nint bestNear = IntPtr.Zero;
        double bestNearScore = double.MaxValue;
        foreach (var (hwnd, rc) in candidates)
        {
            foreach (var v in variants)
            {
                double dx = Math.Abs(rc.L - v.X);
                double dy = Math.Abs(rc.T - v.Y);
                double dw = Math.Abs(rc.W - v.W);
                double dh = Math.Abs(rc.H - v.H);
                if (dx <= 32 && dy <= 32 && dw <= 48 && dh <= 48)
                {
                    double score = dx + dy + dw + dh;
                    if (score < bestNearScore)
                    {
                        bestNearScore = score;
                        bestNear = hwnd;
                    }
                }
            }
        }
        if (bestNear != IntPtr.Zero)
            return bestNear;

        double sizeTol = isPopup ? 48.0 : 32.0;
        nint bestSize = IntPtr.Zero;
        double bestSizeScore = double.MaxValue;
        foreach (var (hwnd, rc) in candidates)
        {
            foreach (var v in variants)
            {
                double dx = Math.Abs(rc.L - v.X);
                double dy = Math.Abs(rc.T - v.Y);
                double dw = Math.Abs(rc.W - v.W);
                double dh = Math.Abs(rc.H - v.H);
                if (dw <= sizeTol && dh <= sizeTol)
                {
                    double score = dw + dh + 0.05 * (dx + dy);
                    if (score < bestSizeScore)
                    {
                        bestSizeScore = score;
                        bestSize = hwnd;
                    }
                }
            }
        }
        return bestSize;
    }

    private List<WindowCandidate> CollectCandidates(bool includeNonTopmost)
    {
        _enumIncludeNonTopmost = includeNonTopmost;
        _enumBuffer.Clear();
        EnumWindows(_enumDelegate, IntPtr.Zero);
        return _enumBuffer;
    }

    private bool OnEnumWindow(nint hWnd, nint lParam)
    {
        if (IsCandidateWindow(hWnd, out var candidate))
            _enumBuffer.Add(candidate);
        return true;
    }

    private bool IsCandidateWindow(nint hwnd, out WindowCandidate candidate)
    {
        candidate = default;
        if (hwnd == IntPtr.Zero || hwnd == _ownHwnd)
            return false;
        if (FindByHwnd(hwnd) is not null || _ghostStyle.IsManagedWindow(hwnd))
            return false;
        if (!IsWindowVisible(hwnd))
            return false;

        nint exStyle = GhostStyle.GetWindowLongPtrW(hwnd, GhostStyle.GWL_EXSTYLE);
        bool isTopmost = (exStyle & GhostStyle.WS_EX_TOPMOST) != 0;
        if (!_enumIncludeNonTopmost && !isTopmost)
            return false;

        if (!GetWindowRect(hwnd, out var rc))
            return false;

        if (rc.Right - rc.Left < MinCandidateW || rc.Bottom - rc.Top < MinCandidateH)
            return false;

        string className = GetWindowClassName(hwnd);
        if (string.Equals(className, GhostStyle.HostClassName, StringComparison.Ordinal) ||
            string.Equals(className, SubtitleOverlay.OverlayClassName, StringComparison.Ordinal))
        {
            return false;
        }

        bool isTestClass = TestWindowClass is not null && string.Equals(className, TestWindowClass, StringComparison.Ordinal);
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == (uint)Environment.ProcessId && !isTestClass)
            return false;

        candidate = new WindowCandidate(hwnd, new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom), isTopmost);

        if (isTestClass || (isTopmost && AllowAnyTopmost))
            return true;

        if (!string.Equals(className, "Chrome_WidgetWin_1", StringComparison.Ordinal))
            return false;

        if ((exStyle & WS_EX_TOOLWINDOW) != 0)
            return false;

        if (!HasWindowText(hwnd))
            return false;

        string? exeName = GetProcessExeName(pid);
        if (string.IsNullOrEmpty(exeName))
            return false;

        foreach (string allowedExe in BrowserExes)
        {
            if (string.Equals(exeName, allowedExe, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

    // WM_GETTEXTLENGTH goes to another process; a hung browser window must not stall the UI thread.
    private static bool HasWindowText(nint hwnd) =>
        SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, out nint len) != IntPtr.Zero &&
        len > 0;

    private static string GetWindowClassName(nint hwnd)
    {
        char* buf = stackalloc char[256];
        int len = GetClassNameW(hwnd, buf, 256);
        return len > 0 ? new string(buf, 0, len) : string.Empty;
    }

    private static string? GetProcessExeName(uint pid)
    {
        if (pid == 0)
            return null;

        nint hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hProc == IntPtr.Zero)
            return null;

        try
        {
            char* buf = stackalloc char[1024];
            uint size = 1024;
            if (!QueryFullProcessImageNameW(hProc, 0, buf, ref size) || size == 0)
                return null;

            string fullPath = new(buf, 0, (int)size);
            return Path.GetFileName(fullPath);
        }
        finally
        {
            CloseHandle(hProc);
        }
    }

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    public void Dispose()
    {
        ClearAll();
        if (_showHook != IntPtr.Zero)
        {
            UnhookWinEvent(_showHook);
            _showHook = IntPtr.Zero;
        }
    }
}
