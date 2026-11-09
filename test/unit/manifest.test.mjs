import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (rel) => fs.readFileSync(new URL(`../../extension/${rel}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const cfg = JSON.parse(read("config/selectors.json"));
const box = { URL, URLSearchParams };
vm.runInNewContext(read("shared/protocol.js"), box);
const P = box.GhostPiPProtocol;

const supportedHosts = [...new Set(Object.values(cfg.sites).flatMap((s) => s.hosts))].sort();
const BROAD = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|https?:\/\/\*\.\*\/\*)$/;

function patternMatches(pattern, href) {
  const m = /^(https?):\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern);
  assert.ok(m, `unexpected host pattern ${pattern}`);
  const u = new URL(href);
  if (u.protocol !== `${m[1]}:`) return false;
  return m[2] ? u.hostname === m[3] || u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
}

test("required host permissions are exactly the supported sites", () => {
  assert.deepEqual([...manifest.host_permissions].sort(), supportedHosts);
  for (const p of [...manifest.host_permissions, ...manifest.permissions]) assert.doesNotMatch(p, BROAD, p);
});

test("all-sites access is optional and matches the runtime registration", () => {
  assert.deepEqual([...manifest.optional_host_permissions].sort(), [...P.ALL_SITES_ORIGINS].sort());
});

test("the static content script covers exactly the supported sites with the shared file list", () => {
  const [main] = manifest.content_scripts;
  assert.deepEqual([...main.matches].sort(), supportedHosts);
  assert.deepEqual(main.js, [...P.CONTENT_JS]);
  assert.deepEqual(main.css, [...P.CONTENT_CSS]);
  for (const m of main.matches) assert.doesNotMatch(m, BROAD, m);
});

test("every site's own hosts cover the URLs its pattern accepts", () => {
  const samples = {
    youtube: ["https://www.youtube.com/watch?v=a", "https://m.youtube.com/watch?v=a"],
    soop: ["https://play.sooplive.co.kr/x/1", "https://vod.sooplive.com/player/1"],
    primevideo: ["https://www.amazon.co.jp/gp/video/detail/x", "https://www.primevideo.com/detail/x"],
    max: ["https://play.max.com/video/x", "https://hbomax.com/x"],
    disneyplus: ["https://disneyplus.com/x", "https://www.disneyplus.com/x"],
  };
  for (const [id, urls] of Object.entries(samples)) {
    const site = cfg.sites[id];
    for (const href of urls) {
      assert.match(href, new RegExp(site.match), href);
      assert.ok(site.hosts.some((h) => patternMatches(h, href)), `${id} hosts miss ${href}`);
    }
  }
});

test("chat framing is no longer a static, unscoped ruleset", () => {
  assert.equal(manifest.declarative_net_request, undefined);
  assert.ok(manifest.permissions.includes("declarativeNetRequest"));
  for (const r of P.chatFramingRules("x")) assert.ok(r.condition.initiatorDomains?.length, `rule ${r.id} lacks initiator scope`);
});

test("chat-frame content script only targets the framed chat pages", () => {
  const chat = manifest.content_scripts[1];
  assert.deepEqual(chat.js, ["content/chat-frame.js"]);
  for (const m of chat.matches) assert.ok(/(chzzk\.naver\.com|youtube\.com|twitch\.tv)\//.test(m), m);
});
