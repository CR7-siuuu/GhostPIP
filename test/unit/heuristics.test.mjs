import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const load = (rel) => {
  const box = {};
  vm.runInNewContext(fs.readFileSync(new URL(`../../extension/${rel}`, import.meta.url), "utf8"), box);
  return box;
};
const H = load("content/heuristics.js").GhostPiPHeuristics;
const S = load("content/subtitles.js").GhostPiPSubtitles;

test("ad skip labels need both skip and ad wording", () => {
  for (const label of ["광고 건너뛰기", "광고 건너뛰기 ▶", "광고 스킵", "Skip Ad", "Skip ads", "SKIP AD 5", "Skip sponsor", "Skip advertisement"]) {
    assert.equal(H.isAdSkipLabel(label), true, label);
    assert.equal(H.isAdSkipText(label), true, label);
  }
});

test("intro, recap and next-episode skip buttons never count as ads", () => {
  for (const label of [
    "건너뛰기", "Skip", "오프닝 건너뛰기", "인트로 건너뛰기", "요약 건너뛰기", "다음 화", "다음 화 보기",
    "Skip Intro", "Skip Recap", "Skip Opening", "Skip Credits", "Next Episode", "광고 없이 오프닝 건너뛰기",
  ]) {
    assert.equal(H.isAdSkipLabel(label), false, label);
  }
  assert.equal(H.isContentSkipLabel("오프닝 건너뛰기"), true);
  assert.equal(H.isContentSkipLabel("Skip Ad"), false);
});

test("long button text is not treated as an ad label", () => {
  assert.equal(H.isAdSkipLabel(`Skip ad ${"x".repeat(60)}`), false);
});

test("isGifLike flags silent looping or short clips and keeps real playback", () => {
  assert.equal(H.isGifLike({ loop: true }), true);
  assert.equal(H.isGifLike({ duration: 12 }), true);
  assert.equal(H.isGifLike({ duration: Infinity, muted: true, controls: false, paused: false, currentTime: 3 }), true);
  assert.equal(H.isGifLike({ loop: true, webkitAudioDecodedByteCount: 10 }), false);
  assert.equal(H.isGifLike({ duration: 1200, muted: false, controls: true }), false);
  assert.equal(H.isGifLike({ duration: Infinity, muted: true, controls: true, paused: false, currentTime: 3 }), false);
  assert.equal(H.isGifLike({ duration: NaN, muted: true, controls: false, paused: false, currentTime: 0.5 }), false);
});

test("stripCueMarkup removes tags and style blocks and decodes entities", () => {
  assert.equal(S.stripCueMarkup("<c.yellow>Hi</c><br/>there {\\an8}&amp; you"), "Hi\nthere & you");
  assert.equal(S.stripCueMarkup("&lt;b&gt; &quot;x&quot; &#39;y&#39;&nbsp;z"), "<b> \"x\" 'y' z");
  assert.equal(S.stripCueMarkup(null), "");
});

test("normalizeLines collapses whitespace, drops repeats and caps at four lines", () => {
  assert.equal(S.normalizeLines(["  a  b ", "a b", "", null, "c\r\nd\ne\nf"]), "a b\nc\nd\ne");
  assert.equal(S.normalizeLines([]), "");
});
