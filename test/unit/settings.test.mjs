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
  SEEK_STEPS,
  isValidDodge,
  isValidHotkey,
  formatKeyEvent,
  merge,
  patch,
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
