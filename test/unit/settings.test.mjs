import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL("../../extension/shared/settings.js", import.meta.url), "utf8"), sandbox);
const { DEFAULTS, merge } = sandbox.GhostPiPSettings;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("missing or garbage storage yields defaults", () => {
  assert.deepEqual(plain(merge(undefined)), plain(DEFAULTS));
  assert.deepEqual(plain(merge("nope")), plain(DEFAULTS));
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
