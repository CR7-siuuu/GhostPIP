using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed unsafe class GhostStyle
{
    public const int GWL_EXSTYLE = -20;
    public const nint WS_EX_TOPMOST = 0x00000008;
    public const nint WS_EX_TRANSPARENT = 0x00000020;
    public const nint WS_EX_LAYERED = 0x00080000;
    public const uint LWA_ALPHA = 0x00000002;

    private static readonly nint HWND_TOPMOST = -1;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    private delegate bool EnumChildProc(nint hWnd, nint lParam);

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
        nint D3dChild);

    private readonly Dictionary<nint, AppliedState> _applied = new();
    private readonly EnumChildProc _enumChildDelegate;
    private nint _foundRenderChild;
    private nint _foundD3dChild;

    public GhostStyle()
    {
        _enumChildDelegate = OnEnumChild;
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

    public bool TryGetContentRelRect(nint hwnd, out PipTracker.RECT relRect) =>
        TryGetContentRelRect(hwnd, out relRect, out _, out _, out _, out _);

    private bool TryGetContentRelRect(
        nint hwnd,
        out PipTracker.RECT relRect,
        out nint d3dChild,
        out int d3dW,
        out int d3dH,
        out int d3dRelT)
    {
        relRect = default;
        d3dChild = IntPtr.Zero;
        d3dW = 0;
        d3dH = 0;
        d3dRelT = 0;

        if (hwnd == IntPtr.Zero || !PipTracker.GetWindowRect(hwnd, out var winRc))
            return false;

        _foundRenderChild = IntPtr.Zero;
        _foundD3dChild = IntPtr.Zero;
        EnumChildWindows(hwnd, _enumChildDelegate, IntPtr.Zero);
        if (_foundRenderChild == IntPtr.Zero || !PipTracker.GetWindowRect(_foundRenderChild, out var childRc))
            return false;

        int l = Math.Max(0, childRc.Left - winRc.Left);
        int t = Math.Max(0, childRc.Top - winRc.Top);
        int r = Math.Max(l + 1, childRc.Right - winRc.Left);
        int b = Math.Max(t + 1, childRc.Bottom - winRc.Top);
        if (t <= 0 || r <= l || b <= t)
            return false;

        if (_foundD3dChild != IntPtr.Zero && PipTracker.GetWindowRect(_foundD3dChild, out var d3dRc))
        {
            d3dChild = _foundD3dChild;
            int winW = Math.Max(1, winRc.Right - winRc.Left);
            int winH = Math.Max(1, winRc.Bottom - winRc.Top);
            d3dW = Math.Max(winW, d3dRc.Right - d3dRc.Left);
            d3dH = Math.Max(winH, d3dRc.Bottom - d3dRc.Top);
            d3dRelT = d3dRc.Top - winRc.Top;
        }

        relRect = new PipTracker.RECT { Left = l, Top = t, Right = r, Bottom = b };
        return true;
    }

    public bool TryGetLogicalWindowRect(nint hwnd, out PipTracker.RECT rc) =>
        PipTracker.GetWindowRect(hwnd, out rc);

    public void MoveLogicalWindow(nint hwnd, int logicalX, int logicalY)
    {
        SetWindowPos(
            hwnd,
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

        SetWindowPos(
            hwnd,
            IntPtr.Zero,
            0,
            0,
            Math.Max(140, logicalW),
            Math.Max(90, logicalH),
            SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
    }

    public static byte ComputeAlpha(double opacity) =>
        (byte)Math.Clamp((int)Math.Round(opacity * 255.0, MidpointRounding.AwayFromZero), 26, 255);

    private void UnclipWindow(nint hwnd, AppliedState prev)
    {
        nint d3d = prev.D3dChild;
        if (d3d == IntPtr.Zero || !IsWindow(d3d))
        {
            _foundRenderChild = IntPtr.Zero;
            _foundD3dChild = IntPtr.Zero;
            EnumChildWindows(hwnd, _enumChildDelegate, IntPtr.Zero);
            d3d = _foundD3dChild;
        }

        if (d3d != IntPtr.Zero && IsWindow(d3d) && PipTracker.GetWindowRect(hwnd, out var winRc))
        {
            int w = Math.Max(1, winRc.Right - winRc.Left);
            int h = Math.Max(1, winRc.Bottom - winRc.Top);
            SetWindowPos(d3d, IntPtr.Zero, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        SetWindowRgn(hwnd, IntPtr.Zero, true);
    }

    public bool Apply(nint hwnd, double opacity, bool clickThrough, bool hideHeader = false)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            _applied.Remove(hwnd);
            return false;
        }

        byte alpha = ComputeAlpha(opacity);
        nint curEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        nint desiredEx = curEx | WS_EX_LAYERED;
        if (clickThrough)
            desiredEx |= WS_EX_TRANSPARENT;
        else
            desiredEx &= ~WS_EX_TRANSPARENT;

        bool exChanged = desiredEx != curEx;
        if (exChanged)
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desiredEx);

        bool hadPrev = _applied.TryGetValue(hwnd, out var prev);
        bool layeredWasMissing = (curEx & WS_EX_LAYERED) == 0;
        if (!hadPrev || layeredWasMissing || exChanged || prev.Alpha != alpha)
            SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);

        bool wantClip = false;
        int clipL = 0, clipT = 0, clipR = 0, clipB = 0;
        nint d3dChild = IntPtr.Zero;
        int d3dW = 0, d3dH = 0, d3dRelT = 0;
        if (hideHeader && TryGetContentRelRect(hwnd, out var rel, out d3dChild, out d3dW, out d3dH, out d3dRelT))
        {
            wantClip = true;
            clipL = rel.Left;
            clipT = rel.Top;
            clipR = rel.Right;
            clipB = rel.Bottom;
        }

        if (wantClip)
        {
            bool clipChanged = !hadPrev || !prev.Clipped || prev.ClipL != clipL || prev.ClipT != clipT || prev.ClipR != clipR || prev.ClipB != clipB;
            if (d3dChild != IntPtr.Zero && (clipChanged || d3dRelT != -clipT))
            {
                SetWindowPos(d3dChild, IntPtr.Zero, 0, -clipT, Math.Max(1, d3dW), Math.Max(1, d3dH), SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
        else if (!hadPrev || prev.Clipped)
        {
            if (hadPrev && prev.Clipped)
                UnclipWindow(hwnd, prev);
            else
                SetWindowRgn(hwnd, IntPtr.Zero, true);
            d3dChild = IntPtr.Zero;
        }

        int nextTick = hadPrev ? prev.TickCount + 1 : 0;
        if ((curEx & WS_EX_TOPMOST) == 0 || exChanged || (clickThrough && nextTick % 10 == 0))
        {
            uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | (exChanged ? SWP_FRAMECHANGED : 0u);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        }

        _applied[hwnd] = new AppliedState(alpha, clickThrough, nextTick, wantClip, clipL, clipT, clipR, clipB, d3dChild);
        return true;
    }

    public void Restore(nint hwnd)
    {
        bool hadPrev = _applied.TryGetValue(hwnd, out var prev);
        _applied.Remove(hwnd);
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

        if (hadPrev && prev.Clipped)
            UnclipWindow(hwnd, prev);
        else
            SetWindowRgn(hwnd, IntPtr.Zero, true);

        nint curEx = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        nint nextEx = curEx & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT);
        if (nextEx != curEx)
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextEx);
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
