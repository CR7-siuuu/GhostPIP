import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL("../../extension/shared/settings.js", import.meta.url), "utf8"), sandbox);
const {
  CORNERS,
  DEFAULTS,
  HOLD_KEYS,
  PEEK_KEYS,
  HOLD_MATCH,
  PEEK_MATCH,
  SEEK_STEPS,
  isValidDodge,
  isValidHotkey,
  formatKeyEvent,
  merge,
  patch,
  isEditableTarget,
  isMousePeekButton,
  createPeekInput,
  stepPeekInput,
  matchShortcut,
} = sandbox.GhostPiPSettings;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("missing or garbage storage yields defaults", () => {
  assert.deepEqual(plain(merge(undefined)), plain(DEFAULTS));
  assert.deepEqual(plain(merge("nope")), plain(DEFAULTS));
  assert.deepEqual(plain(CORNERS), ["TL", "TR", "BL", "BR"]);
});

test("stored values override defaults field by field", () => {
  const s = merge({ clickThrough: true, dodge: { home: "TL", marginPx: 40 } });
  assert.equal(s.clickThrough, true);
  assert.equal(s.dodge.home, "TL");
  assert.equal(s.dodge.marginPx, 40);
  assert.equal(s.dodge.returnDelayMs, DEFAULTS.dodge.returnDelayMs);
});

test("wrongly typed fields fall back per field", () => {
  const s = merge({ opacity: "0.3", dodge: { marginPx: "x", enabled: 1 } });
  assert.equal(s.opacity, DEFAULTS.opacity);
  assert.equal(s.dodge.marginPx, DEFAULTS.dodge.marginPx);
  assert.equal(s.dodge.enabled, DEFAULTS.dodge.enabled);
});

test("opacity is clamped to 0.1..1", () => {
  assert.equal(merge({ opacity: 0 }).opacity, 0.1);
  assert.equal(merge({ opacity: 3 }).opacity, 1);
});

test("dodge that breaks the corner invariant falls back to default dodge", () => {
  assert.deepEqual(plain(merge({ dodge: { allowed: ["BR"], home: "BR" } }).dodge), plain(DEFAULTS.dodge));
  assert.deepEqual(plain(merge({ dodge: { allowed: ["TL", "BR"], axis: "vertical" } }).dodge), plain(DEFAULTS.dodge));
  assert.deepEqual(plain(merge({ dodge: { home: "XX" } }).dodge), plain(DEFAULTS.dodge));
  assert.deepEqual(plain(merge({ dodge: { axis: "toString" } }).dodge), plain(DEFAULTS.dodge));
  const ok = merge({ dodge: { allowed: ["TR", "BR"], axis: "vertical", home: "TR" } }).dodge;
  assert.equal(ok.home, "TR");
  assert.deepEqual(plain(ok.allowed), ["TR", "BR"]);
});

test("merge never aliases DEFAULTS", () => {
  merge(undefined).dodge.allowed.push("TL");
  assert.equal(DEFAULTS.dodge.allowed.length, 4);
});

test("isValidDodge enforces home in allowed and at least one axis-aligned pair", () => {
  assert.equal(isValidDodge(["TL", "TR", "BL", "BR"], "free", "BR"), true);
  assert.equal(isValidDodge(["TR", "BR"], "vertical", "BR"), true);
  assert.equal(isValidDodge(["TL", "BR"], "vertical", "BR"), false);
  assert.equal(isValidDodge(["TL", "BL"], "vertical", "BR"), false);
  assert.equal(isValidDodge(["TL", "TR"], "horizontal", "TL"), true);
  assert.equal(isValidDodge(["TL", "BL"], "horizontal", "TL"), false);
  assert.equal(isValidDodge(["BR"], "free", "BR"), false);
});

test("patch merges valid partial fields and rejects invariant violations without clobbering existing settings", () => {
  const initial = merge({
    clickThrough: true,
    opacity: 0.55,
    dodge: { allowed: ["TR", "BR"], axis: "vertical", home: "BR", autoReturn: false },
  });

  const ok1 = patch(initial, { opacity: 0.85, dodge: { home: "TR" } });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.settings.clickThrough, true);
  assert.equal(ok1.settings.opacity, 0.85);
  assert.equal(ok1.settings.dodge.home, "TR");
  assert.equal(ok1.settings.dodge.axis, "vertical");
  assert.deepEqual(plain(ok1.settings.dodge.allowed), ["TR", "BR"]);
  assert.equal(ok1.settings.dodge.autoReturn, false);

  const badCorner = patch(ok1.settings, { dodge: { allowed: ["TR"] } });
  assert.equal(badCorner.ok, false);
  assert.deepEqual(plain(badCorner.settings), plain(ok1.settings));

  const badAxis = patch(ok1.settings, { dodge: { axis: "horizontal" } });
  assert.equal(badAxis.ok, false);
  assert.deepEqual(plain(badAxis.settings), plain(ok1.settings));

  const badHome = patch(ok1.settings, { dodge: { home: "TL" } });
  assert.equal(badHome.ok, false);
  assert.deepEqual(plain(badHome.settings), plain(ok1.settings));
});

test("custom hotkeys and hold key validation and formatting", () => {
  assert.equal(HOLD_KEYS.includes("Alt"), true);
  assert.equal(HOLD_KEYS.includes("Ctrl+Alt"), true);
  assert.equal(isValidHotkey("Alt+G"), true);
  assert.equal(isValidHotkey("Ctrl+Shift+F1"), true);
  assert.equal(isValidHotkey("F8"), true);
  assert.equal(isValidHotkey("G"), false);
  assert.equal(isValidHotkey(""), false);

  assert.equal(formatKeyEvent({ ctrlKey: true, altKey: false, shiftKey: true, code: "KeyX", key: "X" }), "Ctrl+Shift+X");
  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: false, shiftKey: false, code: "F9", key: "F9" }), "F9");
  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: false, shiftKey: false, code: "KeyG", key: "g" }), null);

  const custom = merge({
    hotkeys: {
      clickThrough: "Ctrl+Shift+X",
      dodge: "F8",
      mute: "Alt+`",
      playPause: "Ctrl+Space",
      seekBack: "Ctrl+Left",
      seekForward: "Ctrl+Right",
      peek: "Ctrl+Shift+P",
      hold: "Alt",
    },
  });
  assert.equal(custom.hotkeys.clickThrough, "Ctrl+Shift+X");
  assert.equal(custom.hotkeys.dodge, "F8");
  assert.equal(custom.hotkeys.mute, "Alt+`");
  assert.equal(custom.hotkeys.playPause, "Ctrl+Space");
  assert.equal(custom.hotkeys.seekBack, "Ctrl+Left");
  assert.equal(custom.hotkeys.seekForward, "Ctrl+Right");
  assert.equal(custom.hotkeys.peek, "Ctrl+Shift+P");
  assert.equal(custom.hotkeys.hold, "Alt");

  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: true, shiftKey: false, code: "Space", key: " " }), "Alt+Space");
  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: true, shiftKey: false, code: "ArrowLeft", key: "ArrowLeft" }), "Alt+Left");
  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: true, shiftKey: false, code: "ArrowRight", key: "ArrowRight" }), "Alt+Right");
  assert.equal(formatKeyEvent({ ctrlKey: false, altKey: true, shiftKey: false, code: "KeyP", key: "p" }), "Alt+P");
});

test("media and peek defaults, constants, clamping, and per-field fallback", () => {
  assert.equal(DEFAULTS.opacity, 0.7);
  assert.deepEqual(plain(PEEK_KEYS), ["Alt", "Mouse4", "Mouse5", "Backquote", "Ctrl", "Shift", "Ctrl+Alt"]);
  assert.deepEqual(plain(SEEK_STEPS), [5, 10]);
  assert.deepEqual(plain(DEFAULTS.media), { enabled: true, seekSec: 5, wheelVolume: true });
  assert.deepEqual(plain(DEFAULTS.peek), { enabled: false, key: "Alt", idleOpacity: 0, activeOpacity: 0.8 });
  assert.equal(DEFAULTS.hotkeys.playPause, "Alt+Space");
  assert.equal(DEFAULTS.hotkeys.seekBack, "Alt+Left");
  assert.equal(DEFAULTS.hotkeys.seekForward, "Alt+Right");
  assert.equal(DEFAULTS.hotkeys.peek, "Alt+P");

  const clamped = merge({
    media: { enabled: false, seekSec: 99, wheelVolume: "bad" },
    peek: { enabled: true, key: "Mouse4", idleOpacity: 0.8, activeOpacity: 0.01 },
    hotkeys: { playPause: "Space", seekBack: "Alt+Left", seekForward: "", peek: "P" },
  });
  assert.equal(clamped.media.enabled, false);
  assert.equal(clamped.media.seekSec, 5);
  assert.equal(clamped.media.wheelVolume, true);
  assert.equal(clamped.peek.enabled, true);
  assert.equal(clamped.peek.key, "Mouse4");
  assert.equal(clamped.peek.idleOpacity, 0.2);
  assert.equal(clamped.peek.activeOpacity, 0.1);
  assert.equal(clamped.hotkeys.playPause, "Alt+Space");
  assert.equal(clamped.hotkeys.seekBack, "Alt+Left");
  assert.equal(clamped.hotkeys.seekForward, "Alt+Right");
  assert.equal(clamped.hotkeys.peek, "Alt+P");

  const badPeekKey = merge({ peek: { enabled: true, key: "Space", idleOpacity: -0.5, activeOpacity: 2 } });
  assert.equal(badPeekKey.peek.enabled, true);
  assert.equal(badPeekKey.peek.key, "Alt");
  assert.equal(badPeekKey.peek.idleOpacity, 0);
  assert.equal(badPeekKey.peek.activeOpacity, 1);
});

test("patch deep-merges media, peek, and hotkeys and rejects invalid updates cleanly", () => {
  const base = merge({
    media: { enabled: true, seekSec: 10, wheelVolume: false },
    peek: { enabled: true, key: "Mouse5", idleOpacity: 0.05, activeOpacity: 0.9 },
  });

  const okMedia = patch(base, { media: { wheelVolume: true } });
  assert.equal(okMedia.ok, true);
  assert.deepEqual(plain(okMedia.settings.media), { enabled: true, seekSec: 10, wheelVolume: true });
  assert.deepEqual(plain(okMedia.settings.peek), plain(base.peek));

  const okPeek = patch(okMedia.settings, { peek: { key: "Backquote", idleOpacity: 0.5, activeOpacity: 1.5 } });
  assert.equal(okPeek.ok, true);
  assert.equal(okPeek.settings.peek.key, "Backquote");
  assert.equal(okPeek.settings.peek.idleOpacity, 0.2);
  assert.equal(okPeek.settings.peek.activeOpacity, 1);
  assert.equal(okPeek.settings.peek.enabled, true);

  const okHk = patch(okPeek.settings, { hotkeys: { playPause: "Ctrl+Space", peek: "F9" } });
  assert.equal(okHk.ok, true);
  assert.equal(okHk.settings.hotkeys.playPause, "Ctrl+Space");
  assert.equal(okHk.settings.hotkeys.peek, "F9");
  assert.equal(okHk.settings.hotkeys.seekBack, "Alt+Left");

  for (const invalid of [
    { media: { seekSec: 7 } },
    { media: { enabled: "yes" } },
    { media: null },
    { peek: { key: "Enter" } },
    { peek: { idleOpacity: NaN } },
    { peek: [] },
    { hotkeys: { playPause: "Space" } },
    { hotkeys: { peek: "" } },
  ]) {
    const res = patch(okHk.settings, invalid);
    assert.equal(res.ok, false);
    assert.deepEqual(plain(res.settings), plain(okHk.settings));
  }

  assert.equal(formatKeyEvent({ code: "Space", key: " ", altKey: true }), "Alt+Space");
  assert.equal(formatKeyEvent({ key: " ", altKey: true }), "Alt+Space");
  assert.equal(formatKeyEvent({ code: "ArrowLeft", key: "ArrowLeft", altKey: true }), "Alt+Left");
  assert.equal(formatKeyEvent({ key: "ArrowRight", altKey: true }), "Alt+Right");
  assert.equal(formatKeyEvent({ code: "KeyP", key: "p", altKey: true }), "Alt+P");
});

const hotkeyVectors = JSON.parse(fs.readFileSync(new URL("../../shared/hotkey-vectors.json", import.meta.url), "utf8"));

test("isValidHotkey satisfies every shared hotkey vector", () => {
  for (const { spec, valid } of hotkeyVectors.cases) assert.equal(isValidHotkey(spec), valid, JSON.stringify(spec));
});

test("reserved hotkeys mirror shared/hotkey-vectors.json and are all rejected", () => {
  const { RESERVED_HOTKEYS } = sandbox.GhostPiPSettings;
  assert.deepEqual(plain(RESERVED_HOTKEYS), hotkeyVectors.reserved);
  for (const combo of hotkeyVectors.reserved) assert.equal(isValidHotkey(combo), false, combo);
});

test("formatKeyEvent never yields a combo the validator rejects", () => {
  assert.equal(formatKeyEvent({ shiftKey: true, code: "KeyA", key: "A" }), null);
  assert.equal(formatKeyEvent({ ctrlKey: true, code: "KeyC", key: "c" }), null);
  assert.equal(formatKeyEvent({ shiftKey: true, code: "F2", key: "F2" }), "Shift+F2");
});

test("dodge numeric fields clamp into their ranges in merge and patch", () => {
  const { DODGE_RANGES } = sandbox.GhostPiPSettings;
  const low = merge({ dodge: { marginPx: -5, edgeInsetPx: -1, hoverDelayMs: -10, cooldownMs: -1, returnDelayMs: -1, ignoreScreenEdgePx: -3 } });
  const high = merge({ dodge: { marginPx: 1e6, edgeInsetPx: 1e6, hoverDelayMs: 1e9, cooldownMs: 1e9, returnDelayMs: 1e9, ignoreScreenEdgePx: 1e6 } });
  for (const [k, [min, max]] of Object.entries(DODGE_RANGES)) {
    assert.equal(low.dodge[k], min, `${k} low`);
    assert.equal(high.dodge[k], max, `${k} high`);
  }
  const p = patch(merge(undefined), { dodge: { edgeInsetPx: 1e6, marginPx: 40 } });
  assert.equal(p.ok, true);
  assert.equal(p.settings.dodge.edgeInsetPx, DODGE_RANGES.edgeInsetPx[1]);
  assert.equal(p.settings.dodge.marginPx, 40);
  assert.equal(patch(merge(undefined), { dodge: { marginPx: "x" } }).ok, false);
});

test("dodge.js validates corners with the settings.js table and rejects unknown axis or corner", () => {
  const box = {};
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/shared/settings.js", import.meta.url), "utf8"), box);
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/content/dodge.js", import.meta.url), "utf8"), box);
  const S = box.GhostPiPSettings;
  const D = box.GhostPiPDodge;
  const subsets = [];
  for (let mask = 0; mask < 16; mask++) subsets.push(S.CORNERS.filter((_, i) => mask & (1 << i)));
  for (const allowed of subsets) {
    for (const axis of [...Object.keys(S.PAIRS), "diagonal", "toString"]) {
      for (const home of [...S.CORNERS, "XX"]) {
        assert.equal(D.isValidDodge(allowed, axis, home), S.isValidDodge(allowed, axis, home), `${allowed}|${axis}|${home}`);
      }
    }
  }
  assert.equal(D.isValidDodge(["TL", "TR", "ZZ"], "free", "TL"), false);
  assert.equal(D.isValidDodge(["TL", "TR"], "diagonal", "TL"), false);
});

test("HOLD_MATCH, PEEK_MATCH, stepPeekInput, isEditableTarget, isMousePeekButton, and matchShortcut", () => {
  assert.equal(HOLD_MATCH["Ctrl+Alt"]({ ctrlKey: true, altKey: true }), true);
  assert.equal(HOLD_MATCH["Ctrl+Alt"]({ ctrlKey: true, altKey: false }), false);
  assert.equal(HOLD_MATCH.Shift({ shiftKey: true }), true);

  let st = createPeekInput();
  assert.equal(PEEK_MATCH.Alt(st), false);
  st = stepPeekInput(st, "keydown", { key: "Alt", altKey: true });
  assert.equal(PEEK_MATCH.Alt(st), true);
  st = stepPeekInput(st, "keyup", { key: "Alt", altKey: false });
  assert.equal(PEEK_MATCH.Alt(st), false);

  st = stepPeekInput(st, "keydown", { code: "Backquote", key: "`" });
  assert.equal(PEEK_MATCH.Backquote(st), true);
  st = stepPeekInput(st, "buttondown", { button: 3, buttons: 8 });
  assert.equal(PEEK_MATCH.Mouse4(st), true);
  st = stepPeekInput(st, "buttonup", { button: 3, buttons: 0 });
  assert.equal(PEEK_MATCH.Mouse4(st), false);
  st = stepPeekInput(st, "reset");
  assert.equal(PEEK_MATCH.Backquote(st), false);

  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
  assert.equal(isEditableTarget(null), false);

  const peekMouse4 = merge({ peek: { enabled: true, key: "Mouse4" } });
  assert.equal(isMousePeekButton(peekMouse4, 3, true), true);
  assert.equal(isMousePeekButton(peekMouse4, 4, true), false);
  assert.equal(isMousePeekButton(peekMouse4, 3, false), false);

  const customHk = merge({
    media: { enabled: true, seekSec: 10 },
    hotkeys: { clickThrough: "Ctrl+Shift+X", playPause: "Alt+Space", seekBack: "Alt+Left", peek: "Alt+P" },
  });
  assert.deepEqual(
    plain(matchShortcut({ isTrusted: true, ctrlKey: true, shiftKey: true, code: "KeyX", key: "X" }, customHk)),
    { type: "INTENT", intent: "TOGGLE_CLICK_THROUGH" },
  );
  assert.equal(
    matchShortcut({ isTrusted: true, altKey: true, code: "KeyG", key: "g" }, merge(undefined)),
    null,
  );
  assert.deepEqual(
    plain(matchShortcut({ altKey: true, code: "Space", key: " " }, customHk)),
    { type: "MEDIA_ACTION", action: "PLAY_PAUSE" },
  );
  assert.deepEqual(
    plain(matchShortcut({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" }, customHk)),
    { type: "MEDIA_ACTION", action: "SEEK", deltaSec: -10 },
  );
  assert.equal(
    matchShortcut({ altKey: true, code: "Space", key: " " }, customHk, { engineConnected: true }),
    null,
  );
  assert.equal(
    matchShortcut({ altKey: true, code: "Space", key: " ", target: { tagName: "INPUT" } }, customHk),
    null,
  );
});
