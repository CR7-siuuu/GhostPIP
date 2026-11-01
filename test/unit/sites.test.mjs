import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/config/selectors.json"), "utf8"));
const sites = Object.entries(cfg.sites).map(([id, s]) => ({ id, re: new RegExp(s.match), site: s }));
const siteFor = (url) => sites.find((s) => s.re.test(url))?.id ?? "generic";

const SUPPORTED = {
  "https://www.youtube.com/watch?v=jNQXAC9IVRw": "youtube",
  "https://chzzk.naver.com/live/64a90ba95d1f9feb0a798a20bbf0f40c": "chzzk",
  "https://chzzk.naver.com/video/1234567": "chzzkVod",
  "https://play.sooplive.co.kr/streamer/123456789": "soop",
  "https://vod.sooplive.co.kr/player/123456": "soop",
  "https://www.twitch.tv/somechannel": "twitch",
  "https://www.twitch.tv/somechannel?sr=a": "twitch",
  "https://www.twitch.tv/videos/2283746123": "twitchVod",
  "https://www.netflix.com/watch/81234567?trackId=1": "netflix",
  "https://www.disneyplus.com/ko-kr/play/abc-123": "disneyplus",
  "https://www.primevideo.com/detail/0ABCDEF/": "primevideo",
  "https://www.amazon.com/gp/video/detail/B0ABCDEFG": "primevideo",
  "https://www.amazon.co.jp/gp/video/detail/B0ABCDEFG": "primevideo",
  "https://www.coupangplay.com/play/abc": "coupangplay",
  "https://www.tving.com/player/E000001": "tving",
  "https://www.wavve.com/player/vod?contentid=1": "wavve",
  "https://watcha.com/watch/abc": "watcha",
  "https://laftel.net/player/123/456": "laftel",
  "https://serieson.naver.com/v3/movie/products/123": "serieson",
  "https://tv.apple.com/kr/episode/abc": "appletv",
  "https://play.max.com/video/watch/abc": "max",
  "https://www.hulu.com/watch/abc": "hulu",
  "https://www.paramountplus.com/shows/video/abc": "paramountplus",
  "https://www.peacocktv.com/watch/playback/vod/abc": "peacock",
  "https://www.crunchyroll.com/watch/ABC/def": "crunchyroll",
};

const NOT_SUPPORTED = [
  "https://www.amazon.com/dp/B0ABCDEFG",
  "https://www.youtube.com/",
  "https://www.reddit.com/r/videos/",
  "https://x.com/someone/status/1",
  "https://evilnetflix.com/watch/1",
  "https://www.netflix.com.attacker.example/watch/1",
];

test("streaming and OTT URLs resolve to their site entry", () => {
  for (const [url, want] of Object.entries(SUPPORTED)) assert.equal(siteFor(url), want, url);
});

test("other sites stay generic (gated by the allSites toggle)", () => {
  for (const url of NOT_SUPPORTED) assert.equal(siteFor(url), "generic", url);
});

test("every entry anchors its pattern and declares chatPopoutUrl", () => {
  for (const { id, site } of sites) {
    assert.ok(site.match.startsWith("^https://"), `${id} must anchor to https origin`);
    assert.ok("chatPopoutUrl" in site, `${id} must declare chatPopoutUrl`);
  }
});
