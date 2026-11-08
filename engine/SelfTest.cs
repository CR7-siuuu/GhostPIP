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
            DodgeRect? customRect = null;
            if (inputEl.TryGetProperty("rect", out var rectEl) && rectEl.ValueKind == JsonValueKind.Object)
                customRect = ParseRect(rectEl);

            var res = DodgeSolver.Step(state, new DodgeInput(now, cursor, size, area, customRect), cfg);
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

        TestMultiWindowHelpers();
        suites++;

        TestSubtitleOverlayRasterizer();
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
               sm.Settings.ClickThrough && Math.Abs(sm.Settings.Opacity - 1.0) < 1e-9 &&
               sm.Settings.EffectiveMedia == Settings.DefaultMedia &&
               sm.Settings.EffectivePeek == Settings.DefaultPeek &&
               sm.Settings.Hotkeys is { PlayPause: "Alt+Space", SeekBack: "Alt+Left", SeekForward: "Alt+Right", Peek: "Alt+P" },
               "Valid legacy STATE parsed with media/peek/hotkey defaults and opacity clamped to 1.0");

        const string mediaAndPeekStateJson = """
        {
          "v": 1,
          "type": "STATE",
          "settings": {
            "clickThrough": false,
            "opacity": 0.7,
            "dodge": {
              "enabled": true,
              "axis": "free",
              "allowed": ["TL", "BR"],
              "home": "BR",
              "style": "move"
            },
            "hotkeys": {
              "clickThrough": "Alt+G",
              "dodge": "Alt+Shift+D",
              "mute": "Alt+M",
              "hold": "Ctrl+Alt",
              "playPause": "Alt+K",
              "seekBack": "Alt+J",
              "seekForward": "Alt+L",
              "peek": "Alt+`"
            },
            "media": {
              "enabled": false,
              "seekSec": 10,
              "wheelVolume": false
            },
            "peek": {
              "enabled": true,
              "key": "Mouse4",
              "idleOpacity": 0.5,
              "activeOpacity": 1.5
            }
          }
        }
        """;

        Assert(Protocol.TryParseIncoming(mediaAndPeekStateJson, out var msgMediaPeek) &&
               msgMediaPeek is StateMessage smMp &&
               smMp.Settings.EffectiveMedia is { Enabled: false, SeekSec: 10, WheelVolume: false } &&
               smMp.Settings.EffectivePeek is { Enabled: true, Key: "Mouse4" } pk &&
               Math.Abs(pk.IdleOpacity - 0.2) < 1e-9 &&
               Math.Abs(pk.ActiveOpacity - 1.0) < 1e-9 &&
               smMp.Settings.Hotkeys is { PlayPause: "Alt+K", SeekBack: "Alt+J", SeekForward: "Alt+L", Peek: "Alt+`" },
               "STATE with media, peek (clamped), and extended hotkeys parsed");

        const string invalidPeekKeyJson = """
        {
          "v": 1,
          "type": "STATE",
          "settings": {
            "clickThrough": false,
            "opacity": 0.7,
            "dodge": {
              "enabled": true,
              "axis": "free",
              "allowed": ["TL", "BR"],
              "home": "BR",
              "style": "move"
            },
            "peek": {
              "enabled": true,
              "key": "BogusKey"
            }
          }
        }
        """;

        Assert(!Protocol.TryParseIncoming(invalidPeekKeyJson, out _), "Invalid peek.key enum must be rejected");

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
               msg2 is PipOpenedMessage { TabId: 42, Kind: "document", Dpr: 1.25, SavedBounds: null } po &&
               Math.Abs(po.Rect.W - 480) < 1e-9,
               "PIP_OPENED parsed");

        const string popupOpenedWithBoundsJson = """
        {"v":1,"type":"PIP_OPENED","tabId":99,"kind":"popup","rect":{"x":120,"y":140,"w":480,"h":300},"dpr":1.5,"savedBounds":{"x":300,"y":400,"w":520,"h":320}}
        """;
        Assert(Protocol.TryParseIncoming(popupOpenedWithBoundsJson, out var msgPopup) &&
               msgPopup is PipOpenedMessage { TabId: 99, Kind: "popup", Dpr: 1.5, SavedBounds: { X: 300, Y: 400, W: 520, H: 320 } },
               "PIP_OPENED popup with savedBounds parsed");

        const string posOnlyBoundsJson = """
        {"v":1,"type":"PIP_OPENED","tabId":100,"kind":"document","rect":{"x":10,"y":20,"w":400,"h":250},"savedBounds":{"x":640,"y":360,"w":0,"h":0}}
        """;
        Assert(Protocol.TryParseIncoming(posOnlyBoundsJson, out var msgPosOnly) &&
               msgPosOnly is PipOpenedMessage { TabId: 100, SavedBounds: { X: 640, Y: 360, W: 0, H: 0 } },
               "PIP_OPENED position-only savedBounds parsed");

        const string resizeWithTabJson = """
        {"v":1,"type":"PIP_RESIZE","deltaH":-420,"dpr":1.25,"tabId":77}
        """;
        Assert(Protocol.TryParseIncoming(resizeWithTabJson, out var msgResizeTab) &&
               msgResizeTab is PipResizeMessage { DeltaH: -420, Dpr: 1.25, TabId: 77 },
               "PIP_RESIZE with tabId parsed");

        const string resizeLegacyJson = """
        {"v":1,"type":"PIP_RESIZE","deltaH":420,"dpr":1.0}
        """;
        Assert(Protocol.TryParseIncoming(resizeLegacyJson, out var msgResizeLegacy) &&
               msgResizeLegacy is PipResizeMessage { DeltaH: 420, TabId: -1 },
               "PIP_RESIZE without tabId defaults to -1");

        string longText = new('가', 1200);
        string subtitleJson = $$$"""{"v":1,"type":"PIP_SUBTITLE","tabId":15,"text":"{{{longText}}}"}""";
        Assert(Protocol.TryParseIncoming(subtitleJson, out var msgSub) &&
               msgSub is PipSubtitleMessage { TabId: 15 } sub &&
               sub.Text.Length == 1000,
               "PIP_SUBTITLE parsed and clamped to 1000 chars");

        Assert(Protocol.TryParseIncoming("""{"v":1,"type":"PIP_SUBTITLE","tabId":-1}""", out var msgSubEmpty) &&
               msgSubEmpty is PipSubtitleMessage { TabId: -1, Text: "" },
               "PIP_SUBTITLE allows tabId -1 and empty text");

        byte[] boundsBytes = Protocol.SerializeOutgoing(new PipBoundsMessage(99, "popup", 310, 415, 500, 320));
        using var boundsDoc = JsonDocument.Parse(boundsBytes);
        var boundsRoot = boundsDoc.RootElement;
        Assert(boundsRoot.GetProperty("v").GetInt32() == 1 &&
               boundsRoot.GetProperty("type").GetString() == "PIP_BOUNDS" &&
               boundsRoot.GetProperty("tabId").GetInt32() == 99 &&
               boundsRoot.GetProperty("kind").GetString() == "popup" &&
               boundsRoot.GetProperty("x").GetInt32() == 310 &&
               boundsRoot.GetProperty("y").GetInt32() == 415 &&
               boundsRoot.GetProperty("w").GetInt32() == 500 &&
               boundsRoot.GetProperty("h").GetInt32() == 320,
               "PIP_BOUNDS serialized");

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

        byte[] volIntentBytes = Protocol.SerializeOutgoing(new IntentMessage("MEDIA_VOLUME", Delta: -0.05, TabId: 42));
        using var volIntentDoc = JsonDocument.Parse(volIntentBytes);
        var volRoot = volIntentDoc.RootElement;
        Assert(volRoot.GetProperty("intent").GetString() == "MEDIA_VOLUME" &&
               Math.Abs(volRoot.GetProperty("delta").GetDouble() + 0.05) < 1e-9 &&
               volRoot.GetProperty("tabId").GetInt32() == 42,
               "INTENT MEDIA_VOLUME with delta and tabId serialized");

        byte[] volGlobalBytes = Protocol.SerializeOutgoing(new IntentMessage("MEDIA_VOLUME", Delta: 0.05, TabId: null));
        using var volGlobalDoc = JsonDocument.Parse(volGlobalBytes);
        Assert(volGlobalDoc.RootElement.GetProperty("intent").GetString() == "MEDIA_VOLUME" &&
               Math.Abs(volGlobalDoc.RootElement.GetProperty("delta").GetDouble() - 0.05) < 1e-9 &&
               !volGlobalDoc.RootElement.TryGetProperty("tabId", out _),
               "INTENT MEDIA_VOLUME without tabId omits tabId");

        byte[] peekStateBytes = Protocol.SerializeOutgoing(new PeekStateMessage(true));
        using var peekStateDoc = JsonDocument.Parse(peekStateBytes);
        Assert(peekStateDoc.RootElement.GetProperty("type").GetString() == "PEEK_STATE" &&
               peekStateDoc.RootElement.GetProperty("active").GetBoolean(),
               "PEEK_STATE serialized");

        Assert(Protocol.TryParseIncoming("""{"v":1,"type":"SESSION_STATE","active":true}""", out var msgSessOn) &&
               msgSessOn is SessionStateMessage { Active: true },
               "SESSION_STATE active=true parsed");
        Assert(Protocol.TryParseIncoming("""{"v":1,"type":"SESSION_STATE","active":false}""", out var msgSessOff) &&
               msgSessOff is SessionStateMessage { Active: false },
               "SESSION_STATE active=false parsed");
        Assert(!Protocol.TryParseIncoming("""{"v":1,"type":"SESSION_STATE"}""", out _),
               "SESSION_STATE without active rejected");

        string? prevTestMode = Environment.GetEnvironmentVariable("GHOSTPIP_TEST_MODE");
        try
        {
            Environment.SetEnvironmentVariable("GHOSTPIP_TEST_MODE", null);
            Assert(!Protocol.TryParseIncoming("""{"v":1,"type":"TEST_MOUSE","event":"down","x":10,"y":20}""", out _),
                   "TEST_MOUSE rejected outside GHOSTPIP_TEST_MODE");
            Assert(!Protocol.TryParseIncoming("""{"v":1,"type":"TEST_PEEK","peek":true}""", out _),
                   "TEST_PEEK rejected outside GHOSTPIP_TEST_MODE");
            Assert(!Protocol.TryParseIncoming("""{"v":1,"type":"TEST_HOTKEY","id":"playPause"}""", out _),
                   "TEST_HOTKEY rejected outside GHOSTPIP_TEST_MODE");

            Environment.SetEnvironmentVariable("GHOSTPIP_TEST_MODE", "1");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_MOUSE","event":"down","x":10,"y":20}""", out var msgMouse) &&
                   msgMouse is TestMouseMessage { Event: "down", X: 10, Y: 20 },
                   "TEST_MOUSE parsed in GHOSTPIP_TEST_MODE");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_PEEK","peek":true}""", out var msgPeekOn) &&
                   msgPeekOn is TestPeekMessage { Peek: true },
                   "TEST_PEEK true parsed in GHOSTPIP_TEST_MODE");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_PEEK","peek":null}""", out var msgPeekNull) &&
                   msgPeekNull is TestPeekMessage { Peek: null },
                   "TEST_PEEK null parsed in GHOSTPIP_TEST_MODE");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_HOTKEY","id":"playPause"}""", out var msgHk) &&
                   msgHk is TestHotkeyMessage { Action: "playPause" },
                   "TEST_HOTKEY playPause parsed in GHOSTPIP_TEST_MODE");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_HOTKEY","id":"peek"}""", out var msgHkPeek) &&
                   msgHkPeek is TestHotkeyMessage { Action: "peek" },
                   "TEST_HOTKEY peek parsed in GHOSTPIP_TEST_MODE");
            Assert(!Protocol.TryParseIncoming("""{"v":1,"type":"TEST_HOTKEY","id":"unknown"}""", out _),
                   "TEST_HOTKEY rejects unknown action");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_WHEEL","x":50,"y":60,"delta":120,"altOnly":true}""", out var msgWheelAlt) &&
                   msgWheelAlt is TestWheelMessage { X: 50, Y: 60, Delta: 120, AltOnly: true },
                   "TEST_WHEEL altOnly=true parsed");
            Assert(Protocol.TryParseIncoming("""{"v":1,"type":"TEST_WHEEL","x":50,"y":60,"delta":-120}""", out var msgWheelDef) &&
                   msgWheelDef is TestWheelMessage { X: 50, Y: 60, Delta: -120, Hold: true, AltOnly: false },
                   "TEST_WHEEL altOnly defaults to false");
        }
        finally
        {
            Environment.SetEnvironmentVariable("GHOSTPIP_TEST_MODE", prevTestMode);
        }
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

        Assert(Hotkeys.TryParseHotkey("Alt+Space", out uint m7, out uint vk7) &&
               m7 == Hotkeys.MOD_ALT && vk7 == 0x20, "Alt+Space parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+Left", out uint m8, out uint vk8) &&
               m8 == Hotkeys.MOD_ALT && vk8 == 0x25, "Alt+Left parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+Right", out uint m9, out uint vk9) &&
               m9 == Hotkeys.MOD_ALT && vk9 == 0x27, "Alt+Right parsed");

        Assert(Hotkeys.TryParseHotkey("Alt+P", out uint m10, out uint vk10) &&
               m10 == Hotkeys.MOD_ALT && vk10 == 'P', "Alt+P parsed");

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
        Assert(GhostStyle.ComputeAlpha(0.0) == 26, "Legacy opacity 0.0 -> alpha 26 floor");
        Assert(GhostStyle.ComputeAlpha(0.1) == 26, "Opacity 0.1 -> alpha 26");
        Assert(GhostStyle.ComputeAlpha(0.5) == 128, "Opacity 0.5 -> alpha 128");
        Assert(GhostStyle.ComputeAlpha(1.0) == 255, "Opacity 1.0 -> alpha 255");
        Assert(GhostStyle.ComputeAlpha(0.0, allowZero: true) == 0, "Peek opacity 0.0 -> alpha 0");
        Assert(GhostStyle.ComputeAlpha(0.05, allowZero: true) == 13, "Peek opacity 0.05 -> alpha 13");
        Assert(GhostStyle.ComputeAlpha(0.8, allowZero: true) == 204, "Peek opacity 0.8 -> alpha 204");
    }

    private static void TestMultiWindowHelpers()
    {
        var candidates = new List<(nint Hwnd, DodgeRect Rect)>
        {
            ((nint)1001, new DodgeRect(0, 0, 960, 720)),
            ((nint)1002, new DodgeRect(192, 198, 192 + 496, 198 + 278))
        };

        nint popupMatch = PipTracker.FindBestMatch(candidates, "popup", new PipRect(200, 200, 480, 270), 1.0);
        Assert(popupMatch == (nint)1002, "Popup matching picks DWM-framed popup window");

        var onlyMainBrowser = new List<(nint Hwnd, DodgeRect Rect)>
        {
            ((nint)1001, new DodgeRect(0, 0, 960, 720))
        };
        Assert(PipTracker.FindBestMatch(onlyMainBrowser, "popup", new PipRect(200, 200, 480, 270), 1.0) == IntPtr.Zero,
               "Popup matching never hijacks normal browser window via loose fallback");

        var cfg = Settings.Defaults.Dodge;
        Assert(Program.ChooseUnoccupiedCorner(cfg, []) == "BR", "First window chooses Home");
        Assert(Program.ChooseUnoccupiedCorner(cfg, ["BR"]) == "TL", "Second window chooses first unoccupied Allowed corner");
        Assert(Program.ChooseUnoccupiedCorner(cfg, ["BR", "TL"]) == "TR", "Third window chooses TR");
        Assert(Program.ChooseUnoccupiedCorner(cfg, ["BR", "TL", "TR"]) == "BL", "Fourth window chooses BL");
    }

    private static void TestSubtitleOverlayRasterizer()
    {
        SubtitleOverlay.RenderTestBitmap(
            "자막 테스트\nSubtitle Test",
            360,
            18,
            out int w,
            out int h,
            out int nonZeroAlphaPixels,
            out bool validPremultiplied);

        Assert(w > 0 && h > 0, $"Subtitle bitmap dimensions must be positive, got {w}x{h}");
        Assert(nonZeroAlphaPixels > 50, $"Subtitle bitmap must contain rendered pixels, got {nonZeroAlphaPixels}");
        Assert(validPremultiplied, "Subtitle bitmap must contain valid premultiplied BGRA pixels with rendered glyphs");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
