import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL("../../extension/shared/settings.js", import.meta.url), "utf8"), sandbox);
const { CORNERS, DEFAULTS, HOLD_KEYS, isValidDodge, isValidHotkey, formatKeyEvent, merge, patch } = sandbox.GhostPiPSettings;
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
    hotkeys: { clickThrough: "Ctrl+Shift+X", dodge: "F8", mute: "Alt+`", hold: "Alt" },
  });
  assert.equal(custom.hotkeys.clickThrough, "Ctrl+Shift+X");
  assert.equal(custom.hotkeys.dodge, "F8");
  assert.equal(custom.hotkeys.mute, "Alt+`");
  assert.equal(custom.hotkeys.hold, "Alt");
});
