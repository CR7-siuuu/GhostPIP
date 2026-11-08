using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed class TrackedPip : IDisposable
{
    public int TabId { get; set; }
    public nint Hwnd { get; }
    public string Kind { get; set; }
    public DodgeState DodgeState { get; set; }
    public string HomeCorner { get; set; }
    public long DetectedAtMs { get; }
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

    public TrackedPip(
        int tabId,
        nint hwnd,
        string kind,
        string initialCorner,
        long detectedAtMs,
        PipRect? savedBounds = null)
    {
        TabId = tabId;
        Hwnd = hwnd;
        Kind = kind;
        HomeCorner = initialCorner;
        DodgeState = DodgeSolver.InitialState(initialCorner);
        DetectedAtMs = detectedAtMs;
        PendingSavedBounds = savedBounds;
    }

    public void Dispose()
    {
        Subtitle?.Dispose();
        Subtitle = null;
    }
}

public sealed unsafe class PipTracker : IDisposable
{
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint EVENT_OBJECT_DESTROY = 0x8001;
    private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const nint WS_EX_TOOLWINDOW = 0x00000080;
    private const long OpenRetryTimeoutMs = 3000;
    private const long AutoDetectIntervalMs = 500;

    private static readonly string[] BrowserExes =
    [
        "chrome.exe",
        "msedge.exe",
        "whale.exe",
        "brave.exe"
    ];

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

    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(nint hWnd);

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

    private sealed record PendingOpen(
        int TabId,
        string Kind,
        PipRect Rect,
        double Dpr,
        PipRect? SavedBounds,
        long StartedAtMs);

    private readonly nint _ownHwnd;
    private readonly GhostStyle _ghostStyle;
    private readonly Action<OutgoingMessage> _send;
    private readonly Action<TrackedPip>? _onUnbound;
    private readonly WinEventDelegate _winEventDelegate;
    private readonly EnumWindowsProc _enumDelegate;
    private readonly List<(nint Hwnd, DodgeRect Rect)> _enumBuffer = new(16);
    private readonly Dictionary<int, PendingOpen> _pendingByTab = new();
    private readonly Dictionary<int, string> _pendingSubtitles = new();
    private readonly List<TrackedPip> _tracked = new(4);
    private nint _hook;
    private bool _enumIncludeNonTopmost;
    private int _enumMinW = 150;
    private int _enumMinH = 150;
    private int _nextAutoTabId = -1;
    private long _lastAutoDetectMs = -AutoDetectIntervalMs;
    private string _defaultCorner = Settings.Defaults.Dodge.Home;

    public IReadOnlyList<TrackedPip> Tracked => _tracked;

    public PipTracker(
        nint ownHwnd,
        GhostStyle ghostStyle,
        Action<OutgoingMessage> send,
        Action<TrackedPip>? onUnbound = null)
    {
        _ownHwnd = ownHwnd;
        _ghostStyle = ghostStyle;
        _send = send;
        _onUnbound = onUnbound;
        _winEventDelegate = OnWinEvent;
        _enumDelegate = OnEnumWindow;
        _hook = SetWinEventHook(
            EVENT_OBJECT_DESTROY,
            EVENT_OBJECT_LOCATIONCHANGE,
            IntPtr.Zero,
            _winEventDelegate,
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
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
                bool isPopup = string.Equals(msg.Kind, "popup", StringComparison.Ordinal);
                var candidates = CollectCandidates(includeNonTopmost: isPopup, minW: 140, minH: 110);
                nint replacement = FindBestMatch(candidates, msg.Kind, msg.Rect, msg.Dpr);
                if (replacement != IntPtr.Zero && replacement != existing.Hwnd)
                {
                    Unbind(existing, sendLost: false);
                    BindNew(msg.TabId, replacement, msg.Kind, msg.SavedBounds, nowMs);
                    _pendingByTab.Remove(msg.TabId);
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
                    return;
                }
            }

            Unbind(existing, sendLost: false);
        }

        _pendingByTab[msg.TabId] = new PendingOpen(msg.TabId, msg.Kind, msg.Rect, msg.Dpr, msg.SavedBounds, nowMs);
        if (TryResolveSinglePending(msg.TabId, nowMs))
            return;

        if (!string.Equals(msg.Kind, "popup", StringComparison.Ordinal))
        {
            TrackedPip? promotable = FindPromotableAutoPip(msg, nowMs);
            if (promotable is not null)
            {
                _pendingByTab.Remove(msg.TabId);
                promotable.TabId = msg.TabId;
                promotable.Kind = msg.Kind;
                promotable.HoverInitialized = false;
                if (msg.SavedBounds is not null)
                {
                    promotable.PendingSavedBounds = msg.SavedBounds;
                    promotable.Initialized = false;
                }
                if (!string.Equals(msg.Kind, "native", StringComparison.Ordinal))
                    promotable.Subtitle?.Hide();
                ApplyPendingSubtitleIfAny(promotable);
                _send(new PipBoundMessage(msg.TabId));
            }
        }
    }

    private TrackedPip? FindPromotableAutoPip(PipOpenedMessage msg, long nowMs)
    {
        string? testClass = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS");
        for (int i = 0; i < _tracked.Count; i++)
        {
            var pip = _tracked[i];
            if (pip.TabId >= 0)
                continue;
            if (!GhostStyle.IsWindow(pip.Hwnd) || !IsWindowVisible(pip.Hwnd))
                continue;

            bool kindCompat = !string.IsNullOrEmpty(testClass) ||
                              string.Equals(pip.Kind, msg.Kind, StringComparison.Ordinal);
            if (!kindCompat)
                continue;

            if (_tracked.Count == 1 || nowMs - pip.DetectedAtMs <= OpenRetryTimeoutMs)
                return pip;
        }
        return null;
    }

    public void OnPipClosed(int tabId)
    {
        _pendingByTab.Remove(tabId);
        _pendingSubtitles.Remove(tabId);

        var exact = FindByTabId(tabId);
        if (exact is not null)
        {
            Unbind(exact, sendLost: false);
            return;
        }

        if (_tracked.Count == 1 && _tracked[0].TabId < 0)
            Unbind(_tracked[0], sendLost: false);
    }

    public void ClearAll()
    {
        _pendingByTab.Clear();
        _pendingSubtitles.Clear();
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

        if (_pendingByTab.Count > 0)
        {
            TryResolveAllPending(nowMs);

            if (_pendingByTab.Count > 0)
            {
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
            }
        }

        if (_pendingByTab.Count == 0 && nowMs - _lastAutoDetectMs >= AutoDetectIntervalMs)
        {
            _lastAutoDetectMs = nowMs;
            TryAutoDetect(nowMs);
        }
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
        if (idObject != 0 || hwnd == IntPtr.Zero)
            return;

        if (eventType == EVENT_OBJECT_DESTROY)
        {
            var pip = FindByHwnd(hwnd);
            if (pip is not null)
            {
                Unbind(pip, sendLost: true);
                return;
            }
        }

        if (_pendingByTab.Count > 0 && (eventType == EVENT_OBJECT_SHOW || eventType == EVENT_OBJECT_LOCATIONCHANGE))
            TryResolveAllPending(Environment.TickCount64);
    }

    private void TryResolveAllPending(long nowMs)
    {
        if (_pendingByTab.Count == 0)
            return;

        int[] tabIds = [.. _pendingByTab.Keys];
        foreach (int tabId in tabIds)
            TryResolveSinglePending(tabId, nowMs);
    }

    private bool TryResolveSinglePending(int tabId, long nowMs)
    {
        if (!_pendingByTab.TryGetValue(tabId, out var p))
            return false;

        bool isPopup = string.Equals(p.Kind, "popup", StringComparison.Ordinal);
        var candidates = CollectCandidates(includeNonTopmost: isPopup, minW: 140, minH: 110);
        if (candidates.Count == 0)
            return false;

        nint matched = FindBestMatch(candidates, p.Kind, p.Rect, p.Dpr);
        if (matched == IntPtr.Zero)
            return false;

        _pendingByTab.Remove(tabId);
        BindNew(p.TabId, matched, p.Kind, p.SavedBounds, nowMs);
        return true;
    }

    private void BindNew(int tabId, nint hwnd, string kind, PipRect? savedBounds, long nowMs)
    {
        var pip = new TrackedPip(tabId, hwnd, kind, _defaultCorner, nowMs, savedBounds);
        ApplyPendingSubtitleIfAny(pip);
        _tracked.Add(pip);
        if (tabId >= 0)
            _send(new PipBoundMessage(tabId));
    }

    private void ApplyPendingSubtitleIfAny(TrackedPip pip)
    {
        if (pip.TabId >= 0 && _pendingSubtitles.TryGetValue(pip.TabId, out string? sub))
        {
            _pendingSubtitles.Remove(pip.TabId);
            pip.SubtitleText = sub;
        }
        else if (pip.TabId < 0 && string.Equals(pip.Kind, "native", StringComparison.Ordinal) && _pendingSubtitles.Count == 1)
        {
            foreach (var kv in _pendingSubtitles)
            {
                pip.SubtitleText = kv.Value;
                break;
            }
        }
    }

    private void Unbind(TrackedPip pip, bool sendLost)
    {
        _tracked.Remove(pip);
        pip.Dispose();
        _onUnbound?.Invoke(pip);
        _ghostStyle.Restore(pip.Hwnd);
        if (sendLost && pip.TabId >= 0)
            _send(new PipLostMessage(pip.TabId, "closed"));
    }

    private int AllocateAutoTabId()
    {
        while (FindByTabId(_nextAutoTabId) is not null)
            _nextAutoTabId--;
        return _nextAutoTabId--;
    }

    private void TryAutoDetect(long nowMs)
    {
        string? testClass = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS");
        var candidates = CollectCandidates(includeNonTopmost: false, minW: 150, minH: 150);
        foreach (var (hwnd, rc) in candidates)
        {
            if (string.IsNullOrEmpty(testClass) && (rc.W > 1200 || rc.H > 1100))
                continue;

            string kind = !string.IsNullOrEmpty(testClass)
                ? "native"
                : _ghostStyle.TryGetContentRelRect(hwnd, out _)
                    ? "document"
                    : "native";

            int autoTabId = AllocateAutoTabId();
            BindNew(autoTabId, hwnd, kind, savedBounds: null, nowMs);
            return;
        }
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
        if (bestSize != IntPtr.Zero)
            return bestSize;

        if (!isPopup)
        {
            foreach (var (hwnd, rc) in candidates)
            {
                if (rc.W <= 1200 && rc.H <= 1100)
                    return hwnd;
            }
        }

        return IntPtr.Zero;
    }

    private List<(nint Hwnd, DodgeRect Rect)> CollectCandidates(bool includeNonTopmost, int minW, int minH)
    {
        _enumIncludeNonTopmost = includeNonTopmost;
        _enumMinW = minW;
        _enumMinH = minH;
        _enumBuffer.Clear();
        EnumWindows(_enumDelegate, IntPtr.Zero);
        return _enumBuffer;
    }

    private bool OnEnumWindow(nint hWnd, nint lParam)
    {
        if (IsCandidateWindow(hWnd, out var rect))
            _enumBuffer.Add((hWnd, rect));
        return true;
    }

    private bool IsCandidateWindow(nint hwnd, out DodgeRect rect)
    {
        rect = default;
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

        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w < _enumMinW || h < _enumMinH)
            return false;

        string className = GetWindowClassName(hwnd);
        if (string.Equals(className, GhostStyle.HostClassName, StringComparison.Ordinal) ||
            string.Equals(className, SubtitleOverlay.OverlayClassName, StringComparison.Ordinal))
        {
            return false;
        }

        string? testClass = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS");
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == (uint)Environment.ProcessId)
        {
            if (string.IsNullOrEmpty(testClass) || !string.Equals(className, testClass, StringComparison.Ordinal))
                return false;
        }

        rect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);

        if (!string.IsNullOrEmpty(testClass) && string.Equals(className, testClass, StringComparison.Ordinal))
            return true;

        if (isTopmost && Environment.GetEnvironmentVariable("GHOSTPIP_ALLOW_ANY_TOPMOST") == "1")
            return true;

         if (!string.Equals(className, "Chrome_WidgetWin_1", StringComparison.Ordinal))
            return false;

        if ((exStyle & WS_EX_TOOLWINDOW) != 0)
            return false;

        if (GetWindowTextLengthW(hwnd) <= 0)
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

    public void Dispose()
    {
        ClearAll();
        if (_hook != IntPtr.Zero)
        {
            UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
    }
}
