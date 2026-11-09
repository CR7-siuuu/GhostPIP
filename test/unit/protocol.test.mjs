import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = { URL, URLSearchParams };
vm.runInNewContext(fs.readFileSync(new URL("../../extension/shared/protocol.js", import.meta.url), "utf8"), sandbox);
const P = sandbox.GhostPiPProtocol;
const plain = (v) => JSON.parse(JSON.stringify(v));

const cfg = JSON.parse(fs.readFileSync(new URL("../../extension/config/selectors.json", import.meta.url), "utf8"));
const sites = Object.entries(cfg.sites).map(([id, s]) => ({ id, re: new RegExp(s.match), site: s }));
const chatFor = (href) => P.chatUrlFor(sites.find((s) => s.re.test(href))?.site ?? null, href);

const RECT = { x: 10, y: 20, w: 480, h: 270 };

test("buildPipOpenedEngineMsg forwards in-contract entries and adds savedBounds only for a single PiP", () => {
  const saved = { tabId: 7, kind: "native", rect: RECT, dpr: 1.25 };
  assert.deepEqual(plain(P.buildPipOpenedEngineMsg(saved, { 7: saved }, null)), {
    v: 1, type: "PIP_OPENED", tabId: 7, kind: "native", rect: RECT, dpr: 1.25,
  });
  const bounds = { x: 100, y: 200, w: 640, h: 360, kind: "native" };
  assert.deepEqual(plain(P.buildPipOpenedEngineMsg(saved, { 7: saved }, bounds).savedBounds), { x: 100, y: 200, w: 640, h: 360 });
  assert.equal(P.buildPipOpenedEngineMsg(saved, { 7: saved, 8: saved }, bounds).savedBounds, undefined);
  const doc = { ...saved, kind: "document" };
  assert.deepEqual(plain(P.buildPipOpenedEngineMsg(doc, { 7: doc }, bounds).savedBounds), { x: 100, y: 200, w: 0, h: 0 });
  assert.equal(P.buildPipOpenedEngineMsg(saved, { 7: saved }, { x: 1e9, y: 0 }).savedBounds, undefined);
});

test("buildPipOpenedEngineMsg rejects out-of-contract tabId, kind, rect and dpr", () => {
  const ok = { tabId: 3, kind: "popup", rect: RECT, dpr: 1 };
  for (const bad of [
    { tabId: -1 }, { tabId: 1.5 }, { tabId: "3" },
    { kind: "window" }, { kind: undefined },
    { dpr: 0.1 }, { dpr: 9 }, { dpr: NaN },
    { rect: null }, { rect: { ...RECT, x: 100001 } }, { rect: { ...RECT, y: -100001 } },
    { rect: { ...RECT, w: 0 } }, { rect: { ...RECT, h: 20001 } }, { rect: { ...RECT, w: Infinity } },
  ]) {
    assert.equal(P.buildPipOpenedEngineMsg({ ...ok, ...bad }, {}, null), null, JSON.stringify(bad));
  }
  assert.ok(P.buildPipOpenedEngineMsg({ ...ok, rect: { x: -100000, y: 100000, w: 1, h: 20000 } }, {}, null));
});

test("PIP_RESIZE deltaH clamps to ±4000 and non-finite values are dropped", () => {
  assert.equal(P.clampDeltaH(45), 45);
  assert.equal(P.clampDeltaH(99999), 4000);
  assert.equal(P.clampDeltaH(-99999), -4000);
  assert.equal(P.clampDeltaH(NaN), null);
  assert.equal(P.clampDeltaH("10"), null);
});

test("engine messages must carry v === 1", () => {
  assert.equal(P.isEngineMessage({ v: 1, type: "PIP_BOUND", tabId: 1 }), true);
  for (const bad of [null, "x", { type: "PIP_BOUND" }, { v: 2, type: "HELLO" }, { v: "1", type: "HELLO" }, { v: 1 }]) {
    assert.equal(P.isEngineMessage(bad), false, JSON.stringify(bad));
  }
});

test("reconnect backoff doubles from 1s and caps at 60s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(P.reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test("a missing or foreign native host stops retries; transient errors do not", () => {
  assert.equal(P.isHostMissingError("Specified native messaging host not found."), true);
  assert.equal(P.isHostMissingError("Access to the specified native messaging host is forbidden."), true);
  assert.equal(P.isHostMissingError("Native host has exited."), false);
  assert.equal(P.isHostMissingError("Error when communicating with the native messaging host."), false);
  assert.equal(P.isHostMissingError(undefined), false);
});

test("chatUrlFor builds chat URLs from selectors.json, including /live/ and m.youtube", () => {
  assert.equal(chatFor("https://www.youtube.com/watch?v=abc123"), "https://www.youtube.com/live_chat?is_popout=1&v=abc123");
  assert.equal(chatFor("https://m.youtube.com/watch?v=abc123&t=5"), "https://www.youtube.com/live_chat?is_popout=1&v=abc123");
  assert.equal(chatFor("https://www.youtube.com/live/jfKfPfyJRdk?si=x"), "https://www.youtube.com/live_chat?is_popout=1&v=jfKfPfyJRdk");
  assert.equal(chatFor("https://chzzk.naver.com/live/64a90ba95d1f9feb0a798a20bbf0f40c"), "https://chzzk.naver.com/live/64a90ba95d1f9feb0a798a20bbf0f40c/chat");
  assert.equal(chatFor("https://www.twitch.tv/somechannel"), "https://www.twitch.tv/popout/somechannel/chat");
});

test("chatUrlFor returns null where the page has no chat", () => {
  for (const href of [
    "https://www.twitch.tv/directory",
    "https://www.twitch.tv/directory?sort=VIEWER_COUNT",
    "https://www.twitch.tv/search?term=x",
    "https://www.twitch.tv/videos/123",
    "https://chzzk.naver.com/video/1234",
    "https://www.netflix.com/watch/1",
    "https://www.youtube.com/watch",
    "https://example.com/watch?v=abc",
  ]) {
    assert.equal(chatFor(href), null, href);
  }
});

test("chat URLs outside the framing allowlist are rejected", () => {
  assert.equal(P.isAllowedChatUrl("https://www.youtube.com/live_chat?v=a"), true);
  assert.equal(P.isAllowedChatUrl("https://www.twitch.tv/popout/x/chat"), true);
  assert.equal(P.isAllowedChatUrl("https://chzzk.naver.com/live/abc/chat"), true);
  for (const bad of [
    "https://evil.example/www.youtube.com/live_chat",
    "http://www.youtube.com/live_chat?v=a",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=a",
    "https://chzzk.naver.com/live/abc",
    null,
  ]) {
    assert.equal(P.isAllowedChatUrl(bad), false, String(bad));
  }
  assert.equal(P.chatUrlFor({ chatPopoutUrl: "https://evil.example/{channel}", idFrom: { pathIndex: 1 } }, "https://www.twitch.tv/x"), null);
});

test("chat framing rules are scoped by initiator or tab and strip only framing headers", () => {
  const rules = P.chatFramingRules("abcdefghijklmnopabcdefghijklmnop", [11, 12]);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) {
    const c = r.condition;
    assert.ok(c.initiatorDomains?.length || c.tabIds?.length, `rule ${r.id} must be scoped`);
    assert.deepEqual(plain(c.resourceTypes), ["sub_frame"]);
    for (const h of r.action.responseHeaders) {
      assert.ok(["x-frame-options", "frame-options", "content-security-policy"].includes(h.header), h.header);
      if (h.header === "content-security-policy") assert.equal(c.regexFilter, P.CHAT_CSP_REGEX);
    }
  }
  assert.deepEqual(plain(rules[0].condition.initiatorDomains), ["youtube.com", "chzzk.naver.com", "twitch.tv", "abcdefghijklmnopabcdefghijklmnop"]);
  assert.equal(P.chatFramingRules("id").length, 2);
});

test("media target candidates prefer the mapped source, then the newest PiP", () => {
  const pip = { 5: { tabId: 5, sourceTabId: 2 }, 9: { tabId: 9 } };
  const popups = new Map([[40, 3]]);
  assert.deepEqual(plain(P.mediaTargetCandidates({ preferredTabId: 40, sourceByPopupTab: popups, pip })), [3, 9, 2]);
  assert.deepEqual(plain(P.mediaTargetCandidates({ preferredTabId: 5, pip })), [2, 9]);
  assert.deepEqual(plain(P.mediaTargetCandidates({ preferredTabId: -1, pip: {} })), []);
  assert.deepEqual(plain(P.mediaTargetCandidates({ pip: {} })), []);
});

test("fallback tab picks an active supported site before audible or arbitrary tabs", () => {
  const isSite = (t) => t.site;
  const a = { id: 1, active: true }, b = { id: 2, audible: true, site: true }, c = { id: 3, active: true, site: true };
  assert.equal(P.pickFallbackTab([a, b, c], isSite), c);
  assert.equal(P.pickFallbackTab([a, b], isSite), b);
  assert.equal(P.pickFallbackTab([a, { id: 4 }], isSite), a);
  assert.equal(P.pickFallbackTab([], isSite), null);
});

test("sanitizeLayout keeps in-range fields and drops the rest", () => {
  assert.deepEqual(plain(P.sanitizeLayout(undefined)), {
    width: 480, height: null, aspectRatio: null, pos: null, chatOpen: false, chatHeight: null, pipChatHeight: null, pipWidth: null, pipPos: null,
  });
  const s = P.sanitizeLayout({
    width: 640.4, height: 10, aspectRatio: 0.5625, pos: { rx: 2, ry: -1 }, chatOpen: 1,
    chatHeight: 300, pipChatHeight: 50, pipWidth: 9999, pipPos: { x: 10.6, y: -20.2 },
  });
  assert.deepEqual(plain(s), {
    width: 640, height: null, aspectRatio: 0.5625, pos: { rx: 1, ry: 0 }, chatOpen: true,
    chatHeight: 300, pipChatHeight: null, pipWidth: null, pipPos: { x: 11, y: -20 },
  });
});

test("boostVideoSdp injects AS bitrate and fmtp google bitrate parameters", () => {
  const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fmtp:96 level-asymmetry-allowed=1\r\n";
  const out = P.boostVideoSdp(sdp);
  assert.ok(out.includes("m=video 9 UDP/TLS/RTP/SAVPF 96\r\nb=AS:12000\r\n"));
  assert.ok(out.includes("a=fmtp:96 level-asymmetry-allowed=1;x-google-min-bitrate=4000;x-google-start-bitrate=8000;x-google-max-bitrate=12000"));
  assert.equal(P.boostVideoSdp(null), null);
});

test("isBottomEdgeChatResize, computeResizeRect, resizePipWindow, and moveWindowWithinScreen", () => {
  assert.equal(
    P.isBottomEdgeChatResize({
      chatShown: true,
      frameConnected: true,
      pointerAgeMs: 200,
      pointerX: 100,
      pointerY: 390,
      prevW: 400,
      prevH: 400,
      dw: 0,
      dh: 20,
    }),
    true,
  );
  assert.equal(
    P.isBottomEdgeChatResize({
      chatShown: true,
      frameConnected: true,
      pointerAgeMs: 200,
      pointerX: 5,
      pointerY: 390,
      prevW: 400,
      prevH: 400,
      dw: 10,
      dh: 20,
    }),
    false,
  );

  const rectSE = P.computeResizeRect({ l: 100, t: 100, r: 580, b: 370 }, "se", 40, 30, { l: 0, t: 0, r: 1920, b: 1080 });
  assert.deepEqual(plain(rectSE), { x: 100, y: 100, w: 520, h: 300 });
  const rectNW = P.computeResizeRect({ l: 100, t: 100, r: 580, b: 370 }, "nw", -20, -10, { l: 0, t: 0, r: 1920, b: 1080 });
  assert.deepEqual(plain(rectNW), { x: 80, y: 90, w: 500, h: 280 });

  const calls = [];
  const win = {
    closed: false,
    screenX: 100,
    screenY: 800,
    outerWidth: 480,
    outerHeight: 300,
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
    moveTo(x, y) {
      calls.push(["move", x, y]);
      this.screenX = x;
      this.screenY = y;
    },
    resizeTo(w, h) {
      calls.push(["resize", w, h]);
      this.outerWidth = w;
      this.outerHeight = h;
    },
  };
  P.resizePipWindow(win, 120);
  assert.deepEqual(calls, [["move", 100, 680], ["resize", 480, 420]]);

  assert.equal(P.moveWindowWithinScreen(win, { x: 3000, y: -50 }), true);
  assert.equal(win.screenX, 1920 - 480);
  assert.equal(win.screenY, 0);
});
