import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "test/e2e/out");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lib = {};
vm.runInNewContext(read("extension/shared/settings.js") + "\n" + read("extension/content/dodge.js"), lib);
const Dodge = lib.GhostPiPDodge;
const DEFAULTS = JSON.parse(JSON.stringify(lib.GhostPiPSettings.DEFAULTS));

const STEPS = [
  "1 live subtitles (YouTube DOM & HTML5 track in docPip)",
  "2 multi-PiP full mode (docPip + popupPip + independent OS dodge)",
  "3 full mode window bounds memory (PIP_BOUNDS round-trip)",
  "4 DRM native PiP Win32 subtitle overlay (GhostPiPSubtitleOverlay)",
  "5 in-game media remote (focus-free play/pause, seek, Alt+Wheel volume)",
  "6 peek mode / reverse ghost (0%/5% hidden -> 80% hold -> 0% release)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (r) => r && `${Math.round(r.l)},${Math.round(r.t)}-${Math.round(r.r)},${Math.round(r.b)}`;

async function poll(fn, ok, timeout = 3500) {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(80);
    v = await fn();
  }
  return v;
}

const PAGE_HTML = ({ w = 640, h = 360, hue = 200, drm = false, seekable = false } = {}) => `<!doctype html>
<meta charset="utf-8">
<body style="margin:0;background:#0b0f19;color:#fff;font-family:sans-serif">
  <div id="player" style="position:absolute;left:40px;top:40px;width:${Math.min(w, 640)}px;height:${Math.min(h, 480)}px">
    <video id="vid" controls autoplay playsinline style="width:100%;height:100%;display:block;background:#000"></video>
    <div class="ytp-caption-window-container" id="ytCap"></div>
    <div class="player-timedtext" id="nfCap"></div>
  </div>
  <script>
    const c = document.createElement("canvas");
    c.width = ${w};
    c.height = ${h};
    const g = c.getContext("2d");
    let tick = 0;
    setInterval(() => {
      tick++;
      g.fillStyle = "hsl(" + ((${hue} + tick * 5) % 360) + ", 72%, 45%)";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#fff";
      g.font = "bold 28px sans-serif";
      g.fillText("FRAME " + tick, 24, 54);
    }, 33);
    const v = document.getElementById("vid");
    window.__seekReady = !${seekable ? "true" : "false"};
    if (${seekable ? "true" : "false"} && typeof MediaSource !== "undefined") {
      const ms = new MediaSource();
      v.src = URL.createObjectURL(ms);
      v.addEventListener("timeupdate", () => {
        if (!window.__disableLoop && v.currentTime > 0.35) {
          v.currentTime = 0.05;
        }
      });
      ms.addEventListener(
        "sourceopen",
        () => {
          const mime = MediaRecorder.isTypeSupported('video/webm; codecs="vp8"')
            ? 'video/webm; codecs="vp8"'
            : "video/webm";
          const sb = ms.addSourceBuffer(mime);
          ms.duration = 120;
          const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime });
          rec.ondataavailable = async (ev) => {
            if (ev.data && ev.data.size > 0 && !sb.updating) {
              const buf = await ev.data.arrayBuffer();
              sb.addEventListener(
                "updateend",
                () => {
                  if (ms.readyState === "open" && (!Number.isFinite(ms.duration) || ms.duration < 120)) {
                    ms.duration = 120;
                  }
                  v.play().catch(() => {});
                  window.__seekReady = true;
                },
                { once: true },
              );
              sb.appendBuffer(buf);
            }
          };
          rec.start();
          setTimeout(() => {
            if (rec.state !== "inactive") rec.stop();
          }, 550);
        },
        { once: true },
      );
    } else {
      v.srcObject = c.captureStream(30);
      v.play().catch(() => {});
    }
    window.__drmReady = !${drm ? "true" : "false"};
    if (${drm ? "true" : "false"}) {
      navigator
        .requestMediaKeySystemAccess("org.w3.clearkey", [
          {
            initDataTypes: ["keyids"],
            videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }],
          },
        ])
        .then((access) => access.createMediaKeys())
        .then((keys) => v.setMediaKeys(keys))
        .then(() => {
          window.__drmReady = true;
        })
        .catch(() => {
          window.__drmReady = "fallback";
        });
    }
    window.__setYtCaption = (txt) => {
      const box = document.getElementById("ytCap");
      box.replaceChildren();
      if (!txt) return;
      const line = document.createElement("span");
      line.className = "caption-visual-line";
      const seg = document.createElement("span");
      seg.className = "ytp-caption-segment";
      seg.textContent = txt;
      line.appendChild(seg);
      box.appendChild(line);
    };
    window.__setNfCaption = (txt) => {
      const box = document.getElementById("nfCap");
      box.replaceChildren();
      if (!txt) return;
      const inner = document.createElement("div");
      inner.className = "player-timedtext-text-container";
      inner.textContent = txt;
      box.appendChild(inner);
    };
    window.__setTrackCaption = (txt) => {
      let tr = v.textTracks[0];
      if (!tr) {
        tr = v.addTextTrack("subtitles", "Korean", "ko");
      }
      tr.mode = "showing";
      while (tr.cues && tr.cues.length > 0) {
        tr.removeCue(tr.cues[0]);
      }
      if (txt) {
        tr.addCue(new VTTCue(0, 999999, txt));
      }
      return tr;
    };
  </script>
</body>`;

function inspectWin32State() {
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

pips = []
subs = []
def cb(hwnd, _):
    if not win32gui.IsWindowVisible(hwnd): return True
    cn = win32gui.GetClassName(hwnd)
    ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    if cn == "GhostPiPSubtitleOverlay":
        cx = (l + r) // 2
        cy = (t + b) // 2
        hit = u32.WindowFromPoint(wt.POINT(cx, cy))
        subs.append({
            "hwnd": hwnd,
            "rect": {"l": l, "t": t, "r": r, "b": b, "w": r - l, "h": b - t},
            "layered": bool(ex & WS_EX_LAYERED),
            "transparent": bool(ex & WS_EX_TRANSPARENT),
            "topmost": bool(ex & WS_EX_TOPMOST),
            "hitPassesThrough": bool(hit != hwnd and not u32.IsChild(hwnd, hit)),
        })
        return True
    if cn not in ("Chrome_WidgetWin_1", "GhostPiPClipHost"): return True
    if not (ex & WS_EX_TOPMOST): return True
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    if proc_name(pid) not in ("chrome.exe", "ghostpip.engine.exe"): return True
    if r - l < 140 or b - t < 100 or r - l > 1200 or b - t > 1100: return True
    hmon = u32.MonitorFromWindow(hwnd, 2)
    mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
    u32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    alpha = wt.BYTE(255)
    flags = wt.DWORD(0)
    if ex & WS_EX_LAYERED:
        u32.GetLayeredWindowAttributes(hwnd, None, ctypes.byref(alpha), ctypes.byref(flags))
    cx = (l + r) // 2
    cy = (t + b) // 2
    hit_c = u32.WindowFromPoint(wt.POINT(cx, cy))
    hit_t = u32.WindowFromPoint(wt.POINT(cx, min(b - 4, t + 20)))
    passes = (hit_c != hwnd and not u32.IsChild(hwnd, hit_c)) and (hit_t != hwnd and not u32.IsChild(hwnd, hit_t))
    pips.append({
        "hwnd": hwnd,
        "className": cn,
        "rect": {"l": l, "t": t, "r": r, "b": b, "w": r - l, "h": b - t},
        "work": {"l": mi.rcWork.left, "t": mi.rcWork.top, "r": mi.rcWork.right, "b": mi.rcWork.bottom},
        "layered": bool(ex & WS_EX_LAYERED),
        "transparent": bool(ex & WS_EX_TRANSPARENT),
        "topmost": bool(ex & WS_EX_TOPMOST),
        "alpha": int(alpha.value) & 0xff,
        "hitPassesThrough": bool(passes),
    })
    return True
win32gui.EnumWindows(cb, None)
print(json.dumps({"pips": pips, "subs": subs, "fgHwnd": int(u32.GetForegroundWindow())}))
`;
  const out = execFileSync("python", ["-c", py], { encoding: "utf8" }).trim();
  return JSON.parse(out);
}

async function sendEnginePointerDrag(sw, { fromX, fromY, toX, toY, hold = true, steps = 10 }) {
  const fx = Math.round(fromX);
  const fy = Math.round(fromY);
  const tx = Math.round(toX);
  const ty = Math.round(toY);
  await sw.evaluate(({ hold, x, y }) => {
    GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold });
    GhostPiPBackground.postToEngine({ v: 1, type: "TEST_MOUSE", event: "move", x, y });
  }, { hold, x: fx, y: fy });
  await sleep(50);
  await sw.evaluate(({ x, y }) => {
    GhostPiPBackground.postToEngine({ v: 1, type: "TEST_MOUSE", event: "down", x, y });
  }, { x: fx, y: fy });
  await sleep(40);
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fx + ((tx - fx) * i) / steps);
    const y = Math.round(fy + ((ty - fy) * i) / steps);
    await sw.evaluate(({ x, y }) => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_MOUSE", event: "move", x, y });
    }, { x, y });
    await sleep(20);
  }
  await sleep(50);
  await sw.evaluate(({ x, y }) => {
    GhostPiPBackground.postToEngine({ v: 1, type: "TEST_MOUSE", event: "up", x, y });
    GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold: false });
  }, { x: tx, y: ty });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const w = Number(u.searchParams.get("w")) || 640;
  const h = Number(u.searchParams.get("h")) || 360;
  const hue = Number(u.searchParams.get("hue")) || 200;
  const drm = u.searchParams.get("drm") === "1";
  const seekable = u.searchParams.get("seekable") === "1";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML({ w, h, hue, drm, seekable }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

execFileSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "engine/installer/install.ps1"), "-InPlace", "-Dev"],
  { stdio: "inherit" },
);
await sleep(800);

const row = Object.fromEntries(STEPS.map((s) => [s, { status: "FAIL", info: "not reached" }]));
async function step(name, fn) {
  try {
    const { ok, info } = await fn();
    row[name] = { status: ok ? "PASS" : "FAIL", info };
  } catch (e) {
    row[name] = { status: "FAIL", info: `threw: ${String(e.message ?? e).slice(0, 220)}` };
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: null,
  env: { ...process.env, GHOSTPIP_TEST_MODE: "1" },
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=ko"],
});

try {
  const extId = await browser.installExtension(path.join(ROOT, "extension"));
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 10000 },
  );
  const sw = await swTarget.worker();
  await poll(() => sw.evaluate(() => typeof globalThis.GhostPiPBackground === "object"), Boolean, 3000);
  {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
    await p.evaluate(() => {
      const btn = document.createElement("button");
      btn.id = "__gpGrantAllSites";
      btn.onclick = () => chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
      document.body.prepend(btn);
    });
    await p.click("#__gpGrantAllSites");
    await sleep(350);
    execFileSync("python", [
      "-c",
      `import win32gui, win32con, time
def cb(h, _):
    if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == "Chrome_WidgetWin_1" and win32gui.GetWindowText(h) == "":
        l, t, r, b = win32gui.GetWindowRect(h)
        if 250 <= r - l <= 800 and 100 <= b - t <= 450:
            win32gui.PostMessage(h, win32con.WM_KEYDOWN, win32con.VK_TAB, 0)
            win32gui.PostMessage(h, win32con.WM_KEYUP, win32con.VK_TAB, 0)
            time.sleep(0.06)
            win32gui.PostMessage(h, win32con.WM_KEYDOWN, win32con.VK_RETURN, 0)
            win32gui.PostMessage(h, win32con.WM_KEYUP, win32con.VK_RETURN, 0)
    return True
win32gui.EnumWindows(cb, None)`,
    ]);
    await sleep(250);
    await p.close();
  }

  const resetAll = async (patch = {}) => {
    await sw.evaluate(async ({ defaults, patch }) => {
      const base = structuredClone(defaults);
      const next = {
        ...base,
        ...patch,
        allSites: true,
        dodge: { ...base.dodge, ...(patch.dodge ?? {}) },
        media: { ...base.media, ...(patch.media ?? {}) },
        peek: { ...base.peek, ...(patch.peek ?? {}) },
        hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
      };
      await chrome.storage.local.set({ settings: next, gpTestHooks: true });
      await chrome.storage.local.remove(["floatLayout", "pipBounds"]);
      await chrome.storage.session.remove(["pip", "inTab", "inTabSessions"]);
      GhostPiPBackground.postToEngine({ v: 1, type: "STATE", settings: next });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOLD", hold: null });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_PEEK", peek: null });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: null, y: null });
      GhostPiPBackground.syncEngineSessionState({});
    }, { defaults: DEFAULTS, patch });
  };

  const tab1 = (await browser.pages())[0] ?? (await browser.newPage());
  {
    const cdp = await tab1.createCDPSession();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 20, top: 20, width: 1200, height: 860, windowState: "normal" },
    });
    await cdp.detach();
  }

  const openLauncherAndClick = async (page, action) => {
    await page.bringToFront();
    await page.waitForFunction(() => {
      const v = document.getElementById("vid");
      return v && v.videoWidth > 0 && v.readyState >= 2;
    });
    await sleep(600);
    const pt = await page.evaluate(() => {
      const v = document.getElementById("vid");
      const r = v.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(5, 5);
    await sleep(80);
    await page.mouse.move(pt.x, pt.y, { steps: 6 });
    const btn = await poll(
      () =>
        page.evaluate((act) => {
          const host = document.getElementById("ghostpip-launcher");
          const b = host?.shadowRoot?.querySelector(`[data-action="${act}"]`);
          if (!host?.matches(":popover-open") || !b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, action),
      Boolean,
      2500,
    );
    assert(btn, `launcher ${action} button did not appear`);
    await page.mouse.click(btn.x, btn.y);
  };

  const readDocPipSubtitle = (page) =>
    page.evaluate(() => {
      const el = documentPictureInPicture.window?.document?.querySelector(".pip-subtitles");
      return el && !el.hidden ? { text: el.textContent ?? "", pe: getComputedStyle(el).pointerEvents } : null;
    });

  // STEP 1: Live Subtitles (YouTube DOM & HTML5 <track> in docPip)
  await step("1 live subtitles (YouTube DOM & HTML5 track in docPip)", async () => {
    await resetAll({ dodge: { enabled: false, autoReturn: false } });
    await tab1.goto(`${base}?w=640&h=360&hue=190`, { waitUntil: "load" });
    await openLauncherAndClick(tab1, "docPip");
    await poll(() => tab1.evaluate(() => Boolean(documentPictureInPicture.window?.document.querySelector("video"))), Boolean, 3000);

    await tab1.evaluate(() => window.__setYtCaption("안녕하세요 유튜브 자막 테스트"));
    const localSub = await poll(
      () => readDocPipSubtitle(tab1),
      (s) => s?.text === "안녕하세요 유튜브 자막 테스트",
      2500,
    );

    await tab1.evaluate(() => {
      window.__setYtCaption("");
      window.__setTrackCaption("HTML5 트랙 자막 정상 출력");
    });
    const trackSub = await poll(
      () => readDocPipSubtitle(tab1),
      (s) => s?.text === "HTML5 트랙 자막 정상 출력",
      2500,
    );
    const trackMode = await tab1.evaluate(() => document.getElementById("vid").textTracks[0]?.mode);
    await tab1.evaluate(() => {
      window.__setTrackCaption("");
      documentPictureInPicture.window?.close();
    });

    const ok =
      localSub?.text === "안녕하세요 유튜브 자막 테스트" &&
      localSub?.pe === "none" &&
      trackSub?.text === "HTML5 트랙 자막 정상 출력" &&
      trackMode === "hidden";
    return {
      ok,
      info: `local="${localSub?.text}"(pe=${localSub?.pe}) track="${trackSub?.text}"(mode=${trackMode})`,
    };
  });

  // STEP 2: Multi-PiP Full Mode (docPip + popupPip Independent OS Windows + Subtitles + Independent Dodge)
  await step("2 multi-PiP full mode (docPip + popupPip + independent OS dodge)", async () => {
    await resetAll({ clickThrough: false, dodge: { enabled: false, autoReturn: false } });
    await sw.evaluate(() => GhostPiPBackground.connectEngine());
    await poll(
      () => sw.evaluate(async () => (await chrome.storage.session.get("engine")).engine?.connected === true),
      Boolean,
      4000,
    );

    await tab1.goto(`${base}?w=640&h=360&hue=180`, { waitUntil: "load" });
    await tab1.evaluate(() => window.__setYtCaption("창1 문서 PiP 자막"));
    await openLauncherAndClick(tab1, "docPip");

    await poll(
      () =>
        sw.evaluate(async () => {
          const { pip = {} } = await chrome.storage.session.get("pip");
          return Object.values(pip).filter((e) => e.bound && e.kind === "document").length === 1;
        }),
      Boolean,
      4500,
    );

    const tab2 = await browser.newPage();
    await tab2.goto(`${base}?w=640&h=360&hue=330`, { waitUntil: "load" });
    await tab2.evaluate(() => window.__setYtCaption("창2 팝업 PiP 자막"));
    await openLauncherAndClick(tab2, "docPip");

    const boundBoth = await poll(
      () =>
        sw.evaluate(async () => {
          const { pip = {} } = await chrome.storage.session.get("pip");
          const vals = Object.values(pip);
          return (
            vals.some((e) => e.bound && e.kind === "document") &&
            vals.some((e) => e.bound && e.kind === "popup")
          );
        }),
      Boolean,
      5500,
    );

    const winState0 = await poll(
      () => inspectWin32State(),
      (s) => s.pips.length >= 2 && s.pips.every((p) => p.layered && p.topmost),
      4000,
    );

    const docSubText = await poll(
      () =>
        tab1.evaluate(() => {
          const d = documentPictureInPicture.window?.document;
          const el = d?.querySelector(".pip-subtitles");
          return el && !el.hidden ? el.textContent : "";
        }),
      (txt) => txt === "창1 문서 PiP 자막",
      2500,
    );

    const popupTarget = await browser.waitForTarget(
      (t) => t.type() === "page" && t.url().startsWith(`chrome-extension://${extId}/player/player.html`),
      { timeout: 4000 },
    );
    const popupPlayerPage = await popupTarget.page();
    const popupSubText = await poll(
      () =>
        popupPlayerPage.evaluate(() => {
          const el = document.getElementById("pipSubtitles");
          return el && !el.hidden ? el.textContent : "";
        }),
      (txt) => txt === "창2 팝업 PiP 자막",
      3000,
    );

    const [wA, wB] = winState0.pips;
    const separated =
      Boolean(wA && wB) &&
      (Math.abs(wA.rect.l - wB.rect.l) > 100 || Math.abs(wA.rect.t - wB.rect.t) > 100);

    // Enable clickThrough + OS dodge, place cursor on Window A -> Window A dodges, Window B stays put!
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      const next = {
        ...settings,
        clickThrough: true,
        dodge: { ...settings.dodge, enabled: true, autoReturn: false, hoverDelayMs: 60, cooldownMs: 120 },
      };
      await chrome.storage.local.set({ settings: next, gpTestHooks: true });
      GhostPiPBackground.postToEngine({ v: 1, type: "STATE", settings: next });
    });
    await sleep(150);

    const cxA = Math.round((wA.rect.l + wA.rect.r) / 2);
    const cyA = Math.round((wA.rect.t + wA.rect.b) / 2);
    await sw.evaluate(({ x, y }) => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x, y });
    }, { x: cxA, y: cyA });

    const winStateAfterDodge = await poll(
      () => inspectWin32State(),
      (s) => {
        const curA = s.pips.find((p) => p.hwnd === wA.hwnd);
        return curA && (Math.abs(curA.rect.l - wA.rect.l) > 100 || Math.abs(curA.rect.t - wA.rect.t) > 100);
      },
      3000,
    );
    const movedA = winStateAfterDodge.pips.find((p) => p.hwnd === wA.hwnd);
    const stayedB = winStateAfterDodge.pips.find((p) => p.hwnd === wB.hwnd);
    const bStayedPut =
      Boolean(stayedB) && Math.abs(stayedB.rect.l - wB.rect.l) <= 6 && Math.abs(stayedB.rect.t - wB.rect.t) <= 6;

    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_CURSOR", x: null, y: null }));
    await tab2.close();
    await tab1.evaluate(() => documentPictureInPicture.window?.close());
    await poll(() => inspectWin32State(), (s) => s.pips.length === 0, 3000);

    const ok =
      boundBoth &&
      winState0.pips.length === 2 &&
      separated &&
      docSubText === "창1 문서 PiP 자막" &&
      popupSubText === "창2 팝업 PiP 자막" &&
      Boolean(movedA) &&
      bStayedPut;
    return {
      ok,
      info: `wins=${winState0.pips.length} separated=${separated} sub1="${docSubText}" sub2="${popupSubText}" win1Moved=${fmt(wA?.rect)}->${fmt(movedA?.rect)} win2Stayed=${bStayedPut}`,
    };
  });

  // STEP 3: Full Mode Window Position & Size Memory (PIP_BOUNDS Round-Trip)
  await step("3 full mode window bounds memory (PIP_BOUNDS round-trip)", async () => {
    await resetAll({ clickThrough: true, dodge: { enabled: false, autoReturn: false } });
    await sw.evaluate(() => GhostPiPBackground.connectEngine());
    await tab1.goto(`${base}?w=640&h=360&hue=210`, { waitUntil: "load" });
    await openLauncherAndClick(tab1, "docPip");

    await poll(
      () =>
        sw.evaluate(async () => {
          const { pip = {} } = await chrome.storage.session.get("pip");
          return Object.values(pip).some((e) => e.bound && e.kind === "document");
        }),
      Boolean,
      4500,
    );
    const w0 = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      Boolean,
      4000,
    );
    assert(w0, "hosted docPip window not found in Win32");
    await sleep(950);

    // Hold Ctrl+Alt and resize west edge wider by 80px, then drag window to custom position (240, 190)
    await sendEnginePointerDrag(sw, {
      fromX: w0.rect.l + 2,
      fromY: Math.round((w0.rect.t + w0.rect.b) / 2),
      toX: w0.rect.l - 78,
      toY: Math.round((w0.rect.t + w0.rect.b) / 2),
      hold: true,
    });
    await sleep(300);

    const wResized = inspectWin32State().pips[0];
    const targetX = 240;
    const targetY = 190;
    await sendEnginePointerDrag(sw, {
      fromX: Math.round((wResized.rect.l + wResized.rect.r) / 2),
      fromY: Math.round((wResized.rect.t + wResized.rect.b) / 2),
      toX: targetX + Math.round(wResized.rect.w / 2),
      toY: targetY + Math.round(wResized.rect.h / 2),
      hold: true,
    });
    await sleep(200);

    const savedPipBounds = await poll(
      () => sw.evaluate(async () => (await chrome.storage.local.get("pipBounds")).pipBounds),
      (b) => b && Math.abs(b.x - targetX) <= 12 && Math.abs(b.y - targetY) <= 12,
      2500,
    );

    await tab1.evaluate(() => documentPictureInPicture.window?.close());
    await poll(() => inspectWin32State(), (s) => s.pips.length === 0, 3000);

    // Open a brand new video in Full Mode -> must restore remembered (X, Y) and resized width!
    await tab1.goto(`${base}?w=640&h=360&hue=95`, { waitUntil: "load" });
    await openLauncherAndClick(tab1, "docPip");
    const wRestored = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (w) => w && savedPipBounds && Math.abs(w.rect.l - savedPipBounds.x) <= 10 && Math.abs(w.rect.t - savedPipBounds.y) <= 10,
      4500,
    );

    await tab1.evaluate(() => documentPictureInPicture.window?.close());
    await poll(() => inspectWin32State(), (s) => s.pips.length === 0, 3000);

    const ok =
      Boolean(savedPipBounds) &&
      Boolean(wRestored) &&
      wResized.rect.w >= w0.rect.w + 50 &&
      Math.abs(wRestored.rect.w - wResized.rect.w) <= 12 &&
      Math.abs(wRestored.rect.l - savedPipBounds.x) <= 10 &&
      Math.abs(wRestored.rect.t - savedPipBounds.y) <= 10;
    return {
      ok,
      info: `origW=${w0.rect.w} resizedW=${wResized?.rect.w} saved=(${savedPipBounds?.x},${savedPipBounds?.y},${savedPipBounds?.w}x${savedPipBounds?.h}) restored=${fmt(wRestored?.rect)}(w=${wRestored?.rect.w})`,
    };
  });

  // STEP 4: DRM / Native PiP Win32 Subtitle Overlay (GhostPiPSubtitleOverlay)
  await step("4 DRM native PiP Win32 subtitle overlay (GhostPiPSubtitleOverlay)", async () => {
    await resetAll({ clickThrough: true, dodge: { enabled: false, autoReturn: false } });
    await sw.evaluate(() => GhostPiPBackground.connectEngine());

    await tab1.setRequestInterception(true);
    const onReq = (req) => {
      const u = new URL(req.url());
      if (u.hostname === "www.netflix.com" && req.resourceType() === "document") {
        req.respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: PAGE_HTML({ w: 640, h: 360, hue: 5, drm: true }),
        });
      } else if (u.hostname === "www.netflix.com") {
        req.respond({ status: 404, body: "" });
      } else {
        req.continue();
      }
    };
    tab1.on("request", onReq);

    await tab1.goto("https://www.netflix.com/watch/99999", { waitUntil: "load" });
    await tab1.waitForFunction(() => Boolean(window.__drmReady));
    await tab1.evaluate(() => window.__setNfCaption("넷플릭스 DRM 자막 오버레이 테스트"));
    const drmState = await tab1.evaluate(() => window.__drmReady);
    if (drmState === true) {
      await openLauncherAndClick(tab1, "docPip");
    } else {
      await tab1.evaluate(() => document.getElementById("vid").requestPictureInPicture());
    }

    const nativeAndSub = await poll(
      () => inspectWin32State(),
      (s) => s.pips.length === 1 && s.subs.length === 1,
      4500,
    );
    const pipW = nativeAndSub.pips[0];
    const subW = nativeAndSub.subs[0];

    const centeredHorizontally =
      Boolean(pipW && subW) &&
      Math.abs((subW.rect.l + subW.rect.r) / 2 - (pipW.rect.l + pipW.rect.r) / 2) <= 12;
    const anchoredAtBottom =
      Boolean(pipW && subW) && subW.rect.b <= pipW.rect.b && pipW.rect.b - subW.rect.b <= 40;

    // Clear subtitle -> Win32 GhostPiPSubtitleOverlay must hide cleanly
    await tab1.evaluate(() => window.__setNfCaption(""));
    const afterClear = await poll(() => inspectWin32State(), (s) => s.subs.length === 0, 2500);

    await tab1.evaluate(() => document.exitPictureInPicture?.().catch(() => {}));
    tab1.off("request", onReq);
    await tab1.setRequestInterception(false);

    const ok =
      Boolean(pipW && subW) &&
      subW.layered === true &&
      subW.transparent === true &&
      subW.topmost === true &&
      subW.hitPassesThrough === true &&
      centeredHorizontally &&
      anchoredAtBottom &&
      afterClear.subs.length === 0;
    return {
      ok,
      info: `pip=${fmt(pipW?.rect)} sub=${fmt(subW?.rect)} layered=${subW?.layered} clickThrough=${subW?.hitPassesThrough} centered=${centeredHorizontally} bottomAnchored=${anchoredAtBottom} hiddenOnClear=${afterClear.subs.length === 0}`,
    };
  });

  // STEP 5: Focus-Free In-Game Media Remote (Alt+Space Play/Pause, Alt+Arrows Seek, Alt+Wheel Volume)
  await step("5 in-game media remote (focus-free play/pause, seek, Alt+Wheel volume)", async () => {
    await resetAll({
      clickThrough: true,
      dodge: { enabled: false, autoReturn: false },
      media: { enabled: true, seekSec: 5, wheelVolume: true },
    });
    await sw.evaluate(() => GhostPiPBackground.connectEngine());
    await poll(
      () => sw.evaluate(async () => (await chrome.storage.session.get("engine")).engine?.connected === true),
      Boolean,
      4000,
    );

    await tab1.goto(`${base}?w=640&h=360&hue=215&seekable=1`, { waitUntil: "load" });
    await tab1.waitForFunction(() => Boolean(window.__seekReady));
    await openLauncherAndClick(tab1, "docPip");

    const pipW = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      Boolean,
      4500,
    );

    // Keep focus on a separate "game" window/tab so we prove PiP never steals OS foreground focus
    const gameTab = await browser.newPage();
    await gameTab.goto(`${base}?w=640&h=360&hue=40`, { waitUntil: "load" });
    await gameTab.bringToFront();
    await sleep(200);

    const readMediaState = () =>
      tab1.evaluate(() => {
        const d = documentPictureInPicture.window?.document;
        const v = document.getElementById("vid");
        const hud = d?.querySelector(".pip-hud");
        return {
          paused: Boolean(v?.paused),
          currentTime: Number(v?.currentTime ?? 0),
          volume: Number(v?.volume ?? 1),
          hudText: hud?.hasAttribute("data-show") ? hud.textContent : "",
        };
      });

    // 1. Alt+Space -> Pause, then Alt+Space -> Play
    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOTKEY", action: "playPause" }));
    const afterPause = await poll(readMediaState, (m) => m.paused === true, 2000);
    const fgAfterPause = inspectWin32State().fgHwnd;

    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOTKEY", action: "playPause" }));
    const afterPlay = await poll(readMediaState, (m) => m.paused === false, 2000);

    // 2. Alt+Right (+5s) -> ~15s, then Alt+Left (-5s) -> ~10s
    await tab1.evaluate(() => {
      window.__disableLoop = true;
      const v = document.getElementById("vid");
      if (v) v.currentTime = 10;
    });
    await sleep(140);
    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOTKEY", action: "seekForward" }));
    const afterSeekFwd = await poll(readMediaState, (m) => Math.abs(m.currentTime - 15) < 1.2, 2000);

    await sleep(140);
    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOTKEY", action: "seekBack" }));
    const afterSeekBack = await poll(readMediaState, (m) => Math.abs(m.currentTime - 10) < 1.2, 2000);

    // 3. Alt+Wheel Down x2 anywhere on screen (e.g. (120, 120) away from PiP) -> volume 1.0 -> 0.90, then Up x1 -> 0.95
    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x: 120, y: 120, delta: -120, hold: false, altOnly: true });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x: 120, y: 120, delta: -120, hold: false, altOnly: true });
    });
    const afterVolDown = await poll(readMediaState, (m) => Math.abs(m.volume - 0.9) < 0.015, 2000);

    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_WHEEL", x: 120, y: 120, delta: 120, hold: false, altOnly: true });
    });
    const afterVolUp = await poll(readMediaState, (m) => Math.abs(m.volume - 0.95) < 0.015, 2000);
    const fgAfterAll = inspectWin32State().fgHwnd;

    await gameTab.close();
    await tab1.evaluate(() => documentPictureInPicture.window?.close());
    await poll(() => inspectWin32State(), (s) => s.pips.length === 0, 3000);

    const focusKept = Boolean(pipW) && fgAfterPause !== pipW.hwnd && fgAfterAll !== pipW.hwnd;
    const ok =
      afterPause.paused === true &&
      afterPlay.paused === false &&
      Math.abs(afterSeekFwd.currentTime - 15) < 1.2 &&
      Math.abs(afterSeekBack.currentTime - 10) < 1.2 &&
      Math.abs(afterVolDown.volume - 0.9) < 0.015 &&
      Math.abs(afterVolUp.volume - 0.95) < 0.015 &&
      focusKept;
    return {
      ok,
      info: `pause=${afterPause.paused}->play=${!afterPlay.paused} seek=10->${afterSeekFwd.currentTime.toFixed(1)}->${afterSeekBack.currentTime.toFixed(1)} vol=${afterVolDown.volume.toFixed(2)}->${afterVolUp.volume.toFixed(2)} hud="${afterVolUp.hudText}" focusKept=${focusKept}`,
    };
  });

  // STEP 6: Reverse Ghost / Peek Mode (0%/5% Hidden -> 80% Hold -> 0% Release)
  await step("6 peek mode / reverse ghost (0%/5% hidden -> 80% hold -> 0% release)", async () => {
    // Intentionally leave clickThrough: false to prove Peek Mode enforces click-through on its own!
    await resetAll({
      clickThrough: false,
      dodge: { enabled: false, autoReturn: false },
      peek: { enabled: false, key: "Alt", idleOpacity: 0, activeOpacity: 0.8 },
    });
    await sw.evaluate(() => GhostPiPBackground.connectEngine());
    await poll(
      () => sw.evaluate(async () => (await chrome.storage.session.get("engine")).engine?.connected === true),
      Boolean,
      4000,
    );

    await tab1.goto(`${base}?w=640&h=360&hue=280`, { waitUntil: "load" });
    await openLauncherAndClick(tab1, "docPip");

    const wInitial = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (p) => p && p.alpha === Math.round(0.7 * 255),
      4500,
    );

    // Toggle Peek Mode ON via global shortcut Alt+P ("peek") while TEST_PEEK is false
    await sw.evaluate(() => {
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_PEEK", peek: false });
      GhostPiPBackground.postToEngine({ v: 1, type: "TEST_HOTKEY", action: "peek" });
    });

    const wHidden0 = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (p) => p && p.alpha === 0 && p.transparent === true && p.hitPassesThrough === true,
      2500,
    );

    // Hold Peek key -> Win32 alpha rises to 204 (80%), while staying click-through!
    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_PEEK", peek: true }));
    const wPeeking = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (p) => p && p.alpha === 204 && p.transparent === true && p.hitPassesThrough === true,
      2500,
    );

    // Release Peek key -> Win32 alpha immediately returns to 0!
    await sw.evaluate(() => GhostPiPBackground.postToEngine({ v: 1, type: "TEST_PEEK", peek: false }));
    const wReleased = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (p) => p && p.alpha === 0 && p.hitPassesThrough === true,
      2500,
    );

    // Faint outline idleOpacity: 0.05 -> Win32 alpha === 13
    await sw.evaluate(() => GhostPiPBackground.patchSettings({ peek: { idleOpacity: 0.05 } }));
    const wOutline = await poll(
      () => inspectWin32State().pips.find((p) => p.className === "GhostPiPClipHost" && p.layered),
      (p) => p && p.alpha === 13 && p.hitPassesThrough === true,
      2500,
    );

    await tab1.evaluate(() => documentPictureInPicture.window?.close());
    await poll(() => inspectWin32State(), (s) => s.pips.length === 0, 3000);

    const ok =
      Boolean(wInitial && wHidden0 && wPeeking && wReleased && wOutline) &&
      wHidden0.alpha === 0 &&
      wHidden0.hitPassesThrough === true &&
      wPeeking.alpha === 204 &&
      wPeeking.hitPassesThrough === true &&
      wReleased.alpha === 0 &&
      wOutline.alpha === 13;
    return {
      ok,
      info: `win32Alpha=(${wInitial?.alpha}->${wHidden0?.alpha}->hold:${wPeeking?.alpha}->rel:${wReleased?.alpha}->5%:${wOutline?.alpha}) passThrough=${wPeeking?.hitPassesThrough}`,
    };
  });

  await sw.evaluate(() => GhostPiPBackground.patchSettings({ enabled: false }).catch(() => {}));
  await sleep(400);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log("\n[features v1.1 e2e]");
for (const s of STEPS) {
  console.log(`  ${row[s].status.padEnd(4)} ${s.padEnd(64)} ${row[s].info}`);
}
const failed = STEPS.some((s) => row[s].status !== "PASS");
process.exit(failed ? 1 : 0);
