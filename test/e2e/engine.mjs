import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  "1 native connect & popup",
  "2 docPip bind & ghost style",
  "3 clickThrough & opacity win32",
  "4 os dodge & autoReturn",
  "5 close & engine exit",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 4) => ["l", "t", "r", "b"].every((k) => Math.abs(a[k] - b[k]) <= tol);
const fmt = (r) => r && `${Math.round(r.l)},${Math.round(r.t)}-${Math.round(r.r)},${Math.round(r.b)}`;

async function poll(fn, ok, timeout = 3000) {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(80);
    v = await fn();
  }
  return v;
}

function inspectWin32Pip(expectedW, expectedH) {
  const py = `
import ctypes, ctypes.wintypes as wt, json, win32gui, win32process, os
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x8
WS_EX_TRANSPARENT = 0x20
WS_EX_LAYERED = 0x80000
u32 = ctypes.windll.user32

class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

def proc_name(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not h: return ""
    buf = ctypes.create_unicode_buffer(1024); sz = wt.DWORD(1024)
    ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz))
    ctypes.windll.kernel32.CloseHandle(h)
    return os.path.basename(buf.value).lower()

cands = []
def cb(hwnd, _):
    cn = win32gui.GetClassName(hwnd)
    if not win32gui.IsWindowVisible(hwnd) or cn not in ("Chrome_WidgetWin_1", "GhostPiPClipHost"): return True
    ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
    if not (ex & WS_EX_TOPMOST): return True
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    if proc_name(pid) not in ("chrome.exe", "ghostpip.engine.exe"): return True
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    if r - l < 150 or b - t < 150: return True
    cr = wt.COLORREF(); alpha = ctypes.c_byte(); flags = wt.DWORD()
    u32.GetLayeredWindowAttributes(hwnd, ctypes.byref(cr), ctypes.byref(alpha), ctypes.byref(flags))
    hmon = u32.MonitorFromWindow(hwnd, 2)
    mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
    u32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    rgn_rc = wt.RECT()
    rgn_type = u32.GetWindowRgnBox(hwnd, ctypes.byref(rgn_rc))
    d3d_rel_t = 0
    def child_cb(ch, __):
        nonlocal d3d_rel_t
        ccn = win32gui.GetClassName(ch)
        if ccn in ("Chrome_WidgetWin_1", "Intermediate D3D Window"):
            cl, ct, cr2, cb2 = win32gui.GetWindowRect(ch)
            if ct - t < d3d_rel_t:
                d3d_rel_t = ct - t
        return True
    win32gui.EnumChildWindows(hwnd, child_cb, None)
    cx = (l + r) // 2
    cy = (t + b) // 2
    hit_c = u32.WindowFromPoint(wt.POINT(cx, cy))
    hit_t = u32.WindowFromPoint(wt.POINT(cx, t + 20))
    passes = (hit_c != hwnd and not u32.IsChild(hwnd, hit_c)) and (hit_t != hwnd and not u32.IsChild(hwnd, hit_t))
    cands.append({
        "hwnd": hwnd,
        "rect": {"l": l, "t": t, "r": r, "b": b, "w": r - l, "h": b - t},
        "work": {"l": mi.rcWork.left, "t": mi.rcWork.top, "r": mi.rcWork.right, "b": mi.rcWork.bottom},
        "layered": bool(ex & WS_EX_LAYERED),
        "transparent": bool(ex & WS_EX_TRANSPARENT),
        "hitPassesThrough": bool(passes),
        "alpha": alpha.value & 0xff,
        "rgnTop": -d3d_rel_t if d3d_rel_t < 0 else (rgn_rc.top if rgn_type == 2 else 0),
        "score": abs((r - l) - ${expectedW}) + abs((b - t) - ${expectedH})
    })
    return True
win32gui.EnumWindows(cb, None)
cands.sort(key=lambda x: x["score"])
print(json.dumps(cands[0] if cands else None))
`;
  const out = execFileSync("python", ["-c", py], { encoding: "utf8" }).trim();
  return JSON.parse(out);
}

function getEnginePids() {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-Command", "@(Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
    { encoding: "utf8" },
  ).trim();
  return out ? out.split(",").map(Number).filter(Number.isFinite) : [];
}

execFileSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "engine/installer/install.ps1"), "-InPlace"],
  { stdio: "inherit" },
);
await sleep(1600);

const row = Object.fromEntries(STEPS.map((s) => [s, { status: "FAIL", info: "not reached" }]));
async function step(name, fn) {
  try {
    const { ok, info } = await fn();
    row[name] = { status: ok ? "PASS" : "FAIL", info };
  } catch (e) {
    row[name] = { status: "FAIL", info: `threw: ${String(e.message ?? e).slice(0, 180)}` };
  }
}

const initialPids = new Set(getEnginePids());
let spawnedPids = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: null,
  env: { ...process.env, GHOSTPIP_TEST_MODE: "1" },
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run"],
});

try {
  const extId = await browser.installExtension(path.join(ROOT, "extension"));
  assert.equal(extId, "iphdokhjjgakpbmhemjjgglcdgjfedea", "deterministic extension ID mismatch");

  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 10000 },
  );
  const sw = await swTarget.worker();
  await poll(() => sw.evaluate(() => typeof globalThis.GhostPiPBackground === "object"), Boolean, 3000);

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

  const popupPage = await browser.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });

  await step("1 native connect & popup", async () => {
    await sw.evaluate(() => GhostPiPBackground.connectEngine());
    const st = await poll(
      () =>
        popupPage.evaluate(() => ({
          badge: document.getElementById("modeBadge").textContent,
          bannerHidden: document.getElementById("engineBanner").hidden,
        })),
      (s) => s.badge === "엔진 연결됨" && s.bannerHidden === true,
      4000,
    );
    const engineState = await sw.evaluate(async () => (await chrome.storage.session.get("engine")).engine);
    spawnedPids = getEnginePids().filter((pid) => !initialPids.has(pid));
    const ok =
      st.badge === "엔진 연결됨" &&
      st.bannerHidden === true &&
      engineState?.connected === true &&
      engineState?.engineVersion === "1.0.0" &&
      spawnedPids.length >= 1;
    return {
      ok,
      info: `badge="${st.badge}" bannerHidden=${st.bannerHidden} version=${engineState?.engineVersion} spawnedPids=${spawnedPids.join(",")}`,
    };
  });

  await videoPage.bringToFront();
  await videoPage.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await videoPage.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused && v.readyState >= 2),
    { timeout: 30000, polling: 500 },
  );
  await sleep(1500);

  let pipSize = { w: 496, h: 850 };

  await step("2 docPip bind & ghost style", async () => {
    await sw.evaluate(async (defaults) => {
      const s = structuredClone(defaults);
      s.dodge.enabled = false;
      s.dodge.autoReturn = false;
      await chrome.storage.local.set({ settings: s });
      GhostPiPBackground.postToEngine({ v: 1, type: "STATE", settings: s });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: 100, y: 100 });
    }, DEFAULTS);

    const vCenter = await videoPage.evaluate(() => {
      document.documentElement.setAttribute("data-gp-force-chat", "");
      const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
      v.loop = true;
      window.__gpVideo = v;
      const r = v.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await videoPage.mouse.move(vCenter.x, vCenter.y, { steps: 6 });

    const docPipBtn = await poll(
      () =>
        videoPage.evaluate(() => {
          const host = document.getElementById("ghostpip-launcher");
          const b = host?.shadowRoot?.querySelector('[data-action="docPip"]');
          if (!host?.matches(":popover-open") || !b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }),
      Boolean,
      2500,
    );
    assert(docPipBtn, "docPip button not found");
    await videoPage.mouse.click(docPipBtn.x, docPipBtn.y);

    const boundEntry = await poll(
      () =>
        sw.evaluate(async () => {
          const { pip = {} } = await chrome.storage.session.get("pip");
          return Object.values(pip).find((e) => e.bound === true) ?? null;
        }),
      Boolean,
      5000,
    );
    assert(boundEntry, "Engine did not report PIP_BOUND");
    pipSize = { w: Math.round(boundEntry.rect.w), h: Math.round(boundEntry.rect.h) };

    const win = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && w.layered && w.alpha === 179 && !w.transparent && w.rgnTop > 0,
      3000,
    );
    const wantBr = Dodge.cornerRect("BR", { w: win.rect.w, h: win.rect.h }, win.work, DEFAULTS.dodge.edgeInsetPx);

    const chatBefore = await videoPage.evaluate(() => {
      const d = documentPictureInPicture.window.document;
      const bar = d.querySelector(".pip-bar");
      const btn = d.querySelector('[data-action="toggleChat"]');
      return {
        hiddenWhenIdle: getComputedStyle(bar).opacity === "0",
        label: btn?.textContent ?? "",
        hasIframe: Boolean(d.querySelector("iframe")),
      };
    });

    const hoverPt = {
      x: Math.round((win.rect.l + win.rect.r) / 2),
      y: Math.round(win.rect.t + win.rgnTop + 16),
    };
    await sw.evaluate((pt) => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: pt.x, y: pt.y });
    }, hoverPt);

    const hoveredState = await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          const bar = d.querySelector(".pip-bar");
          return {
            hoveredAttr: d.body.hasAttribute("data-hovered"),
            barOpacity: getComputedStyle(bar).opacity,
          };
        }),
      (s) => s.hoveredAttr && s.barOpacity === "1",
      2000,
    );
    const winWhileHovered = inspectWin32Pip(pipSize.w, pipSize.h);

    await videoPage.evaluate(() => {
      documentPictureInPicture.window.document.querySelector('[data-action="toggleChat"]').click();
    });
    const chatHiddenWin = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h - 420),
      (w) => w && Math.abs(w.rect.h - (win.rect.h - 420)) <= 40,
      2500,
    );
    const chatAfterHide = await videoPage.evaluate(() => {
      const d = documentPictureInPicture.window.document;
      const btn = d.querySelector('[data-action="toggleChat"]');
      return {
        label: btn?.textContent ?? "",
        hasIframe: Boolean(d.querySelector("iframe")),
      };
    });

    const opacityBeforeWheel = await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.opacity);
    const shrunk = inspectWin32Pip(pipSize.w, pipSize.h - 420);
    const wheelPt = {
      x: Math.round((shrunk.rect.l + shrunk.rect.r) / 2),
      y: Math.round((shrunk.rect.t + shrunk.rect.b) / 2),
    };
    await sw.evaluate((pt) => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x: pt.x, y: pt.y, delta: -120, hold: true });
    }, wheelPt);
    const opacityAfterWheel = await poll(
      () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.opacity),
      (op) => op !== opacityBeforeWheel,
      2000,
    );
    await sleep(400);
    const chatStaysHiddenAfterWheel =
      opacityAfterWheel !== opacityBeforeWheel &&
      (await videoPage.evaluate(() => !documentPictureInPicture.window.document.querySelector("iframe")));
    await popupPage.evaluate(
      (op) => chrome.runtime.sendMessage({ v: 1, type: "PATCH_SETTINGS", patch: { opacity: op } }),
      opacityBeforeWheel,
    );

    await videoPage.evaluate(() => {
      documentPictureInPicture.window.document.querySelector('[data-action="toggleChat"]').click();
    });
    const chatRestoredWin = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && Math.abs(w.rect.h - win.rect.h) <= 20,
      2500,
    );

    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: 100, y: 100 });
    });

    await popupPage.evaluate(() =>
      chrome.runtime.sendMessage({ v: 1, type: "PATCH_SETTINGS", patch: { showChat: false } }),
    );
    const barHiddenWhenShowChatOff = await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          const chatBtn = d.querySelector('[data-action="toggleChat"]');
          const closeBtn = d.querySelector('[data-action="closePip"]');
          return Boolean(chatBtn?.hidden) && Boolean(closeBtn && !closeBtn.hidden) && !d.querySelector("iframe");
        }),
      Boolean,
      2000,
    );
    await popupPage.evaluate(() =>
      chrome.runtime.sendMessage({ v: 1, type: "PATCH_SETTINGS", patch: { showChat: true } }),
    );
    await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          const chatBtn = d.querySelector('[data-action="toggleChat"]');
          return Boolean(chatBtn && !chatBtn.hidden && d.querySelector("iframe"));
        }),
      Boolean,
      2000,
    );
    await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && Math.abs(w.rect.h - win.rect.h) <= 20,
      2500,
    );

    await videoPage.evaluate(() => {
      window.__pipAdSkipped = 0;
      const btn = document.createElement("button");
      btn.className = "ytp-skip-ad-button";
      btn.style.cssText = "position:fixed;left:20px;top:20px;width:100px;height:36px;z-index:99999;";
      btn.textContent = "광고 건너뛰기";
      btn.onclick = () => {
        window.__pipAdSkipped++;
        btn.remove();
      };
      document.body.appendChild(btn);
    });
    const pipSkipAdWorked = await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          const sb = d.querySelector('[data-action="skipAd"]');
          if (!sb || sb.hidden) return false;
          sb.click();
          return window.__pipAdSkipped === 1 && sb.hidden;
        }),
      Boolean,
      2000,
    );

    const ok =
      Boolean(boundEntry?.bound) &&
      win.layered === true &&
      win.transparent === false &&
      win.alpha === 179 &&
      win.rgnTop > 0 &&
      winWhileHovered?.rgnTop > 0 &&
      hoveredState.hoveredAttr === true &&
      hoveredState.barOpacity === "1" &&
      near(win.rect, wantBr) &&
      chatBefore.hiddenWhenIdle === true &&
      chatBefore.label === "채팅창 숨기기" &&
      chatBefore.hasIframe === true &&
      chatAfterHide.label === "채팅창 보기" &&
      chatAfterHide.hasIframe === false &&
      chatStaysHiddenAfterWheel === true &&
      barHiddenWhenShowChatOff === true &&
      pipSkipAdWorked === true &&
      Boolean(chatHiddenWin) &&
      Boolean(chatRestoredWin);
    return {
      ok,
      info: `bound=${boundEntry?.bound} layered=${win.layered} alpha=${win.alpha} rgnTop=${win.rgnTop}(hover:${winWhileHovered?.rgnTop}) hoverBar=${hoveredState.barOpacity} showChatOffHidden=${barHiddenWhenShowChatOff} chatBtn="${chatBefore.label}"->"${chatAfterHide.label}" wheelKeepsChatHidden=${chatStaysHiddenAfterWheel} h=${win.rect.h}->${chatHiddenWin?.rect?.h}->${chatRestoredWin?.rect?.h} rect=${fmt(win.rect)}`,
    };
  });

  await step("3 clickThrough & opacity win32", async () => {
    await popupPage.bringToFront();
    await popupPage.click("#clickThrough");
    await popupPage.evaluate(() => {
      const el = document.getElementById("opacity");
      el.value = "40";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const win = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && w.layered && w.transparent === true && w.alpha === 102,
      3000,
    );

    const cx = Math.round((win.rect.l + win.rect.r) / 2);
    const cy = Math.round((win.rect.t + win.rect.b) / 2);
    const topBarY = Math.round(win.rect.t + 20);

    await sw.evaluate(
      (x, y) => {
        GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold: false });
        GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x, y });
      },
      cx,
      topBarY,
    );
    await sleep(160);
    const winOnBarHover = inspectWin32Pip(pipSize.w, pipSize.h);
    const barWhileClickThrough = await videoPage.evaluate(() => {
      const d = documentPictureInPicture.window.document;
      const bar = d.querySelector(".pip-bar");
      return {
        hoveredAttr: d.body.hasAttribute("data-hovered"),
        barOpacity: getComputedStyle(bar).opacity,
      };
    });

    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold: true });
    });
    const barWhileHeld = await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          const bar = d.querySelector(".pip-bar");
          return {
            hoveredAttr: d.body.hasAttribute("data-hovered"),
            barOpacity: getComputedStyle(bar).opacity,
          };
        }),
      (s) => s.hoveredAttr === true && s.barOpacity === "1",
      2000,
    );
    const winWhileHeld = inspectWin32Pip(pipSize.w, pipSize.h);

    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold: false });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: 100, y: 100 });
    });
    const barAfterHoldRelease = await poll(
      () =>
        videoPage.evaluate(() => {
          const d = documentPictureInPicture.window.document;
          return d.body.hasAttribute("data-hovered");
        }),
      (hovered) => hovered === false,
      2000,
    );

    await sw.evaluate(
      (x, y) => {
        GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x, y, delta: 120, hold: true });
        GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x, y, delta: 120, hold: true });
      },
      cx,
      cy,
    );
    const afterWheel = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && w.alpha === 128,
      2000,
    );
    const syncedOpacity = await poll(
      () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.opacity),
      (op) => Math.abs((op ?? 0) - 0.5) < 0.02,
      2000,
    );

    const ok =
      win?.layered === true &&
      win?.transparent === true &&
      win?.hitPassesThrough === true &&
      win?.alpha === 102 &&
      winOnBarHover?.transparent === true &&
      winOnBarHover?.hitPassesThrough === true &&
      barWhileClickThrough.hoveredAttr === false &&
      barWhileClickThrough.barOpacity === "0" &&
      barWhileHeld.hoveredAttr === true &&
      barWhileHeld.barOpacity === "1" &&
      winWhileHeld?.transparent === false &&
      barAfterHoldRelease === false &&
      afterWheel?.alpha === 128 &&
      Math.abs((syncedOpacity ?? 0) - 0.5) < 0.02;
    return {
      ok,
      info: `layered=${win?.layered} transparent=${win?.transparent}(onBar:${winOnBarHover?.transparent},pass:${winOnBarHover?.hitPassesThrough}) barNoHold=${barWhileClickThrough.barOpacity} barHeld=${barWhileHeld.barOpacity} alpha=${win?.alpha}->wheel:${afterWheel?.alpha}`,
    };
  });

  await step("4 os dodge & autoReturn", async () => {
    const w0 = inspectWin32Pip(pipSize.w, pipSize.h);
    const size = { w: w0.rect.w, h: w0.rect.h };
    const wantTl = Dodge.cornerRect("TL", size, w0.work, DEFAULTS.dodge.edgeInsetPx);
    const wantBr = Dodge.cornerRect("BR", size, w0.work, DEFAULTS.dodge.edgeInsetPx);

    await sw.evaluate(async () => {
      await GhostPiPBackground.connectEngine();
      const { settings } = await chrome.storage.local.get("settings");
      const next = {
        ...settings,
        dodge: { ...settings.dodge, enabled: true, autoReturn: true, returnDelayMs: 400, hoverDelayMs: 80, cooldownMs: 150 },
      };
      await chrome.storage.local.set({ settings: next });
      GhostPiPBackground.postToEngine({ v: 1, type: "STATE", settings: next });
    });
    await sleep(120);

    const brCx = Math.round((wantBr.l + wantBr.r) / 2);
    const brCy = Math.round((wantBr.t + wantBr.b) / 2);
    await sw.evaluate(
      (x, y) => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x, y }),
      brCx,
      brCy,
    );

    const movedTl = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && near(w.rect, wantTl),
      3000,
    );

    const midX = Math.round((w0.work.l + w0.work.r) / 2);
    const midY = Math.round((w0.work.t + w0.work.b) / 2);
    await sw.evaluate(
      (x, y) => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x, y }),
      midX,
      midY,
    );

    const returnedBr = await poll(
      () => inspectWin32Pip(pipSize.w, pipSize.h),
      (w) => w && near(w.rect, wantBr),
      3000,
    );

    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: null, y: null }));
    const ok = near(movedTl.rect, wantTl) && near(returnedBr.rect, wantBr);
    return {
      ok,
      info: `dodged=${fmt(movedTl.rect)}(want TL ${fmt(wantTl)}) -> autoReturned=${fmt(returnedBr.rect)}(want BR ${fmt(wantBr)})`,
    };
  });

  await step("5 close & engine exit", async () => {
    await popupPage.evaluate(() =>
      chrome.runtime.sendMessage({ v: 1, type: "PATCH_SETTINGS", patch: { enabled: false } }),
    );
    const remainingAfterDisable = await poll(
      () => getEnginePids().filter((pid) => spawnedPids.includes(pid)),
      (pids) => pids.length === 0,
      4000,
    );
    const cleared = await poll(
      () =>
        sw.evaluate(async () => {
          const { pip = {} } = await chrome.storage.session.get("pip");
          return Object.keys(pip).length === 0;
        }),
      Boolean,
      2500,
    );
    await browser.close();
    const ok = cleared && remainingAfterDisable.length === 0;
    return { ok, info: `pipCleared=${cleared} exitedOnDisable=${remainingAfterDisable.length === 0}` };
  });
} finally {
  await browser.close().catch(() => {});
}

console.log("\n[engine e2e]");
for (const s of STEPS) {
  console.log(`  ${row[s].status.padEnd(4)} ${s.padEnd(32)} ${row[s].info}`);
}
const failed = STEPS.some((s) => row[s].status !== "PASS");
process.exit(failed ? 1 : 0);
