using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

/// <summary>A monitor's work area in physical pixels and its scale relative to 96 DPI.</summary>
public readonly record struct MonitorContext(DodgeRect Area, double Scale)
{
    public int Px(int logicalPx) => Dpi.Px(logicalPx, Scale);

    public DodgeConfig Scaled(DodgeConfig cfg) => Dpi.ScaleDodge(cfg, Scale);
}

public static class Dpi
{
    private const int MDT_EFFECTIVE_DPI = 0;

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(nint hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    public static double ScaleOf(uint dpi) => dpi == 0 ? 1.0 : dpi / 96.0;

    public static int Px(int logicalPx, double scale) =>
        (int)Math.Round(logicalPx * scale, MidpointRounding.AwayFromZero);

    public static bool HasSize(PipRect r) => r.W > 0 && r.H > 0;

    public static DodgeConfig ScaleDodge(DodgeConfig cfg, double scale) =>
        scale == 1.0
            ? cfg
            : cfg with { MarginPx = Px(cfg.MarginPx, scale), EdgeInsetPx = Px(cfg.EdgeInsetPx, scale) };

    public static double ForMonitor(nint hMonitor)
    {
        if (hMonitor == IntPtr.Zero)
            return 1.0;
        try
        {
            return GetDpiForMonitor(hMonitor, MDT_EFFECTIVE_DPI, out uint dpiX, out _) == 0 ? ScaleOf(dpiX) : 1.0;
        }
        catch (EntryPointNotFoundException)
        {
            return 1.0;
        }
        catch (DllNotFoundException)
        {
            return 1.0;
        }
    }

    /// <summary>
    /// Places saved bounds (physical px) inside the work area of the monitor that contains them,
    /// enforcing DPI-scaled minimum sizes. Position-only bounds (w/h 0) keep the current size.
    /// </summary>
    public static DodgeRect ClampSavedBounds(PipRect saved, DodgeRect area, double scale, int curW, int curH)
    {
        int rawX = ToInt(saved.X);
        int rawY = ToInt(saved.Y);
        int rawW = ToInt(saved.W);
        int rawH = ToInt(saved.H);
        int minW = Px(180, scale);
        int minH = Px(120, scale);

        int w = rawW > 0 && rawH > 0 ? Math.Clamp(rawW, minW, Math.Max(minW, area.W)) : Math.Max(1, curW);
        int h = rawW > 0 && rawH > 0 ? Math.Clamp(rawH, minH, Math.Max(minH, area.H)) : Math.Max(1, curH);
        int x = Math.Clamp(rawX, area.L, Math.Max(area.L, area.R - w));
        int y = Math.Clamp(rawY, area.T, Math.Max(area.T, area.B - h));
        return new DodgeRect(x, y, x + w, y + h);
    }

    private static int ToInt(double v) =>
        (int)Math.Round(Math.Clamp(v, -Protocol.MaxAbsCoord, Protocol.MaxAbsCoord), MidpointRounding.AwayFromZero);
}
