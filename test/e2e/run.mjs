import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "test/e2e/out");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lib = {};
vm.runInNewContext(read("extension/shared/settings.js"), lib);
const DEFAULTS = JSON.parse(JSON.stringify(lib.GhostPiPSettings.DEFAULTS));
const SITES = JSON.parse(read("extension/config/selectors.json")).sites;

const FIND = {
  twitch: ["https://www.twitch.tv/directory/all",
    () => [...document.querySelectorAll('a[data-a-target="preview-card-image-link"]')].map((a) => a.href)[0]],
  chzzk: ["https://chzzk.naver.com/lives",
    () => [...document.querySelectorAll('a[href*="/live/"]')].map((a) => a.href)[0]],
  soop: ["https://www.sooplive.co.kr/",
    () => [...document.querySelectorAll('a[href*="play.sooplive."]')].map((a) => a.href).find((h) => /\/\d+/.test(h))],
};
const TARGETS = [
  { name: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  { name: "twitch" },
  { name: "chzzk" },
  { name: "soop" },
].filter((t) => process.argv.length <= 2 || process.argv.slice(2).includes(t.name));

const STEPS = ["1 launcher", "2 docPip"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: null,
  // --window-size would also force the Document PiP window to that size, so size the window via CDP.
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=ko"],
});
const extId = await browser.installExtension(path.join(ROOT, "extension"));

async function worker() {
  const t = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 10000 },
  );
  return t.worker();
}

async function resetSettings(patch = {}) {
  const w = await worker();
  await w.evaluate(async (defaults, patch) => {
    const s = structuredClone(defaults);
    Object.assign(s.dodge, patch.dodge ?? {});
    await chrome.storage.local.set({ settings: { ...s, ...patch, dodge: s.dodge }, gpTestHooks: true });
  }, DEFAULTS, patch);
}

async function patchSettings(patch) {
  const w = await worker();
  await w.evaluate(async (patch) => {
    const { settings } = await chrome.storage.local.get("settings");
    const s = GhostPiPSettings.merge(settings);
    await chrome.storage.local.set({ settings: { ...s, ...patch, dodge: { ...s.dodge, ...(patch.dodge ?? {}) } } });
  }, patch);
}

const readPip = async () => (await worker()).evaluate(async () => (await chrome.storage.session.get("pip")).pip ?? {});

async function poll(fn, ok, timeout = 2000) {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

async function discover(page, name) {
  const [list, expr] = FIND[name];
  await page.goto(list, { waitUntil: "domcontentloaded", timeout: 30000 });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const url = await page.evaluate(expr).catch(() => null);
    if (url) return url;
    await sleep(500);
  }
  return null;
}

async function runSite(page, target) {
  const row = Object.fromEntries(STEPS.map((s) => [s, { status: "FAIL", info: "not reached" }]));
  const skipAll = (why) => {
    for (const s of STEPS) row[s] = { status: "SKIP", info: why };
    return row;
  };

  const url = target.url ?? (await discover(page, target.name).catch(() => null));
  if (!url) return skipAll("live channel discovery failed");
  row.url = url;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const playing = await page
    .waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused && v.readyState >= 2),
      { timeout: 30000, polling: 500 })
    .then(() => true, () => false);
  if (!playing) return skipAll("no playing <video> before the extension acted");
  await sleep(2000);

  const siteEntry = Object.entries(SITES).find(([, s]) => new RegExp(s.match).test(page.url()));
  const selector = siteEntry?.[1].video ?? null;
  row.siteId = siteEntry?.[0] ?? "generic";
  await resetSettings({ dodge: { autoReturn: false } });

  row.selector = await page.evaluate((sel) => {
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const pick = (l) => [...l].filter((v) => v.videoWidth > 0).sort((a, b) => area(b) - area(a))[0];
    const v = (sel && pick(document.querySelectorAll(sel))) || pick(document.querySelectorAll("video"));
    v.loop = true;
    window.__gp = { v, parent: v.parentNode, next: v.nextSibling };
    return sel ? `${sel} → ${v.matches(sel) ? "matched" : "NOT matched (fallback)"}` : "generic fallback";
  }, selector);

  const videoRect = () => page.evaluate(() => {
    const r = window.__gp.v.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  });
  const advancing = async () => {
    const t0 = await page.evaluate(() => window.__gp.v.currentTime);
    await sleep(1200);
    const t1 = await page.evaluate(() => window.__gp.v.currentTime);
    return { ok: t1 - t0 > 0.3, dt: +(t1 - t0).toFixed(2) };
  };
  const shadowButton = (hostId, action) => page.evaluate((id, a) => {
    const host = document.getElementById(id);
    const b = host?.shadowRoot?.querySelector(`[data-action="${a}"]`);
    if (!host?.matches(":popover-open") || !b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, hostId, action);
  const center = (r) => ({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 });
  const shot = (step) => page.screenshot({ path: path.join(OUT, `${target.name}_${step}.png`) }).catch(() => {});

  async function step(name, fn) {
    try {
      const { ok, info } = await fn();
      row[name] = { status: ok ? "PASS" : "FAIL", info };
    } catch (e) {
      row[name] = { status: "FAIL", info: `threw: ${String(e.message ?? e).slice(0, 160)}` };
    }
  }

  async function hoverLauncher(action) {
    const c = center(await videoRect());
    await page.mouse.move(c.x, c.y, { steps: 8 });
    return poll(() => shadowButton("ghostpip-launcher", action), Boolean, 1500);
  }

  await step("1 launcher", async () => {
    await page.mouse.move(5, 5, { steps: 3 });
    await sleep(700);
    const before = await page.evaluate(() => {
      const host = document.getElementById("ghostpip-launcher");
      return { open: !!host?.matches(":popover-open"), pinned: !!host?.hasAttribute("data-pinned") };
    });
    const b = await hoverLauncher("docPip");
    const meta = await page.evaluate(() => {
      const host = document.getElementById("ghostpip-launcher");
      const bar = host?.shadowRoot?.querySelector(".bar");
      const btns = [...(host?.shadowRoot?.querySelectorAll("button") ?? [])].map((el) => el.textContent.trim());
      const vr = window.__gp.v.getBoundingClientRect();
      const br = bar?.getBoundingClientRect();
      const centerDiff = br ? Math.abs((br.left + br.right) / 2 - (vr.left + vr.right) / 2) : 999;
      return { btns, centerDiff: Math.round(centerDiff), barW: Math.round(br?.width ?? 0) };
    });
    const ok =
      !!b &&
      (!before.open || before.pinned) &&
      meta.btns.join(",") === "PiP 열기" &&
      meta.centerDiff <= 4;
    return {
      ok,
      info: `beforeHover open=${before.open} pinned=${before.pinned}; btns=[${meta.btns.join(", ")}] centerDiff=${meta.centerDiff}px barW=${meta.barW}px`,
    };
  });

  await step("2 docPip", async () => {
    await page.mouse.move(5, 5, { steps: 3 });
    const b = await hoverLauncher("docPip");
    if (!b) return { ok: false, info: "launcher not open" };
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.click(b.x, b.y);
    const opened = await page
      .waitForFunction(() => documentPictureInPicture.window?.document.querySelector("video"), { timeout: 6000, polling: 200 })
      .then(() => true, () => false);
    if (!opened) return { ok: false, info: "documentPictureInPicture.window did not open" };
    await sleep(2500);
    const r = await page.evaluate(async () => {
      const w = documentPictureInPicture.window;
      const m = w.document.querySelector("video");
      const c = w.document.createElement("canvas");
      c.width = 64;
      c.height = 36;
      const g = c.getContext("2d");
      g.drawImage(m, 0, 0, 64, 36);
      const px = g.getImageData(0, 0, 64, 36).data;
      let sum = 0, sq = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += l;
        sq += l * l;
      }
      const n = px.length / 4;
      return {
        mirrorW: m.videoWidth,
        std: Math.round(Math.sqrt(sq / n - (sum / n) ** 2)),
        iframe: w.document.querySelector("iframe")?.src ?? null,
        inPlace: window.__gp.v.isConnected && window.__gp.v.parentNode === window.__gp.parent,
        sourceHidden: window.__gp.v.classList.contains("ghostpip-docpip-source") && getComputedStyle(window.__gp.v).filter.includes("brightness(0)"),
        live: { x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight },
      };
    });
    const adv = await advancing();
    const pip = Object.values(await poll(readPip, (p) => Object.values(p).some((e) => e.kind === "document"), 1500));
    const reported = pip.find((e) => e.kind === "document");
    const rectMatches = !!reported && ["x", "y", "w", "h"].every((k) => Math.abs(reported.rect[k] - r.live[k]) <= 4);
    const site = SITES[row.siteId];
    let wantChat = null;
    if (row.siteId === "chzzk" || row.siteId === "twitch") {
      const id = new URL(page.url()).pathname.split("/")[site.idFrom.pathIndex];
      wantChat = site.chatPopoutUrl.replace(/\{\w+\}/, encodeURIComponent(id));
    }
    await patchSettings({ showChat: false });
    const chatRemoved = await poll(
      () => page.evaluate(() => documentPictureInPicture.window?.document.querySelector("iframe") === null),
      Boolean,
      1500,
    );
    await patchSettings({ showChat: true });
    await shot("2_docPip");
    await page.evaluate(() => documentPictureInPicture.window.close());
    const cleared = Object.keys(await poll(readPip, (p) => Object.keys(p).length === 0, 2000)).length === 0;
    const restoredSource = await page.evaluate(() => !window.__gp.v.classList.contains("ghostpip-docpip-source"));
    const ok = r.mirrorW > 0 && r.std > 5 && r.inPlace && r.sourceHidden && restoredSource
      && adv.ok && rectMatches && cleared && chatRemoved
      && (!wantChat || r.iframe === wantChat);
    return {
      ok,
      info: `mirrorW=${r.mirrorW} std=${r.std} inPlace=${r.inPlace} srcHidden=${r.sourceHidden}->restored=${restoredSource} dt=${adv.dt} chatRemoved=${chatRemoved} PIP_OPENED=${reported ? JSON.stringify(reported.rect) : "none"} live=${JSON.stringify(r.live)} closedCleared=${cleared} iframe=${r.iframe}${wantChat ? ` want=${wantChat}` : ""}`,
    };
  });

  return row;
}

const results = {};
const page = (await browser.pages())[0] ?? (await browser.newPage());
{
  const cdp = await page.createCDPSession();
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" } });
  await cdp.detach();
}
for (const target of TARGETS) {
  try {
    results[target.name] = await runSite(page, target);
  } catch (e) {
    results[target.name] = Object.fromEntries(STEPS.map((s) => [s, { status: "FAIL", info: `site threw: ${e.message}` }]));
  }
  const r = results[target.name];
  console.log(`\n[${target.name}] ${r.url ?? ""} site=${r.siteId ?? "-"} selector=${r.selector ?? "-"}`);
  for (const s of STEPS) console.log(`  ${r[s].status.padEnd(4)} ${s.padEnd(20)} ${r[s].info}`);
}
await browser.close();

const names = Object.keys(results);
console.log(`\n| step | ${names.join(" | ")} |\n|---|${names.map(() => "---").join("|")}|`);
for (const s of STEPS) console.log(`| ${s} | ${names.map((n) => results[n][s].status).join(" | ")} |`);
const failed = names.some((n) => STEPS.some((s) => results[n][s].status === "FAIL"));
process.exit(failed ? 1 : 0);
