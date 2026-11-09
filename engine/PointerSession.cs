namespace GhostPiP.Engine;

public enum PointerPhase
{
    Idle,
    Down,
    Dragging,
    Resizing
}

public enum PointerActionKind
{
    None,
    Move,
    Resize
}

public readonly record struct PointerAction(PointerActionKind Kind, nint Hwnd, int L, int T, int W, int H);

public enum PointerEndKind
{
    None,
    Click,
    Drag,
    Resize
}

public readonly record struct PointerEnd(PointerEndKind Kind, nint Hwnd, int X, int Y, bool Resized);

public enum WheelAction
{
    None,
    Volume,
    Opacity
}

public readonly record struct HitTarget(nint Hwnd, DodgeRect Rect, bool Hosted, bool Native, int TabId, double Scale);

/// <summary>
/// What the low-level mouse hook may read. Built on the UI thread each tick and after anything that
/// moves a PiP, so the hook never queries windows itself. Targets are ordered topmost first.
/// </summary>
public sealed record HookSnapshot(HitTarget[] TopFirst, bool Enabled, bool PassThrough, bool VolumeWheel)
{
    public static readonly HookSnapshot Empty = new([], false, false, false);

    public HitTarget? Hit(int x, int y, int expandPx, bool hostedOnly)
    {
        foreach (var t in TopFirst)
        {
            if (hostedOnly && !t.Hosted)
                continue;
            if (x < t.Rect.L - expandPx || x > t.Rect.R + expandPx || y < t.Rect.T - expandPx || y > t.Rect.B + expandPx)
                continue;
            return t;
        }
        return null;
    }

    public (WheelAction Action, bool Swallow) DecideWheel(int x, int y, bool hold, bool altOnly)
    {
        if (altOnly && !hold && VolumeWheel)
            return (WheelAction.Volume, true);
        if (CanAdjustOpacity(x, y, hold))
            return (WheelAction.Opacity, hold);
        if (altOnly && VolumeWheel)
            return (WheelAction.Volume, true);
        return (WheelAction.None, false);
    }

    public bool CanAdjustOpacity(int x, int y, bool hold) =>
        Enabled && Hit(x, y, 0, hostedOnly: false) is HitTarget hit && (hold || (!PassThrough && hit.Native));
}

/// <summary>
/// The engine-driven pointer gesture on a hosted (Document PiP / popup) window. Pure state: the hook
/// feeds it button and move events, and the UI thread applies the returned actions.
/// </summary>
public sealed class PointerSession
{
    public const int DragThresholdPx = 5;
    public const int ResizeThresholdPx = 2;
    public const int HitExpandPx = 6;
    public const int MinResizeW = 200;
    public const int MinResizeH = 130;

    private string _dir = string.Empty;
    private DodgeRect _start;
    private int _x0;
    private int _y0;
    private int _minW;
    private int _minH;
    private bool _resized;

    public PointerPhase Phase { get; private set; }
    public nint Hwnd { get; private set; }

    /// <summary>Returns true when the button-down must be swallowed because the engine owns the gesture.</summary>
    public bool OnButtonDown(HookSnapshot s, int x, int y, bool hold, out HitTarget? observed)
    {
        observed = null;
        if (!s.Enabled || (s.PassThrough && !hold))
            return false;

        observed = s.Hit(x, y, HitExpandPx, hostedOnly: false);
        if (s.Hit(x, y, HitExpandPx, hostedOnly: true) is not HitTarget doc)
            return false;

        string? dir = ResizeDir(x, y, doc.Rect, doc.Scale);
        if (dir is not null)
        {
            Begin(PointerPhase.Resizing, doc, x, y);
            _dir = dir;
            _minW = Dpi.Px(MinResizeW, doc.Scale);
            _minH = Dpi.Px(MinResizeH, doc.Scale);
            return true;
        }

        if (hold)
        {
            Begin(PointerPhase.Down, doc, x, y);
            return true;
        }

        return false;
    }

    public PointerAction OnMove(int x, int y)
    {
        int dx = x - _x0;
        int dy = y - _y0;
        switch (Phase)
        {
            case PointerPhase.Down:
                if (Math.Abs(dx) < DragThresholdPx && Math.Abs(dy) < DragThresholdPx)
                    return default;
                Phase = PointerPhase.Dragging;
                return new PointerAction(PointerActionKind.Move, Hwnd, _start.L + dx, _start.T + dy, _start.W, _start.H);

            case PointerPhase.Dragging:
                return new PointerAction(PointerActionKind.Move, Hwnd, _start.L + dx, _start.T + dy, _start.W, _start.H);

            case PointerPhase.Resizing:
                if (!_resized && Math.Abs(dx) < ResizeThresholdPx && Math.Abs(dy) < ResizeThresholdPx)
                    return default;
                _resized = true;
                bool e = _dir.Contains('e'), w = _dir.Contains('w'), s = _dir.Contains('s'), n = _dir.Contains('n');
                int nextW = e ? Math.Max(_minW, _start.W + dx) : w ? Math.Max(_minW, _start.W - dx) : _start.W;
                int nextH = s ? Math.Max(_minH, _start.H + dy) : n ? Math.Max(_minH, _start.H - dy) : _start.H;
                int nextL = w ? _start.R - nextW : _start.L;
                int nextT = n ? _start.B - nextH : _start.T;
                return new PointerAction(PointerActionKind.Resize, Hwnd, nextL, nextT, nextW, nextH);

            default:
                return default;
        }
    }

    /// <summary>Ends the gesture and returns what the UI thread must finish. Swallow the button-up when Kind != None.</summary>
    public PointerEnd OnButtonUp(int x, int y)
    {
        var end = Phase switch
        {
            PointerPhase.Down => new PointerEnd(PointerEndKind.Click, Hwnd, x, y, false),
            PointerPhase.Dragging => new PointerEnd(PointerEndKind.Drag, Hwnd, x, y, false),
            PointerPhase.Resizing => new PointerEnd(PointerEndKind.Resize, Hwnd, x, y, _resized),
            _ => default
        };
        Reset();
        return end;
    }

    public void Forget(nint hwnd)
    {
        if (Phase != PointerPhase.Idle && Hwnd == hwnd)
            Reset();
    }

    public void Reset()
    {
        Phase = PointerPhase.Idle;
        Hwnd = IntPtr.Zero;
        _dir = string.Empty;
        _resized = false;
    }

    private void Begin(PointerPhase phase, HitTarget target, int x, int y)
    {
        Phase = phase;
        Hwnd = target.Hwnd;
        _start = target.Rect;
        _x0 = x;
        _y0 = y;
        _resized = false;
    }

    public static string? ResizeDir(int x, int y, DodgeRect rc, double scale)
    {
        int outer = Dpi.Px(6, scale);
        int corner = Dpi.Px(16, scale);
        int edge = Dpi.Px(8, scale);

        if (x < rc.L - outer || x > rc.R + outer || y < rc.T - outer || y > rc.B + outer)
            return null;

        bool cornerW = x <= rc.L + corner;
        bool cornerE = x >= rc.R - corner;
        bool cornerN = y <= rc.T + corner;
        bool cornerS = y >= rc.B - corner;

        if (cornerN && cornerW) return "nw";
        if (cornerN && cornerE) return "ne";
        if (cornerS && cornerW) return "sw";
        if (cornerS && cornerE) return "se";

        if (x <= rc.L + edge) return "w";
        if (x >= rc.R - edge) return "e";
        if (y >= rc.B - edge) return "s";
        if (y <= rc.T + edge) return "n";
        return null;
    }
}
