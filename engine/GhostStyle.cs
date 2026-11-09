using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed unsafe class GhostStyle
{
    public const string HostClassName = "GhostPiPClipHost";
    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const nint WS_EX_TOPMOST = 0x00000008;
    public const nint WS_EX_TRANSPARENT = 0x00000020;
    public const nint WS_EX_TOOLWINDOW = 0x00000080;
    public const nint WS_EX_LAYERED = 0x00080000;
    public const uint LWA_ALPHA = 0x00000002;

    private const uint WS_POPUP_U = 0x80000000;
    private const uint WS_CHILD_U = 0x40000000;
    private const uint WS_VISIBLE_U = 0x10000000;
    private const uint WS_CLIPSIBLINGS_U = 0x04000000;
    private const uint WS_CLIPCHILDREN_U = 0x02000000;

    private static readonly nint HWND_TOPMOST = -1;
    private static readonly nint HWND_NOTOPMOST = -2;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    private delegate bool EnumChildProc(nint hWnd, nint lParam);
    private delegate nint WndProcDelegate(nint hWnd, uint msg, nint wParam, nint lParam);

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

    [DllImport("kernel32.dll", EntryPoint = "GetModuleHandleW", CharSet = CharSet.Unicode)]
    private static extern nint GetModuleHandleW(string? lpModuleName);

    [DllImport("user32.dll", EntryPoint = "RegisterClassExW", SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowExW(
        uint dwExStyle,
        string lpClassName,
        string lpWindowName,
        uint dwStyle,
        int X,
        int Y,
        int nWidth,
        int nHeight,
        nint hWndParent,
        nint hMenu,
        nint hInstance,
        nint lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetParent(nint hWndChild, nint hWndNewParent);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")]
    private static extern nint DefWindowProcW(nint hWnd, uint Msg, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern nint GetWindowLongPtrW(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    public static extern nint SetWindowLongPtrW(nint hWnd, int nIndex, nint dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetLayeredWindowAttributes(nint hwnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(nint hWndParent, EnumChildProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(nint hWnd, char* lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(nint hWnd, nint hRgn, bool bRedraw);

    private readonly record struct AppliedState(
        byte Alpha,
        bool ClickThrough,
        int TickCount,
        bool Clipped,
        int ClipL,
        int ClipT,
        int ClipR,
        int ClipB,
        int PadW,
        int PadH,
        nint OrigStyle,
        nint OrigExStyle,
        nint HostHwnd,
        nint RenderChild,
        nint D3dChild);

    private static bool _hostClassRegistered;
    private static WndProcDelegate? _hostWndProcDelegate;

    private const uint WM_CLOSE = 0x0010;
    private const uint GW_HWNDNEXT = 2;
    private const int TopmostReassertTicks = 10;
    private const int ChildProbeTicks = 32;

    [DllImport("user32.dll")]
    private static extern nint GetWindow(nint hWnd, uint uCmd);

    private readonly Dictionary<nint, AppliedState> _applied = new();
    private readonly EnumChildProc _enumChildDelegate;
    private nint _foundRenderChild;
    private nint _foundD3dChild;

    public GhostStyle()
    {
        _enumChildDelegate = OnEnumChild;
    }

    // A WM_CLOSE (e.g. a non-forced taskkill) must not reach DefWindowProc: destroying the host would
    // destroy the reparented Chrome window with it. The engine window's WM_CLOSE detaches first.
    private static nint HostWndProc(nint hWnd, uint msg, nint wParam, nint lParam) =>
        msg == WM_CLOSE ? IntPtr.Zero : DefWindowProcW(hWnd, msg, wParam, lParam);

    /// <summary>True when <paramref name="upper"/> sits above <paramref name="lower"/> within <paramref name="maxSteps"/> z-order steps.</summary>
    public static bool IsAbove(nint upper, nint lower, int maxSteps)
    {
        if (upper == IntPtr.Zero || lower == IntPtr.Zero || upper == lower)
            return false;

        nint cur = GetWindow(upper, GW_HWNDNEXT);
        for (int i = 0; cur != IntPtr.Zero && i < maxSteps; i++)
        {
            if (cur == lower)
                return true;
            cur = GetWindow(cur, GW_HWNDNEXT);
        }
        return false;
    }

    private static void EnsureHostClassRegistered()
    {
        if (_hostClassRegistered)
            return;

        _hostWndProcDelegate = HostWndProc;
        nint hInst = GetModuleHandleW(null);
        fixed (char* clsPtr = HostClassName)
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_hostWndProcDelegate),
                hInstance = hInst,
                lpszClassName = clsPtr
            };
            RegisterClassExW(ref wc);
        }
        _hostClassRegistered = true;
    }

    private bool OnEnumChild(nint child, nint lParam)
    {
        char* buf = stackalloc char[64];
        int len = GetClassNameW(child, buf, 64);
        if (len <= 0)
            return true;

        var span = new ReadOnlySpan<char>(buf, len);
        if (_foundRenderChild == IntPtr.Zero && span.SequenceEqual("Chrome_RenderWidgetHostHWND".AsSpan()))
        {
            _foundRenderChild = child;
        }
        else if (_foundD3dChild == IntPtr.Zero && span.SequenceEqual("Intermediate D3D Window".AsSpan()))
        {
            _foundD3dChild = child;
        }

        return _foundRenderChild == IntPtr.Zero || _foundD3dChild == IntPtr.Zero;
    }

    /// <summary>
    /// Finds the content (render widget) rect relative to the window. A still-valid cached child is
    /// reused so the per-tick path does not walk the child tree.
    /// </summary>
    private bool TryGetContentRelRect(
        nint hwnd,
        nint cachedRender,
        nint cachedD3d,
        out PipTracker.RECT relRect,
        out nint renderChild,
        out nint d3dChild)
    {
        relRect = default;
        renderChild = IntPtr.Zero;
        d3dChild = IntPtr.Zero;

        if (hwnd == IntPtr.Zero || !PipTracker.GetWindowRect(hwnd, out var winRc))
            return false;

        if (cachedRender != IntPtr.Zero && IsWindow(cachedRender))
        {
            _foundRenderChild = cachedRender;
            _foundD3dChild = cachedD3d != IntPtr.Zero && IsWindow(cachedD3d) ? cachedD3d : IntPtr.Zero;
        }
        else
        {
            _foundRenderChild = IntPtr.Zero;
            _foundD3dChild = IntPtr.Zero;
            EnumChildWindows(hwnd, _enumChildDelegate, IntPtr.Zero);
        }
        if (_foundRenderChild == IntPtr.Zero || !PipTracker.GetWindowRect(_foundRenderChild, out var childRc))
            return false;

        int l = Math.Max(0, childRc.Left - winRc.Left);
        int t = Math.Max(0, childRc.Top - winRc.Top);
        int r = Math.Max(l + 1, childRc.Right - winRc.Left);
        int b = Math.Max(t + 1, childRc.Bottom - winRc.Top);
        if (t <= 0 || r <= l || b <= t)
            return false;

        renderChild = _foundRenderChild;
        d3dChild = _foundD3dChild;
        relRect = new PipTracker.RECT { Left = l, Top = t, Right = r, Bottom = b };
        return true;
    }

    public nint GetInputTargetHwnd(nint hwnd) =>
        _applied.TryGetValue(hwnd, out var state) && state.RenderChild != IntPtr.Zero && IsWindow(state.RenderChild)
            ? state.RenderChild
            : hwnd;

    public nint GetLogicalTopHwnd(nint hwnd) =>
        _applied.TryGetValue(hwnd, out var state) && state.HostHwnd != IntPtr.Zero && IsWindow(state.HostHwnd)
            ? state.HostHwnd
            : hwnd;

    public bool IsManagedWindow(nint hwnd)
    {
        if (hwnd == IntPtr.Zero)
            return false;
        if (_applied.ContainsKey(hwnd))
            return true;
        foreach (var state in _applied.Values)
        {
            if (state.HostHwnd == hwnd || state.RenderChild == hwnd || state.D3dChild == hwnd)
                return true;
        }
        return false;
    }

    public bool TryGetLogicalWindowRect(nint hwnd, out PipTracker.RECT rc)
    {
        if (_applied.TryGetValue(hwnd, out var state) && state.HostHwnd != IntPtr.Zero && IsWindow(state.HostHwnd))
            return PipTracker.GetWindowRect(state.HostHwnd, out rc);

        return PipTracker.GetWindowRect(hwnd, out rc);
    }

    public void MoveLogicalWindow(nint hwnd, int logicalX, int logicalY)
    {
        nint target = _applied.TryGetValue(hwnd, out var state) && state.HostHwnd != IntPtr.Zero && IsWindow(state.HostHwnd)
            ? state.HostHwnd
            : hwnd;
        SetWindowPos(
            target,
            IntPtr.Zero,
            logicalX,
            logicalY,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
    }

    public void ResizeLogicalWindow(nint hwnd, int logicalW, int logicalH)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

        int visW = Math.Max(140, logicalW);
        int visH = Math.Max(90, logicalH);

        if (_applied.TryGetValue(hwnd, out var state) && state.HostHwnd != IntPtr.Zero && IsWindow(state.HostHwnd))
        {
            SetWindowPos(
                state.HostHwnd,
                IntPtr.Zero,
                0,
                0,
                visW,
                visH,
                SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
            SetWindowPos(
                hwnd,
                IntPtr.Zero,
                -state.ClipL,
                -state.ClipT,
                visW + state.PadW,
                visH + state.PadH,
                SWP_NOACTIVATE | SWP_NOZORDER);
            return;
        }

        SetWindowPos(
            hwnd,
            IntPtr.Zero,
            0,
            0,
            visW,
            visH,
            SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
    }

    public void MoveAndResizeLogicalWindow(nint hwnd, int logicalX, int logicalY, int logicalW, int logicalH)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

        int visW = Math.Max(140, logicalW);
        int visH = Math.Max(90, logicalH);

        if (_applied.TryGetValue(hwnd, out var state) && state.HostHwnd != IntPtr.Zero && IsWindow(state.HostHwnd))
        {
            SetWindowPos(
                state.HostHwnd,
                IntPtr.Zero,
                logicalX,
                logicalY,
                visW,
                visH,
                SWP_NOACTIVATE | SWP_NOZORDER);
            SetWindowPos(
                hwnd,
                IntPtr.Zero,
                -state.ClipL,
                -state.ClipT,
                visW + state.PadW,
                visH + state.PadH,
                SWP_NOACTIVATE | SWP_NOZORDER);
            return;
        }

        SetWindowPos(
            hwnd,
            IntPtr.Zero,
            logicalX,
            logicalY,
            visW,
            visH,
            SWP_NOACTIVATE | SWP_NOZORDER);
    }

    public static byte ComputeAlpha(double opacity) =>
        ComputeAlpha(opacity, allowZero: false);

    public static byte ComputeAlpha(double opacity, bool allowZero) =>
        (byte)Math.Clamp((int)Math.Round(opacity * 255.0, MidpointRounding.AwayFromZero), allowZero ? 0 : 26, 255);

    private static void DetachFromHost(nint hwnd, AppliedState prev)
    {
        nint host = prev.HostHwnd;
        int restoreX = 0, restoreY = 0;
        PipTracker.RECT hostRc = default;
        bool hasHostPos = host != IntPtr.Zero && IsWindow(host) && PipTracker.GetWindowRect(host, out hostRc);
        if (hasHostPos)
        {
            restoreX = hostRc.Left - prev.ClipL;
            restoreY = hostRc.Top - prev.ClipT;
        }

        if (hwnd != IntPtr.Zero && IsWindow(hwnd))
        {
            if (host != IntPtr.Zero)
                SetParent(hwnd, IntPtr.Zero);
            if (prev.OrigStyle != IntPtr.Zero)
                SetWindowLongPtrW(hwnd, GWL_STYLE, prev.OrigStyle);
            nint zOrder = (prev.OrigExStyle & WS_EX_TOPMOST) != 0 ? HWND_TOPMOST : HWND_NOTOPMOST;
            if (hasHostPos)
                SetWindowPos(hwnd, zOrder, restoreX, restoreY, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            SubtitleOverlay.RestoreDwmBorder(hwnd);
        SetWindowRgn(hwnd, IntPtr.Zero, true);
        }

        if (host != IntPtr.Zero && IsWindow(host))
            DestroyWindow(host);
    }

    public bool Apply(nint hwnd, double opacity, bool clickThrough, bool hideHeader = false, bool allowZeroAlpha = false)
    {
        bool hadPrev = _applied.TryGetValue(hwnd, out var prev);
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            if (hadPrev)
            {
                _applied.Remove(hwnd);
                DetachFromHost(IntPtr.Zero, prev);
            }
            return false;
        }

        nint origExStyle = hadPrev ? prev.OrigExStyle : GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        byte alpha = ComputeAlpha(opacity, allowZeroAlpha);
        bool ghosted = clickThrough || alpha < 255;
        int nextTick = hadPrev ? prev.TickCount + 1 : 0;
        bool periodicTopmost = ghosted && nextTick % TopmostReassertTicks == 0;
        bool wantClip = false;
        int clipL = 0, clipT = 0, clipR = 0, clipB = 0;
        nint renderChild = IntPtr.Zero;
        nint d3dChild = IntPtr.Zero;
        bool probeChildren = !hadPrev || prev.Clipped || nextTick % ChildProbeTicks == 0;
        if (hideHeader && probeChildren &&
            TryGetContentRelRect(hwnd, hadPrev ? prev.RenderChild : IntPtr.Zero, hadPrev ? prev.D3dChild : IntPtr.Zero,
                out var rel, out renderChild, out d3dChild))
        {
            wantClip = true;
            clipL = rel.Left;
            clipT = rel.Top;
            clipR = rel.Right;
            clipB = rel.Bottom;
        }

        if (wantClip && PipTracker.GetWindowRect(hwnd, out var winRc))
        {
            int winW = Math.Max(1, winRc.Right - winRc.Left);
            int winH = Math.Max(1, winRc.Bottom - winRc.Top);
            int visW = Math.Max(1, clipR - clipL);
            int visH = Math.Max(1, clipB - clipT);
            int padW = Math.Max(0, winW - visW);
            int padH = Math.Max(0, winH - visH);

            nint hostHwnd = hadPrev ? prev.HostHwnd : IntPtr.Zero;
            nint origStyle = hadPrev && prev.OrigStyle != IntPtr.Zero ? prev.OrigStyle : GetWindowLongPtrW(hwnd, GWL_STYLE);
            bool hostCreated = false;

            if (hostHwnd == IntPtr.Zero || !IsWindow(hostHwnd))
            {
                EnsureHostClassRegistered();
                int hostX = winRc.Left + clipL;
                int hostY = winRc.Top + clipT;
                uint hostExInit = (uint)(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | (clickThrough ? WS_EX_TRANSPARENT : 0));
                uint hostStyleInit = WS_POPUP_U | WS_VISIBLE_U | WS_CLIPCHILDREN_U | WS_CLIPSIBLINGS_U;
                hostHwnd = CreateWindowExW(
                    hostExInit,
                    HostClassName,
                    "GhostPiP Host",
                    hostStyleInit,
                    hostX,
                    hostY,
                    visW,
                    visH,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    GetModuleHandleW(null),
                    IntPtr.Zero);

                if (hostHwnd != IntPtr.Zero)
                {
                    hostCreated = true;
                    SubtitleOverlay.SuppressDwmBorder(hostHwnd);
                    SetLayeredWindowAttributes(hostHwnd, 0, alpha, LWA_ALPHA);
                    nint preChildEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    if ((preChildEx & WS_EX_LAYERED) != 0)
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, preChildEx & ~WS_EX_LAYERED);
                    nint childStyle = unchecked((origStyle & ~(nint)0x80000000L) | (nint)0x40000000L);
                    SetWindowLongPtrW(hwnd, GWL_STYLE, childStyle);
                    SetParent(hwnd, hostHwnd);
                    SetWindowPos(hwnd, IntPtr.Zero, -clipL, -clipT, winW, winH, SWP_NOZORDER | SWP_NOACTIVATE);
                    if (d3dChild != IntPtr.Zero && IsWindow(d3dChild))
                        SetWindowPos(d3dChild, IntPtr.Zero, 0, 0, winW, winH, SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }

            if (hostHwnd != IntPtr.Zero && IsWindow(hostHwnd))
            {
                if (!hostCreated && PipTracker.GetWindowRect(hostHwnd, out var hostRc))
                {
                    int curHostW = hostRc.Right - hostRc.Left;
                    int curHostH = hostRc.Bottom - hostRc.Top;
                    if (curHostW != visW || curHostH != visH)
                        SetWindowPos(hostHwnd, IntPtr.Zero, 0, 0, visW, visH, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

                    int relHwndX = winRc.Left - hostRc.Left;
                    int relHwndY = winRc.Top - hostRc.Top;
                    if (relHwndX != -clipL || relHwndY != -clipT)
                        SetWindowPos(hwnd, IntPtr.Zero, -clipL, -clipT, winW, winH, SWP_NOZORDER | SWP_NOACTIVATE);
                }

                nint curHostEx = GetWindowLongPtrW(hostHwnd, GWL_EXSTYLE);
                nint desiredHostEx = curHostEx | WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
                if (clickThrough)
                    desiredHostEx |= WS_EX_TRANSPARENT;
                else
                    desiredHostEx &= ~WS_EX_TRANSPARENT;

                bool hostExChanged = desiredHostEx != curHostEx;
                if (hostExChanged)
                    SetWindowLongPtrW(hostHwnd, GWL_EXSTYLE, desiredHostEx);

                nint curHwndEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                nint desiredHwndEx = clickThrough ? (curHwndEx | WS_EX_TRANSPARENT) : (curHwndEx & ~WS_EX_TRANSPARENT);
                desiredHwndEx &= ~WS_EX_LAYERED;
                if (desiredHwndEx != curHwndEx)
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desiredHwndEx);

                if (hostCreated || hostExChanged || !hadPrev || prev.Alpha != alpha)
                    SetLayeredWindowAttributes(hostHwnd, 0, alpha, LWA_ALPHA);

                if (hostCreated || hostExChanged || (curHostEx & WS_EX_TOPMOST) == 0 || periodicTopmost)
                {
                    uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | (hostExChanged ? SWP_FRAMECHANGED : 0u);
                    SetWindowPos(hostHwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
                }

                _applied[hwnd] = new AppliedState(
                    alpha,
                    clickThrough,
                    nextTick,
                    true,
                    clipL,
                    clipT,
                    clipR,
                    clipB,
                    padW,
                    padH,
                    origStyle,
                    origExStyle,
                    hostHwnd,
                    renderChild,
                    d3dChild);
                return true;
            }
        }

        if (hadPrev && prev.HostHwnd != IntPtr.Zero)
            DetachFromHost(hwnd, prev);

        nint curEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        nint desiredEx = curEx | WS_EX_LAYERED;
        if (clickThrough)
            desiredEx |= WS_EX_TRANSPARENT;
        else
            desiredEx &= ~WS_EX_TRANSPARENT;

        bool exChanged = desiredEx != curEx;
        if (exChanged)
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desiredEx);

        if (!hadPrev)
            SubtitleOverlay.SuppressDwmBorder(hwnd);

        bool layeredWasMissing = (curEx & WS_EX_LAYERED) == 0;
        if (!hadPrev || layeredWasMissing || exChanged || prev.Alpha != alpha)
            SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);

        if ((curEx & WS_EX_TOPMOST) == 0 || exChanged || periodicTopmost)
        {
            uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | (exChanged ? SWP_FRAMECHANGED : 0u);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        }

        _applied[hwnd] = new AppliedState(alpha, clickThrough, nextTick, false, 0, 0, 0, 0, 0, 0, IntPtr.Zero, origExStyle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    public void Restore(nint hwnd)
    {
        bool hadPrev = _applied.TryGetValue(hwnd, out var prev);
        _applied.Remove(hwnd);

        if (hadPrev && prev.HostHwnd != IntPtr.Zero)
            DetachFromHost(hwnd, prev);

        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

        SubtitleOverlay.RestoreDwmBorder(hwnd);
        SetWindowRgn(hwnd, IntPtr.Zero, true);
        nint curEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        nint nextEx = curEx & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT);
        if (nextEx != curEx)
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextEx);
        if (hadPrev && (prev.OrigExStyle & WS_EX_TOPMOST) == 0)
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    public void RestoreAll()
    {
        if (_applied.Count == 0)
            return;

        nint[] keys = [.. _applied.Keys];
        foreach (nint hwnd in keys)
            Restore(hwnd);
    }
}
