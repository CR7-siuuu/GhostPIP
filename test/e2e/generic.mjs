import http from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canvas-backed <video> elements so the page needs no media files. `real` is an unmuted player with
// controls; `gif` mimics a gifv clip (muted, looping, autoplay, no audio); `cover` is an image card
// laid over the real player but outside its wrapper.
const PAGE = (kind) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111">
<div id="player" style="position:absolute;left:40px;top:40px;width:640px;height:360px">
  ${kind === "gif" ? "" : '<video id="real" controls autoplay playsinline style="width:640px;height:360px"></video>'}
</div>
${kind === "gif" ? '<video id="gif" muted loop autoplay playsinline style="position:absolute;left:40px;top:40px;width:640px;height:360px"></video>' : ""}
${kind === "cover" ? '<div id="cover" style="position:absolute;left:400px;top:200px;width:240px;height:160px;background:#c33"></div>' : ""}
<script>
  const c = document.createElement("canvas"); c.width = 320; c.height = 180;
  const g = c.getContext("2d"); let n = 0;
  setInterval(() => { g.fillStyle = "hsl(" + (n++ * 7 % 360) + ",70%,50%)"; g.fillRect(0, 0, 320, 180); }, 33);
  for (const v of document.querySelectorAll("video")) { v.srcObject = c.captureStream(30); v.play().catch(() => {}); }
</script>`;

const server = http.createServer((req, res) => {
  const kind = new URL(req.url, "http://x").searchParams.get("kind") || "real";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE(kind));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: { width: 1000, height: 700 },
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run"],
});

const results = [];
try {
  const extId = await browser.installExtension(path.join(ROOT, "extension"));
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
  );
  const sw = await swTarget.worker();
  const setAllSites = (on) =>
    sw.evaluate(async (on) => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...GhostPiPSettings.merge(settings), allSites: on } });
    }, on);

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const launcherOpen = () =>
    page.evaluate(() => Boolean(document.getElementById("ghostpip-launcher")?.matches(":popover-open")));

  // OTT origins are served the same canvas test page via interception, so the content script sees
  // a real netflix.com / coupangplay.com URL without needing an account or DRM.
  const OTT_HOSTS = ["www.netflix.com", "www.coupangplay.com"];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (OTT_HOSTS.includes(u.hostname) && req.resourceType() === "document") {
      req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE(u.searchParams.get("kind") || "real") });
    } else if (OTT_HOSTS.includes(u.hostname)) {
      req.respond({ status: 404, body: "" });
    } else {
      req.continue();
    }
  });

  async function hoverAt(kind, x, y, origin = base) {
    await page.goto(`${origin}?kind=${kind}`, { waitUntil: "load" });
    await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.videoWidth > 0));
    await sleep(2200);
    await page.mouse.move(5, 5);
    await sleep(150);
    await page.mouse.move(x, y, { steps: 6 });
    await sleep(700);
    return launcherOpen();
  }

  async function check(name, want, fn) {
    const got = await fn();
    results.push({ name, ok: got === want, info: `launcher=${got} want=${want}` });
  }

  await setAllSites(true);
  await check("1 real player shows launcher", true, () => hoverAt("real", 200, 150));
  await check("2 gif-like clip shows nothing", false, () => hoverAt("gif", 200, 150));
  await check("3 image over player shows nothing", false, () => hoverAt("cover", 500, 260));
  await check("4 player beside image still shows", true, () => hoverAt("cover", 150, 120));
  await setAllSites(false);
  await check("5 allSites off hides on generic", false, () => hoverAt("real", 200, 150));
  await check("6 allSites off, netflix player shows", true, () => hoverAt("real", 200, 150, "https://www.netflix.com/watch/1"));
  await check("7 allSites off, coupangplay shows", true, () => hoverAt("real", 200, 150, "https://www.coupangplay.com/play/1"));
  await check("8 OTT preview clip shows nothing", false, () => hoverAt("gif", 200, 150, "https://www.netflix.com/browse"));
  await setAllSites(true);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log("\n[generic e2e]");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name.padEnd(36)} ${r.info}`);
process.exit(results.length === 8 && results.every((r) => r.ok) ? 0 : 1);
