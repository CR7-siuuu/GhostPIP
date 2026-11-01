using System.Text;
using System.Text.Json;

namespace GhostPiP.Engine;

public static class SelfTest
{
    public static int Run(string[] args)
    {
        try
        {
            string vectorsPath = ResolveVectorsPath(args);
            int vectorPassed = RunDodgeVectorTests(vectorsPath);
            int unitPassed = RunUnitTests();

            Console.WriteLine($"[SelfTest] PASS: {vectorPassed}/{vectorPassed} dodge vectors, {unitPassed}/{unitPassed} unit suites.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[SelfTest] FAIL: {ex.Message}");
            return 1;
        }
    }

    private static string ResolveVectorsPath(string[] args)
    {
        if (args.Length >= 2 && !string.IsNullOrWhiteSpace(args[1]) && File.Exists(args[1]))
            return args[1];

        string[] candidates =
        [
            Path.Combine(Environment.CurrentDirectory, "shared", "dodge-vectors.json"),
            Path.Combine(Environment.CurrentDirectory, "..", "shared", "dodge-vectors.json"),
            Path.Combine(AppContext.BaseDirectory, "shared", "dodge-vectors.json"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "shared", "dodge-vectors.json")
        ];

        foreach (string c in candidates)
        {
            if (File.Exists(c))
                return Path.GetFullPath(c);
        }

        throw new FileNotFoundException("Could not find shared/dodge-vectors.json.");
    }

    private static int RunDodgeVectorTests(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        using var doc = JsonDocument.Parse(bytes);
        var cases = doc.RootElement.GetProperty("cases");
        int passed = 0;

        foreach (var testCase in cases.EnumerateArray())
        {
            string name = testCase.GetProperty("name").GetString() ?? "<unnamed>";
            string fn = testCase.GetProperty("fn").GetString() ?? "";

            switch (fn)
            {
                case "step":
                    RunStepVector(name, testCase);
                    break;

                case "isValidDodge":
                    RunIsValidDodgeVector(name, testCase);
                    break;

                case "cornerRect":
                    RunCornerRectVector(name, testCase);
                    break;

                case "nearestCorner":
                    RunNearestCornerVector(name, testCase);
                    break;

                default:
                    throw new InvalidOperationException($"Unknown vector fn '{fn}' in '{name}'.");
            }

            passed++;
        }

        return passed;
    }

    private static void RunStepVector(string name, JsonElement testCase)
    {
        var cfgEl = testCase.GetProperty("cfg");
        var allowed = new List<string>();
        foreach (var item in cfgEl.GetProperty("allowed").EnumerateArray())
            allowed.Add(item.GetString()!);

        var cfg = new DodgeConfig(
            Enabled: cfgEl.GetProperty("enabled").GetBoolean(),
            Axis: cfgEl.GetProperty("axis").GetString()!,
            Allowed: allowed.ToArray(),
            Home: cfgEl.GetProperty("home").GetString()!,
            AutoReturn: cfgEl.GetProperty("autoReturn").GetBoolean(),
            ReturnDelayMs: cfgEl.GetProperty("returnDelayMs").GetInt32(),
            MarginPx: cfgEl.GetProperty("marginPx").GetInt32(),
            EdgeInsetPx: cfgEl.GetProperty("edgeInsetPx").GetInt32(),
            HoverDelayMs: cfgEl.GetProperty("hoverDelayMs").GetInt32(),
            CooldownMs: cfgEl.GetProperty("cooldownMs").GetInt32(),
            Style: cfgEl.GetProperty("style").GetString()!,
            IgnoreScreenEdgePx: cfgEl.GetProperty("ignoreScreenEdgePx").GetInt32()
        );

        var startEl = testCase.GetProperty("start");
        var state = DodgeSolver.InitialState(startEl.GetProperty("corner").GetString()!);
        if (startEl.TryGetProperty("faded", out var fadedEl))
            state = state with { Faded = fadedEl.GetBoolean() };
        if (startEl.TryGetProperty("hoverSince", out var hoverEl) && hoverEl.ValueKind == JsonValueKind.Number)
            state = state with { HoverSince = hoverEl.GetDouble() };
        if (startEl.TryGetProperty("lastMoveAt", out var moveEl) && moveEl.ValueKind == JsonValueKind.Number)
            state = state with { LastMoveAt = moveEl.GetDouble() };
        if (startEl.TryGetProperty("outsideHomeSince", out var outEl) && outEl.ValueKind == JsonValueKind.Number)
            state = state with { OutsideHomeSince = outEl.GetDouble() };

        int stepIdx = 0;
        foreach (var stepEl in testCase.GetProperty("steps").EnumerateArray())
        {
            var inputEl = stepEl.GetProperty("input");
            double now = inputEl.GetProperty("now").GetDouble();
            DodgePoint? cursor = null;
            if (inputEl.TryGetProperty("cursor", out var curEl) && curEl.ValueKind == JsonValueKind.Object)
            {
                cursor = new DodgePoint(curEl.GetProperty("x").GetInt32(), curEl.GetProperty("y").GetInt32());
            }

            var sizeEl = inputEl.GetProperty("size");
            var size = new DodgeSize(sizeEl.GetProperty("w").GetInt32(), sizeEl.GetProperty("h").GetInt32());
            var area = ParseRect(inputEl.GetProperty("area"));

            var res = DodgeSolver.Step(state, new DodgeInput(now, cursor, size, area), cfg);
            state = res.State;

            var expectEl = stepEl.GetProperty("expect");
            var expectAct = expectEl.GetProperty("action");
            string expType = expectAct.GetProperty("type").GetString()!;
            Assert(res.Action.Type == expType, $"{name} [step {stepIdx}]: expected action.type={expType}, got {res.Action.Type}");

            if (expectAct.TryGetProperty("corner", out var expActCorner))
            {
                string c = expActCorner.GetString()!;
                Assert(res.Action.Corner == c, $"{name} [step {stepIdx}]: expected action.corner={c}, got {res.Action.Corner}");
            }

            if (expectAct.TryGetProperty("on", out var expActOn))
            {
                bool on = expActOn.GetBoolean();
                Assert(res.Action.On == on, $"{name} [step {stepIdx}]: expected action.on={on}, got {res.Action.On}");
            }

            string expCorner = expectEl.GetProperty("corner").GetString()!;
            Assert(state.Corner == expCorner, $"{name} [step {stepIdx}]: expected state.Corner={expCorner}, got {state.Corner}");

            if (expectEl.TryGetProperty("faded", out var expFaded))
            {
                bool f = expFaded.GetBoolean();
                Assert(state.Faded == f, $"{name} [step {stepIdx}]: expected state.Faded={f}, got {state.Faded}");
            }

            stepIdx++;
        }
    }

    private static void RunIsValidDodgeVector(string name, JsonElement testCase)
    {
        var argsEl = testCase.GetProperty("args");
        var allowed = new List<string>();
        foreach (var item in argsEl[0].EnumerateArray())
            allowed.Add(item.GetString()!);
        string axis = argsEl[1].GetString()!;
        string home = argsEl[2].GetString()!;
        bool expected = testCase.GetProperty("expect").GetBoolean();
        bool actual = DodgeSolver.IsValidDodge(allowed, axis, home);
        Assert(actual == expected, $"{name}: expected {expected}, got {actual}");
    }

    private static void RunCornerRectVector(string name, JsonElement testCase)
    {
        var argsEl = testCase.GetProperty("args");
        string corner = argsEl[0].GetString()!;
        var size = new DodgeSize(argsEl[1].GetProperty("w").GetInt32(), argsEl[1].GetProperty("h").GetInt32());
        var area = ParseRect(argsEl[2]);
        int inset = argsEl[3].GetInt32();
        var expected = ParseRect(testCase.GetProperty("expect"));
        var actual = DodgeSolver.CornerRect(corner, size, area, inset);
        Assert(actual == expected, $"{name}: expected {expected}, got {actual}");
    }

    private static void RunNearestCornerVector(string name, JsonElement testCase)
    {
        var argsEl = testCase.GetProperty("args");
        var rect = ParseRect(argsEl[0]);
        var area = ParseRect(argsEl[1]);
        string expected = testCase.GetProperty("expect").GetString()!;
        string actual = DodgeSolver.NearestCorner(rect, area);
        Assert(actual == expected, $"{name}: expected {expected}, got {actual}");
    }

    private static DodgeRect ParseRect(JsonElement el) =>
        new(
            el.GetProperty("l").GetInt32(),
            el.GetProperty("t").GetInt32(),
            el.GetProperty("r").GetInt32(),
            el.GetProperty("b").GetInt32()
        );

    private static int RunUnitTests()
    {
        int suites = 0;

        TestHoldStateMachine();
        suites++;

        TestProtocol();
        suites++;

        TestHotkeys();
        suites++;

        TestNativeMessaging();
        suites++;

        TestGhostStyleAlpha();
        suites++;

        return suites;
    }

    private static void TestHoldStateMachine()
    {
        var sm = new HoldStateMachine();
        Assert(sm.State == HoldState.Ghost, "Initial HoldState must be Ghost");

        var r1 = sm.Step(holdDown: false, lButtonDown: false);
        Assert(r1 is { State: HoldState.Ghost, IsInteractive: false, DragEnded: false }, "Ghost idle");

        var r2 = sm.Step(holdDown: true, lButtonDown: false);
        Assert(r2 is { State: HoldState.Interact, IsInteractive: true, DragEnded: false }, "Ghost -> Interact");

        var r3 = sm.Step(holdDown: true, lButtonDown: true);
        Assert(r3 is { State: HoldState.Dragging, IsInteractive: true, DragEnded: false }, "Interact -> Dragging");

        var r4 = sm.Step(holdDown: false, lButtonDown: true);
        Assert(r4 is { State: HoldState.Dragging, IsInteractive: true, DragEnded: false }, "Dragging persists when hold released mid-drag");

        var r5 = sm.Step(holdDown: false, lButtonDown: false);
        Assert(r5 is { State: HoldState.Ghost, IsInteractive: false, DragEnded: true }, "Dragging -> Ghost on LButton release with DragEnded=true");

        sm.Step(holdDown: true, lButtonDown: false);
        sm.Step(holdDown: true, lButtonDown: true);
        var r6 = sm.Step(holdDown: true, lButtonDown: false);
        Assert(r6 is { State: HoldState.Interact, IsInteractive: true, DragEnded: true }, "Dragging -> Interact when hold kept down");
    }

    private static void TestProtocol()
    {
        const string validStateJson = """
        {
          "v": 1,
          "type": "STATE",
          "settings": {
            "clickThrough": true,
            "opacity": 1.5,
            "dodge": {
              "enabled": true,
              "axis": "free",
              "allowed": ["TL", "BR"],
              "home": "BR",
              "autoReturn": true,
              "returnDelayMs": 2500,
              "marginPx": 20,
              "edgeInsetPx": 16,
              "hoverDelayMs": 100,
              "cooldownMs": 300,
              "style": "move",
              "ignoreScreenEdgePx": 0
            },
            "hotkeys": {
              "clickThrough": "Alt+G",
              "dodge": "Alt+Shift+D",
              "mute": "Alt+M",
              "hold": "Ctrl+Alt"
            }
          }
        }
        """;

        Assert(Protocol.TryParseIncoming(validStateJson, out var msg1) && msg1 is StateMessage sm &&
               sm.Settings.ClickThrough && Math.Abs(sm.Settings.Opacity - 1.0) < 1e-9,
               "Valid STATE parsed and opacity clamped to 1.0");

        const string invalidDodgeJson = """
        {
          "v": 1,
          "type": "STATE",
          "settings": {
            "clickThrough": false,
            "opacity": 0.7,
            "dodge": {
              "enabled": true,
              "axis": "vertical",
              "allowed": ["TL", "BR"],
              "home": "BR",
              "style": "move"
            }
          }
        }
        """;

        Assert(!Protocol.TryParseIncoming(invalidDodgeJson, out _), "Invalid dodge settings must be rejected");

        const string pipOpenedJson = """
        {"v":1,"type":"PIP_OPENED","tabId":42,"kind":"document","rect":{"x":100,"y":200,"w":480,"h":270},"dpr":1.25}
        """;
        Assert(Protocol.TryParseIncoming(pipOpenedJson, out var msg2) &&
               msg2 is PipOpenedMessage { TabId: 42, Kind: "document", Dpr: 1.25 } po &&
               Math.Abs(po.Rect.W - 480) < 1e-9,
               "PIP_OPENED parsed");

        const string localeJson = """
        {"v":1,"type":"LOCALE","strings":{"trayTip":"GhostPiP Engine","trayActive":"GhostPiP Engine (実行中)","trayEmergency":"クリックスルーを解除","trayExit":"終了"}}
        """;
        Assert(Protocol.TryParseIncoming(localeJson, out var msg3) &&
               msg3 is LocaleMessage { Tray: { Exit: "終了", Emergency: "クリックスルーを解除" } },
               "LOCALE parsed");
        Assert(Protocol.TryParseIncoming("""{"v":1,"type":"LOCALE","strings":{}}""", out var msg4) &&
               msg4 is LocaleMessage lm && lm.Tray == TrayStrings.English,
               "LOCALE falls back to English for missing strings");

        byte[] helloBytes = Protocol.SerializeOutgoing(new HelloMessage("1.0.0", ["Alt+G"]));
        using var helloDoc = JsonDocument.Parse(helloBytes);
        Assert(helloDoc.RootElement.GetProperty("type").GetString() == "HELLO" &&
               helloDoc.RootElement.GetProperty("hotkeyErrors")[0].GetString() == "Alt+G",
               "HELLO serialized");

        byte[] intentBytes = Protocol.SerializeOutgoing(new IntentMessage("SET_HOME", "TL"));
        using var intentDoc = JsonDocument.Parse(intentBytes);
        Assert(intentDoc.RootElement.GetProperty("intent").GetString() == "SET_HOME" &&
               intentDoc.RootElement.GetProperty("corner").GetString() == "TL",
               "INTENT serialized");
    }

    private static void TestHotkeys()
    {
        Assert(Hotkeys.TryParseHotkey("Alt+G", out uint m1, out uint vk1) &&
               m1 == Hotkeys.MOD_ALT && vk1 == 'G', "Alt+G parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+Shift+D", out uint m2, out uint vk2) &&
               m2 == (Hotkeys.MOD_ALT | Hotkeys.MOD_SHIFT) && vk2 == 'D', "Alt+Shift+D parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+M", out uint m3, out uint vk3) &&
               m3 == Hotkeys.MOD_ALT && vk3 == 'M', "Alt+M parsed");

        Assert(Hotkeys.TryParseHotkey("Ctrl+Shift+F1", out uint m4, out uint vk4) &&
               m4 == (Hotkeys.MOD_CONTROL | Hotkeys.MOD_SHIFT) && vk4 == 0x70, "Ctrl+Shift+F1 parsed");

        Assert(Hotkeys.TryParseHotkey("F8", out uint m5, out uint vk5) &&
               m5 == 0 && vk5 == 0x77, "Standalone F8 parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+`", out uint m6, out uint vk6) &&
               m6 == Hotkeys.MOD_ALT && vk6 == 0xC0, "Alt+` parsed");

        Assert(!Hotkeys.TryParseHotkey("G", out _, out _), "Modifier-less key rejected");
        Assert(!Hotkeys.TryParseHotkey("", out _, out _), "Empty key rejected");
    }

    private static void TestNativeMessaging()
    {
        using var ms = new MemoryStream();
        string incomingJson = """{"v":1,"type":"PIP_CLOSED","tabId":7}""";
        NativeMessagingHost.WriteFrame(ms, Encoding.UTF8.GetBytes(incomingJson));
        NativeMessagingHost.WriteMessage(ms, new PipBoundMessage(7));

        ms.Position = 0;
        byte[]? f1 = NativeMessagingHost.ReadFrame(ms);
        Assert(f1 is not null && Protocol.TryParseIncoming(f1, out var m1) && m1 is PipClosedMessage { TabId: 7 },
               "Frame 1 round-trip");

        byte[]? f2 = NativeMessagingHost.ReadFrame(ms);
        Assert(f2 is not null && Encoding.UTF8.GetString(f2).Contains("\"PIP_BOUND\""),
               "Frame 2 round-trip");

        Assert(NativeMessagingHost.ReadFrame(ms) is null, "EOF returns null");

        using var badStream = new MemoryStream([0x00, 0x00, 0x10, 0x00]);
        bool threw = false;
        try
        {
            NativeMessagingHost.ReadFrame(badStream);
        }
        catch (InvalidDataException)
        {
            threw = true;
        }
        Assert(threw, "Oversize frame throws InvalidDataException");
    }

    private static void TestGhostStyleAlpha()
    {
        Assert(GhostStyle.ComputeAlpha(0.1) == 26, "Opacity 0.1 -> alpha 26");
        Assert(GhostStyle.ComputeAlpha(0.5) == 128, "Opacity 0.5 -> alpha 128");
        Assert(GhostStyle.ComputeAlpha(1.0) == 255, "Opacity 1.0 -> alpha 255");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
