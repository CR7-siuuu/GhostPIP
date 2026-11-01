import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, info) => results.push({ name, ok: Boolean(ok), info });

async function poll(fn, ok, timeout = 4000) {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}

// Ranking banner state of a chzzk chat document: embed marker set by chat-frame.js, and whether any
// ranking wrapper is still rendered.
const RANKING_PROBE = () => {
  const rankingEls = [...document.querySelectorAll('[class*="_ranking_button_"], [class*="_ranking_close_"]')];
  return {
    embed: document.documentElement.hasAttribute("data-ghostpip-embed"),
    rankingFound: rankingEls.length,
    rankingVisible: rankingEls.some((el) => el.getBoundingClientRect().height > 0),
    chatItems: document.querySelectorAll('[class*="_item_"]').length,
  };
};

// Real channels only sometimes show the ranking banner, so also plant a banner-shaped node with the
// same hashed-class pattern and confirm the embed-scoped rule hides it.
const PLANT_RANKING = () => {
  const aside = document.querySelector('aside[class*="_is_popup_chat_"]');
  if (!aside) return null;
  const wrap = document.createElement("div");
  wrap.className = "_container_gptest_2";
  const b = document.createElement("button");
  b.className = "_ranking_button_gptest_141";
  b.textContent = "주간 후원 랭킹";
  wrap.append(b);
  aside.prepend(wrap);
  const hidden = getComputedStyle(wrap).display === "none";
  wrap.remove();
  return hidden;
};

const browser = await puppeteer.launch({  executablePath: CHROME,
  headless: false,
  pipe: true,
  enableExtensions: true,
  defaultViewport: null,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=ko"],
});

try {
  const extId = await browser.installExtension(path.join(ROOT, "extension"));
  const sw = await (await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
  )).worker();
  await sw.evaluate(() => chrome.storage.local.set({ floatLayout: null }));

  const page = (await browser.pages())[0];
  {
    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" } });
    await cdp.detach();
  }

  await page.goto("https://chzzk.naver.com/lives", { waitUntil: "domcontentloaded" });
  const live = await poll(
    () => page.evaluate(() => [...document.querySelectorAll('a[href*="/live/"]')].map((a) => a.href).find((h) => /\/live\/[0-9a-f]{32}/.test(h)) ?? null),
    Boolean,
    20000,
  );
  if (!live) throw new Error("no chzzk live channel found");
  await page.goto(live, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused), { timeout: 30000 });
  await sleep(2000);

  async function launcherButton(action) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const c = await page.evaluate(() => {
        const v = document.querySelector("video.webplayer-internal-video") || document.querySelector("video");
        const r = v.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(5, 5);
      await page.mouse.move(c.x + attempt * 15, c.y + attempt * 10, { steps: 8 });
      const b = await poll(
        () => page.evaluate((action) => {
          const el = document.getElementById("ghostpip-launcher")?.shadowRoot?.querySelector(`[data-action="${action}"]`);
          const r = el?.getBoundingClientRect();
          return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        }, action),
        Boolean,
        2000,
      );
      if (b) return b;
    }
    await page.screenshot({ path: path.join(ROOT, `test/e2e/out/chat_nolauncher_${action}.png`) });
    throw new Error(`launcher (${action}) not shown`);
  }

  // ---- Web mode: hold Ctrl+Alt to expose the controller, open chat, check ranking hidden, drag the grip.
  const btn = await launcherButton("inTab");
  await page.mouse.click(btn.x, btn.y);
  await sleep(600);
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  const chatToggle = await poll(
    () => page.evaluate(() => {
      const el = document.getElementById("ghostpip-controller")?.shadowRoot?.querySelector('[data-action="toggleWebChat"]');
      const r = el?.getBoundingClientRect();
      return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }),
    Boolean,
    2000,
  );
  await page.mouse.click(chatToggle.x, chatToggle.y);
  const chatFrame = await poll(
    () => page.frames().find((f) => /\/chat$/.test(new URL(f.url()).pathname) && f.parentFrame() === page.mainFrame()) ?? null,
    Boolean,
    8000,
  );
  await sleep(4000);
  const webProbe = chatFrame ? await chatFrame.evaluate(RANKING_PROBE).catch((e) => ({ error: e.message })) : null;
  record("1 web chat frame marked as embed", webProbe?.embed, JSON.stringify(webProbe));
  const webPlanted = chatFrame ? await chatFrame.evaluate(PLANT_RANKING).catch(() => null) : null;
  record("2 web chat ranking hidden", webProbe && !webProbe.rankingVisible && webPlanted === true, `real found=${webProbe?.rankingFound} visible=${webProbe?.rankingVisible} planted hidden=${webPlanted}`);

  // Release and re-press Ctrl+Alt so the controller popover is re-opened after the chat popover,
  // confirming the controller's south handle does not steal the top-edge chat grip.
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await sleep(100);
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await sleep(100);

  const readChat = () => page.evaluate(() => {
    const host = document.getElementById("ghostpip-chat");
    const grip = host?.shadowRoot?.querySelector(".chat-resize");
    const hr = host.getBoundingClientRect();
    const gr = grip.getBoundingClientRect();
    return {
      open: host.matches(":popover-open"),
      h: Math.round(hr.height),
      top: Math.round(hr.top),
      atBottom: Math.abs(gr.bottom - hr.bottom) <= 2,
      grip: { x: gr.left + gr.width / 2, y: gr.top + gr.height / 2 },
    };
  });
  const before = await readChat();
  await page.mouse.move(before.grip.x, before.grip.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(before.grip.x, before.grip.y - 60, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const shrunk = await readChat();
  await page.mouse.move(shrunk.grip.x, shrunk.grip.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(shrunk.grip.x, shrunk.grip.y + 40, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const after = await readChat();
  const stored = await sw.evaluate(async () => (await chrome.storage.local.get("floatLayout")).floatLayout?.chatHeight);
  record(
    "3 web chat bottom grip resizes and persists",
    before.open && before.atBottom && before.h - shrunk.h === 60 && after.h - shrunk.h === 40 && after.top === before.top && stored === after.h,
    `open=${before.open} atBottom=${before.atBottom} h=${before.h}->${shrunk.h}->${after.h} top=${before.top}->${after.top} stored=${stored}`,
  );

  // ---- Full mode: click the controller's docPip button directly (trusted click preserves user activation).
  const dbtn = await poll(
    () => page.evaluate(() => {
      const el = document.getElementById("ghostpip-controller")?.shadowRoot?.querySelector('[data-action="docPip"]');
      const r = el?.getBoundingClientRect();
      return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }),
    Boolean,
    2000,
  );
  await page.mouse.click(dbtn.x, dbtn.y);
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => documentPictureInPicture.window?.document.querySelector("iframe"), { timeout: 8000 });
  await sleep(5000);
  const pipFrameDoc = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document.querySelector("iframe").contentDocument;
    const els = [...d.querySelectorAll('[class*="_ranking_button_"], [class*="_ranking_close_"]')];
    return {
      embed: d.documentElement.hasAttribute("data-ghostpip-embed"),
      rankingFound: els.length,
      rankingVisible: els.some((el) => el.getBoundingClientRect().height > 0),
    };
  });
  record("4 PiP chat frame marked as embed", pipFrameDoc.embed, JSON.stringify(pipFrameDoc));
  const pipPlanted = await page.evaluate((src) => {
    const w = documentPictureInPicture.window.document.querySelector("iframe").contentWindow;
    return w.eval(`(${src})()`);
  }, PLANT_RANKING.toString()).catch((e) => "ERR " + e.message);
  record("5 PiP chat ranking hidden", !pipFrameDoc.rankingVisible && pipPlanted === true, `real found=${pipFrameDoc.rankingFound} visible=${pipFrameDoc.rankingVisible} planted hidden=${pipPlanted}`);

  const split = await page.evaluate(async () => {
    const w = documentPictureInPicture.window;
    const d = w.document;
    const s = d.querySelector(".pip-handle.s");
    const frame = d.querySelector("iframe");
    const video = d.querySelector("video");
    const ir0 = frame.getBoundingClientRect();
    const sr0 = s.getBoundingClientRect();
    const vr0 = video.getBoundingClientRect();
    const atBottom = Math.abs(sr0.bottom - ir0.bottom) <= 2 && !d.querySelector(".pip-chat-split");
    const before = Math.round(ir0.height);
    const videoBefore = Math.round(vr0.height);
    const y0 = Math.round(sr0.top + sr0.height / 2);
    const ev = (type, dy) =>
      s.dispatchEvent(
        new w.PointerEvent(type, {
          bubbles: true,
          clientX: Math.round(sr0.left + sr0.width / 2),
          clientY: y0 + dy,
          screenY: 500 + dy,
          button: 0,
          pointerId: 7,
        }),
      );
    ev("pointerdown", 0);
    ev("pointermove", -40);
    ev("pointermove", -80);
    ev("pointerup", -80);
    await new Promise((res) => setTimeout(res, 500));
    const shrunk = Math.round(frame.getBoundingClientRect().height);
    ev("pointerdown", 0);
    ev("pointermove", 50);
    ev("pointerup", 50);
    await new Promise((res) => setTimeout(res, 500));
    return {
      atBottom,
      before,
      shrunk,
      after: Math.round(frame.getBoundingClientRect().height),
      videoBefore,
      videoAfter: Math.round(video.getBoundingClientRect().height),
    };
  });
  const pipStored = await poll(
    () => sw.evaluate(async () => (await chrome.storage.local.get("floatLayout")).floatLayout?.pipChatHeight),
    (v) => v === split.after,
    2500,
  );
  record(
    "6 PiP bottom grip resizes chat and keeps video size",
    split.atBottom && split.before - split.shrunk >= 60 && split.after - split.shrunk >= 40 && split.videoBefore === split.videoAfter && pipStored === split.after,
    `atBottom=${split.atBottom} chat=${split.before}->${split.shrunk}->${split.after} video=${split.videoBefore}->${split.videoAfter} stored=${pipStored}`,
  );

  // Verify corner/edge window resize (including alternating diagonal and vertical steps) freely enlarges the video stage without inflating chat.
  const beforeResize = await page.evaluate(() => {
    const w = documentPictureInPicture.window;
    const d = w.document;
    d.documentElement.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, clientX: w.innerWidth - 6, clientY: w.innerHeight - 6 }));
    return {
      chat0: Math.round(d.querySelector("iframe").getBoundingClientRect().height),
      vid0: Math.round(d.querySelector("video").getBoundingClientRect().height),
      dpr: w.devicePixelRatio || 1,
    };
  });
  await sleep(700);
  for (let i = 0; i < 6; i++) {
    await sw.evaluate((dpr) => GhostPiPBackground.postToEngine({ v: 1, type: "PIP_RESIZE", deltaH: 45, dpr }), beforeResize.dpr);
    await sleep(60);
  }
  await sleep(400);
  const afterResize = await page.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    return {
      chatAfter: Math.round(d.querySelector("iframe").getBoundingClientRect().height),
      vidAfter: Math.round(d.querySelector("video").getBoundingClientRect().height),
    };
  });
  record(
    "7 PiP corner/edge resize enlarges video without inflating chat",
    afterResize.vidAfter - beforeResize.vid0 >= 220 && afterResize.chatAfter <= beforeResize.chat0,
    `video=${beforeResize.vid0}->${afterResize.vidAfter} chat=${beforeResize.chat0}->${afterResize.chatAfter}`,
  );

  const readPip = () =>
    page.evaluate(() => {
      const w = documentPictureInPicture.window;
      const d = w.document;
      return {
        innerH: w.innerHeight,
        chat: Math.round(d.querySelector("iframe").getBoundingClientRect().height),
        vid: Math.round(d.querySelector("video").getBoundingClientRect().height),
        dpr: w.devicePixelRatio || 1,
      };
    });
  const hoverPip = (fx, fy) =>
    page.evaluate(([fx, fy]) => {
      const w = documentPictureInPicture.window;
      w.document.documentElement.dispatchEvent(
        new w.PointerEvent("pointermove", { bubbles: true, clientX: Math.round(w.innerWidth * fx), clientY: Math.round(w.innerHeight * fy) }),
      );
    }, [fx, fy]);

  // Engine-driven bottom-edge drag anywhere along the edge (not a corner) resizes the chat.
  // A real Win32 corner drag (wider and taller) first must leave the chat height alone.
  await sleep(700);
  await hoverPip(0.99, 0.99);
  const beforeCorner = await readPip();
  execFileSync("powershell", ["-NoProfile", "-Command", `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GpDrag {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  public static string Cls(IntPtr h) { var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); return sb.ToString(); }
}
"@
$hostHwnd = [IntPtr]::Zero
[GpDrag]::EnumWindows({ param($h, $l) if ([GpDrag]::IsWindowVisible($h) -and [GpDrag]::Cls($h) -eq "GhostPiPClipHost") { $script:hostHwnd = $h; return $false }; return $true }, [IntPtr]::Zero) | Out-Null
$cw = [IntPtr]::Zero
[GpDrag]::EnumChildWindows($hostHwnd, { param($h, $l) if ([GpDrag]::Cls($h) -eq "Chrome_WidgetWin_1") { $script:cw = $h; return $false }; return $true }, [IntPtr]::Zero) | Out-Null
$hr = New-Object GpDrag+RECT; [GpDrag]::GetWindowRect($hostHwnd, [ref]$hr) | Out-Null
$cr = New-Object GpDrag+RECT; [GpDrag]::GetWindowRect($cw, [ref]$cr) | Out-Null
$w = $hr.R - $hr.L; $h = $hr.B - $hr.T
$padW = ($cr.R - $cr.L) - $w; $padH = ($cr.B - $cr.T) - $h
$offX = $cr.L - $hr.L; $offY = $cr.T - $hr.T
for ($i = 0; $i -lt 40; $i++) {
  if ($i % 2 -eq 0) { $w += 12; $h += 3 } else { $h += 3 }
  [GpDrag]::SetWindowPos($hostHwnd, [IntPtr]::Zero, 0, 0, $w, $h, 0x0016) | Out-Null
  [GpDrag]::SetWindowPos($cw, [IntPtr]::Zero, $offX, $offY, $w + $padW, $h + $padH, 0x0014) | Out-Null
  Start-Sleep -Milliseconds 15
}
`]);
  await sleep(500);
  const afterCorner = await readPip();
  record(
    "7b PiP Win32 corner drag keeps chat height, grows video",
    afterCorner.chat === beforeCorner.chat && afterCorner.vid - beforeCorner.vid >= 100,
    `chat=${beforeCorner.chat}->${afterCorner.chat} video=${beforeCorner.vid}->${afterCorner.vid} innerH=${beforeCorner.innerH}->${afterCorner.innerH}`,
  );
  await sleep(700);
  await page.evaluate(() => {
    const w = documentPictureInPicture.window;
    w.document.documentElement.dispatchEvent(
      new w.PointerEvent("pointermove", { bubbles: true, clientX: Math.round(w.innerWidth * 0.3), clientY: w.innerHeight - 4 }),
    );
  });
  const beforeEdge = await readPip();
  await sw.evaluate((dpr) => GhostPiPBackground.postToEngine({ v: 1, type: "PIP_RESIZE", deltaH: 60, dpr }), beforeEdge.dpr);
  await sleep(500);
  const afterEdge = await readPip();
  record(
    "8 PiP bottom edge (off-center) resizes chat, keeps video",
    Math.abs(afterEdge.chat - beforeEdge.chat - 60) <= 3 && Math.abs(afterEdge.vid - beforeEdge.vid) <= 1,
    `chat=${beforeEdge.chat}->${afterEdge.chat} video=${beforeEdge.vid}->${afterEdge.vid}`,
  );

  // At Chrome's PiP size cap the window cannot grow; the + button grows chat by taking video height.
  await sleep(700);
  await hoverPip(0.5, 0.3);
  await sw.evaluate((dpr) => GhostPiPBackground.postToEngine({ v: 1, type: "PIP_RESIZE", deltaH: 1600, dpr }), beforeEdge.dpr);
  await sleep(700);
  const atCap = await readPip();
  await page.evaluate(() => documentPictureInPicture.window.document.querySelector('[data-action="chatBigger"]').click());
  await sleep(900);
  const afterPlus = await readPip();
  record(
    "9 PiP + button grows chat at Chrome size cap",
    Math.abs(afterPlus.innerH - atCap.innerH) <= 2 && afterPlus.chat - atCap.chat >= 70 && atCap.vid - afterPlus.vid >= 70,
    `innerH=${atCap.innerH}->${afterPlus.innerH} chat=${atCap.chat}->${afterPlus.chat} video=${atCap.vid}->${afterPlus.vid}`,
  );
} catch (e) {
  record("fatal", false, String(e?.message ?? e).slice(0, 200));
} finally {
  await browser.close().catch(() => {});
}

console.log("\n[chat e2e]");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name.padEnd(40)} ${r.info}`);
process.exit(results.length === 10 && results.every((r) => r.ok) ? 0 : 1);
