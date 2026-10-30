using System.Buffers;
using System.Text;
using System.Text.Json;

namespace GhostPiP.Engine;

public sealed record HotkeyConfig(
    string ClickThrough,
    string Dodge,
    string Mute,
    string Hold
);

public sealed record Settings(
    bool ClickThrough,
    double Opacity,
    DodgeConfig Dodge,
    HotkeyConfig Hotkeys,
    bool Enabled = true,
    bool ShowChat = true
)
{
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
            Hold: "Ctrl+Alt"
        ),
        Enabled: true,
        ShowChat: true
    );
}

public readonly record struct PipRect(double X, double Y, double W, double H);

public abstract record IncomingMessage(string Type);
public sealed record StateMessage(Settings Settings) : IncomingMessage("STATE");
public sealed record PipOpenedMessage(int TabId, string Kind, PipRect Rect, double Dpr) : IncomingMessage("PIP_OPENED");
public sealed record PipClosedMessage(int TabId) : IncomingMessage("PIP_CLOSED");
public sealed record PipResizeMessage(int DeltaH, double Dpr) : IncomingMessage("PIP_RESIZE");
public sealed record PingMessage() : IncomingMessage("PING");
public sealed record TestCursorMessage(DodgePoint? Cursor) : IncomingMessage("TEST_CURSOR");
public sealed record TestWheelMessage(int X, int Y, int Delta, bool Hold = true) : IncomingMessage("TEST_WHEEL");
public sealed record TestHoldMessage(bool? Hold) : IncomingMessage("TEST_HOLD");

public abstract record OutgoingMessage(string Type);
public sealed record HelloMessage(string EngineVersion, bool Elevated, string[] HotkeyErrors) : OutgoingMessage("HELLO");
public sealed record IntentMessage(string Intent, string? Corner = null, double? Opacity = null) : OutgoingMessage("INTENT");
public sealed record PipBoundMessage(int TabId) : OutgoingMessage("PIP_BOUND");
public sealed record PipLostMessage(int TabId, string Reason) : OutgoingMessage("PIP_LOST");
public sealed record PipHoverMessage(int TabId, bool Hovered) : OutgoingMessage("PIP_HOVER");
public sealed record PongMessage() : OutgoingMessage("PONG");

public static class Protocol
{
    public const int ProtocolVersion = 1;
    public const string EngineVersion = "0.1.0";

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
                "PING" => SetResult(new PingMessage(), out message),
                "TEST_CURSOR" when Environment.GetEnvironmentVariable("GHOSTPIP_TEST_MODE") == "1" =>
                    TryParseTestCursor(root, out message),
                "TEST_WHEEL" when Environment.GetEnvironmentVariable("GHOSTPIP_TEST_MODE") == "1" =>
                    TryParseTestWheel(root, out message),
                "TEST_HOLD" when Environment.GetEnvironmentVariable("GHOSTPIP_TEST_MODE") == "1" =>
                    TryParseTestHold(root, out message),
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
        int returnDelayMs = Math.Max(0, GetIntOrDefault(dodgeEl, "returnDelayMs", def.Dodge.ReturnDelayMs));
        int marginPx = Math.Max(0, GetIntOrDefault(dodgeEl, "marginPx", def.Dodge.MarginPx));
        int edgeInsetPx = Math.Max(0, GetIntOrDefault(dodgeEl, "edgeInsetPx", def.Dodge.EdgeInsetPx));
        int hoverDelayMs = Math.Max(0, GetIntOrDefault(dodgeEl, "hoverDelayMs", def.Dodge.HoverDelayMs));
        int cooldownMs = Math.Max(0, GetIntOrDefault(dodgeEl, "cooldownMs", def.Dodge.CooldownMs));
        int ignoreScreenEdgePx = Math.Max(0, GetIntOrDefault(dodgeEl, "ignoreScreenEdgePx", def.Dodge.IgnoreScreenEdgePx));

        var hotkeys = def.Hotkeys;
        if (settingsEl.TryGetProperty("hotkeys", out var hkEl) && hkEl.ValueKind == JsonValueKind.Object)
        {
            string hkClick = GetStringOrDefault(hkEl, "clickThrough", def.Hotkeys.ClickThrough);
            string hkDodge = GetStringOrDefault(hkEl, "dodge", def.Hotkeys.Dodge);
            string hkMute = GetStringOrDefault(hkEl, "mute", def.Hotkeys.Mute);
            string hkHold = GetStringOrDefault(hkEl, "hold", def.Hotkeys.Hold);
            if (hkHold is not ("Ctrl+Alt" or "Ctrl+Shift" or "Alt+Shift" or "Ctrl" or "Alt" or "Shift"))
                return false;
            hotkeys = new HotkeyConfig(hkClick, hkDodge, hkMute, hkHold);
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

        message = new StateMessage(new Settings(clickThrough, opacity, dodge, hotkeys, enabled, showChat));
        return true;
    }

    private static bool TryParsePipOpened(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("tabId", out var tabEl) || tabEl.ValueKind != JsonValueKind.Number || !tabEl.TryGetInt32(out int tabId))
            return false;

        string kind = GetStringOrDefault(root, "kind", "");
        if (kind is not ("native" or "document"))
            return false;

        if (!root.TryGetProperty("rect", out var rectEl) || rectEl.ValueKind != JsonValueKind.Object)
            return false;

        double x = GetDoubleOrDefault(rectEl, "x", double.NaN);
        double y = GetDoubleOrDefault(rectEl, "y", double.NaN);
        double w = GetDoubleOrDefault(rectEl, "w", double.NaN);
        double h = GetDoubleOrDefault(rectEl, "h", double.NaN);
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(w) || !double.IsFinite(h) || w <= 0 || h <= 0)
            return false;

        double dpr = GetDoubleOrDefault(root, "dpr", 1.0);
        if (!double.IsFinite(dpr) || dpr <= 0)
            dpr = 1.0;

        message = new PipOpenedMessage(tabId, kind, new PipRect(x, y, w, h), dpr);
        return true;
    }

    private static bool TryParsePipClosed(JsonElement root, out IncomingMessage? message)
    {
        message = null;
        if (!root.TryGetProperty("tabId", out var tabEl) || tabEl.ValueKind != JsonValueKind.Number || !tabEl.TryGetInt32(out int tabId))
            return false;

        message = new PipClosedMessage(tabId);
        return true;
    }

    private static bool TryParsePipResize(JsonElement root, out IncomingMessage? message)
    {
        int deltaH = GetIntOrDefault(root, "deltaH", 0);
        double dpr = GetDoubleOrDefault(root, "dpr", 1.0);
        if (!double.IsFinite(dpr) || dpr <= 0)
            dpr = 1.0;

        message = new PipResizeMessage(deltaH, dpr);
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
        message = new TestWheelMessage(x, y, delta, hold);
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

                case PongMessage:
                    break;
            }

            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }
}
