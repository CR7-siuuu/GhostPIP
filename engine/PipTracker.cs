using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

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

    private sealed record PendingOpen(int TabId, string Kind, PipRect Rect, double Dpr, long StartedAtMs);

    private readonly nint _ownHwnd;
    private readonly GhostStyle _ghostStyle;
    private readonly Action<OutgoingMessage> _send;
    private readonly WinEventDelegate _winEventDelegate;
    private readonly EnumWindowsProc _enumDelegate;
    private readonly List<(nint Hwnd, DodgeRect Rect)> _enumBuffer = new(16);
    private nint _hook;

    private PendingOpen? _pending;
    private long _lastAutoDetectMs = -AutoDetectIntervalMs;

    public nint BoundHwnd { get; private set; }
    public int BoundTabId { get; private set; } = -1;
    public string BoundKind { get; private set; } = "document";

    public PipTracker(nint ownHwnd, GhostStyle ghostStyle, Action<OutgoingMessage> send)
    {
        _ownHwnd = ownHwnd;
        _ghostStyle = ghostStyle;
        _send = send;
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

    public void OnPipOpened(PipOpenedMessage msg, long nowMs)
    {
        if (BoundHwnd != IntPtr.Zero && BoundTabId < 0 && GhostStyle.IsWindow(BoundHwnd) && IsWindowVisible(BoundHwnd))
        {
            BoundTabId = msg.TabId;
            BoundKind = msg.Kind;
            _send(new PipBoundMessage(msg.TabId));
            return;
        }

        if (BoundHwnd != IntPtr.Zero && BoundTabId != msg.TabId)
        {
            _ghostStyle.Restore(BoundHwnd);
            BoundHwnd = IntPtr.Zero;
            BoundTabId = -1;
        }

        _pending = new PendingOpen(msg.TabId, msg.Kind, msg.Rect, msg.Dpr, nowMs);
        TryResolvePending();
    }

    public void OnPipClosed(int tabId)
    {
        if (_pending is not null && _pending.TabId == tabId)
            _pending = null;

        if (BoundHwnd != IntPtr.Zero && (BoundTabId == tabId || BoundTabId < 0))
        {
            _ghostStyle.Restore(BoundHwnd);
            BoundHwnd = IntPtr.Zero;
            BoundTabId = -1;
        }
    }

    public void ClearAll()
    {
        _pending = null;
        if (BoundHwnd != IntPtr.Zero)
        {
            _ghostStyle.Restore(BoundHwnd);
            BoundHwnd = IntPtr.Zero;
            BoundTabId = -1;
        }
    }

    public void Tick(long nowMs)
    {
        if (BoundHwnd != IntPtr.Zero)
        {
            if (!GhostStyle.IsWindow(BoundHwnd) || !IsWindowVisible(BoundHwnd))
            {
                nint oldHwnd = BoundHwnd;
                int oldTabId = BoundTabId;
                BoundHwnd = IntPtr.Zero;
                BoundTabId = -1;
                _ghostStyle.Restore(oldHwnd);
                if (oldTabId >= 0)
                    _send(new PipLostMessage(oldTabId, "closed"));
            }
        }

        if (_pending is not null)
        {
            if (TryResolvePending())
                return;

            if (nowMs - _pending.StartedAtMs >= OpenRetryTimeoutMs)
            {
                int lostTabId = _pending.TabId;
                _pending = null;
                _send(new PipLostMessage(lostTabId, "not_found"));
            }
            return;
        }

        if (BoundHwnd == IntPtr.Zero && nowMs - _lastAutoDetectMs >= AutoDetectIntervalMs)
        {
            _lastAutoDetectMs = nowMs;
            TryAutoDetect();
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

        if (eventType == EVENT_OBJECT_DESTROY && hwnd == BoundHwnd)
        {
            int oldTabId = BoundTabId;
            BoundHwnd = IntPtr.Zero;
            BoundTabId = -1;
            _ghostStyle.Restore(hwnd);
            if (oldTabId >= 0)
                _send(new PipLostMessage(oldTabId, "closed"));
            return;
        }

        if (_pending is not null && (eventType == EVENT_OBJECT_SHOW || eventType == EVENT_OBJECT_LOCATIONCHANGE))
            TryResolvePending();
    }

    private bool TryResolvePending()
    {
        if (_pending is null)
            return false;

        var candidates = CollectCandidates();
        if (candidates.Count == 0)
            return false;

        var p = _pending;
        nint matched = FindBestMatch(candidates, p.Kind, p.Rect, p.Dpr);
        if (matched == IntPtr.Zero)
            return false;

        _pending = null;
        BoundHwnd = matched;
        BoundTabId = p.TabId;
        BoundKind = p.Kind;
        _send(new PipBoundMessage(p.TabId));
        return true;
    }

    private void TryAutoDetect()
    {
        string? testClass = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS");
        var candidates = CollectCandidates();
        foreach (var (hwnd, rc) in candidates)
        {
            if (string.IsNullOrEmpty(testClass) && (rc.W > 1200 || rc.H > 1100))
                continue;

            BoundHwnd = hwnd;
            BoundTabId = -1;
            BoundKind = string.IsNullOrEmpty(testClass) ? "document" : "native";
            return;
        }
    }

    private static nint FindBestMatch(List<(nint Hwnd, DodgeRect Rect)> candidates, string kind, PipRect target, double dpr)
    {
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

        nint bestSize = IntPtr.Zero;
        double bestSizeScore = double.MaxValue;
        foreach (var (hwnd, rc) in candidates)
        {
            foreach (var v in variants)
            {
                double dw = Math.Abs(rc.W - v.W);
                double dh = Math.Abs(rc.H - v.H);
                if (dw <= 32 && dh <= 32)
                {
                    double score = dw + dh;
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

        foreach (var (hwnd, rc) in candidates)
        {
            if (rc.W <= 1200 && rc.H <= 1100)
                return hwnd;
        }

        return IntPtr.Zero;
    }

    private List<(nint Hwnd, DodgeRect Rect)> CollectCandidates()
    {
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
        if (!IsWindowVisible(hwnd))
            return false;

        nint exStyle = GhostStyle.GetWindowLongPtrW(hwnd, GhostStyle.GWL_EXSTYLE);
        if ((exStyle & GhostStyle.WS_EX_TOPMOST) == 0)
            return false;

        if (!GetWindowRect(hwnd, out var rc))
            return false;

        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w < 150 || h < 150)
            return false;

        rect = new DodgeRect(rc.Left, rc.Top, rc.Right, rc.Bottom);

        if (Environment.GetEnvironmentVariable("GHOSTPIP_ALLOW_ANY_TOPMOST") == "1")
            return true;

        string className = GetWindowClassName(hwnd);
        string? testClass = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_CLASS");
        if (!string.IsNullOrEmpty(testClass) && string.Equals(className, testClass, StringComparison.Ordinal))
            return true;

        if (!string.Equals(className, "Chrome_WidgetWin_1", StringComparison.Ordinal))
            return false;

        if ((exStyle & WS_EX_TOOLWINDOW) != 0)
            return false;

        if (GetWindowTextLengthW(hwnd) <= 0)
            return false;

        string? exeName = GetProcessExeName(hwnd);
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

    private static string? GetProcessExeName(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
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
        if (_hook != IntPtr.Zero)
        {
            UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
    }
}
