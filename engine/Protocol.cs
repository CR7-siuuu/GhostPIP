using System.Buffers;
using System.Text;
using System.Text.Json;

namespace GhostPiP.Engine;

public sealed record HotkeyConfig(
    string ClickThrough,
    string Dodge,
    string Mute,
    string Hold,
    string PlayPause = "Alt+Space",
    string SeekBack = "Alt+Left",
    string SeekForward = "Alt+Right",
    string Peek = "Alt+P"
);

public sealed record MediaConfig(
    bool Enabled,
    int SeekSec,
    bool WheelVolume
);

public sealed record PeekConfig(
    bool Enabled,
    string Key,
    double IdleOpacity,
    double ActiveOpacity
);

public sealed record Settings(
    bool ClickThrough,
    double Opacity,
    DodgeConfig Dodge,
    HotkeyConfig Hotkeys,
    bool Enabled = true,
    bool ShowChat = true,
    MediaConfig? Media = null,
    PeekConfig? Peek = null
)
{
    public static readonly MediaConfig DefaultMedia = new(
        Enabled: true,
        SeekSec: 5,
        WheelVolume: true
    );

    public static readonly PeekConfig DefaultPeek = new(
        Enabled: false,
        Key: "Alt",
        IdleOpacity: 0.0,
        ActiveOpacity: 0.8
    );

    public static readonly Settings Defaults = new(
        ClickThrough: false,
        Opacity: 0.7,
        Dodge: new DodgeConfig(
            Enabled: true,
            Axis: "free",
            Allowed: ["TL", "TR", "BL", "BR"],
            Home: "BR",
            AutoReturn: true,
            ReturnDelayMs: 2500,
            MarginPx: 20,
            EdgeInsetPx: 16,
            HoverDelayMs: 100,
            CooldownMs: 300,
            Style: "move",
            IgnoreScreenEdgePx: 0
        ),
        Hotkeys: new HotkeyConfig(
            ClickThrough: "Alt+G",
            Dodge: "Alt+Shift+D",
            Mute: "Alt+M",
            Hold: "Ctrl+Alt",
            PlayPause: "Alt+Space",
            SeekBack: "Alt+Left",
            SeekForward: "Alt+Right",
            Peek: "Alt+P"
        ),
        Enabled: true,
        ShowChat: true,
        Media: DefaultMedia,
        Peek: DefaultPeek
    );

    public MediaConfig EffectiveMedia => Media ?? DefaultMedia;
    public PeekConfig EffectivePeek => Peek ?? DefaultPeek;
}

public readonly record struct PipRect(double X, double Y, double W, double H);

public abstract record IncomingMessage(string Type);
public sealed record StateMessage(Settings Settings) : IncomingMessage("STATE");
public sealed record PipOpenedMessage(int TabId, string Kind, PipRect Rect, double Dpr, PipRect? SavedBounds = null) : IncomingMessage("PIP_OPENED");
public sealed record PipClosedMessage(int TabId) : IncomingMessage("PIP_CLOSED");
public sealed record PipResizeMessage(int DeltaH, double Dpr, int TabId = -1) : IncomingMessage("PIP_RESIZE");
public sealed record PipSubtitleMessage(int TabId, string Text) : IncomingMessage("PIP_SUBTITLE");
public sealed record SessionStateMessage(bool Active) : IncomingMessage("SESSION_STATE");
public sealed record PingMessage() : IncomingMessage("PING");
public sealed record TrayStrings(string Tip, string Active, string Emergency, string Exit)
{
    public static readonly TrayStrings English = new("GhostPiP Engine", "GhostPiP Engine (running)", "Emergency: turn off click-through", "Exit");
}
public sealed record LocaleMessage(TrayStrings Tray) : IncomingMessage("LOCALE");
public sealed record TestCursorMessage(DodgePoint? Cursor) : IncomingMessage("TEST_CURSOR");
public sealed record TestWheelMessage(int X, int Y, int Delta, bool Hold = true, bool AltOnly = false) : IncomingMessage("TEST_WHEEL");
public sealed record TestHoldMessage(bool? Hold) : IncomingMessage("TEST_HOLD");
public sealed record TestPeekMessage(bool? Peek) : IncomingMessage("TEST_PEEK");
public sealed record TestHotkeyMessage(string Action) : IncomingMessage("TEST_HOTKEY");
public sealed record TestMouseMessage(string Event, int X, int Y) : IncomingMessage("TEST_MOUSE");

public abstract record OutgoingMessage(string Type);
public sealed record HelloMessage(string EngineVersion, string[] HotkeyErrors, bool Elevated) : OutgoingMessage("HELLO");
public sealed record IntentMessage(string Intent, string? Corner = null, double? Opacity = null, double? Delta = null, int? TabId = null) : OutgoingMessage("INTENT");
public sealed record PeekStateMessage(bool Active) : OutgoingMessage("PEEK_STATE");
public sealed record PipBoundMessage(int TabId) : OutgoingMessage("PIP_BOUND");
public sealed record PipLostMessage(int TabId, string Reason) : OutgoingMessage("PIP_LOST");
public sealed record PipHoverMessage(int TabId, bool Hovered) : OutgoingMessage("PIP_HOVER");
public sealed record PipBoundsMessage(int TabId, string Kind, int X, int Y, int W, int H) : OutgoingMessage("PIP_BOUNDS");
public sealed record PongMessage() : OutgoingMessage("PONG");

public static class Protocol
{
    public const int ProtocolVersion = 1;
    public const string EngineVersion = "1.1.1";
    public const double MaxAbsCoord = 100000;
    public const double MaxSize = 20000;
    public const double MinDpr = 0.25;
    public const double MaxDpr = 8;
    public const double MaxAbsDeltaH = 4000;

    // GHOSTPIP_TEST_MODE is read once; the self-test flips this property to cover both branches.
    public static bool TestMode { get; set; } = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_MODE") == "1";

    public static bool TryParseIncoming(string json, out IncomingMessage? message) =>
        TryParseIncoming(Encoding.UTF8.GetBytes(json), out message);

    public static bool TryParseIncoming(ReadOnlySpan<byte> utf8Json, out IncomingMessage? message)
    {
        message = null;
        if (utf8Json.IsEmpty)
            return false;

        try
        {
            using var doc = JsonDocument.Parse(utf8Json.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return false;

            if (!root.TryGetProperty("v", out var vProp) || vProp.ValueKind != JsonValueKind.Number || vProp.GetInt32() != ProtocolVersion)
                return false;

            if (!root.TryGetProperty("type", out var typeProp) || typeProp.ValueKind != JsonValueKind.String)
                return false;

            string? type = typeProp.GetString();
            return type switch
            {
                "STATE" => TryParseState(root, out message),
                "PIP_OPENED" => TryParsePipOpened(root, out message),
                "PIP_CLOSED" => TryParsePipClosed(root, out message),
                "PIP_RESIZE" => TryParsePipResize(root, out message),
                "PIP_SUBTITLE" => TryParsePipSubtitle(root, out message),
                "SESSION_STATE" => TryParseSessionState(root, out message),
                "PING" => SetResult(new PingMessage(), out message),
                "LOCALE" => TryParseLocale(root, out message),
                "TEST_CURSOR" when TestMode => TryParseTestCursor(root, out message),
                "TEST_WHEEL" when TestMode => TryParseTestWheel(root, out message),
                "TEST_HOLD" when TestMode => TryParseTestHold(root, out message),
                "TEST_PEEK" when TestMode => TryParseTestPeek(root, out message),
                "TEST_HOTKEY" when TestMode => TryParseTestHotkey(root, out message),
                "TEST_MOUSE" when TestMode => TryParseTestMouse(root, out message),
                _ => false
            };
        }
        catch
        {
            message = null;
            return false;
        }
    }

    private static bool SetResult(IncomingMessage msg, out IncomingMessage? message)
    {
        message = msg;
        return true;
    }

    private static bool TryParseState(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("settings", out var settingsEl) || settingsEl.ValueKind != JsonValueKind.Object)
            return false;

        var def = Settings.Defaults;
        bool enabled = GetBoolOrDefault(settingsEl, "enabled", def.Enabled);
        bool showChat = GetBoolOrDefault(settingsEl, "showChat", def.ShowChat);
        bool clickThrough = GetBoolOrDefault(settingsEl, "clickThrough", def.ClickThrough);
        double rawOpacity = GetDoubleOrDefault(settingsEl, "opacity", def.Opacity);
        if (!double.IsFinite(rawOpacity))
            rawOpacity = def.Opacity;
        double opacity = Math.Clamp(rawOpacity, 0.1, 1.0);

        if (!settingsEl.TryGetProperty("dodge", out var dodgeEl) || dodgeEl.ValueKind != JsonValueKind.Object)
            return false;

        bool dodgeEnabled = GetBoolOrDefault(dodgeEl, "enabled", def.Dodge.Enabled);
        string axis = GetStringOrDefault(dodgeEl, "axis", def.Dodge.Axis);
        string home = GetStringOrDefault(dodgeEl, "home", def.Dodge.Home);
        string style = GetStringOrDefault(dodgeEl, "style", def.Dodge.Style);

        if (style is not ("move" or "fade"))
            return false;

        if (!dodgeEl.TryGetProperty("allowed", out var allowedEl) || allowedEl.ValueKind != JsonValueKind.Array)
            return false;

        var allowedList = new List<string>(4);
        foreach (var item in allowedEl.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
                return false;
            string? c = item.GetString();
            if (string.IsNullOrEmpty(c))
                return false;
            allowedList.Add(c);
        }

        string[] allowed = allowedList.ToArray();
        if (!DodgeSolver.IsValidDodge(allowed, axis, home))
            return false;

        bool autoReturn = GetBoolOrDefault(dodgeEl, "autoReturn", def.Dodge.AutoReturn);
        int returnDelayMs = Math.Clamp(GetIntOrDefault(dodgeEl, "returnDelayMs", def.Dodge.ReturnDelayMs), 0, 60000);
        int marginPx = Math.Clamp(GetIntOrDefault(dodgeEl, "marginPx", def.Dodge.MarginPx), 0, 200);
        int edgeInsetPx = Math.Clamp(GetIntOrDefault(dodgeEl, "edgeInsetPx", def.Dodge.EdgeInsetPx), 0, 200);
        int hoverDelayMs = Math.Clamp(GetIntOrDefault(dodgeEl, "hoverDelayMs", def.Dodge.HoverDelayMs), 0, 5000);
        int cooldownMs = Math.Clamp(GetIntOrDefault(dodgeEl, "cooldownMs", def.Dodge.CooldownMs), 0, 10000);
        int ignoreScreenEdgePx = Math.Clamp(GetIntOrDefault(dodgeEl, "ignoreScreenEdgePx", def.Dodge.IgnoreScreenEdgePx), 0, 200);

        var hotkeys = def.Hotkeys;
        if (settingsEl.TryGetProperty("hotkeys", out var hkEl) && hkEl.ValueKind == JsonValueKind.Object)
        {
            string hkClick = GetStringOrDefault(hkEl, "clickThrough", def.Hotkeys.ClickThrough);
            string hkDodge = GetStringOrDefault(hkEl, "dodge", def.Hotkeys.Dodge);
            string hkMute = GetStringOrDefault(hkEl, "mute", def.Hotkeys.Mute);
            string hkHold = GetStringOrDefault(hkEl, "hold", def.Hotkeys.Hold);
            if (hkHold is not ("Ctrl+Alt" or "Ctrl+Shift" or "Alt+Shift" or "Ctrl" or "Alt" or "Shift"))
                return false;
            string hkPlayPause = GetStringOrDefault(hkEl, "playPause", def.Hotkeys.PlayPause);
            string hkSeekBack = GetStringOrDefault(hkEl, "seekBack", def.Hotkeys.SeekBack);
            string hkSeekForward = GetStringOrDefault(hkEl, "seekForward", def.Hotkeys.SeekForward);
            string hkPeek = GetStringOrDefault(hkEl, "peek", def.Hotkeys.Peek);
            hotkeys = new HotkeyConfig(hkClick, hkDodge, hkMute, hkHold, hkPlayPause, hkSeekBack, hkSeekForward, hkPeek);
        }

        var media = Settings.DefaultMedia;
        if (settingsEl.TryGetProperty("media", out var mediaEl) && mediaEl.ValueKind == JsonValueKind.Object)
        {
            bool mediaEnabled = GetBoolOrDefault(mediaEl, "enabled", Settings.DefaultMedia.Enabled);
            int rawSeekSec = GetIntOrDefault(mediaEl, "seekSec", Settings.DefaultMedia.SeekSec);
            int seekSec = rawSeekSec == 10 ? 10 : 5;
            bool wheelVolume = GetBoolOrDefault(mediaEl, "wheelVolume", Settings.DefaultMedia.WheelVolume);
            media = new MediaConfig(mediaEnabled, seekSec, wheelVolume);
        }

        var peek = Settings.DefaultPeek;
        if (settingsEl.TryGetProperty("peek", out var peekEl) && peekEl.ValueKind == JsonValueKind.Object)
        {
            bool peekEnabled = GetBoolOrDefault(peekEl, "enabled", Settings.DefaultPeek.Enabled);
            string peekKey = GetStringOrDefault(peekEl, "key", Settings.DefaultPeek.Key);
            if (peekKey is not ("Alt" or "Mouse4" or "Mouse5" or "Backquote" or "Ctrl" or "Shift" or "Ctrl+Alt"))
                return false;

            double rawIdle = GetDoubleOrDefault(peekEl, "idleOpacity", Settings.DefaultPeek.IdleOpacity);
            if (!double.IsFinite(rawIdle))
                rawIdle = Settings.DefaultPeek.IdleOpacity;
            double idleOpacity = Math.Clamp(rawIdle, 0.0, 0.2);

            double rawActive = GetDoubleOrDefault(peekEl, "activeOpacity", Settings.DefaultPeek.ActiveOpacity);
            if (!double.IsFinite(rawActive))
                rawActive = Settings.DefaultPeek.ActiveOpacity;
            double activeOpacity = Math.Clamp(rawActive, 0.1, 1.0);

            peek = new PeekConfig(peekEnabled, peekKey, idleOpacity, activeOpacity);
        }

        var dodge = new DodgeConfig(
            Enabled: dodgeEnabled,
            Axis: axis,
            Allowed: allowed,
            Home: home,
            AutoReturn: autoReturn,
            ReturnDelayMs: returnDelayMs,
            MarginPx: marginPx,
            EdgeInsetPx: edgeInsetPx,
            HoverDelayMs: hoverDelayMs,
            CooldownMs: cooldownMs,
            Style: style,
            IgnoreScreenEdgePx: ignoreScreenEdgePx
        );

        message = new StateMessage(new Settings(clickThrough, opacity, dodge, hotkeys, enabled, showChat, media, peek));
        return true;
    }

    private static bool TryParsePipOpened(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!TryGetTabId(root, minTabId: 0, out int tabId))
            return false;

        string kind = GetStringOrDefault(root, "kind", "");
        if (kind is not ("native" or "document" or "popup"))
            return false;

        if (!root.TryGetProperty("rect", out var rectEl) || !TryReadRect(rectEl, allowZeroSize: false, out var rect))
            return false;

        double dpr = 1.0;
        if (root.TryGetProperty("dpr", out var dprEl) && !TryReadDpr(dprEl, out dpr))
            return false;

        PipRect? savedBounds = null;
        if (root.TryGetProperty("savedBounds", out var sbEl) && sbEl.ValueKind == JsonValueKind.Object)
        {
            if (TryReadRect(sbEl, allowZeroSize: true, out var sb))
                savedBounds = sb;
        }

        message = new PipOpenedMessage(tabId, kind, rect, dpr, savedBounds);
        return true;
    }

    private static bool TryParsePipClosed(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!TryGetTabId(root, minTabId: 0, out int tabId))
            return false;

        message = new PipClosedMessage(tabId);
        return true;
    }

    private static bool TryParsePipResize(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("deltaH", out var dEl) || dEl.ValueKind != JsonValueKind.Number ||
            !dEl.TryGetDouble(out double rawDelta) || !double.IsFinite(rawDelta))
        {
            return false;
        }
        int deltaH = (int)Math.Round(Math.Clamp(rawDelta, -MaxAbsDeltaH, MaxAbsDeltaH), MidpointRounding.AwayFromZero);

        double dpr = 1.0;
        if (root.TryGetProperty("dpr", out var dprEl) && !TryReadDpr(dprEl, out dpr))
            return false;

        int tabId = -1;
        if (root.TryGetProperty("tabId", out _) && !TryGetTabId(root, minTabId: -1, out tabId))
            return false;

        message = new PipResizeMessage(deltaH, dpr, tabId);
        return true;
    }

    private static bool TryParsePipSubtitle(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!TryGetTabId(root, minTabId: -1, out int tabId))
            return false;

        string text = GetStringOrDefault(root, "text", "");
        if (text.Length > 1000)
            text = text[..1000];

        message = new PipSubtitleMessage(tabId, text);
        return true;
    }

    private static bool TryGetTabId(JsonElement root, int minTabId, out int tabId)
    {
        tabId = 0;
        return root.TryGetProperty("tabId", out var tabEl) &&
               tabEl.ValueKind == JsonValueKind.Number &&
               tabEl.TryGetInt32(out tabId) &&
               tabId >= minTabId;
    }

    private static bool TryReadDpr(JsonElement el, out double dpr)
    {
        dpr = 1.0;
        return el.ValueKind == JsonValueKind.Number &&
               el.TryGetDouble(out dpr) &&
               double.IsFinite(dpr) &&
               dpr >= MinDpr && dpr <= MaxDpr;
    }

    public static bool IsValidRect(double x, double y, double w, double h, bool allowZeroSize)
    {
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(w) || !double.IsFinite(h))
            return false;
        if (Math.Abs(x) > MaxAbsCoord || Math.Abs(y) > MaxAbsCoord)
            return false;
        if (allowZeroSize && w == 0 && h == 0)
            return true;
        return w >= 1 && w <= MaxSize && h >= 1 && h <= MaxSize;
    }

    private static bool TryReadRect(JsonElement el, bool allowZeroSize, out PipRect rect)
    {
        rect = default;
        if (el.ValueKind != JsonValueKind.Object)
            return false;
        double x = GetDoubleOrDefault(el, "x", double.NaN);
        double y = GetDoubleOrDefault(el, "y", double.NaN);
        double w = GetDoubleOrDefault(el, "w", allowZeroSize ? 0.0 : double.NaN);
        double h = GetDoubleOrDefault(el, "h", allowZeroSize ? 0.0 : double.NaN);
        if (!IsValidRect(x, y, w, h, allowZeroSize))
            return false;
        rect = new PipRect(x, y, w, h);
        return true;
    }

    private static bool TryParseSessionState(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("active", out var actEl) || actEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return false;

        message = new SessionStateMessage(actEl.GetBoolean());
        return true;
    }

    private static bool TryParseTestCursor(JsonElement root, out IncomingMessage? message)
    {
        if (root.TryGetProperty("x", out var xEl) && xEl.ValueKind == JsonValueKind.Number && xEl.TryGetInt32(out int x) &&
            root.TryGetProperty("y", out var yEl) && yEl.ValueKind == JsonValueKind.Number && yEl.TryGetInt32(out int y))
        {
            message = new TestCursorMessage(new DodgePoint(x, y));
            return true;
        }
        if (root.TryGetProperty("cursor", out var curEl) && curEl.ValueKind == JsonValueKind.Object &&
            curEl.TryGetProperty("x", out var cxEl) && cxEl.ValueKind == JsonValueKind.Number && cxEl.TryGetInt32(out int cx) &&
            curEl.TryGetProperty("y", out var cyEl) && cyEl.ValueKind == JsonValueKind.Number && cyEl.TryGetInt32(out int cy))
        {
            message = new TestCursorMessage(new DodgePoint(cx, cy));
            return true;
        }
        message = new TestCursorMessage(null);
        return true;
    }

    private static bool TryParseTestWheel(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("x", out var xEl) || xEl.ValueKind != JsonValueKind.Number || !xEl.TryGetInt32(out int x) ||
            !root.TryGetProperty("y", out var yEl) || yEl.ValueKind != JsonValueKind.Number || !yEl.TryGetInt32(out int y) ||
            !root.TryGetProperty("delta", out var dEl) || dEl.ValueKind != JsonValueKind.Number || !dEl.TryGetInt32(out int delta))
        {
            return false;
        }
        bool hold = GetBoolOrDefault(root, "hold", true);
        bool altOnly = GetBoolOrDefault(root, "altOnly", false);
        message = new TestWheelMessage(x, y, delta, hold, altOnly);
        return true;
    }

    private static bool TryParseTestHold(JsonElement root, out IncomingMessage? message)
    {
        if (root.TryGetProperty("hold", out var hEl) && hEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            message = new TestHoldMessage(hEl.GetBoolean());
            return true;
        }
        message = new TestHoldMessage(null);
        return true;
    }

    private static bool TryParseTestPeek(JsonElement root, out IncomingMessage? message)
    {
        if (root.TryGetProperty("peek", out var pEl) && pEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            message = new TestPeekMessage(pEl.GetBoolean());
            return true;
        }
        message = new TestPeekMessage(null);
        return true;
    }

    private static bool TryParseTestHotkey(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        string id = GetStringOrDefault(root, "id", "");
        if (string.IsNullOrEmpty(id))
            id = GetStringOrDefault(root, "action", "");
        if (id is not ("playPause" or "seekBack" or "seekForward" or "peek" or "clickThrough" or "dodge" or "mute"))
            return false;

        message = new TestHotkeyMessage(id);
        return true;
    }

    private static bool TryParseTestMouse(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        string ev = GetStringOrDefault(root, "event", "");
        if (ev is not ("down" or "move" or "up"))
            return false;
        if (!root.TryGetProperty("x", out var xEl) || xEl.ValueKind != JsonValueKind.Number || !xEl.TryGetInt32(out int x) ||
            !root.TryGetProperty("y", out var yEl) || yEl.ValueKind != JsonValueKind.Number || !yEl.TryGetInt32(out int y))
        {
            return false;
        }
        message = new TestMouseMessage(ev, x, y);
        return true;
    }

    private static bool TryParseLocale(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("strings", out var el) || el.ValueKind != JsonValueKind.Object)
            return false;

        var en = TrayStrings.English;
        message = new LocaleMessage(new TrayStrings(
            GetStringOrDefault(el, "trayTip", en.Tip),
            GetStringOrDefault(el, "trayActive", en.Active),
            GetStringOrDefault(el, "trayEmergency", en.Emergency),
            GetStringOrDefault(el, "trayExit", en.Exit)));
        return true;
    }

    private static bool GetBoolOrDefault(JsonElement obj, string prop, bool fallback) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? el.GetBoolean()
            : fallback;

    private static int GetIntOrDefault(JsonElement obj, string prop, int fallback) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out int val)
            ? val
            : fallback;

    private static double GetDoubleOrDefault(JsonElement obj, string prop, double fallback) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out double val)
            ? val
            : fallback;

    private static string GetStringOrDefault(JsonElement obj, string prop, string fallback) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String && el.GetString() is string s
            ? s
            : fallback;

    public static byte[] SerializeOutgoing(OutgoingMessage message)
    {
        var buffer = new ArrayBufferWriter<byte>(128);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", ProtocolVersion);
            writer.WriteString("type", message.Type);

            switch (message)
            {
                case HelloMessage hello:
                    writer.WriteString("engineVersion", hello.EngineVersion);
                    writer.WriteBoolean("elevated", hello.Elevated);
                    writer.WritePropertyName("hotkeyErrors");
                    writer.WriteStartArray();
                    foreach (var err in hello.HotkeyErrors)
                        writer.WriteStringValue(err);
                    writer.WriteEndArray();
                    break;

                case IntentMessage intent:
                    writer.WriteString("intent", intent.Intent);
                    if (!string.IsNullOrEmpty(intent.Corner))
                        writer.WriteString("corner", intent.Corner);
                    if (intent.Opacity is double op && double.IsFinite(op))
                        writer.WriteNumber("opacity", Math.Round(Math.Clamp(op, 0.1, 1.0), 2, MidpointRounding.AwayFromZero));
                    if (intent.Delta is double d && double.IsFinite(d))
                        writer.WriteNumber("delta", Math.Round(d, 2, MidpointRounding.AwayFromZero));
                    if (intent.TabId is int tid && tid >= 0)
                        writer.WriteNumber("tabId", tid);
                    break;

                case PeekStateMessage peekState:
                    writer.WriteBoolean("active", peekState.Active);
                    break;

                case PipBoundMessage bound:
                    writer.WriteNumber("tabId", bound.TabId);
                    break;

                case PipLostMessage lost:
                    writer.WriteNumber("tabId", lost.TabId);
                    writer.WriteString("reason", lost.Reason);
                    break;

                case PipHoverMessage hover:
                    writer.WriteNumber("tabId", hover.TabId);
                    writer.WriteBoolean("hovered", hover.Hovered);
                    break;

                case PipBoundsMessage bounds:
                    writer.WriteNumber("tabId", bounds.TabId);
                    writer.WriteString("kind", bounds.Kind);
                    writer.WriteNumber("x", bounds.X);
                    writer.WriteNumber("y", bounds.Y);
                    writer.WriteNumber("w", bounds.W);
                    writer.WriteNumber("h", bounds.H);
                    break;

                case PongMessage:
                    break;
            }

            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }
}
