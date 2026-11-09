using System.Buffers;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public sealed unsafe class SubtitleOverlay : IDisposable
{
    public const string OverlayClassName = "GhostPiPSubtitleOverlay";

    private const uint WS_POPUP = 0x80000000;
    private const uint WS_EX_TOPMOST = 0x00000008;
    private const uint WS_EX_TRANSPARENT = 0x00000020;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WS_EX_LAYERED = 0x00080000;
    private const uint WS_EX_NOACTIVATE = 0x08000000;

    private const int SW_HIDE = 0;
    private const int SW_SHOWNOACTIVATE = 4;

    private static readonly nint HWND_TOPMOST = -1;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;

    private const byte AC_SRC_OVER = 0x00;
    private const byte AC_SRC_ALPHA = 0x01;
    private const uint ULW_ALPHA = 0x00000002;

    private const uint BI_RGB = 0;
    private const uint DIB_RGB_COLORS = 0;
    private const int TRANSPARENT = 1;
    private const int FW_SEMIBOLD = 600;
    private const uint DEFAULT_CHARSET = 1;
    private const uint ANTIALIASED_QUALITY = 4;

    private const uint DT_CENTER = 0x00000001;
    private const uint DT_WORDBREAK = 0x00000010;
    private const uint DT_CALCRECT = 0x00000400;
    private const uint DT_NOPREFIX = 0x00000800;

    private const uint DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const uint DWMWA_BORDER_COLOR = 34;
    private const int DWMWCP_DEFAULT = 0;
    private const int DWMWCP_DONOTROUND = 1;
    private const uint DWMWA_COLOR_NONE = 0xFFFFFFFE;
    private const uint DWMWA_COLOR_DEFAULT = 0xFFFFFFFF;

    private delegate nint WndProcDelegate(nint hWnd, uint msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public uint bmiColors;
    }

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

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")]
    private static extern nint DefWindowProcW(nint hWnd, uint Msg, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern nint GetDC(nint hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(nint hWnd, nint hDC);

    [DllImport("user32.dll", EntryPoint = "DrawTextW", ExactSpelling = true)]
    private static extern int DrawTextW(nint hdc, char* lpchText, int cchText, ref RECT lprc, uint format);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool UpdateLayeredWindow(
        nint hWnd,
        nint hdcDst,
        ref POINT pptDst,
        ref SIZE psize,
        nint hdcSrc,
        ref POINT pptSrc,
        uint crKey,
        ref BLENDFUNCTION pblend,
        uint dwFlags);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern nint CreateCompatibleDC(nint hdc);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern bool DeleteDC(nint hdc);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern nint SelectObject(nint hdc, nint h);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern bool DeleteObject(nint ho);

    [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern nint CreateDIBSection(
        nint hdc,
        ref BITMAPINFO pbmi,
        uint usage,
        out void* ppvBits,
        nint hSection,
        uint offset);

    [DllImport("gdi32.dll", EntryPoint = "CreateFontW", ExactSpelling = true)]
    private static extern nint CreateFontW(
        int cHeight,
        int cWidth,
        int cEscapement,
        int cOrientation,
        int fnWeight,
        uint fdwItalic,
        uint fdwUnderline,
        uint fdwStrikeOut,
        uint fdwCharSet,
        uint fdwOutputPrecision,
        uint fdwClipPrecision,
        uint fdwQuality,
        uint fdwPitchAndFamily,
        char* lpszFace);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern int SetBkMode(nint hdc, int mode);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern uint SetTextColor(nint hdc, uint color);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern bool GdiFlush();

    [DllImport("dwmapi.dll", ExactSpelling = true)]
    private static extern int DwmSetWindowAttribute(nint hwnd, uint dwAttribute, void* pvAttribute, uint cbAttribute);

    public static void SuppressDwmBorder(nint hwnd)
    {
        if (hwnd == IntPtr.Zero)
            return;
        try
        {
            uint colorNone = DWMWA_COLOR_NONE;
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &colorNone, sizeof(uint));
            int cornerPref = DWMWCP_DONOTROUND;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &cornerPref, sizeof(int));
        }
        catch
        {
        }
    }

    public static void RestoreDwmBorder(nint hwnd)
    {
        if (hwnd == IntPtr.Zero)
            return;
        try
        {
            uint colorDefault = DWMWA_COLOR_DEFAULT;
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &colorDefault, sizeof(uint));
            int cornerPref = DWMWCP_DEFAULT;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &cornerPref, sizeof(int));
        }
        catch
        {
        }
    }

    private static bool _classRegistered;
    private static WndProcDelegate? _wndProcDelegate;

    private nint _hwnd;
    private nint _memDc;
    private nint _hBitmap;
    private nint _oldBitmap;
    private int _boxW;
    private int _boxH;
    private string _lastText = string.Empty;
    private int _lastMaxBoxW;
    private int _lastFontPx;
    private int _lastX = int.MinValue;
    private int _lastY = int.MinValue;
    private byte _lastAlpha;
    private bool _visible;
    private bool _disposed;

    public nint Hwnd => _hwnd;

    private static nint OverlayWndProc(nint hWnd, uint msg, nint wParam, nint lParam) =>
        DefWindowProcW(hWnd, msg, wParam, lParam);

    private static void EnsureClassRegistered()
    {
        if (_classRegistered)
            return;

        _wndProcDelegate = OverlayWndProc;
        nint hInst = GetModuleHandleW(null);
        fixed (char* clsPtr = OverlayClassName)
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProcDelegate),
                hInstance = hInst,
                lpszClassName = clsPtr
            };
            RegisterClassExW(ref wc);
        }
        _classRegistered = true;
    }

    private bool EnsureWindowCreated()
    {
        if (_hwnd != IntPtr.Zero && GhostStyle.IsWindow(_hwnd))
            return true;

        EnsureClassRegistered();
        uint exStyle = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        _hwnd = CreateWindowExW(
            exStyle,
            OverlayClassName,
            "GhostPiP Subtitle",
            WS_POPUP,
            0,
            0,
            1,
            1,
            IntPtr.Zero,
            IntPtr.Zero,
            GetModuleHandleW(null),
            IntPtr.Zero);

        if (_hwnd != IntPtr.Zero)
            SuppressDwmBorder(_hwnd);

        _visible = false;
        _lastX = int.MinValue;
        _lastY = int.MinValue;
        _lastAlpha = 0;
        return _hwnd != IntPtr.Zero;
    }

    public void Hide()
    {
        if (_visible && _hwnd != IntPtr.Zero && GhostStyle.IsWindow(_hwnd))
            ShowWindow(_hwnd, SW_HIDE);
        _visible = false;
    }

    public void Update(string? rawText, DodgeRect pipRect, double effectiveOpacity, nint pipTopHwnd, double dpiScale)
    {
        if (_disposed)
            return;

        if (effectiveOpacity <= 0.02)
        {
            Hide();
            return;
        }

        string text = rawText?.Trim() ?? string.Empty;
        if (text.Length == 0 || pipRect.W < 80 || pipRect.H < 60)
        {
            Hide();
            return;
        }

        if (!EnsureWindowCreated())
            return;

        int maxBoxW = Math.Clamp(pipRect.W - Dpi.Px(24, dpiScale), Dpi.Px(120, dpiScale), 1600);
        int fontPx = Math.Clamp(pipRect.W / 22, Dpi.Px(14, dpiScale), Dpi.Px(30, dpiScale));

        bool bitmapChanged = false;
        if (_memDc == IntPtr.Zero ||
            _hBitmap == IntPtr.Zero ||
            !string.Equals(text, _lastText, StringComparison.Ordinal) ||
            maxBoxW != _lastMaxBoxW ||
            fontPx != _lastFontPx)
        {
            FreeDib();
            nint screenDc = GetDC(IntPtr.Zero);
            try
            {
                if (!RasterizeToDib(screenDc, text, maxBoxW, fontPx, out _memDc, out _hBitmap, out _oldBitmap, out _, out _boxW, out _boxH))
                {
                    Hide();
                    return;
                }
            }
            finally
            {
                if (screenDc != IntPtr.Zero)
                    ReleaseDC(IntPtr.Zero, screenDc);
            }

            _lastText = text;
            _lastMaxBoxW = maxBoxW;
            _lastFontPx = fontPx;
            bitmapChanged = true;
        }

        byte effectiveAlpha = GhostStyle.ComputeAlpha(effectiveOpacity, allowZero: true);
        int x = pipRect.L + (pipRect.W - _boxW) / 2;
        int y = pipRect.B - _boxH - Math.Clamp(pipRect.H / 16, Dpi.Px(10, dpiScale), Dpi.Px(28, dpiScale));
        bool wasHidden = !_visible;
        bool posChanged = x != _lastX || y != _lastY;

        if (bitmapChanged || wasHidden || posChanged || effectiveAlpha != _lastAlpha)
        {
            nint screenDc = GetDC(IntPtr.Zero);
            try
            {
                var ptDst = new POINT { X = x, Y = y };
                var size = new SIZE { cx = _boxW, cy = _boxH };
                var ptSrc = new POINT { X = 0, Y = 0 };
                var blend = new BLENDFUNCTION
                {
                    BlendOp = AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = effectiveAlpha,
                    AlphaFormat = AC_SRC_ALPHA
                };
                UpdateLayeredWindow(_hwnd, screenDc, ref ptDst, ref size, _memDc, ref ptSrc, 0, ref blend, ULW_ALPHA);
            }
            finally
            {
                if (screenDc != IntPtr.Zero)
                    ReleaseDC(IntPtr.Zero, screenDc);
            }

            _lastX = x;
            _lastY = y;
            _lastAlpha = effectiveAlpha;
        }

        if (wasHidden)
        {
            ShowWindow(_hwnd, SW_SHOWNOACTIVATE);
            _visible = true;
        }

        if (wasHidden || bitmapChanged || posChanged)
            SetWindowPos(_hwnd, HWND_TOPMOST, x, y, _boxW, _boxH, SWP_NOACTIVATE);
        else if (LostZOrder(pipTopHwnd))
            SetWindowPos(_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    private bool LostZOrder(nint pipTopHwnd)
    {
        if ((GhostStyle.GetWindowLongPtrW(_hwnd, GhostStyle.GWL_EXSTYLE) & GhostStyle.WS_EX_TOPMOST) == 0)
            return true;
        return pipTopHwnd != IntPtr.Zero && !GhostStyle.IsAbove(_hwnd, pipTopHwnd, maxSteps: 64);
    }

    public static void RenderTestBitmap(
        string text,
        int maxWidth,
        int fontPx,
        out int w,
        out int h,
        out int nonZeroAlphaPixels,
        out bool validPremultiplied)
    {
        w = 0;
        h = 0;
        nonZeroAlphaPixels = 0;
        validPremultiplied = false;

        nint screenDc = GetDC(IntPtr.Zero);
        nint memDc = IntPtr.Zero;
        nint hBmp = IntPtr.Zero;
        nint oldBmp = IntPtr.Zero;
        try
        {
            if (!RasterizeToDib(
                screenDc,
                text,
                Math.Clamp(maxWidth, 120, 1600),
                Math.Clamp(fontPx, 10, 48),
                out memDc,
                out hBmp,
                out oldBmp,
                out uint* pixels,
                out w,
                out h))
            {
                return;
            }

            int total = w * h;
            bool allValid = total > 0;
            int nonZero = 0;
            int brightGlyphs = 0;

            for (int i = 0; i < total; i++)
            {
                uint px = pixels[i];
                byte b = (byte)(px & 0xFF);
                byte g = (byte)((px >> 8) & 0xFF);
                byte r = (byte)((px >> 16) & 0xFF);
                byte a = (byte)((px >> 24) & 0xFF);

                if (a > 0)
                    nonZero++;
                if (r > 200 && g > 200 && b > 200)
                    brightGlyphs++;
                if (r > a || g > a || b > a)
                    allValid = false;
            }

            bool transparentEdges = pixels[0] == 0 && pixels[w - 1] == 0 && pixels[(h - 1) * w] == 0 && pixels[total - 1] == 0;
            nonZeroAlphaPixels = nonZero;
            validPremultiplied = allValid && transparentEdges && (string.IsNullOrWhiteSpace(text) || brightGlyphs > 0);
        }
        finally
        {
            if (memDc != IntPtr.Zero)
            {
                if (oldBmp != IntPtr.Zero)
                    SelectObject(memDc, oldBmp);
                if (hBmp != IntPtr.Zero)
                    DeleteObject(hBmp);
                DeleteDC(memDc);
            }
            if (screenDc != IntPtr.Zero)
                ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private static bool RasterizeToDib(
        nint screenDc,
        string text,
        int maxBoxW,
        int fontPx,
        out nint memDc,
        out nint hBitmap,
        out nint oldBitmap,
        out uint* pixels,
        out int boxW,
        out int boxH)
    {
        memDc = IntPtr.Zero;
        hBitmap = IntPtr.Zero;
        oldBitmap = IntPtr.Zero;
        pixels = null;
        boxW = 0;
        boxH = 0;

        const int padX = 14;
        const int padY = 7;

        memDc = CreateCompatibleDC(screenDc);
        if (memDc == IntPtr.Zero)
            return false;

        nint hFont;
        fixed (char* facePtr = "Malgun Gothic")
        {
            hFont = CreateFontW(
                -fontPx,
                0,
                0,
                0,
                FW_SEMIBOLD,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                0,
                0,
                ANTIALIASED_QUALITY,
                0,
                facePtr);
        }

        if (hFont == IntPtr.Zero)
        {
            DeleteDC(memDc);
            memDc = IntPtr.Zero;
            return false;
        }

        nint oldFont = SelectObject(memDc, hFont);
        int maxTextW = Math.Max(60, maxBoxW - padX * 2);
        int measuredW;
        int measuredH;

        fixed (char* textPtr = text)
        {
            var calcRc = new RECT { Left = 0, Top = 0, Right = maxTextW, Bottom = 0 };
            int calcH = DrawTextW(memDc, textPtr, text.Length, ref calcRc, DT_CALCRECT | DT_WORDBREAK | DT_CENTER | DT_NOPREFIX);
            measuredW = Math.Clamp(calcRc.Right - calcRc.Left + 2, 1, maxTextW);
            measuredH = Math.Clamp(Math.Max(calcH, calcRc.Bottom - calcRc.Top), fontPx, 1200);
        }

        boxW = Math.Clamp(measuredW + padX * 2, 32, maxBoxW);
        boxH = Math.Clamp(measuredH + padY * 2, 24, 1240);

        var bmi = new BITMAPINFO
        {
            bmiHeader = new BITMAPINFOHEADER
            {
                biSize = (uint)sizeof(BITMAPINFOHEADER),
                biWidth = boxW,
                biHeight = -boxH,
                biPlanes = 1,
                biBitCount = 32,
                biCompression = BI_RGB,
                biSizeImage = (uint)(boxW * boxH * 4)
            }
        };

        hBitmap = CreateDIBSection(memDc, ref bmi, DIB_RGB_COLORS, out void* bits, IntPtr.Zero, 0);
        if (hBitmap == IntPtr.Zero || bits == null)
        {
            SelectObject(memDc, oldFont);
            DeleteObject(hFont);
            DeleteDC(memDc);
            memDc = IntPtr.Zero;
            hBitmap = IntPtr.Zero;
            return false;
        }

        oldBitmap = SelectObject(memDc, hBitmap);
        SetBkMode(memDc, TRANSPARENT);
        SetTextColor(memDc, 0x00FFFFFF);

        fixed (char* textPtr = text)
        {
            int textLeft = (boxW - measuredW) / 2;
            var drawRc = new RECT
            {
                Left = textLeft,
                Top = padY,
                Right = textLeft + measuredW,
                Bottom = boxH - padY
            };
            DrawTextW(memDc, textPtr, text.Length, ref drawRc, DT_WORDBREAK | DT_CENTER | DT_NOPREFIX);
        }

        GdiFlush();

        SelectObject(memDc, oldFont);
        DeleteObject(hFont);

        int total = boxW * boxH;
        byte[] covBuf = ArrayPool<byte>.Shared.Rent(total);
        try
        {
            byte* rawBytes = (byte*)bits;
            for (int i = 0; i < total; i++)
            {
                int off = i * 4;
                byte b = rawBytes[off];
                byte g = rawBytes[off + 1];
                byte r = rawBytes[off + 2];
                covBuf[i] = Math.Max(b, Math.Max(g, r));
            }

            uint* outPx = (uint*)bits;

            for (int y = 0; y < boxH; y++)
            {
                int rowOff = y * boxW;

                for (int x = 0; x < boxW; x++)
                {
                    int idx = rowOff + x;
                    byte fgByte = covBuf[idx];

                    float strokeCov = 0f;
                    int minDy = Math.Max(-2, -y);
                    int maxDy = Math.Min(2, boxH - 1 - y);
                    int minDx = Math.Max(-2, -x);
                    int maxDx = Math.Min(2, boxW - 1 - x);

                    for (int oy = minDy; oy <= maxDy; oy++)
                    {
                        int nRow = (y + oy) * boxW + x;
                        for (int ox = minDx; ox <= maxDx; ox++)
                        {
                            byte nb = covBuf[nRow + ox];
                            if (nb == 0)
                                continue;
                            float dist = MathF.Sqrt(ox * ox + oy * oy);
                            if (dist > 2.35f)
                                continue;
                            float weight = dist <= 1.45f ? 1f : Math.Clamp(2.35f - dist, 0f, 1f);
                            float cand = (nb / 255f) * weight;
                            if (cand > strokeCov)
                                strokeCov = cand;
                        }
                    }

                    if (y >= 2 && covBuf[idx - boxW * 2] > 0)
                    {
                        float drop = (covBuf[idx - boxW * 2] / 255f) * 0.45f;
                        if (drop > strokeCov)
                            strokeCov = drop;
                    }

                    if (fgByte == 0 && strokeCov <= 0.004f)
                    {
                        outPx[idx] = 0;
                        continue;
                    }

                    float shA = Math.Clamp(strokeCov * 0.94f, 0f, 0.96f);
                    float fgA = fgByte / 255f;
                    float invFg = 1f - fgA;
                    float a = fgA + shA * invFg;
                    float rgbP = fgA;

                    byte outA = (byte)Math.Clamp((int)(a * 255f + 0.5f), 0, 255);
                    byte outC = (byte)Math.Clamp((int)(rgbP * 255f + 0.5f), 0, outA);

                    outPx[idx] = ((uint)outA << 24) | ((uint)outC << 16) | ((uint)outC << 8) | outC;
                }
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(covBuf);
        }

        pixels = (uint*)bits;
        return true;
    }

    private void FreeDib()
    {
        if (_memDc != IntPtr.Zero)
        {
            if (_oldBitmap != IntPtr.Zero)
            {
                SelectObject(_memDc, _oldBitmap);
                _oldBitmap = IntPtr.Zero;
            }
            if (_hBitmap != IntPtr.Zero)
            {
                DeleteObject(_hBitmap);
                _hBitmap = IntPtr.Zero;
            }
            DeleteDC(_memDc);
            _memDc = IntPtr.Zero;
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;

        FreeDib();
        if (_hwnd != IntPtr.Zero)
        {
            if (GhostStyle.IsWindow(_hwnd))
                DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
        }
        _visible = false;
    }
}
