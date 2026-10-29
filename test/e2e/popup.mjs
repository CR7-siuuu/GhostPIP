import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "test/e2e/out");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

const lib = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "extension/shared/settings.js"), "utf8"), lib);
const DEFAULTS = JSON.parse(JSON.stringify(lib.GhostPiPSettings.DEFAULTS));

const STEPS = [
  "1 initial & engine live",
  "2 popup -> content live",
  "3 corner invariant",
  "4 toggle mute intent",
  "5 chrome.commands live",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  await sw.evaluate(async (defaults) => {
    await chrome.storage.local.set({ settings: structuredClone(defaults) });
    await chrome.storage.session.remove(["pip", "engine"]);
  }, DEFAULTS);

  const videoPage = (await browser.pages())[0] ?? (await browser.newPage());
  {
    const cdp = await videoPage.createCDPSession();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" },
    });
    await cdp.detach();
  }

  await videoPage.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await videoPage.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused && v.readyState >= 2),
    { timeout: 30000, polling: 500 },
  );
  await sleep(1500);

  const vRect = await videoPage.evaluate(() => {
    const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
    v.loop = true;
    window.__gpVideo = v;
    const r = v.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await videoPage.mouse.move(vRect.x, vRect.y, { steps: 6 });

  const inTabBtn = await poll(
    () =>
      videoPage.evaluate(() => {
        const host = document.getElementById("ghostpip-launcher");
        const b = host?.shadowRoot?.querySelector('[data-action="inTab"]');
        if (!host?.matches(":popover-open") || !b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
    Boolean,
    2500,
  );
  assert(inTabBtn, "launcher inTab button did not open");
  await videoPage.mouse.click(inTabBtn.x, inTabBtn.y);
  await poll(() => videoPage.evaluate(() => window.__gpVideo.matches(":popover-open")), Boolean, 2000);

  await sw.evaluate(() => chrome.storage.session.remove(["pip", "engine"]));
  const popupPage = await browser.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(300);

  const readPopupState = () =>
    popupPage.evaluate(() => ({
      badge: document.getElementById("modeBadge").textContent,
      bannerHidden: document.getElementById("engineBanner").hidden,
      warningHidden: document.getElementById("engineWarning").hidden,
      warningText: document.getElementById("engineWarning").textContent,
      clickThrough: document.getElementById("clickThrough").checked,
      dodgeEnabled: document.getElementById("dodgeEnabled").checked,
      opacity: document.getElementById("opacity").value,
      opacityValue: document.getElementById("opacityValue").textContent,
      home: document.getElementById("home").value,
      axis: document.getElementById("axis").value,
      style: document.getElementById("style").value,
      autoReturn: document.getElementById("autoReturn").checked,
      hold: document.getElementById("hold").value,
      corners: Object.fromEntries(
        [...document.querySelectorAll("input[data-corner]")].map((el) => [
          el.dataset.corner,
          { checked: el.checked, disabled: el.disabled },
        ]),
      ),
      disabledAxes: [...document.getElementById("axis").options].filter((o) => o.disabled).map((o) => o.value),
      disabledHomes: [...document.getElementById("home").options].filter((o) => o.disabled).map((o) => o.value),
    }));

  await step("1 initial & engine live", async () => {
    const init = await readPopupState();
    await popupPage.screenshot({ path: path.join(OUT, "popup_1_initial.png") }).catch(() => {});
    const initOk =
      init.badge === "In-Tab Mode" &&
      init.bannerHidden === false &&
      init.clickThrough === DEFAULTS.clickThrough &&
      init.dodgeEnabled === DEFAULTS.dodge.enabled &&
      init.opacity === String(DEFAULTS.opacity * 100) &&
      init.opacityValue === "70%" &&
      init.home === DEFAULTS.dodge.home &&
      init.axis === DEFAULTS.dodge.axis;

    await sw.evaluate(() =>
      chrome.storage.session.set({
        engine: { connected: true, engineVersion: "0.1.0", elevated: false, hotkeyErrors: ["Alt+G"], protocolMismatch: false },
      }),
    );
    const active = await poll(
      readPopupState,
      (s) => s.badge === "Engine Active" && s.bannerHidden === true && s.warningHidden === false && s.warningText.includes("Alt+G"),
      2000,
    );
    await sw.evaluate(() =>
      chrome.storage.session.set({
        engine: { connected: false, engineVersion: null, elevated: false, hotkeyErrors: [], protocolMismatch: false },
      }),
    );
    const restored = await poll(
      readPopupState,
      (s) => s.badge === "In-Tab Mode" && s.bannerHidden === false && s.warningHidden === true,
      2000,
    );
    const ok =
      initOk &&
      init.warningHidden === true &&
      active.badge === "Engine Active" &&
      active.bannerHidden &&
      !active.warningHidden &&
      active.warningText.includes("Alt+G") &&
      restored.badge === "In-Tab Mode" &&
      restored.warningHidden === true;
    return {
      ok,
      info: `init=${init.badge}(bannerHidden=${init.bannerHidden}) -> active=${active.badge}(bannerHidden=${active.bannerHidden}, warning="${active.warningText}")`,
    };
  });

  await step("2 popup -> content live", async () => {
    await popupPage.click("#clickThrough");
    await popupPage.evaluate(() => {
      const el = document.getElementById("opacity");
      el.value = "45";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await videoPage.bringToFront();
    const videoState = await poll(
      () =>
        videoPage.evaluate(() => {
          const v = window.__gpVideo;
          return {
            pass: v.hasAttribute("data-gp-pass"),
            pe: getComputedStyle(v).pointerEvents,
            varOpacity: Number(v.style.getPropertyValue("--gp-opacity")),
            opacity: Number(getComputedStyle(v).opacity),
          };
        }),
      (v) => v.pass && v.pe === "none" && Math.abs(v.varOpacity - 0.45) < 0.001 && Math.abs(v.opacity - 0.45) < 0.02,
      2500,
    );
    await popupPage.bringToFront();
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
    const ok =
      videoState.pass &&
      videoState.pe === "none" &&
      Math.abs(videoState.opacity - 0.45) < 0.02 &&
      stored.clickThrough === true &&
      Math.abs(stored.opacity - 0.45) < 0.001;
    return {
      ok,
      info: `stored=(clickThrough=${stored.clickThrough}, opacity=${stored.opacity}) video=(pass=${videoState.pass}, pe=${videoState.pe}, opacity=${videoState.opacity})`,
    };
  });

  await step("3 corner invariant", async () => {
    await popupPage.evaluate(() => {
      document.getElementById("dodgeDetails").open = true;
    });
    await popupPage.select("#axis", "vertical");
    const afterAxis = await poll(readPopupState, (s) => s.axis === "vertical" && s.corners.BR.disabled === true, 2000);

    await popupPage.click('input[data-corner="TL"]');
    const afterTl = await poll(
      readPopupState,
      (s) => !s.corners.TL.checked && s.corners.TR.disabled === true && s.corners.BR.disabled === true,
      2000,
    );

    await popupPage.click('input[data-corner="BL"]');
    const minSet = await poll(
      readPopupState,
      (s) =>
        !s.corners.TL.checked &&
        !s.corners.BL.checked &&
        s.corners.TR.disabled &&
        s.corners.BR.disabled &&
        s.disabledAxes.includes("horizontal"),
      2000,
    );
    await popupPage.screenshot({ path: path.join(OUT, "popup_3_invariant.png") }).catch(() => {});

    const forcedReject = await popupPage.evaluate(() =>
      chrome.runtime.sendMessage({
        v: 1,
        type: "PATCH_SETTINGS",
        patch: { dodge: { allowed: ["BR"] } },
      }),
    );

    const ok =
      afterAxis.corners.BR.disabled === true &&
      afterTl.corners.TR.disabled === true &&
      minSet.corners.TR.disabled === true &&
      minSet.corners.BR.disabled === true &&
      minSet.disabledAxes.includes("horizontal") &&
      minSet.disabledHomes.includes("TL") &&
      minSet.disabledHomes.includes("BL") &&
      forcedReject.ok === false &&
      forcedReject.settings.dodge.allowed.length === 2;

    await popupPage.select("#axis", "free");
    await popupPage.click('input[data-corner="TL"]');
    await popupPage.click('input[data-corner="BL"]');
    await poll(readPopupState, (s) => s.corners.TL.checked && s.corners.BL.checked, 2000);

    return {
      ok,
      info: `homeLocked(BR=${afterAxis.corners.BR.disabled}) pairLocked(TR=${afterTl.corners.TR.disabled}) disabledAxes=[${minSet.disabledAxes}] disabledHomes=[${minSet.disabledHomes}] forcedReject.ok=${forcedReject.ok}`,
    };
  });

  await step("4 toggle mute intent", async () => {
    await popupPage.click("#toggleMute");
    const m1 = await poll(
      () =>
        sw.evaluate(async () => {
          const [t] = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
          return t?.mutedInfo?.muted ?? null;
        }),
      (m) => m === true,
      2000,
    );
    await popupPage.click("#toggleMute");
    const m2 = await poll(
      () =>
        sw.evaluate(async () => {
          const [t] = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
          return t?.mutedInfo?.muted ?? null;
        }),
      (m) => m === false,
      2000,
    );
    return { ok: m1 === true && m2 === false, info: `muted: false -> ${m1} -> ${m2}` };
  });

  await step("5 chrome.commands live", async () => {
    const before = await readPopupState();
    await sw.evaluate(() => GhostPiPBackground.dispatchCommand("toggle-click-through"));
    const afterCt = await poll(readPopupState, (s) => s.clickThrough === !before.clickThrough, 2000);
    await sw.evaluate(() => GhostPiPBackground.dispatchCommand("toggle-dodge"));
    const afterDodge = await poll(readPopupState, (s) => s.dodgeEnabled === !before.dodgeEnabled, 2000);
    const ok = afterCt.clickThrough === !before.clickThrough && afterDodge.dodgeEnabled === !before.dodgeEnabled;
    return {
      ok,
      info: `clickThrough: ${before.clickThrough}->${afterCt.clickThrough}, dodgeEnabled: ${before.dodgeEnabled}->${afterDodge.dodgeEnabled}`,
    };
  });
} finally {
  await browser.close();
}

console.log("\n[popup e2e]");
for (const s of STEPS) {
  console.log(`  ${row[s].status.padEnd(4)} ${s.padEnd(25)} ${row[s].info}`);
}
const failed = STEPS.some((s) => row[s].status !== "PASS");
process.exit(failed ? 1 : 0);
