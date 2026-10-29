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
    private const uint SWP_NOACTIVATE = 0x0010;

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

    [DllImport("gdi32.dll")]
    private static extern nint CreateRectRgn(int x1, int y1, int x2, int y2);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(nint hObject);

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
        int ClipB);

    private readonly Dictionary<nint, AppliedState> _applied = new();
    private readonly EnumChildProc _enumChildDelegate;
    private nint _foundRenderChild;

    public GhostStyle()
    {
        _enumChildDelegate = OnEnumChild;
    }

    private bool OnEnumChild(nint child, nint lParam)
    {
        char* buf = stackalloc char[64];
        int len = GetClassNameW(child, buf, 64);
        if (len > 0 && new ReadOnlySpan<char>(buf, len).SequenceEqual("Chrome_RenderWidgetHostHWND".AsSpan()))
        {
            _foundRenderChild = child;
            return false;
        }
        return true;
    }

    public bool TryGetContentRelRect(nint hwnd, out PipTracker.RECT relRect)
    {
        relRect = default;
        if (hwnd == IntPtr.Zero || !PipTracker.GetWindowRect(hwnd, out var winRc))
            return false;

        _foundRenderChild = IntPtr.Zero;
        EnumChildWindows(hwnd, _enumChildDelegate, IntPtr.Zero);
        if (_foundRenderChild == IntPtr.Zero || !PipTracker.GetWindowRect(_foundRenderChild, out var childRc))
            return false;

        int l = Math.Max(0, childRc.Left - winRc.Left);
        int t = Math.Max(0, childRc.Top - winRc.Top);
        int r = Math.Max(l + 1, childRc.Right - winRc.Left);
        int b = Math.Max(t + 1, childRc.Bottom - winRc.Top);
        if (t <= 0 || r <= l || b <= t)
            return false;

        relRect = new PipTracker.RECT { Left = l, Top = t, Right = r, Bottom = b };
        return true;
    }

    public static byte ComputeAlpha(double opacity) =>
        (byte)Math.Clamp((int)Math.Round(opacity * 255.0, MidpointRounding.AwayFromZero), 26, 255);

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
        if (!hadPrev || layeredWasMissing || prev.Alpha != alpha)
            SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);

        bool wantClip = false;
        int clipL = 0, clipT = 0, clipR = 0, clipB = 0;
        if (hideHeader && TryGetContentRelRect(hwnd, out var rel))
        {
            wantClip = true;
            clipL = rel.Left;
            clipT = rel.Top;
            clipR = rel.Right;
            clipB = rel.Bottom;
        }

        if (wantClip)
        {
            if (!hadPrev || !prev.Clipped || prev.ClipL != clipL || prev.ClipT != clipT || prev.ClipR != clipR || prev.ClipB != clipB)
            {
                nint rgn = CreateRectRgn(clipL, clipT, clipR, clipB);
                if (rgn != IntPtr.Zero && SetWindowRgn(hwnd, rgn, true) == 0)
                    DeleteObject(rgn);
            }
        }
        else if (!hadPrev || prev.Clipped)
        {
            SetWindowRgn(hwnd, IntPtr.Zero, true);
        }

        int nextTick = hadPrev ? prev.TickCount + 1 : 0;
        if ((curEx & WS_EX_TOPMOST) == 0 || exChanged || (clickThrough && nextTick % 10 == 0))
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        _applied[hwnd] = new AppliedState(alpha, clickThrough, nextTick, wantClip, clipL, clipT, clipR, clipB);
        return true;
    }

    public void Restore(nint hwnd)
    {
        _applied.Remove(hwnd);
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

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
