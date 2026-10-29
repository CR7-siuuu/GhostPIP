namespace GhostPiP.Engine;

public readonly record struct DodgePoint(int X, int Y);

public readonly record struct DodgeSize(int W, int H);

public readonly record struct DodgeRect(int L, int T, int R, int B)
{
    public int W => R - L;
    public int H => B - T;
}

public sealed record DodgeConfig(
    bool Enabled,
    string Axis,
    string[] Allowed,
    string Home,
    bool AutoReturn,
    int ReturnDelayMs,
    int MarginPx,
    int EdgeInsetPx,
    int HoverDelayMs,
    int CooldownMs,
    string Style,
    int IgnoreScreenEdgePx
);

public sealed record DodgeState(
    string Corner,
    double? HoverSince,
    double LastMoveAt,
    double? OutsideHomeSince,
    bool Faded
);

public readonly record struct DodgeInput(
    double Now,
    DodgePoint? Cursor,
    DodgeSize Size,
    DodgeRect Area
);

public readonly record struct DodgeAction(
    string Type,
    string? Corner = null,
    bool? On = null
);

public readonly record struct DodgeStepResult(
    DodgeState State,
    DodgeAction Action
);

public static class DodgeSolver
{
    public static readonly string[] CORNERS = ["TL", "TR", "BL", "BR"];

    private static readonly (string A, string B)[] FreePairs =
    [
        ("TL", "TR"), ("TL", "BL"), ("TL", "BR"),
        ("TR", "BL"), ("TR", "BR"), ("BL", "BR")
    ];

    private static readonly (string A, string B)[] VerticalPairs =
    [
        ("TL", "BL"), ("TR", "BR")
    ];

    private static readonly (string A, string B)[] HorizontalPairs =
    [
        ("TL", "TR"), ("BL", "BR")
    ];

    private static bool IsTop(string corner) => corner.Length == 2 && corner[0] == 'T';
    private static bool IsLeft(string corner) => corner.Length == 2 && corner[1] == 'L';

    private static bool IsReachable(string axis, string from, string to) => axis switch
    {
        "free" => true,
        "vertical" => IsLeft(from) == IsLeft(to),
        "horizontal" => IsTop(from) == IsTop(to),
        _ => false
    };

    public static bool IsValidDodge(IReadOnlyList<string>? allowed, string? axis, string? home)
    {
        if (allowed is null || string.IsNullOrEmpty(axis) || string.IsNullOrEmpty(home))
            return false;

        for (int i = 0; i < allowed.Count; i++)
        {
            if (Array.IndexOf(CORNERS, allowed[i]) < 0)
                return false;
        }

        if (!ContainsCorner(allowed, home))
            return false;

        var pairs = axis switch
        {
            "free" => FreePairs,
            "vertical" => VerticalPairs,
            "horizontal" => HorizontalPairs,
            _ => null
        };
        if (pairs is null)
            return false;

        foreach (var (a, b) in pairs)
        {
            if (ContainsCorner(allowed, a) && ContainsCorner(allowed, b))
                return true;
        }

        return false;
    }

    private static bool ContainsCorner(IReadOnlyList<string> list, string corner)
    {
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i] == corner)
                return true;
        }
        return false;
    }

    public static DodgeRect CornerRect(string corner, DodgeSize size, DodgeRect area, int inset)
    {
        int l = IsLeft(corner) ? area.L + inset : area.R - inset - size.W;
        int t = IsTop(corner) ? area.T + inset : area.B - inset - size.H;
        return new DodgeRect(l, t, l + size.W, t + size.H);
    }

    public static string NearestCorner(DodgeRect rect, DodgeRect area)
    {
        bool top = rect.T + rect.B <= area.T + area.B;
        bool left = rect.L + rect.R <= area.L + area.R;
        return string.Concat(top ? "T" : "B", left ? "L" : "R");
    }

    public static DodgeState InitialState(string corner) =>
        new(corner, null, double.NegativeInfinity, null, false);

    private static bool ContainsWithMargin(DodgeRect rect, int margin, DodgePoint p) =>
        p.X >= rect.L - margin && p.X < rect.R + margin &&
        p.Y >= rect.T - margin && p.Y < rect.B + margin;

    private static bool NearAreaEdge(DodgePoint p, DodgeRect area, int d) =>
        p.X < area.L + d || p.X >= area.R - d ||
        p.Y < area.T + d || p.Y >= area.B - d;

    private static double DistSqToCenter(DodgeRect rect, DodgePoint p)
    {
        double dx = (rect.L + rect.R) / 2.0 - p.X;
        double dy = (rect.T + rect.B) / 2.0 - p.Y;
        return dx * dx + dy * dy;
    }

    public static DodgeStepResult Step(DodgeState state, DodgeInput input, DodgeConfig cfg)
    {
        double now = input.Now;
        var cursor = input.Cursor;
        var size = input.Size;
        var area = input.Area;
        var s = state;

        DodgeRect RectOf(string corner) => CornerRect(corner, size, area, cfg.EdgeInsetPx);
        bool Covers(string corner) => cursor.HasValue && ContainsWithMargin(RectOf(corner), cfg.MarginPx, cursor.Value);

        DodgeStepResult Stay() => new(s, new DodgeAction("stay"));
        DodgeStepResult Fade(bool on)
        {
            s = s with { Faded = on };
            return new(s, new DodgeAction("fade", On: on));
        }
        DodgeStepResult MoveTo(string corner)
        {
            s = s with
            {
                Corner = corner,
                LastMoveAt = now,
                HoverSince = null,
                OutsideHomeSince = null
            };
            return new(s, new DodgeAction("move", Corner: corner));
        }

        if (!cfg.Enabled)
        {
            s = s with { HoverSince = null };
            return s.Faded ? Fade(false) : Stay();
        }

        if (!cursor.HasValue || (cfg.IgnoreScreenEdgePx > 0 && NearAreaEdge(cursor.Value, area, cfg.IgnoreScreenEdgePx)))
        {
            s = s with { HoverSince = null };
            return Stay();
        }

        bool cooledDown = now - s.LastMoveAt >= cfg.CooldownMs;

        if (Covers(s.Corner))
        {
            s = s with { HoverSince = s.HoverSince ?? now };
            if (now - s.HoverSince.Value < cfg.HoverDelayMs || !cooledDown)
                return Stay();

            if (cfg.Style == "move")
            {
                string? best = null;
                double bestDist = -1;
                foreach (var c in CORNERS)
                {
                    if (c == s.Corner || !ContainsCorner(cfg.Allowed, c) || !IsReachable(cfg.Axis, s.Corner, c) || Covers(c))
                        continue;
                    double d = DistSqToCenter(RectOf(c), cursor.Value);
                    if (d > bestDist)
                    {
                        best = c;
                        bestDist = d;
                    }
                }
                if (best is not null)
                    return MoveTo(best);
            }

            return s.Faded ? Stay() : Fade(true);
        }

        s = s with { HoverSince = null };
        if (s.Faded)
            return Fade(false);

        if (!cfg.AutoReturn || s.Corner == cfg.Home || !ContainsCorner(cfg.Allowed, cfg.Home) || !cooledDown)
            return Stay();

        if (Covers(cfg.Home))
        {
            s = s with { OutsideHomeSince = null };
            return Stay();
        }

        s = s with { OutsideHomeSince = s.OutsideHomeSince ?? now };
        return now - s.OutsideHomeSince.Value >= cfg.ReturnDelayMs ? MoveTo(cfg.Home) : Stay();
    }
}
