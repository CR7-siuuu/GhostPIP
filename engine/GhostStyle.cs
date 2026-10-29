using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed class GhostStyle
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

    private readonly record struct AppliedState(byte Alpha, bool ClickThrough, int TickCount);
    private readonly Dictionary<nint, AppliedState> _applied = new();

    public static byte ComputeAlpha(double opacity) =>
        (byte)Math.Clamp((int)Math.Round(opacity * 255.0, MidpointRounding.AwayFromZero), 26, 255);

    public bool Apply(nint hwnd, double opacity, bool clickThrough)
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

        int nextTick = hadPrev ? prev.TickCount + 1 : 0;
        if ((curEx & WS_EX_TOPMOST) == 0 || exChanged || (clickThrough && nextTick % 10 == 0))
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        _applied[hwnd] = new AppliedState(alpha, clickThrough, nextTick);
        return true;
    }

    public void Restore(nint hwnd)
    {
        _applied.Remove(hwnd);
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            return;

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
