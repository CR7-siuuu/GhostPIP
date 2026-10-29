import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const code = readFileSync(new URL("extension/content/dodge.js", root), "utf8");
const vectors = JSON.parse(readFileSync(new URL("shared/dodge-vectors.json", root), "utf8"));

const sandbox = {};
vm.runInNewContext(code, sandbox);
const D = sandbox.GhostPiPDodge;

// Objects built inside the vm realm carry a foreign Object.prototype, which deepStrictEqual rejects.
const plain = (v) => JSON.parse(JSON.stringify(v));

const AREA = { l: 0, t: 0, r: 1920, b: 1080 };
const SIZE = { w: 480, h: 270 };
const CFG = {
  enabled: true, axis: "free", allowed: ["TL", "TR", "BL", "BR"], home: "BR", autoReturn: false,
  returnDelayMs: 2500, marginPx: 20, edgeInsetPx: 16, hoverDelayMs: 100, cooldownMs: 300,
  style: "move", ignoreScreenEdgePx: 0,
};

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    if (c.fn !== "step") {
      assert.deepEqual(plain(D[c.fn](...c.args)), c.expect);
      return;
    }
    const { corner, ...overrides } = c.start;
    let state = { ...D.initialState(corner), ...overrides };
    c.steps.forEach(({ input, expect }, i) => {
      const r = D.step(state, input, c.cfg);
      assert.deepEqual(plain(r.action), expect.action, `step ${i} action`);
      assert.equal(r.state.corner, expect.corner, `step ${i} corner`);
      if ("faded" in expect) assert.equal(r.state.faded, expect.faded, `step ${i} faded`);
      state = r.state;
    });
  });
}

test("vectors exercise every exported function", () => {
  const fns = new Set(vectors.cases.map((c) => c.fn));
  for (const fn of ["step", "isValidDodge", "cornerRect", "nearestCorner"]) assert.ok(fns.has(fn), fn);
});

test("api is frozen and CORNERS is in contract order", () => {
  assert.ok(Object.isFrozen(D));
  assert.deepEqual(plain(D.CORNERS), ["TL", "TR", "BL", "BR"]);
});

test("initialState matches the contract", () => {
  const s = D.initialState("TR");
  assert.equal(s.lastMoveAt, -Infinity);
  assert.deepEqual(plain({ ...s, lastMoveAt: 0 }), { corner: "TR", hoverSince: null, lastMoveAt: 0, outsideHomeSince: null, faded: false });
});

test("step never mutates its inputs and returns a fresh state", () => {
  const state = { ...D.initialState("BR"), hoverSince: 0 };
  const input = { now: 1000, cursor: { x: 1600, y: 900 }, size: SIZE, area: AREA };
  const cfg = { ...CFG, autoReturn: true };
  const before = structuredClone({ state, input, cfg });
  const r = D.step(state, input, cfg);
  assert.equal(r.action.type, "move");
  assert.notEqual(r.state, state);
  assert.deepEqual({ state, input, cfg }, before);
});

test("every move lands on an allowed, axis-reachable corner whose rect does not cover the cursor", () => {
  const AXES = ["free", "vertical", "horizontal"];
  const reachable = { free: () => true, vertical: (a, b) => a[1] === b[1], horizontal: (a, b) => a[0] === b[0] };
  const allowedSets = [];
  for (let mask = 1; mask < 16; mask++) allowedSets.push(D.CORNERS.filter((_, i) => mask & (1 << i)));
  const covers = (corner, p) => {
    const r = D.cornerRect(corner, SIZE, AREA, CFG.edgeInsetPx);
    const m = CFG.marginPx;
    return p.x >= r.l - m && p.x < r.r + m && p.y >= r.t - m && p.y < r.b + m;
  };
  let moves = 0;
  for (const axis of AXES) {
    for (const allowed of allowedSets) {
      for (const corner of allowed) {
        for (let x = -10; x <= 1930; x += 60) {
          for (let y = -10; y <= 1090; y += 40) {
            const cursor = { x, y };
            const state = { ...D.initialState(corner), hoverSince: 0 };
            const cfg = { ...CFG, axis, allowed, home: corner, hoverDelayMs: 0 };
            const { action } = D.step(state, { now: 1000, cursor, size: SIZE, area: AREA }, cfg);
            if (action.type !== "move") continue;
            moves++;
            const at = `${axis} ${allowed} ${corner} (${x},${y})`;
            assert.ok(covers(corner, cursor), `moved without hover: ${at}`);
            assert.ok(allowed.includes(action.corner), `not allowed: ${at}`);
            assert.ok(reachable[axis](corner, action.corner), `axis violated: ${at}`);
            assert.ok(!covers(action.corner, cursor), `target covers cursor: ${at}`);
          }
        }
      }
    }
  }
  assert.ok(moves > 1000, `only ${moves} moves sampled`);
});

test("cornerRect and nearestCorner round-trip for every corner", () => {
  for (const c of D.CORNERS) assert.equal(D.nearestCorner(D.cornerRect(c, SIZE, AREA, 16), AREA), c);
});
