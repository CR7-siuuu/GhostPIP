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
vm.runInNewContext(read("extension/content/dodge.js") + "\n" + read("extension/shared/settings.js"), lib);
const Dodge = lib.GhostPiPDodge;
const DEFAULTS = JSON.parse(JSON.stringify(lib.GhostPiPSettings.DEFAULTS));

const STEPS = [
  "1 start inTab on youtube",
  "2 switch to Tab B -> remote overlay",
  "3 ghost, wheel opacity, resize & free move in Tab B",
  "4 navigate or open Tab C -> follows custom size/pos/opacity",
  "5 restore from remote tab closes all",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 2) => Boolean(a && b) && ["l", "t", "r", "b"].every((k) => Math.abs(a[k] - b[k]) <= tol);
const fmt = (r) => r && `${Math.round(r.l)},${Math.round(r.t)}-${Math.round(r.r)},${Math.round(r.b)}`;
const center = (r) => ({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 });

async function poll(fn, ok, timeout = 2500) {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(80);
    v = await fn();
  }
  return v;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: null,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run"],
});

const row = Object.fromEntries(STEPS.map((s) => [s, { status: "FAIL", info: "not reached" }]));

async function step(name, fn) {
  try {
    const { ok, info } = await fn();
    row[name] = { status: ok ? "PASS" : "FAIL", info };
  } catch (e) {
    row[name] = { status: "FAIL", info: `threw: ${String(e.message ?? e).slice(0, 180)}` };
  }
}

try {
  const extId = await browser.installExtension(path.join(ROOT, "extension"));
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 10000 },
  );
  const sw = await swTarget.worker();

  const patchSettings = async (patch) =>
    sw.evaluate(async (patch) => {
      const { settings } = await chrome.storage.local.get("settings");
      const s = GhostPiPSettings.merge(settings);
      await chrome.storage.local.set({
        settings: { ...s, ...patch, dodge: { ...s.dodge, ...(patch.dodge ?? {}) } },
      });
    }, patch);

  const readSettings = () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);

  await sw.evaluate(async (defaults) => {
    const s = structuredClone(defaults);
    s.dodge.autoReturn = false;
    await chrome.storage.local.set({ settings: s });
    await chrome.storage.local.remove("floatLayout");
    await chrome.storage.session.remove(["pip", "engine", "inTab"]);
  }, DEFAULTS);

  const tabA = (await browser.pages())[0] ?? (await browser.newPage());
  {
    const cdp = await tabA.createCDPSession();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" },
    });
    await cdp.detach();
  }

  const readFloat = (page) =>
    page.evaluate(() => {
      const v = document.querySelector(".ghostpip-inpage-target");
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return {
        open: v.matches(":popover-open"),
        videoWidth: v.videoWidth || Number(v.dataset.gpVw) || 0,
        videoHeight: v.videoHeight || Number(v.dataset.gpVh) || 0,
        rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
        pe: getComputedStyle(v).pointerEvents,
        opacity: Number(getComputedStyle(v).opacity),
        area: { l: 0, t: 0, r: document.documentElement.clientWidth, b: document.documentElement.clientHeight },
        size: {
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? (Number(v.dataset.gpFrames) || 0),
      };
    });

  const measureRemoteLive = async (page) => {
    const f0 = await poll(
      () => readFloat(page),
      (f) => f?.open && f.videoWidth > 0 && f.frames > 0,
      2500,
    );
    if (!f0) return { f: null, framesDelta: 0, std: 0 };
    await sleep(450);
    const res = await page.evaluate(() => {
      const v = document.querySelector(".ghostpip-inpage-target");
      const vw = v?.videoWidth || Number(v?.dataset.gpVw) || 0;
      if (!v || !vw) return { frames: 0, std: 0 };
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 36;
      const g = c.getContext("2d");
      g.drawImage(v, 0, 0, 64, 36);
      const px = g.getImageData(0, 0, 64, 36).data;
      let sum = 0;
      let sq = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += l;
        sq += l * l;
      }
      const n = px.length / 4;
      return {
        frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? (Number(v.dataset.gpFrames) || 0),
        std: Math.round(Math.sqrt(sq / n - (sum / n) ** 2)),
      };
    });
    const f1 = await readFloat(page);
    return { f: f1, framesDelta: res.frames - f0.frames, std: res.std };
  };

  const shadowButton = (page, hostId, action) =>
    page.evaluate(
      (id, a) => {
        const host = document.getElementById(id);
        const b = host?.shadowRoot?.querySelector(`[data-action="${a}"]`);
        if (!host?.matches(":popover-open") || !b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      hostId,
      action,
    );

  const cornerOf = (corner, f) => Dodge.cornerRect(corner, f.size, f.area, DEFAULTS.dodge.edgeInsetPx);

  let tabB = null;
  let tabC = null;

  await step("1 start inTab on youtube", async () => {
    await tabA.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await tabA.waitForFunction(
      () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused && v.readyState >= 2),
      { timeout: 30000, polling: 500 },
    );
    await sleep(1500);

    const vCenter = await tabA.evaluate(() => {
      const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
      v.loop = true;
      window.__gpSourceVideo = v;
      const r = v.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await tabA.mouse.move(vCenter.x, vCenter.y, { steps: 6 });
    const btn = await poll(() => shadowButton(tabA, "ghostpip-launcher", "inTab"), Boolean, 2000);
    if (!btn) return { ok: false, info: "launcher inTab button did not open" };
    await tabA.mouse.click(btn.x, btn.y);

    const f = await poll(() => readFloat(tabA), (v) => v?.open && near(v.rect, cornerOf("BR", v)), 2000);
    const want = f && cornerOf("BR", f);
    const ok = Boolean(f?.open && near(f.rect, want));
    return { ok, info: `open=${f?.open} rect=${fmt(f?.rect)} want=${fmt(want)}` };
  });

  await step("2 switch to Tab B -> remote overlay", async () => {
    tabB = await browser.newPage();
    await tabB.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await tabB.bringToFront();

    const { f, framesDelta, std } = await measureRemoteLive(tabB);
    await tabB.screenshot({ path: path.join(OUT, "crosstab_2_tabB.png") }).catch(() => {});
    const want = f && cornerOf("BR", f);
    const ok = Boolean(f?.open && f.videoWidth > 0 && near(f.rect, want) && framesDelta > 0 && std > 5);
    return {
      ok,
      info: `open=${f?.open} videoW=${f?.videoWidth} rect=${fmt(f?.rect)} want=${fmt(want)} framesDelta=${framesDelta} std=${std}`,
    };
  });

  await step("3 ghost, wheel opacity, resize & free move in Tab B", async () => {
    await patchSettings({ clickThrough: true, opacity: 0.5, dodge: { enabled: false } });
    const ghost = await poll(
      () => readFloat(tabB),
      (f) => f?.pe === "none" && Math.abs(f.opacity - 0.5) < 0.05,
      2000,
    );
    const ghostCenter = center(ghost.rect);
    await tabB.mouse.move(ghostCenter.x, ghostCenter.y, { steps: 4 });
    const ctrlHiddenInClickThrough = await tabB.evaluate(() => {
      const host = document.getElementById("ghostpip-controller");
      return !host?.matches(":popover-open");
    });
    await tabB.keyboard.down("Control");
    await tabB.keyboard.down("Alt");
    const held = await poll(
      () =>
        tabB.evaluate(() => {
          const v = document.querySelector(".ghostpip-inpage-target");
          const host = document.getElementById("ghostpip-controller");
          if (!v) return null;
          return {
            pe: getComputedStyle(v).pointerEvents,
            opacity: Number(getComputedStyle(v).opacity),
            ctrlOpen: Boolean(host?.matches(":popover-open")),
          };
        }),
      (f) => f?.pe === "auto" && Math.abs(f.opacity - 1) < 0.05 && f.ctrlOpen === true,
      1500,
    );
    await tabB.mouse.move(10, 10);
    await tabB.keyboard.up("Alt");
    await tabB.keyboard.up("Control");
    await patchSettings({ clickThrough: false, opacity: DEFAULTS.opacity, dodge: { enabled: true } });
    await poll(() => readFloat(tabB), (f) => f?.pe === "auto", 1500);

    const f0 = await readFloat(tabB);
    const c0 = center(f0.rect);
    await tabB.mouse.move(c0.x, c0.y, { steps: 8 });
    const wantTl = cornerOf("TL", f0);
    const dodged = await poll(() => readFloat(tabB), (f) => near(f?.rect, wantTl), 2500);

    await tabB.keyboard.down("Control");
    await tabB.keyboard.down("Alt");
    const sePos = await poll(
      () =>
        tabB.evaluate(() => {
          const host = document.getElementById("ghostpip-controller");
          const h = host?.shadowRoot?.querySelector('[data-resize="se"]');
          if (!host?.matches(":popover-open") || !h) return null;
          const r = h.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }),
      Boolean,
      1500,
    );
    await tabB.mouse.move(sePos.x, sePos.y, { steps: 5 });
    await tabB.mouse.down();
    await tabB.mouse.move(sePos.x - 120, sePos.y - 90, { steps: 10 });
    await tabB.mouse.up();
    await sleep(150);
    const resized = await readFloat(tabB);

    const from = center(resized.rect);
    const targetL = 80;
    const targetT = 320;
    await tabB.mouse.move(from.x, from.y, { steps: 5 });
    await sleep(100);
    await tabB.mouse.down();
    await tabB.mouse.move(targetL + resized.size.w / 2, targetT + resized.size.h / 2, { steps: 12 });
    await tabB.mouse.up();
    await sleep(100);

    const movedCenter = { x: targetL + resized.size.w / 2, y: targetT + resized.size.h / 2 };
    await tabB.mouse.move(movedCenter.x, movedCenter.y);
    await tabB.mouse.wheel({ deltaY: 100 });
    await sleep(60);
    await tabB.mouse.wheel({ deltaY: 100 });
    await sleep(150);

    await tabB.keyboard.up("Alt");
    await tabB.keyboard.up("Control");
    await sleep(300);

    const hoverBar = await tabB.evaluate(() => {
      const host = document.getElementById("ghostpip-controller");
      const bar = host?.shadowRoot?.querySelector(".bar");
      const chatBtn = host?.shadowRoot?.querySelector('[data-action="toggleWebChat"]');
      const beforeText = chatBtn?.textContent?.trim() ?? "";
      chatBtn?.click();
      const chatHost = document.getElementById("ghostpip-chat");
      const chatFrame = chatHost?.shadowRoot?.querySelector("iframe");
      const chatOpened = Boolean(chatHost?.matches(":popover-open") && chatFrame?.getAttribute("src"));
      const openedText = chatBtn?.textContent?.trim() ?? "";
      chatBtn?.click();
      return {
        open: !!host?.matches(":popover-open"),
        barOnly: !!host?.hasAttribute("data-bar-only"),
        barOpacity: bar ? getComputedStyle(bar).opacity : "0",
        chatBtnVisible: Boolean(chatBtn && getComputedStyle(chatBtn).display !== "none"),
        chatBtnText: beforeText,
        chatOpened,
        openedText,
      };
    });

    const finalB = await readFloat(tabB);
    const wantCustom = { l: targetL, t: targetT, r: targetL + 360, b: targetT + 270 };
    const stored = await poll(readSettings, (s) => s?.dodge?.home === "BL" && Math.abs(s.opacity - 0.6) < 0.02, 1500);
    await tabB.screenshot({ path: path.join(OUT, "crosstab_3_dodge_drag.png") }).catch(() => {});

    const ok =
      ghost?.pe === "none" &&
      Math.abs(ghost.opacity - 0.5) < 0.05 &&
      ctrlHiddenInClickThrough === true &&
      held?.pe === "auto" &&
      held?.ctrlOpen === true &&
      near(dodged?.rect, wantTl) &&
      Math.abs(resized.size.w - 360) <= 4 &&
      near(finalB?.rect, wantCustom, 4) &&
      Math.abs((finalB?.opacity ?? 0) - 0.6) < 0.02 &&
      stored?.dodge?.home === "BL" &&
      hoverBar.open &&
      hoverBar.barOnly &&
      hoverBar.barOpacity === "1" &&
      hoverBar.chatBtnVisible === true &&
      hoverBar.chatBtnText === "채팅창 보기" &&
      hoverBar.chatOpened === true &&
      hoverBar.openedText === "채팅창 숨기기";
    return {
      ok,
      info: `ghost=(${ghost?.pe},${ghost?.opacity}) dodged=${fmt(dodged?.rect)} resized=${resized?.size.w}x${resized?.size.h} customRect=${fmt(finalB?.rect)}(want ${fmt(wantCustom)}) opacity=${finalB?.opacity} home=${stored?.dodge?.home} hoverBar=(open=${hoverBar.open},barOnly=${hoverBar.barOnly},op=${hoverBar.barOpacity},chat="${hoverBar.chatBtnText}"->"${hoverBar.openedText}",chatOpen=${hoverBar.chatOpened})`,
    };
  });

  await step("4 navigate or open Tab C -> follows custom size/pos/opacity", async () => {
    await tabB.goto("https://example.net", { waitUntil: "domcontentloaded", timeout: 30000 });
    const navB = await measureRemoteLive(tabB);

    tabC = await browser.newPage();
    await tabC.goto("https://example.org", { waitUntil: "domcontentloaded", timeout: 30000 });
    await tabC.bringToFront();

    const { f, framesDelta, std } = await measureRemoteLive(tabC);
    const wantCustom = { l: 80, t: 320, r: 440, b: 590 };
    const fsettled = await poll(() => readFloat(tabC), (v) => near(v?.rect, wantCustom, 4), 2000);
    await tabC.screenshot({ path: path.join(OUT, "crosstab_4_tabC_BL.png") }).catch(() => {});
    const ok = Boolean(
      navB.f?.open &&
        navB.framesDelta > 0 &&
        navB.std > 5 &&
        fsettled?.open &&
        fsettled.videoWidth > 0 &&
        near(fsettled.rect, wantCustom, 4) &&
        Math.abs(fsettled.opacity - 0.6) < 0.02 &&
        framesDelta > 0 &&
        std > 5,
    );
    return {
      ok,
      info: `navB=(framesDelta=${navB.framesDelta},std=${navB.std}) tabC=(open=${fsettled?.open} size=${fsettled?.size.w}x${fsettled?.size.h} rect=${fmt(fsettled?.rect)} opacity=${fsettled?.opacity} framesDelta=${framesDelta} std=${std})`,
    };
  });

  await step("5 restore from remote tab closes all", async () => {
    await tabC.keyboard.down("Control");
    await tabC.keyboard.down("Alt");
    await tabC.mouse.move(20, 20, { steps: 3 });
    const btn = await poll(() => shadowButton(tabC, "ghostpip-controller", "idle"), Boolean, 1500);
    if (!btn) {
      await tabC.keyboard.up("Alt");
      await tabC.keyboard.up("Control");
      return { ok: false, info: "controller idle button not open in Tab C" };
    }
    await tabC.mouse.move(btn.x, btn.y, { steps: 5 });
    await tabC.mouse.click(btn.x, btn.y);
    await tabC.keyboard.up("Alt");
    await tabC.keyboard.up("Control");

    const removedInC = (await poll(() => readFloat(tabC), (f) => f === null, 2000)) === null;
    await tabA.bringToFront();
    const restoredInA = await poll(
      () =>
        tabA.evaluate(() => {
          const v = window.__gpSourceVideo;
          return {
            open: v.matches(":popover-open"),
            hasClass: v.classList.contains("ghostpip-inpage-target"),
            hasPopover: v.hasAttribute("popover"),
          };
        }),
      (s) => !s.open && !s.hasClass && !s.hasPopover,
      2000,
    );
    await tabA.screenshot({ path: path.join(OUT, "crosstab_5_restored.png") }).catch(() => {});
    const ok = removedInC && !restoredInA.open && !restoredInA.hasClass && !restoredInA.hasPopover;
    return {
      ok,
      info: `removedInC=${removedInC} tabA=(open=${restoredInA.open}, hasClass=${restoredInA.hasClass}, hasPopover=${restoredInA.hasPopover})`,
    };
  });
} finally {
  await browser.close();
}

console.log("\n[crosstab e2e]");
for (const s of STEPS) {
  console.log(`  ${row[s].status.padEnd(4)} ${s.padEnd(48)} ${row[s].info}`);
}
const failed = STEPS.some((s) => row[s].status !== "PASS");
process.exit(failed ? 1 : 0);
