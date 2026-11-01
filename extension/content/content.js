(() => {
  try {
    globalThis.__ghostpipCleanup?.();
  } catch {}

  const Dodge = globalThis.GhostPiPDodge;
  const Settings = globalThis.GhostPiPSettings;

  const FLOAT_CLASS = "ghostpip-inpage-target";
  const DOCPIP_SOURCE_CLASS = "ghostpip-docpip-source";
  const DEFAULT_FLOAT_WIDTH = 480;
  const MIN_FLOAT_WIDTH = 140;
  const MAX_FLOAT_WIDTH = 2560;
  const MIN_FLOAT_HEIGHT = 90;
  const MAX_FLOAT_HEIGHT = 2160;
  const CORNER_SNAP_PX = 8;
  const WHEEL_OPACITY_STEP = 0.05;
  const FADED_OPACITY = 0.1;
  const DODGE_TICK_MS = 50;
  const SCAN_THROTTLE_MS = 250;
  const PIP_CHAT_HEIGHT = 420;
  const MIN_CHAT_HEIGHT = 120;
  const GP_VARS = ["--gp-x", "--gp-y", "--gp-w", "--gp-h", "--gp-opacity"];
  const RESIZE_DIRS = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
  const HOLD = {
    "Ctrl+Alt": (e) => e.ctrlKey && e.altKey,
    "Ctrl+Shift": (e) => e.ctrlKey && e.shiftKey,
    "Alt+Shift": (e) => e.altKey && e.shiftKey,
    Ctrl: (e) => e.ctrlKey,
    Alt: (e) => e.altKey,
    Shift: (e) => e.shiftKey,
  };

  const ctx = {
    settings: Settings.merge(undefined),
    layout: { width: DEFAULT_FLOAT_WIDTH, height: null, pos: null, chatOpen: false },
    siteId: "generic",
    site: { video: null, chatPopoutUrl: null },
    video: null,
    url: location.href,
  };

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage({ v: 1, ...msg });
    } catch {
      return null;
    }
  }

  const px = (n) => `${Math.round(n)}px`;
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  function setVars(el, vars) {
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(`--gp-${k}`, v);
  }

  function videoRatio(video, ratioFallback = 9 / 16) {
    return video.videoWidth ? video.videoHeight / video.videoWidth : ratioFallback;
  }

  function floatSize(video, targetWidth, maxHeight, ratioFallback = 9 / 16, maxWidth = MAX_FLOAT_WIDTH) {
    const ratio = videoRatio(video, ratioFallback);
    const clampedW = Math.min(Math.max(MIN_FLOAT_WIDTH, targetWidth), Math.max(MIN_FLOAT_WIDTH, maxWidth));
    const height = Math.round(clampedW * ratio);
    if (height <= maxHeight) return { w: Math.round(clampedW), h: height };
    const h = Math.round(Math.max(120, maxHeight));
    return { w: Math.round(h / ratio), h };
  }

  function sanitizeLayout(raw) {
    const width =
      Number.isFinite(raw?.width) && raw.width >= MIN_FLOAT_WIDTH && raw.width <= MAX_FLOAT_WIDTH
        ? Math.round(raw.width)
        : DEFAULT_FLOAT_WIDTH;
    const height =
      Number.isFinite(raw?.height) && raw.height >= MIN_FLOAT_HEIGHT && raw.height <= MAX_FLOAT_HEIGHT
        ? Math.round(raw.height)
        : null;
    const pos =
      raw?.pos &&
      typeof raw.pos === "object" &&
      Number.isFinite(raw.pos.rx) &&
      Number.isFinite(raw.pos.ry)
        ? { rx: Math.min(1, Math.max(0, raw.pos.rx)), ry: Math.min(1, Math.max(0, raw.pos.ry)) }
        : null;
    const chatOpen = Boolean(raw?.chatOpen);
    const sizeOrNull = (v) => (Number.isFinite(v) && v >= MIN_CHAT_HEIGHT && v <= MAX_FLOAT_HEIGHT ? Math.round(v) : null);
    return { width, height, pos, chatOpen, chatHeight: sizeOrNull(raw?.chatHeight), pipChatHeight: sizeOrNull(raw?.pipChatHeight) };
  }

  function toRelPos(l, t, s, vp) {
    const maxL = Math.max(1, vp.r - s.w);
    const maxT = Math.max(1, vp.b - s.h);
    return {
      rx: Math.min(1, Math.max(0, l / maxL)),
      ry: Math.min(1, Math.max(0, t / maxT)),
    };
  }

  function fromRelPos(pos, s, vp) {
    const maxL = Math.max(0, vp.r - s.w);
    const maxT = Math.max(0, vp.b - s.h);
    const l = Math.round(Math.min(1, Math.max(0, pos.rx)) * maxL);
    const t = Math.round(Math.min(1, Math.max(0, pos.ry)) * maxT);
    return { l, t, r: l + s.w, b: t + s.h };
  }

  function persistLayout(next) {
    ctx.layout = sanitizeLayout({ ...ctx.layout, ...next });
    chrome.storage.local.set({ floatLayout: ctx.layout }).catch(() => {});
  }

  function stepOpacity(delta) {
    const next = Math.round(Math.min(1, Math.max(0.1, ctx.settings.opacity + delta)) * 100) / 100;
    if (next === ctx.settings.opacity) return next;
    ctx.settings = { ...ctx.settings, opacity: next };
    send({ type: "PATCH_SETTINGS", patch: { opacity: next } });
    return next;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(d) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  const ICON_WEB_MODE =
    "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9ZM3.5 3.2a.3.3 0 0 0-.3.3v9a.3.3 0 0 0 .3.3h9a.3.3 0 0 0 .3-.3v-9a.3.3 0 0 0-.3-.3h-9ZM8 8.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v2.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5V8.5Z";
  const ICON_FULL_MODE =
    "M2.5 3A1.5 1.5 0 0 0 1 4.5v7A1.5 1.5 0 0 0 2.5 13h5a.6.6 0 0 0 0-1.2h-5a.3.3 0 0 1-.3-.3v-7a.3.3 0 0 1 .3-.3h7a.3.3 0 0 1 .3.3v2a.6.6 0 1 0 1.2 0v-2A1.5 1.5 0 0 0 9.5 3h-7Zm6.5 5.5A1.5 1.5 0 0 1 10.5 7h3A1.5 1.5 0 0 1 15 8.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 11.5v-3Z";
  const ICON_CHAT =
    "M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12h2.2v2.1a.5.5 0 0 0 .82.38L8.4 12h5.1A1.5 1.5 0 0 0 15 10.5v-7A1.5 1.5 0 0 0 13.5 2h-11Zm2 3.2h7a.6.6 0 1 1 0 1.2h-7a.6.6 0 0 1 0-1.2Zm0 2.6h4.5a.6.6 0 1 1 0 1.2H4.5a.6.6 0 0 1 0-1.2Z";

  const BASE_CSS = `
    .bar { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px;
      background: linear-gradient(180deg, rgba(22, 27, 42, 0.9) 0%, rgba(13, 16, 26, 0.94) 100%);
      border: 1px solid rgba(125, 211, 252, 0.28);
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.6), 0 0 12px rgba(56, 189, 248, 0.14);
      backdrop-filter: blur(10px) saturate(150%);
      font: 600 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif; color: #f8fafc; }
    button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 999px; white-space: nowrap; color: rgba(241, 245, 249, 0.94);
      transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease; }
    button svg { width: 12px; height: 12px; fill: #7dd3fc; flex: none; transition: fill 0.14s ease; }
    button:hover { background: linear-gradient(135deg, rgba(56, 189, 248, 0.28) 0%, rgba(99, 102, 241, 0.32) 100%);
      color: #fff; box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.35); }
    button:hover svg { fill: #fff; }
    :host([data-pinned]) .bar:not(:hover) { opacity: 0.65; }`;

  const CONTROLLER_CSS = `
    .surface { position: absolute; inset: 0; box-sizing: border-box; pointer-events: none; border-radius: 6px;
      border: 2px solid rgba(56, 189, 248, 0.92);
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      box-shadow: 0 0 18px rgba(56, 189, 248, 0.22), inset 0 0 12px rgba(56, 189, 248, 0.12); }
    .handle { position: absolute; z-index: 2; pointer-events: auto; }
    .handle.n { top: -4px; left: 14px; right: 14px; height: 10px; cursor: ns-resize; }
    .handle.s { bottom: -4px; left: 14px; right: 14px; height: 10px; cursor: ns-resize; }
    .handle.w { left: -4px; top: 14px; bottom: 14px; width: 10px; cursor: ew-resize; }
    .handle.e { right: -4px; top: 14px; bottom: 14px; width: 10px; cursor: ew-resize; }
    .handle.nw { top: -5px; left: -5px; width: 18px; height: 18px; cursor: nwse-resize; }
    .handle.ne { top: -5px; right: -5px; width: 18px; height: 18px; cursor: nesw-resize; }
    .handle.sw { bottom: -5px; left: -5px; width: 18px; height: 18px; cursor: nesw-resize; }
    .handle.se { bottom: -5px; right: -5px; width: 18px; height: 18px; cursor: nwse-resize; }
    .handle.nw::after, .handle.ne::after, .handle.sw::after, .handle.se::after {
      content: ""; position: absolute; width: 9px; height: 9px; border-radius: 3px;
      background: linear-gradient(135deg, #bae6fd 0%, #38bdf8 100%);
      border: 1.5px solid #0f172a;
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
    .handle.nw::after { top: 4px; left: 4px; }
    .handle.ne::after { top: 4px; right: 4px; }
    .handle.sw::after { bottom: 4px; left: 4px; }
    .handle.se::after { bottom: 4px; right: 4px; }
    .bar { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 3;
      pointer-events: auto; }
    .skip-ad { position: absolute; bottom: 12px; right: 12px; z-index: 4; pointer-events: auto;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.92); border: 1.5px solid rgba(56, 189, 248, 0.78);
      color: #f8fafc; font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.65); cursor: pointer; backdrop-filter: blur(8px); }
    .skip-ad:hover { background: linear-gradient(135deg, rgba(56, 189, 248, 0.35) 0%, rgba(99, 102, 241, 0.4) 100%);
      border-color: #7dd3fc; color: #fff; }
    .skip-ad[hidden] { display: none !important; }
    .hud { position: absolute; bottom: 10px; left: 10px; z-index: 3; pointer-events: none;
      padding: 5px 10px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(125, 211, 252, 0.35); color: #e0f2fe;
      font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 4px 12px rgba(2, 6, 23, 0.55); backdrop-filter: blur(8px); }
    :host([data-bar-only]) .surface,
    :host([data-bar-only]) .handle,
    :host([data-bar-only]) .hud,
    :host([data-chat-top-grip]) .handle.s { display: none; }
    :host([data-remote]) button[data-mode="local"],
    :host(:not([data-remote])) button[data-mode="remote"] { display: none; }`;

  // Open shadow root so tests can pierce it; popover so it renders in the top layer above site overlays.
  function overlayHost(id, css, ...content) {
    document.getElementById(id)?.remove();
    const host = h("div", { id, popover: "manual" });
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style, ...content);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    root.addEventListener("click", (e) => ACTIONS[e.target.closest?.("[data-action]")?.dataset.action]?.());
    return {
      host,
      root,
      get open() {
        return host.matches(":popover-open");
      },
      show(vars) {
        setVars(host, vars);
        if (!host.isConnected) document.documentElement.append(host);
        if (!this.open) host.showPopover();
      },
      hide() {
        if (this.open) host.hidePopover();
      },
    };
  }

  const launcher = overlayHost(
    "ghostpip-launcher",
    BASE_CSS,
    h("div", { class: "bar" },
      h("button", { "data-action": "inTab", title: "웹 모드 (브라우저 탭 내 오버레이)" },
        svgIcon(ICON_WEB_MODE),
        "웹 모드"),
      h("button", { "data-action": "docPip", title: "전체 모드 (데스크톱 PiP 창)" },
        svgIcon(ICON_FULL_MODE),
        "전체 모드")),
  );

  const hudEl = h("div", { class: "hud" }, "");
  const webChatLabel = h("span", {}, "채팅창 보기");
  const webChatBtn = h(
    "button",
    { "data-action": "toggleWebChat" },
    svgIcon(ICON_CHAT),
    webChatLabel,
  );
  const skipAdBtn = h(
    "button",
    { class: "skip-ad", "data-action": "skipAd", hidden: "" },
    "광고 건너뛰기 ⏭",
  );
  const WEB_CHAT_CSS = `
    :host { box-sizing: border-box; background: #0f172a; box-shadow: 0 8px 24px rgba(2, 6, 23, 0.55); }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .chat-resize { position: absolute; left: 14px; right: 14px; height: 12px; z-index: 2; cursor: ns-resize; touch-action: none; }
    .chat-resize[data-edge="top"] { top: 0; }
    .chat-resize[data-edge="bottom"] { bottom: 0; }
    .chat-resize::after { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 4px; border-radius: 4px;
      transform: translate(-50%, -50%); background: rgba(125, 211, 252, 0.9); box-shadow: 0 0 6px rgba(56, 189, 248, 0.7);
      opacity: 0; transition: opacity 0.14s ease; }
    :host(:hover) .chat-resize::after, :host([data-interactive]) .chat-resize::after, .chat-resize[data-active]::after { opacity: 1; }
    :host([data-resizing]) iframe { pointer-events: none; }`;
  const webChatFrame = h("iframe", {});
  const webChatResize = h("div", { class: "chat-resize", "data-edge": "bottom", title: "드래그해서 채팅창 크기 조절" });
  const webChat = overlayHost("ghostpip-chat", WEB_CHAT_CSS, webChatFrame, webChatResize);

  const controller = overlayHost(
    "ghostpip-controller",
    BASE_CSS + CONTROLLER_CSS,
    h("div", { class: "surface" }),
    ...RESIZE_DIRS.map((dir) => h("div", { class: `handle ${dir}`, "data-resize": dir })),
    hudEl,
    skipAdBtn,
    h("div", { class: "bar" },
      h("button", { "data-action": "idle" }, "복귀"),
      h("button", { "data-action": "docPip", "data-mode": "local" },
        svgIcon(ICON_FULL_MODE),
        "전체 모드"),
      h("button", { "data-action": "focusSource", "data-mode": "remote" }, "원본 탭"),
      webChatBtn),
  );

  let dragSink = null;
  let toggleWebChatSink = null;
  let skipAdSink = null;
  controller.root.addEventListener("pointerdown", (e) => {
    if (!dragSink || e.button !== 0 || e.target.closest?.(".bar") || e.target.closest?.(".skip-ad")) return;
    const target = e.target;
    const resizeDir = target.dataset?.resize || null;
    if (!resizeDir) return;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {}
    dragSink.start(e, resizeDir);
  });
  window.addEventListener("pointermove", (e) => {
    dragSink?.pointerMove?.(e);
    if (!dragSink?.active()) return;
    if (e.isTrusted && (e.buttons & 1) === 0) {
      dragSink.end();
      return;
    }
    dragSink.move(e);
  }, true);
  window.addEventListener("pointerup", () => {
    dragSink?.pointerUp?.();
    if (dragSink?.active()) dragSink.end();
  }, true);
  window.addEventListener("pointercancel", () => {
    dragSink?.pointerUp?.();
    if (dragSink?.active()) dragSink.end();
  }, true);

  const AD_SKIP_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-container button",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-overlay-close-button",
    ".pzp-ad-skip-button",
    "[class*='pzp-ad'] button[class*='skip' i]",
    "[class*='ad_skip' i]",
    "#skip_btn",
    "#da_btn_skip",
    ".da_skip",
    ".btn_skip",
    "button[data-role='skip']",
    "[aria-label*='광고 건너뛰기']",
    "[aria-label*='Skip Ad' i]",
    "[aria-label*='Skip Ads' i]",
  ].join(",");

  function isVisibleElement(el) {
    if (!el || !el.isConnected || el.disabled) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findSkipAdElement(video) {
    for (const el of document.querySelectorAll(AD_SKIP_SELECTORS)) {
      if (isVisibleElement(el)) return el;
    }
    const container =
      video?.closest?.(
        "#movie_player, .html5-video-player, .pzp, [class*='live_player'], #livePlayer, .video_box, [class*='video-player']",
      ) || video?.parentElement?.parentElement;
    if (container) {
      for (const btn of container.querySelectorAll("button, [role='button']")) {
        if (!isVisibleElement(btn)) continue;
        const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.trim();
        if (/광고\s*건너뛰기|건너뛰기|광고\s*스킵|skip\s*ads?|^skip$/i.test(text)) return btn;
      }
    }
    return null;
  }

  function canSkipAd(video) {
    if (findSkipAdElement(video)) return true;
    return Boolean(
      document.querySelector(
        "#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing, .ytp-ad-player-overlay, .ytp-ad-player-overlay-layout",
      ),
    );
  }

  function triggerSkipAd(video) {
    const btn = findSkipAdElement(video);
    if (btn) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      btn.click?.();
    }
    for (const closeBtn of document.querySelectorAll(".ytp-ad-overlay-close-button")) {
      if (isVisibleElement(closeBtn)) closeBtn.click?.();
    }
    const v = video || ctx.video || findVideo();
    if (
      v &&
      (btn ||
        document.querySelector(
          "#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing",
        )) &&
      Number.isFinite(v.duration) &&
      v.duration > 0 &&
      v.duration < 600
    ) {
      try {
        v.currentTime = v.duration;
      } catch {}
    }
  }

  // GIF-style clips (X/Reddit/Imgur "gifv", hero backgrounds) are silent and loop or end quickly;
  // real playback either decodes audio, is live, or runs long enough to be worth floating.
  function isGifLike(v) {
    if (v.webkitAudioDecodedByteCount > 0 || v.audioTracks?.length > 0) return false;
    if (v.loop) return true;
    const d = v.duration;
    if (Number.isFinite(d) && d > 0 && d < 30) return true;
    return v.muted && !v.controls && !v.paused && v.currentTime > 1.5;
  }

  function isRenderedVideo(v, minW, minH) {
    if (v.videoWidth <= 0 || v.hasAttribute("data-gp-remote") || !v.isConnected) return false;
    const r = v.getBoundingClientRect();
    if (r.width < minW || r.height < minH) return false;
    const cs = getComputedStyle(v);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  }

  function findVideo() {
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const pick = (list, ok) => [...list].filter(ok).sort((a, b) => area(b) - area(a))[0] ?? null;
    if (ctx.site.video) {
      return (
        pick(document.querySelectorAll(ctx.site.video), (v) => isRenderedVideo(v, 1, 1)) ||
        pick(document.querySelectorAll("video"), (v) => isRenderedVideo(v, 1, 1))
      );
    }
    // Listed sites without a dedicated selector (OTT services) stay on even when allSites is off,
    // but still go through the generic filter so browse-page preview clips are skipped.
    if (ctx.siteId === "generic" && !ctx.settings.allSites) return null;
    return pick(document.querySelectorAll("video"), (v) => isRenderedVideo(v, 280, 158) && !isGifLike(v));
  }

  // The pointer must be on the player itself, not on an image or card that merely overlaps the
  // video's rect: some element on the composed path has to be the video or a tight wrapper of it.
  function isPointerOnPlayer(video, e) {
    const vr = video.getBoundingClientRect();
    if (!inside(vr, e.clientX, e.clientY)) return false;
    const maxArea = vr.width * vr.height * 1.6;
    for (const el of e.composedPath()) {
      if (el === video) return true;
      if (el === document.body || el === document.documentElement || el === document || el === window) break;
      if (!(el instanceof Element)) continue;
      if (el.contains(video) || el.shadowRoot?.contains(video)) {
        const r = el.getBoundingClientRect();
        return r.width * r.height <= maxArea;
      }
    }
    return false;
  }

  function hasYouTubeLiveChat() {
    if (document.documentElement.hasAttribute("data-gp-force-chat")) return true;
    const chatEl = document.querySelector("ytd-live-chat-frame:not([hidden]), #chat:not([hidden]) iframe#chatframe");
    if (chatEl && !chatEl.closest("[hidden]")) return true;
    const liveBadge = document.querySelector(".ytp-live-badge:not([disabled])");
    return isVisibleElement(liveBadge);
  }

  function chatUrlFor(site) {
    if (location.hostname === "www.youtube.com" && location.pathname === "/watch" && !hasYouTubeLiveChat()) {
      return null;
    }
    if (site?.chatPopoutUrl && site?.idFrom) {
      const id = "param" in site.idFrom
        ? new URLSearchParams(location.search).get(site.idFrom.param)
        : location.pathname.split("/")[site.idFrom.pathIndex];
      if (id) {
        return site.chatPopoutUrl.replace(/\{(?:videoId|channelId|channel)\}/g, encodeURIComponent(id));
      }
    }
    if (ctx.siteId !== "generic" && !site?.chatPopoutUrl) return null;
    if (location.hostname === "chzzk.naver.com" && location.pathname.startsWith("/live/")) {
      const id = location.pathname.split("/")[2];
      if (id) return `https://chzzk.naver.com/live/${encodeURIComponent(id)}/chat`;
    }
    if (location.hostname === "www.youtube.com" && location.pathname === "/watch") {
      const id = new URLSearchParams(location.search).get("v");
      if (id) return `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(id)}`;
    }
    if (location.hostname === "www.twitch.tv") {
      const id = location.pathname.split("/")[1];
      if (id) return `https://www.twitch.tv/popout/${encodeURIComponent(id)}/chat`;
    }
    return null;
  }

  function persistHome(corner, keepLayoutPos = false) {
    send({ type: "PATCH_SETTINGS", patch: { dodge: { home: corner } }, keepLayoutPos });
  }

  function enterIdle() {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    let pointerOver = false;
    let launcherOver = false;
    let idleTimer = null;

    function update() {
      if (!ctx.settings.enabled) return launcher.hide();
      const r = ctx.video?.getBoundingClientRect();
      if (!r || r.width === 0) return launcher.hide();
      const anchor = { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 6 };
      if (pointerOver || launcherOver) launcher.show({ x: px(anchor.x), y: px(anchor.y) });
      else launcher.hide();
    }

    function armIdleHide() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!launcherOver) {
          pointerOver = false;
          update();
        }
      }, 2000);
    }

    launcher.host.addEventListener("pointerenter", () => {
      launcherOver = true;
      clearTimeout(idleTimer);
      update();
    }, on);
    launcher.host.addEventListener("pointerleave", () => {
      launcherOver = false;
      armIdleHide();
      update();
    }, on);

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      pointerOver = Boolean(ctx.video) && isPointerOnPlayer(ctx.video, e);
      if (pointerOver) armIdleHide();
      else clearTimeout(idleTimer);
      update();
    }, { capture: true, ...on });

    document.documentElement.addEventListener("mouseleave", () => {
      pointerOver = false;
      launcherOver = false;
      clearTimeout(idleTimer);
      update();
    }, on);

    const timer = setInterval(update, 500);

    return {
      settingsChanged: update,
      exit() {
        ac.abort();
        clearInterval(timer);
        clearTimeout(idleTimer);
        launcher.hide();
      },
    };
  }

  function enterFloating({ video, ratioFallback = 9 / 16, isRemote = false, chatUrl = null }, leave) {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const viewport = () => ({
      l: 0,
      t: 0,
      r: document.documentElement.clientWidth || window.innerWidth,
      b: document.documentElement.clientHeight || window.innerHeight,
    });
    const cfg = () => ctx.settings.dodge;

    let floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
    let floatHeight = ctx.layout.height || null;
    let customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
    let lastHome = cfg().home;
    let corner = lastHome;
    let dodge = Dodge.initialState(corner);
    let faded = false;
    let held = false;
    let wheelPreview = false;
    let waitCursorLeave = false;
    let drag = null;
    let pendingMove = null;
    let cursor = null;
    let remoteChatUrl = chatUrl;
    let remoteHasAd = false;
    let webChatOpen = Boolean(ctx.layout.chatOpen);
    let chatHeight = ctx.layout.chatHeight;
    let chatResize = null;

    const resolveChatUrl = () =>
      ctx.settings.showChat ? (remoteChatUrl || (!isRemote ? chatUrlFor(ctx.site) : null)) : null;

    toggleWebChatSink = () => {
      if (!resolveChatUrl()) return;
      webChatOpen = !webChatOpen;
      persistLayout({ width: floatWidth, height: floatHeight, pos: customPos, chatOpen: webChatOpen });
      render();
    };

    skipAdSink = () => {
      if (isRemote) {
        send({ type: "SKIP_AD" });
        remoteHasAd = false;
        render();
      } else {
        triggerSkipAd(video);
        render();
      }
    };

    controller.host.toggleAttribute("data-remote", Boolean(isRemote));

    function size() {
      const vp = viewport();
      const maxW = Math.max(MIN_FLOAT_WIDTH, vp.r);
      const maxH = Math.max(MIN_FLOAT_HEIGHT, vp.b);
      if (Number.isFinite(floatHeight) && floatHeight > 0) {
        return {
          w: Math.round(Math.min(Math.max(MIN_FLOAT_WIDTH, floatWidth), maxW)),
          h: Math.round(Math.min(Math.max(MIN_FLOAT_HEIGHT, floatHeight), maxH)),
        };
      }
      const defaultMaxH = floatWidth === DEFAULT_FLOAT_WIDTH ? vp.b * 0.6 : maxH;
      return floatSize(video, floatWidth, defaultMaxH, ratioFallback, Math.max(MIN_FLOAT_WIDTH, vp.r - 16));
    }

    function rect() {
      if (drag) return { l: drag.x, t: drag.y, r: drag.x + drag.w, b: drag.y + drag.h };
      const s = size();
      const vp = viewport();
      if (customPos) return fromRelPos(customPos, s, vp);
      return Dodge.cornerRect(corner, s, vp, cfg().edgeInsetPx);
    }

    function boundsWithChat(r) {
      const curChatUrl = resolveChatUrl();
      if (!webChatOpen || !curChatUrl) {
        return { l: r.l, t: r.t, r: r.r, b: r.b, videoT: r.t, chatT: r.b, chatH: 0, chatUrl: curChatUrl, edge: "bottom" };
      }
      const vp = viewport();
      const h = Math.round(r.b - r.t);
      const wanted = chatHeight ?? Math.min(320, Math.max(160, Math.round(vp.b * 0.36)));
      const chatH = Math.round(Math.max(MIN_CHAT_HEIGHT, Math.min(wanted, vp.b - h - 16)));
      const fitsBelow = r.b + chatH <= vp.b - 8;
      const videoT = fitsBelow ? r.t : Math.max(8, r.b - h - chatH);
      const chatT = videoT + h;
      // The grip sits on whichever chat edge is free to move, so it tracks the pointer while dragging.
      const edge = fitsBelow ? "bottom" : "top";
      return { l: r.l, t: videoT, r: r.r, b: chatT + chatH, videoT, chatT, chatH, chatUrl: curChatUrl, edge };
    }

    webChatResize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = rect();
      const b = boundsWithChat(r);
      const vp = viewport();
      const h = Math.round(r.b - r.t);
      const edge = webChatResize.dataset.edge;
      const maxH = edge === "bottom" ? vp.b - 8 - r.b : r.b - 8 - h;
      chatResize = { edge, startY: e.clientY, startH: b.chatH, maxH: Math.max(MIN_CHAT_HEIGHT, maxH) };
      try {
        webChatResize.setPointerCapture(e.pointerId);
      } catch {}
      webChatResize.toggleAttribute("data-active", true);
      webChat.host.toggleAttribute("data-resizing", true);
    }, on);
    webChatResize.addEventListener("pointermove", (e) => {
      if (!chatResize) return;
      const dy = e.clientY - chatResize.startY;
      const raw = chatResize.startH + (chatResize.edge === "bottom" ? dy : -dy);
      chatHeight = Math.round(Math.min(chatResize.maxH, Math.max(MIN_CHAT_HEIGHT, raw)));
      render();
    }, on);
    const endChatResize = () => {
      if (!chatResize) return;
      chatResize = null;
      webChatResize.removeAttribute("data-active");
      webChat.host.removeAttribute("data-resizing");
      persistLayout({ chatHeight });
      render();
    };
    webChatResize.addEventListener("pointerup", endChatResize, on);
    webChatResize.addEventListener("pointercancel", endChatResize, on);

    function isInteractive() {
      if (held || drag !== null || chatResize !== null) return true;
      if (!ctx.settings.clickThrough && !cfg().enabled && cursor) {
        const b = boundsWithChat(rect());
        return cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b;
      }
      return false;
    }

    function render(anim = false) {
      const r = rect();
      const b = boundsWithChat(r);
      const w = Math.round(r.r - r.l);
      const h = Math.round(r.b - r.t);
      const canShowChat = Boolean(b.chatUrl);
      const showChatNow = Boolean(webChatOpen && canShowChat);
      webChatBtn.style.display = canShowChat ? "inline-flex" : "none";
      webChatLabel.textContent = showChatNow ? "채팅창 숨기기" : "채팅창 보기";

      const interactive = isInteractive();
      const hovered =
        drag !== null ||
        (cursor !== null && cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
      const hasSkipAd = isRemote ? Boolean(remoteHasAd) : canSkipAd(video);
      skipAdBtn.hidden = !hasSkipAd;
      const showBarOnly = !interactive && !ctx.settings.clickThrough && (hovered || hasSkipAd);
      const videoGeo = { x: px(r.l), y: px(b.videoT), w: px(w), h: px(h) };
      const ctrlGeo = videoGeo;
      const opacity = interactive && !wheelPreview ? 1 : faded ? FADED_OPACITY : ctx.settings.opacity;
      const shouldAnim = Boolean(anim && !document.hidden && drag === null);
      video.toggleAttribute("data-gp-anim", shouldAnim);
      setVars(video, { ...videoGeo, opacity: String(opacity) });
      video.toggleAttribute("data-gp-pass", !interactive && ctx.settings.clickThrough);
      video.toggleAttribute("data-gp-drag", drag !== null);

      if (canShowChat) {
        if (!webChat.host.isConnected) document.documentElement.append(webChat.host);
        if (webChatFrame.getAttribute("src") !== b.chatUrl) {
          webChatFrame.setAttribute("src", b.chatUrl);
        }
      }
      if (showChatNow && b.chatH > 0) {
        if (!chatResize) webChatResize.dataset.edge = b.edge;
        webChat.host.toggleAttribute("data-gp-anim", shouldAnim && !chatResize);
        webChat.host.toggleAttribute("data-gp-pass", !interactive && ctx.settings.clickThrough);
        webChat.host.toggleAttribute("data-gp-drag", drag !== null);
        webChat.host.toggleAttribute("data-interactive", interactive);
        webChat.show({
          x: px(r.l),
          y: px(b.chatT),
          w: px(w),
          h: px(b.chatH),
          opacity: String(opacity),
        });
      } else {
        webChat.hide();
      }

      hudEl.textContent = `투명도 ${Math.round(ctx.settings.opacity * 100)}% (휠 조절) · ${w}×${h}`;
      controller.host.toggleAttribute("data-hovered", hovered);
      controller.host.toggleAttribute("data-bar-only", showBarOnly);
      controller.host.toggleAttribute("data-chat-top-grip", showChatNow && (chatResize ? chatResize.edge : b.edge) === "top");
      if (interactive || showBarOnly) controller.show(ctrlGeo);
      else controller.hide();
    }

    function settingsChanged() {
      if (cfg().home !== lastHome) {
        lastHome = cfg().home;
        corner = lastHome;
        customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
        dodge = Dodge.initialState(corner);
        faded = false;
      }
      render();
    }

    function layoutChanged() {
      if (drag) return;
      floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
      floatHeight = ctx.layout.height || null;
      customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
      webChatOpen = Boolean(ctx.layout.chatOpen);
      if (!chatResize) chatHeight = ctx.layout.chatHeight;
      render();
    }

    function tick() {
      if (!isRemote) {
        const nowHasAd = canSkipAd(video);
        if (nowHasAd !== !skipAdBtn.hidden) render();
      }
      if (isInteractive()) return;
      const vp = viewport();
      const s = size();
      const r = rect();
      if (!ctx.settings.clickThrough && cursor !== null) {
        const b = boundsWithChat(r);
        if (webChatOpen && b.chatH > 0 && cursor.x >= r.l && cursor.x <= r.r && cursor.y >= b.chatT && cursor.y <= b.chatT + b.chatH) {
          return;
        }
      }
      const m = cfg().marginPx;
      const cursorInCurrent =
        cursor !== null &&
        cursor.x >= r.l - m &&
        cursor.x < r.r + m &&
        cursor.y >= r.t - m &&
        cursor.y < r.b + m;

      if (waitCursorLeave) {
        if (cursorInCurrent) {
          dodge = { ...dodge, hoverSince: null };
          return;
        }
        waitCursorLeave = false;
      }

      let stepCursor = cursor;
      if (customPos !== null) {
        if (cursorInCurrent) {
          const cr = Dodge.cornerRect(dodge.corner, s, vp, cfg().edgeInsetPx);
          stepCursor = { x: (cr.l + cr.r) / 2, y: (cr.t + cr.b) / 2 };
        } else {
          stepCursor = null;
        }
      }

      const out = Dodge.step(dodge, { now: performance.now(), cursor: stepCursor, size: s, area: vp }, cfg());
      dodge = out.state;
      if (out.action.type === "move") {
        customPos = null;
        corner = out.action.corner;
      } else if (out.action.type === "fade") {
        faded = out.action.on;
      } else {
        return;
      }
      render(true);
    }

    function setHeld(next) {
      if (next === held) return;
      if (held && !next) {
        wheelPreview = false;
        if (cursor) {
          const r = rect();
          const m = cfg().marginPx;
          if (cursor.x >= r.l - m && cursor.x < r.r + m && cursor.y >= r.t - m && cursor.y < r.b + m) {
            waitCursorLeave = true;
            dodge = { ...dodge, hoverSince: null };
          }
        }
      }
      held = next;
      render();
    }
    const holdFrom = (e) => e.isTrusted && setHeld(HOLD[ctx.settings.hotkeys.hold](e));

    window.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || drag !== null) return;
      if (e.target === controller.host || controller.host.contains(e.target)) return;
      if (webChat.open && (e.target === webChat.host || webChat.host.contains(e.target))) return;
      const modHeld = held || HOLD[ctx.settings.hotkeys.hold](e);
      if (!modHeld && ctx.settings.clickThrough) return;
      const r = rect();
      const b = boundsWithChat(r);
      const h = Math.round(r.b - r.t);
      if (e.clientX >= r.l && e.clientX <= r.r && e.clientY >= b.videoT && e.clientY <= b.videoT + h) {
        pendingMove = { startX: e.clientX, startY: e.clientY };
      }
    }, { capture: true, ...on });

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      const prevInteractive = isInteractive();
      const prevHovered = controller.host.hasAttribute("data-hovered");
      cursor = { x: e.clientX, y: e.clientY };
      holdFrom(e);
      const b = boundsWithChat(rect());
      const nowHovered =
        drag !== null || (cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
      if (prevInteractive !== isInteractive() || prevHovered !== nowHovered) render();
      tick();
    }, { capture: true, ...on });

    window.addEventListener("wheel", (e) => {
      const r = rect();
      const overRect = e.clientX >= r.l && e.clientX <= r.r && e.clientY >= r.t && e.clientY <= r.b;
      if (!overRect && e.target !== video && e.target !== controller.host) return;
      const modHeld = held || HOLD[ctx.settings.hotkeys.hold](e);
      if (!modHeld && ctx.settings.clickThrough) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.deltaY) return;
      wheelPreview = true;
      waitCursorLeave = true;
      dodge = { ...dodge, hoverSince: null };
      stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
      render();
    }, { capture: true, passive: false, ...on });

    document.documentElement.addEventListener("mouseleave", () => {
      cursor = null;
      render();
    }, on);
    window.addEventListener("keydown", holdFrom, { capture: true, ...on });
    window.addEventListener("keyup", holdFrom, { capture: true, ...on });
    window.addEventListener("blur", () => setHeld(false), on);
    document.addEventListener("visibilitychange", () => setHeld(false), on);
    window.addEventListener("resize", render, on);
    video.addEventListener("resize", render, on);
    const timer = setInterval(tick, DODGE_TICK_MS);

    dragSink = {
      active() {
        return drag !== null;
      },
      pointerMove(e) {
        if (!pendingMove || drag !== null) return;
        if (e.isTrusted && (e.buttons & 1) === 0) {
          pendingMove = null;
          return;
        }
        if (Math.hypot(e.clientX - pendingMove.startX, e.clientY - pendingMove.startY) >= 4) {
          const start = pendingMove;
          pendingMove = null;
          this.start({ clientX: start.startX, clientY: start.startY }, null);
        }
      },
      pointerUp() {
        pendingMove = null;
      },
      start(e, resizeDir) {
        pendingMove = null;
        wheelPreview = false;
        const r = rect();
        if (resizeDir) {
          drag = {
            mode: "resize",
            dir: resizeDir,
            startRect: r,
            startX: e.clientX,
            startY: e.clientY,
            x: r.l,
            y: r.t,
            w: r.r - r.l,
            h: r.b - r.t,
          };
        } else {
          drag = {
            mode: "move",
            x: r.l,
            y: r.t,
            w: r.r - r.l,
            h: r.b - r.t,
            dx: e.clientX - r.l,
            dy: e.clientY - r.t,
          };
        }
        render();
      },
      move(e) {
        if (!drag) return;
        const vp = viewport();
        if (drag.mode === "move") {
          const s = size();
          drag.w = s.w;
          drag.h = s.h;
          drag.x = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, vp.r - s.w));
          drag.y = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, vp.b - s.h));
        } else {
          const sr = drag.startRect;
          const startW = sr.r - sr.l;
          const startH = sr.b - sr.t;
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          const hasW = drag.dir.includes("w");
          const hasE = drag.dir.includes("e");
          const hasN = drag.dir.includes("n");
          const hasS = drag.dir.includes("s");

          const maxW = hasW ? sr.r : hasE ? vp.r - sr.l : vp.r;
          const maxH = hasN ? sr.b : hasS ? vp.b - sr.t : vp.b;

          const rawW = hasE ? startW + dx : hasW ? startW - dx : startW;
          const rawH = hasS ? startH + dy : hasN ? startH - dy : startH;

          const nextW = Math.round(
            Math.min(Math.max(MIN_FLOAT_WIDTH, rawW), Math.max(MIN_FLOAT_WIDTH, Math.min(MAX_FLOAT_WIDTH, maxW))),
          );
          const nextH = Math.round(
            Math.min(Math.max(MIN_FLOAT_HEIGHT, rawH), Math.max(MIN_FLOAT_HEIGHT, Math.min(MAX_FLOAT_HEIGHT, maxH))),
          );

          const nextX = hasW ? sr.r - nextW : sr.l;
          const nextY = hasN ? sr.b - nextH : sr.t;

          floatWidth = nextW;
          floatHeight = nextH;
          drag.x = Math.max(0, nextX);
          drag.y = Math.max(0, nextY);
          drag.w = nextW;
          drag.h = nextH;
        }
        render();
      },
      end() {
        if (!drag) return;
        const vp = viewport();
        const r = { l: drag.x, t: drag.y, r: drag.x + drag.w, b: drag.y + drag.h };
        const s = { w: drag.w, h: drag.h };
        drag = null;
        waitCursorLeave = true;

        const nearest = Dodge.nearestCorner(r, vp);
        const cr = Dodge.cornerRect(nearest, s, vp, cfg().edgeInsetPx);
        const nearCorner = Math.hypot(r.l - cr.l, r.t - cr.t) <= CORNER_SNAP_PX;

        corner = nearest;
        dodge = Dodge.initialState(corner);
        faded = false;
        customPos = nearCorner ? null : toRelPos(r.l, r.t, s, vp);

        persistLayout({ width: floatWidth, height: floatHeight, pos: customPos, chatOpen: webChatOpen });
        if (cfg().allowed.includes(nearest) && nearest !== cfg().home) {
          lastHome = nearest;
          persistHome(nearest, true);
        }
        render();
      },
    };

    function exit() {
      ac.abort();
      clearInterval(timer);
      dragSink = null;
      toggleWebChatSink = null;
      skipAdSink = null;
      pendingMove = null;
      webChat.hide();
      webChatFrame.removeAttribute("src");
      controller.hide();
      video.removeAttribute("data-gp-anim");
      if (video.matches(":popover-open")) video.hidePopover();
    }

    function setChatUrl(nextUrl) {
      if (nextUrl && nextUrl !== remoteChatUrl) {
        remoteChatUrl = nextUrl;
        render();
      }
    }

    function setHasAd(nextHasAd) {
      const b = Boolean(nextHasAd);
      if (b !== remoteHasAd) {
        remoteHasAd = b;
        render();
      }
    }

    video.setAttribute("popover", "manual");
    video.classList.add(FLOAT_CLASS);
    render();
    try {
      video.showPopover();
    } catch {
      queueMicrotask(leave);
    }

    return { exit, settingsChanged, layoutChanged, setChatUrl, setHasAd };
  }

  function boostVideoSdp(sdp) {
    if (typeof sdp !== "string") return sdp;
    let out = sdp.replace(/(m=video .*\r\n)/, "$1b=AS:12000\r\n");
    out = out.replace(
      /(a=fmtp:\d+ )([^\r\n]*)/g,
      (_m, p1, p2) =>
        `${p1}${p2};x-google-min-bitrate=4000;x-google-start-bitrate=8000;x-google-max-bitrate=12000`,
    );
    return out;
  }

  function enterInTab(_arg, leave) {
    const video = ctx.video;
    const original = {
      popover: video.getAttribute("popover"),
      class: video.hasAttribute("class"),
      style: video.hasAttribute("style"),
    };
    const floating = enterFloating({ video, isRemote: false }, leave);
    const capCanvas = document.createElement("canvas");
    const capCtx = capCanvas.getContext("2d", { alpha: false });
    let alive = true;
    let senderPort = null;
    let keepAlivePc1 = null;
    let keepAlivePc2 = null;
    let keepAliveSink = null;
    let keepAliveTracks = [];
    const rtcPeers = new Map();

    function stopRtcPeer(portId) {
      const entry = rtcPeers.get(portId);
      if (!entry) return;
      rtcPeers.delete(portId);
      try {
        entry.pc.close();
      } catch {}
      try {
        entry.track.stop();
      } catch {}
    }

    function stopAllRtcPeers() {
      for (const portId of [...rtcPeers.keys()]) stopRtcPeer(portId);
    }

    function stopKeepAlive() {
      stopAllRtcPeers();
      if (keepAlivePc1) {
        keepAlivePc1.close();
        keepAlivePc1 = null;
      }
      if (keepAlivePc2) {
        keepAlivePc2.close();
        keepAlivePc2 = null;
      }
      if (keepAliveSink) {
        keepAliveSink.srcObject = null;
        keepAliveSink = null;
      }
      for (const t of keepAliveTracks) t.stop();
      keepAliveTracks = [];
    }

    // Chromium's WebMediaPlayerImpl suspends the video decoder when a tab is hidden unless an active
    // captureStream() WebRTC sink is attached while the tab is still visible.
    async function startKeepAlive() {
      stopKeepAlive();
      if (!alive || video.mediaKeys) return;
      try {
        const stream = video.captureStream();
        keepAliveTracks = stream.getVideoTracks();
        if (!keepAliveTracks.length) return;
        for (const t of keepAliveTracks) t.contentHint = "detail";
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        keepAlivePc1 = pc1;
        keepAlivePc2 = pc2;
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
        const sink = document.createElement("video");
        sink.muted = true;
        sink.playsInline = true;
        keepAliveSink = sink;
        pc2.ontrack = (e) => {
          sink.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          sink.play().catch(() => {});
        };
        for (const t of keepAliveTracks) pc1.addTrack(t, stream);
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
      } catch {}
    }

    async function startRtcSender(portId = 0) {
      stopRtcPeer(portId);
      if (!alive || !senderPort || video.mediaKeys) return;
      try {
        const baseTrack = keepAliveTracks[0] ?? video.captureStream().getVideoTracks()[0];
        if (!baseTrack) return;
        const track = baseTrack.clone();
        track.contentHint = "detail";
        const pc = new RTCPeerConnection();
        rtcPeers.set(portId, { pc, track });
        pc.onicecandidate = (e) => {
          if (e.candidate && senderPort && rtcPeers.get(portId)?.pc === pc) {
            try {
              senderPort.postMessage({ type: "RTC_CANDIDATE", candidate: e.candidate.toJSON(), portId });
            } catch {}
          }
        };
        const stream = new MediaStream([track]);
        const sender = pc.addTrack(track, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        try {
          const params = sender.getParameters();
          params.degradationPreference = "maintain-resolution";
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 12_000_000;
          params.encodings[0].maxFramerate = 60;
          params.encodings[0].scaleResolutionDownBy = 1;
          await sender.setParameters(params);
        } catch {}
        if (rtcPeers.get(portId)?.pc === pc && senderPort) {
          senderPort.postMessage({ type: "RTC_OFFER", sdp: boostVideoSdp(pc.localDescription.sdp), portId });
        }
      } catch {}
    }

    function snapshotFrame(targetW = 640) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const desiredW = Math.max(480, Math.min(1280, Number(targetW) || 640));
      const cw = Math.min(desiredW, vw);
      const ch = Math.max(1, Math.round((cw * vh) / vw));
      if (capCanvas.width !== cw || capCanvas.height !== ch) {
        capCanvas.width = cw;
        capCanvas.height = ch;
      }
      try {
        capCtx.drawImage(video, 0, 0, cw, ch);
        const dataUrl = capCanvas.toDataURL("image/jpeg", 0.88);
        return { type: "FRAME", dataUrl, vw, vh, hasAd: canSkipAd(video) };
      } catch {
        return null;
      }
    }

    function captureFrame(targetW, portId = null) {
      if (!alive || !senderPort) return;
      const frame = snapshotFrame(targetW);
      if (frame) {
        if (portId) frame.portId = portId;
        try {
          senderPort.postMessage(frame);
        } catch {}
      }
    }

    function connectSender() {
      if (!alive || senderPort) return;
      try {
        const port = chrome.runtime.connect({ name: "ghostpip-sender" });
        senderPort = port;
        port.onMessage.addListener((msg) => {
          const portId = msg?.portId || 0;
          if (msg?.type === "PULL_FRAME") {
            captureFrame(msg.targetW, portId);
          } else if (msg?.type === "RTC_INIT") {
            startRtcSender(portId);
          } else if (msg?.type === "RTC_ANSWER" && msg.sdp) {
            rtcPeers.get(portId)?.pc.setRemoteDescription({ type: "answer", sdp: boostVideoSdp(msg.sdp) }).catch(() => {});
          } else if (msg?.type === "RTC_CANDIDATE" && msg.candidate) {
            rtcPeers.get(portId)?.pc.addIceCandidate(msg.candidate).catch(() => {});
          } else if (msg?.type === "RTC_CLOSE") {
            stopRtcPeer(portId);
          } else if (msg?.type === "SKIP_AD") {
            triggerSkipAd(video);
          }
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (senderPort === port) senderPort = null;
        });
      } catch {}
    }

    const onLoadedData = () => {
      if (!alive) return;
      const activePortIds = [...rtcPeers.keys()];
      startKeepAlive().then(() => {
        if (senderPort) {
          for (const pid of activePortIds) startRtcSender(pid);
        }
      });
    };
    video.addEventListener("loadeddata", onLoadedData);
    startKeepAlive();
    connectSender();

    function querySource() {
      connectSender();
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      const ratio = vw > 0 && vh > 0 ? vh / vw : 9 / 16;
      return { ok: true, ratio, vw, vh, chatUrl: chatUrlFor(ctx.site), frame: snapshotFrame(640) };
    }

    const frameWarmTimer = setInterval(() => {
      if (alive && senderPort) captureFrame(640);
    }, 220);

    function exit() {
      alive = false;
      clearInterval(frameWarmTimer);
      video.removeEventListener("loadeddata", onLoadedData);
      if (senderPort) {
        try {
          senderPort.disconnect();
        } catch {}
        senderPort = null;
      }
      stopKeepAlive();
      send({ type: "INTAB_CLOSED" });
      floating.exit();
      if (original.popover === null) video.removeAttribute("popover");
      else video.setAttribute("popover", original.popover);
      video.classList.remove(FLOAT_CLASS);
      video.removeAttribute("data-gp-pass");
      video.removeAttribute("data-gp-drag");
      video.removeAttribute("data-gp-anim");
      for (const name of GP_VARS) video.style.removeProperty(name);
      for (const attr of ["class", "style"]) {
        if (!original[attr] && !video.getAttribute(attr)) video.removeAttribute(attr);
      }
    }

    const initVw = video.videoWidth || 0;
    const initVh = video.videoHeight || 0;
    const initRatio = initVw > 0 && initVh > 0 ? initVh / initVw : 9 / 16;
    send({
      type: "INTAB_OPENED",
      ratio: initRatio,
      vw: initVw,
      vh: initVh,
      chatUrl: chatUrlFor(ctx.site),
      frame: snapshotFrame(640),
    });
    return {
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      querySource,
      connectSender,
    };
  }

  function enterRemoteInTab({ ratio, vw: initVw, vh: initVh, chatUrl, initialFrame } = {}, leave) {
    const initRatio = ratio || (initVw > 0 && initVh > 0 ? initVh / initVw : 9 / 16);
    const startW = initVw > 0 ? initVw : initialFrame?.vw > 0 ? initialFrame.vw : DEFAULT_FLOAT_WIDTH;
    const startH =
      initVh > 0
        ? initVh
        : initialFrame?.vh > 0
          ? initialFrame.vh
          : Math.max(1, Math.round(startW * initRatio));
    const canvas = h("canvas", {
      class: FLOAT_CLASS,
      "data-gp-remote": "",
      popover: "manual",
    });
    canvas.width = startW;
    canvas.height = startH;
    canvas.videoWidth = startW;
    canvas.videoHeight = startH;
    let framesRendered = 0;
    canvas.getVideoPlaybackQuality = () => ({ totalVideoFrames: framesRendered });
    const ctx2d = canvas.getContext("2d", { alpha: false });
    document.documentElement.append(canvas);

    const floating = enterFloating({ video: canvas, ratioFallback: initRatio, isRemote: true, chatUrl }, leave);

    let alive = true;
    let receiverPort = null;
    let pulling = false;
    let lastPullAt = 0;
    let pullTimer = null;
    let rtcPeer = null;
    let rtcVideo = null;
    let rtcActive = false;
    let lastRtcDrawAt = 0;

    function syncVideoDimensions(vw, vh) {
      if (!(vw > 0 && vh > 0)) return false;
      const aspectChanged = canvas.videoWidth !== vw || canvas.videoHeight !== vh;
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }
      canvas.videoWidth = vw;
      canvas.videoHeight = vh;
      canvas.dataset.gpVw = String(vw);
      canvas.dataset.gpVh = String(vh);
      return aspectChanged;
    }

    function drawRtcFrame() {
      if (!alive || !rtcVideo || rtcVideo.readyState < 2 || !rtcVideo.videoWidth || !rtcVideo.videoHeight) {
        return false;
      }
      const vw = rtcVideo.videoWidth;
      const vh = rtcVideo.videoHeight;
      try {
        const aspectChanged = syncVideoDimensions(vw, vh);
        ctx2d.drawImage(rtcVideo, 0, 0, canvas.width, canvas.height);
        framesRendered++;
        canvas.dataset.gpFrames = String(framesRendered);
        rtcActive = true;
        lastRtcDrawAt = performance.now();
        if (aspectChanged) canvas.dispatchEvent(new Event("resize"));
        return true;
      } catch {
        return false;
      }
    }

    function stopRtcReceiver() {
      rtcActive = false;
      if (rtcPeer) {
        rtcPeer.close();
        rtcPeer = null;
      }
      if (rtcVideo) {
        rtcVideo.srcObject = null;
        rtcVideo = null;
      }
    }

    async function handleRtcOffer(sdp) {
      stopRtcReceiver();
      if (!alive || !receiverPort) return;
      try {
        const pc = new RTCPeerConnection();
        rtcPeer = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && receiverPort && rtcPeer === pc) {
            try {
              receiverPort.postMessage({ type: "RTC_CANDIDATE", candidate: e.candidate.toJSON() });
            } catch {}
          }
        };
        const vid = document.createElement("video");
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.addEventListener("loadeddata", () => drawRtcFrame());
        vid.addEventListener("playing", () => drawRtcFrame());
        rtcVideo = vid;
        pc.ontrack = (e) => {
          vid.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          vid.play().catch(() => {});
        };
        await pc.setRemoteDescription({ type: "offer", sdp: boostVideoSdp(sdp) });
        const answer = await pc.createAnswer();
        const boostedAnswer = boostVideoSdp(answer.sdp);
        await pc.setLocalDescription({ type: "answer", sdp: boostedAnswer });
        if (rtcPeer === pc && receiverPort) {
          receiverPort.postMessage({ type: "RTC_ANSWER", sdp: boostedAnswer });
        }
      } catch {}
    }

    function requestFrame() {
      if (!alive) return;
      if (!document.hidden && drawRtcFrame()) return;
      if (!receiverPort) connectReceiver();
      if (!receiverPort) return;
      const now = performance.now();
      if (pulling && now - lastPullAt < 220) return;
      pulling = true;
      lastPullAt = now;
      const targetW = Math.round((ctx.layout.width || DEFAULT_FLOAT_WIDTH) * (window.devicePixelRatio || 1) * 1.5);
      try {
        receiverPort.postMessage({ type: "PULL_FRAME", targetW });
      } catch {
        pulling = false;
      }
    }

    async function handleFrame(msg) {
      if (msg && typeof msg.hasAd === "boolean") floating.setHasAd?.(msg.hasAd);
      const rtcFresh = !document.hidden && rtcActive && performance.now() - lastRtcDrawAt < 140;
      if (!alive || !msg?.dataUrl || rtcFresh) {
        pulling = false;
        return;
      }
      try {
        const comma = msg.dataUrl.indexOf(",");
        const b64 = comma >= 0 ? msg.dataUrl.slice(comma + 1) : msg.dataUrl;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (!alive || (!document.hidden && rtcActive && performance.now() - lastRtcDrawAt < 140)) {
          bmp.close();
          pulling = false;
          return;
        }
        const targetVw = msg.vw > 0 ? msg.vw : bmp.width;
        const targetVh = msg.vh > 0 ? msg.vh : bmp.height;
        const aspectChanged = syncVideoDimensions(targetVw, targetVh);
        ctx2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        framesRendered++;
        canvas.dataset.gpFrames = String(framesRendered);
        if (aspectChanged) canvas.dispatchEvent(new Event("resize"));
      } catch {}
      pulling = false;
      if (alive && !document.hidden && (!rtcActive || performance.now() - lastRtcDrawAt >= 140)) {
        clearTimeout(pullTimer);
        pullTimer = setTimeout(requestFrame, 33);
      }
    }

    function connectReceiver() {
      if (!alive || receiverPort) return;
      try {
        const port = chrome.runtime.connect({ name: "ghostpip-receiver" });
        receiverPort = port;
        port.onMessage.addListener((msg) => {
          if (msg?.type === "FRAME") {
            handleFrame(msg);
          } else if (msg?.type === "RTC_OFFER" && msg.sdp) {
            handleRtcOffer(msg.sdp);
          } else if (msg?.type === "RTC_CANDIDATE" && rtcPeer && msg.candidate) {
            rtcPeer.addIceCandidate(msg.candidate).catch(() => {});
          }
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (receiverPort === port) {
            receiverPort = null;
            pulling = false;
          }
        });
        port.postMessage({ type: "RTC_INIT" });
      } catch {}
    }

    if (initialFrame?.dataUrl) {
      handleFrame(initialFrame);
    }
    connectReceiver();
    requestFrame();
    const onVisChange = () => {
      if (!document.hidden && alive) {
        if (!receiverPort) connectReceiver();
        if (!drawRtcFrame()) requestFrame();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    const renderTick = setInterval(() => {
      if (document.hidden) return;
      if (!drawRtcFrame()) requestFrame();
    }, 16);

    function exit() {
      alive = false;
      document.removeEventListener("visibilitychange", onVisChange);
      clearInterval(renderTick);
      clearTimeout(pullTimer);
      stopRtcReceiver();
      if (receiverPort) {
        try {
          receiverPort.disconnect();
        } catch {}
        receiverPort = null;
      }
      floating.exit();
      canvas.remove();
    }

    return {
      video: canvas,
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      kick: (msg) => {
        if (msg?.chatUrl) floating.setChatUrl?.(msg.chatUrl);
        if (msg?.initialFrame?.dataUrl && (!rtcActive || performance.now() - lastRtcDrawAt >= 140)) {
          handleFrame(msg.initialFrame);
        }
        const peerDead =
          !rtcPeer ||
          rtcPeer.connectionState === "failed" ||
          rtcPeer.connectionState === "closed" ||
          rtcPeer.connectionState === "disconnected";
        if (peerDead && receiverPort) {
          try {
            receiverPort.postMessage({ type: "RTC_INIT" });
          } catch {}
        }
        if (!drawRtcFrame()) requestFrame();
      },
      ready: Promise.resolve({ ok: true }),
    };
  }

  const PIP_CSS = `
    ${BASE_CSS}
    html, body { margin: 0; height: 100%; background: #000; color: #fff; font: 13px system-ui, "Malgun Gothic", sans-serif; overflow: hidden; }
    body { display: flex; flex-direction: column; position: relative; }
    video { flex: 1 1 auto; min-height: 0; width: 100%; height: 100%; object-fit: fill; background: #000; }
    iframe { flex: 0 0 var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px); width: 100%; border: 0; background: #fff; }
    body[data-chat-resizing] iframe { pointer-events: none; }
    .pip-chat-split { position: fixed; left: 0; right: 0; bottom: calc(var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px) - 6px); height: 12px; z-index: 13;
      cursor: ns-resize; touch-action: none; display: none; }
    body[data-chat-open] .pip-chat-split { display: block; }
    .pip-chat-split::after { content: ""; position: absolute; left: 50%; top: 50%; width: 52px; height: 4px; border-radius: 4px;
      transform: translate(-50%, -50%); background: rgba(125, 211, 252, 0.95); box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
      opacity: 0; transition: opacity 0.14s ease; }
    body:not([data-click-through]):hover .pip-chat-split::after, body[data-hovered] .pip-chat-split::after,
    body[data-chat-resizing] .pip-chat-split::after { opacity: 1; }
    body[data-click-through]:not([data-hovered]) .pip-chat-split { pointer-events: none; }
    .pip-bar { position: fixed; bottom: 14px; left: 50%; z-index: 12; opacity: 0; pointer-events: auto;
      transform: translateX(-50%); transition: opacity 0.14s ease; }
    body[data-chat-open] .pip-bar { bottom: calc(var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px) + 14px); }
    .pip-bar button { padding: 7px 14px; font-size: 12.5px; pointer-events: auto; }
    .pip-bar button[hidden] { display: none !important; }
    body:not([data-click-through]):hover .pip-bar,
    body[data-hovered] .pip-bar { opacity: 1; pointer-events: auto; }
    .pip-handle { position: fixed; z-index: 11; pointer-events: none; opacity: 0; transition: opacity 0.16s ease; }
    body:not([data-click-through]):hover .pip-handle,
    body[data-hovered] .pip-handle { pointer-events: auto; opacity: 1; }
    .pip-handle.n { top: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
    .pip-handle.s { bottom: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
    .pip-handle.w { left: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
    .pip-handle.e { right: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
    .pip-handle.nw { top: 0; left: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .pip-handle.ne { top: 0; right: 0; width: 16px; height: 16px; cursor: nesw-resize; }
    .pip-handle.sw { bottom: 0; left: 0; width: 16px; height: 16px; cursor: nesw-resize; }
    .pip-handle.se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .pip-handle.nw::after, .pip-handle.ne::after, .pip-handle.sw::after, .pip-handle.se::after {
      content: ""; position: absolute; width: 8px; height: 8px; border-radius: 2.5px;
      background: linear-gradient(135deg, #bae6fd 0%, #38bdf8 100%);
      border: 1.5px solid #0f172a; box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
    .pip-handle.nw::after { top: 3px; left: 3px; }
    .pip-handle.ne::after { top: 3px; right: 3px; }
    .pip-handle.sw::after { bottom: 3px; left: 3px; }
    .pip-handle.se::after { bottom: 3px; right: 3px; }
    .pip-skip-ad { position: fixed; right: 12px; bottom: 12px; z-index: 12; opacity: 0; pointer-events: none;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.92); border: 1.5px solid rgba(56, 189, 248, 0.78);
      color: #f8fafc; font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.65); cursor: pointer; transition: opacity 0.16s ease; }
    .pip-skip-ad[hidden] { display: none !important; }
    body[data-chat-open] .pip-skip-ad { bottom: calc(var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px) + 12px); }
    body:not([data-click-through]) .pip-skip-ad,
    body[data-hovered] .pip-skip-ad { opacity: 1; pointer-events: auto; }
    .pip-hud { position: fixed; top: 8px; left: 8px; z-index: 10; padding: 4px 8px; border-radius: 5px; pointer-events: none;
      background: rgba(18, 18, 22, 0.85); color: #fff; font: 600 12px/1 system-ui, "Malgun Gothic", sans-serif;
      opacity: 0; transition: opacity 0.15s ease-out; }
    .pip-hud[data-show] { opacity: 1; }`;

  function resizeDocPipWindow(w, deltaH) {
    if (!w || w.closed) return;
    try {
      const prevH = w.outerHeight;
      const nextH = Math.max(180, prevH + deltaH);
      const availTop = w.screen?.availTop ?? 0;
      const availH = w.screen?.availHeight ?? 1080;
      const inBottomHalf = w.screenY + prevH / 2 > availTop + availH / 2;
      if (inBottomHalf && deltaH > 0) {
        w.moveTo(w.screenX, Math.max(availTop, w.screenY - deltaH));
        w.resizeTo(w.outerWidth, nextH);
      } else if (inBottomHalf && deltaH < 0) {
        w.resizeTo(w.outerWidth, nextH);
        w.moveTo(w.screenX, w.screenY - deltaH);
      } else {
        w.resizeTo(w.outerWidth, nextH);
      }
    } catch {}
  }

  function buildPipDocument(win, stream, chatUrl, showChat, { onClosePip, onToggleChat, onResizeChat, onSkipAd, isClickThrough, isHoldEvent } = {}) {
    const doc = win.document;
    const style = doc.createElement("style");
    style.textContent = PIP_CSS;
    doc.head.append(style);
    const mirror = doc.createElement("video");
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.srcObject = stream;
    const pipHud = doc.createElement("div");
    pipHud.className = "pip-hud";
    const pipSkipAd = doc.createElement("button");
    pipSkipAd.type = "button";
    pipSkipAd.className = "pip-skip-ad";
    pipSkipAd.dataset.action = "skipAd";
    pipSkipAd.hidden = true;
    pipSkipAd.textContent = "광고 건너뛰기 ⏭";
    pipSkipAd.addEventListener("click", (e) => {
      e.stopPropagation();
      onSkipAd?.();
    });
    const handles = RESIZE_DIRS.map((dir) => {
      const el = doc.createElement("div");
      el.className = `pip-handle ${dir}`;
      el.dataset.resize = dir;
      return el;
    });
    doc.body.toggleAttribute("data-click-through", Boolean(isClickThrough?.()));
    doc.body.append(mirror, ...handles, pipHud, pipSkipAd);

    const pipBar = doc.createElement("div");
    pipBar.className = "bar pip-bar";
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.dataset.action = "closePip";
    closeBtn.textContent = "복귀";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClosePip?.();
    });
    pipBar.append(closeBtn);

    let chatBtn = null;
    let chatLabel = null;
    if (chatUrl) {
      chatLabel = doc.createElement("span");
      chatBtn = doc.createElement("button");
      chatBtn.type = "button";
      chatBtn.dataset.action = "toggleChat";
      chatBtn.hidden = !Boolean(showChat && chatUrl);
      chatBtn.append(svgIcon(ICON_CHAT), chatLabel);
      chatBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleChat?.();
      });
      pipBar.append(chatBtn);
    }
    doc.body.append(pipBar);

    let engineHovered = false;
    let pointerHovered = false;
    const syncHovered = () => {
      doc.body.toggleAttribute("data-hovered", Boolean(engineHovered || pointerHovered));
    };
    const onPointerHover = (e) => {
      pointerHovered = Boolean(!isClickThrough?.() || isHoldEvent?.(e));
      syncHovered();
    };
    doc.documentElement.addEventListener("pointerenter", onPointerHover);
    doc.documentElement.addEventListener("pointermove", onPointerHover);
    doc.documentElement.addEventListener("mouseleave", () => {
      pointerHovered = false;
      syncHovered();
    });

    let frame = null;
    let chatShown = Boolean(showChat && chatUrl);
    let chatH = Number.isFinite(ctx.layout.pipChatHeight) ? ctx.layout.pipChatHeight : PIP_CHAT_HEIGHT;
    const applyChatH = () => doc.body.style.setProperty("--gp-chat-h", `${chatH}px`);
    applyChatH();

    // Dragging the split trades height between video and chat inside the fixed-size window.
    const split = doc.createElement("div");
    split.className = "pip-chat-split";
    split.title = "드래그해서 채팅창 크기 조절";
    doc.body.append(split);
    let splitDrag = null;
    split.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      splitDrag = { startY: e.clientY, startH: chatH };
      try {
        split.setPointerCapture(e.pointerId);
      } catch {}
      doc.body.toggleAttribute("data-chat-resizing", true);
    });
    split.addEventListener("pointermove", (e) => {
      if (!splitDrag) return;
      const maxH = Math.max(MIN_CHAT_HEIGHT, win.innerHeight - MIN_FLOAT_HEIGHT);
      chatH = Math.round(Math.min(maxH, Math.max(MIN_CHAT_HEIGHT, splitDrag.startH - (e.clientY - splitDrag.startY))));
      applyChatH();
    });
    const endSplit = () => {
      if (!splitDrag) return;
      splitDrag = null;
      doc.body.removeAttribute("data-chat-resizing");
      persistLayout({ pipChatHeight: chatH });
    };
    split.addEventListener("pointerup", endSplit);
    split.addEventListener("pointercancel", endSplit);

    function syncChat(enabled, resizeWin = false) {
      if (!chatUrl) return;
      const nextShown = Boolean(enabled);
      const changed = nextShown !== chatShown;
      chatShown = nextShown;
      doc.body.toggleAttribute("data-chat-open", nextShown);
      if (chatLabel) chatLabel.textContent = nextShown ? "채팅창 숨기기" : "채팅창 보기";
      if (chatBtn) chatBtn.toggleAttribute("data-active", nextShown);
      if (nextShown) {
        if (!frame) {
          frame = doc.createElement("iframe");
          frame.src = chatUrl;
          frame.addEventListener("load", () => {
            try {
              if (
                !document.documentElement.hasAttribute("data-gp-force-chat") &&
                frame?.contentDocument?.querySelector("yt-live-chat-unavailable-message-renderer")
              ) {
                if (chatBtn) chatBtn.hidden = true;
                syncChat(false, true);
              }
            } catch {}
          });
        }
        if (!frame.isConnected) doc.body.append(frame);
      } else if (frame) {
        frame.remove();
      }
      if (resizeWin && changed) {
        onResizeChat?.(nextShown ? chatH : -chatH);
      }
    }

    function setFeatureEnabled(enabled) {
      if (chatBtn) chatBtn.hidden = !Boolean(enabled && chatUrl);
      syncChat(Boolean(enabled && chatUrl), true);
    }

    function toggleChatOpen() {
      if (!chatUrl || (chatBtn && chatBtn.hidden)) return;
      syncChat(!chatShown, true);
    }

    function setHovered(hovered) {
      engineHovered = Boolean(hovered);
      if (!engineHovered) pointerHovered = false;
      syncHovered();
    }

    function setClickThrough(enabled) {
      doc.body.toggleAttribute("data-click-through", Boolean(enabled));
      if (enabled) pointerHovered = false;
      syncHovered();
    }

    function setSkipAdVisible(visible) {
      pipSkipAd.hidden = !Boolean(visible);
    }

    syncChat(showChat, false);
    mirror.play().catch(() => {});
    return { mirror, pipHud, syncChat, setFeatureEnabled, toggleChatOpen, setHovered, setClickThrough, setSkipAdVisible };
  }

  function enterDocPip({ stream: firstStream, chatUrl, win: winPromise }, leave) {
    const video = ctx.video;
    const originalHasClass = video.hasAttribute("class");
    video.classList.add(DOCPIP_SOURCE_CLASS);
    const ac = new AbortController();
    let stream = firstStream;
    let win = null;
    let mirror = null;
    let pipHud = null;
    let setFeatureEnabled = null;
    let toggleChatOpen = null;
    let setHovered = null;
    let setClickThrough = null;
    let setSkipAdVisible = null;
    let hudTimer = null;
    let rectSyncTimer = null;
    let adPollTimer = null;
    let engineConnected = true;

    function syncPipOpacity(showToast = false) {
      if (!mirror) return;
      mirror.style.opacity = engineConnected ? "1" : String(ctx.settings.opacity);
      if (showToast && pipHud) {
        pipHud.textContent = `투명도 ${Math.round(ctx.settings.opacity * 100)}%`;
        pipHud.setAttribute("data-show", "");
        clearTimeout(hudTimer);
        hudTimer = setTimeout(() => pipHud?.removeAttribute("data-show"), 900);
      }
    }

    function handleResizeChat(deltaH) {
      if (!win || win.closed) return;
      if (!engineConnected) {
        resizeDocPipWindow(win, deltaH);
        return;
      }
      send({
        type: "PIP_RESIZE",
        deltaH,
        dpr: win.devicePixelRatio || 1,
      }).then((res) => {
        if (!res?.handledByEngine) resizeDocPipWindow(win, deltaH);
      });
    }

    function handleToggleChat() {
      toggleChatOpen?.();
    }

    winPromise.then((w) => {
      if (ac.signal.aborted) return w.close();
      win = w;
      const built = buildPipDocument(w, stream, chatUrl, Boolean(ctx.settings.showChat), {
        onClosePip: () => {
          send({ type: "FOCUS_SOURCE_TAB" });
          leave();
        },
        onToggleChat: handleToggleChat,
        onResizeChat: handleResizeChat,
        onSkipAd: () => {
          triggerSkipAd(video);
          setSkipAdVisible?.(canSkipAd(video));
        },
        isClickThrough: () => Boolean(ctx.settings.clickThrough),
        isHoldEvent: (e) => Boolean(HOLD[ctx.settings.hotkeys.hold]?.(e)),
      });
      mirror = built.mirror;
      pipHud = built.pipHud;
      setFeatureEnabled = built.setFeatureEnabled;
      toggleChatOpen = built.toggleChatOpen;
      setHovered = built.setHovered;
      setClickThrough = built.setClickThrough;
      setSkipAdVisible = built.setSkipAdVisible;
      setSkipAdVisible(canSkipAd(video));
      adPollTimer = setInterval(() => {
        if (!ac.signal.aborted && !w.closed) setSkipAdVisible?.(canSkipAd(video));
      }, 400);
      w.addEventListener("pagehide", leave, { signal: ac.signal });
      w.addEventListener("keydown", (e) => {
        if (HOLD[ctx.settings.hotkeys.hold]?.(e)) setHovered?.(true);
      }, { capture: true, signal: ac.signal });
      w.addEventListener("keyup", (e) => {
        if (ctx.settings.clickThrough && !HOLD[ctx.settings.hotkeys.hold]?.(e)) setHovered?.(false);
      }, { capture: true, signal: ac.signal });
      w.addEventListener("blur", () => {
        if (ctx.settings.clickThrough) setHovered?.(false);
      }, { signal: ac.signal });
      w.addEventListener("wheel", (e) => {
        if (e.target !== mirror && !HOLD[ctx.settings.hotkeys.hold](e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.deltaY) return;
        stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
        syncPipOpacity(true);
      }, { capture: true, passive: false, signal: ac.signal });
      // Until its first resize the PiP window reports the opener's placeholder geometry, so the
      // rect handshake waits for it, with a timeout in case the platform never resizes.
      new Promise((placed) => {
        w.addEventListener("resize", placed, { once: true, signal: ac.signal });
        setTimeout(placed, 150);
      }).then(() => {
        if (ac.signal.aborted) return;
        const readRect = () => ({ x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight });
        send({
          type: "PIP_OPENED",
          kind: "document",
          rect: readRect(),
          dpr: w.devicePixelRatio,
        }).then((res) => {
          engineConnected = Boolean(res?.engineConnected);
          syncPipOpacity(false);
        });
        for (const delay of [400, 900]) {
          setTimeout(() => {
            if (!ac.signal.aborted) send({ type: "PIP_RECT_UPDATED", rect: readRect() });
          }, delay);
        }
        rectSyncTimer = setInterval(() => {
          if (!ac.signal.aborted && !w.closed) {
            send({ type: "PIP_RECT_UPDATED", rect: readRect() });
          }
        }, 2000);
      });
    }, leave);

    video.addEventListener("loadeddata", () => {
      for (const t of stream.getTracks()) t.stop();
      stream = video.captureStream();
      if (mirror) mirror.srcObject = stream;
    }, { signal: ac.signal });

    let lastShowChat = Boolean(ctx.settings.showChat);

    return {
      settingsChanged: () => {
        syncPipOpacity(false);
        const showChat = Boolean(ctx.settings.showChat);
        if (showChat !== lastShowChat) {
          lastShowChat = showChat;
          setFeatureEnabled?.(showChat);
        }
        setClickThrough?.(Boolean(ctx.settings.clickThrough));
      },
      toggleChat: () => {
        toggleChatOpen?.();
      },
      setHovered: (hovered) => {
        setHovered?.(hovered);
      },
      exit() {
        ac.abort();
        clearTimeout(hudTimer);
        clearInterval(rectSyncTimer);
        clearInterval(adPollTimer);
        video.classList.remove(DOCPIP_SOURCE_CLASS);
        if (!originalHasClass && !video.getAttribute("class")) video.removeAttribute("class");
        for (const t of stream.getTracks()) t.stop();
        if (!win) return;
        send({ type: "PIP_CLOSED" });
        win.close();
      },
    };
  }

  function enterNativePip(request, leave) {
    const video = ctx.video;
    const ac = new AbortController();
    let opened = false;
    function reportOpened(pw) {
      if (opened || !pw) return;
      opened = true;
      // The native PiP window's screen position is not exposed to pages; the opener's position is a
      // placeholder and the engine matches on size.
      send({
        type: "PIP_OPENED",
        kind: "native",
        rect: { x: window.screenX, y: window.screenY, w: pw.width, h: pw.height },
        dpr: devicePixelRatio,
      });
    }
    video.addEventListener("enterpictureinpicture", (e) => reportOpened(e.pictureInPictureWindow), { signal: ac.signal });
    video.addEventListener("leavepictureinpicture", leave, { signal: ac.signal });
    Promise.resolve(request).then(reportOpened, leave);
    return {
      exit() {
        ac.abort();
        if (opened) send({ type: "PIP_CLOSED" });
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      },
    };
  }

  document.addEventListener("enterpictureinpicture", (e) => {
    if (!ctx.settings.enabled || current.name !== "idle" || !(e.target instanceof HTMLVideoElement)) return;
    ctx.video = e.target;
    go("nativePip", Promise.resolve(e.pictureInPictureWindow));
  }, true);

  // DRM or an uncapturable element falls back to native PiP. Both checks are synchronous so the
  // click's user activation is still unspent when requestWindow/requestPictureInPicture runs.
  function startPip() {
    const video = ctx.video;
    let stream = null;
    if (!video.mediaKeys) {
      try {
        stream = video.captureStream();
      } catch {}
    }
    if (!stream) {
      // DRM players (Netflix and friends) often set disablePictureInPicture; the user asked for PiP
      // explicitly, so lift it for this request.
      video.disablePictureInPicture = false;
      return go("nativePip", video.requestPictureInPicture());
    }
    const chatUrl = chatUrlFor(ctx.site);
    const showChat = Boolean(ctx.settings.showChat && chatUrl);
    const size = floatSize(video, DEFAULT_FLOAT_WIDTH, DEFAULT_FLOAT_WIDTH);
    const height = size.h + (showChat ? (ctx.layout.pipChatHeight ?? PIP_CHAT_HEIGHT) : 0);
    go("docPip", { stream, chatUrl, win: documentPictureInPicture.requestWindow({ width: size.w, height }) });
  }

  const ACTIONS = {
    inTab: () => go("inTab"),
    docPip: startPip,
    idle: () => {
      send({ type: "INTAB_STOP_ALL" });
      go("idle");
    },
    focusSource: () => {
      send({ type: "FOCUS_SOURCE_TAB" });
    },
    toggleWebChat: () => {
      toggleWebChatSink?.();
    },
    skipAd: () => {
      skipAdSink?.();
    },
  };

  const ENTER = {
    idle: enterIdle,
    inTab: enterInTab,
    remoteInTab: enterRemoteInTab,
    docPip: enterDocPip,
    nativePip: enterNativePip,
  };
  const TRANSITIONS = {
    idle: ["idle", "inTab", "remoteInTab", "docPip", "nativePip"],
    inTab: ["idle", "docPip", "nativePip"],
    remoteInTab: ["idle", "remoteInTab"],
    docPip: ["idle"],
    nativePip: ["idle"],
  };
  const noop = () => {};
  let current = { name: "idle", video: null, exit: noop, settingsChanged: noop, layoutChanged: noop };

  function go(next, arg) {
    if (!TRANSITIONS[current.name].includes(next)) return;
    if (next !== "idle" && next !== "remoteInTab" && !ctx.video) return;
    current.exit();
    const inst = { name: next, video: ctx.video, exit: noop, settingsChanged: noop, layoutChanged: noop };
    current = inst;
    Object.assign(inst, ENTER[next](arg, () => current === inst && go("idle")));
  }

  function scan() {
    if (location.href !== ctx.url) {
      ctx.url = location.href;
      if (current.name === "idle") {
        ctx.video = null;
        go("idle");
      } else if (current.video && !current.video.isConnected) {
        ctx.video = null;
        go("idle");
      }
      loadSite();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (current.video && !current.video.isConnected) go("idle");
  }

  function applySettings(stored) {
    ctx.settings = Settings.merge(stored);
    if (!ctx.settings.enabled && current.name !== "idle") {
      go("idle");
      return;
    }
    current.settingsChanged();
  }

  function applyLayout(stored) {
    ctx.layout = sanitizeLayout(stored);
    current.layoutChanged?.();
  }

  const settingsReady = chrome.storage.local
    .get(["settings", "floatLayout"])
    .then(({ settings, floatLayout }) => {
      applyLayout(floatLayout);
      applySettings(settings);
    }, noop);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.floatLayout) applyLayout(changes.floatLayout.newValue);
    if (changes.settings) applySettings(changes.settings.newValue);
  });

  async function loadSite() {
    const url = location.href;
    await settingsReady;
    const res = await send({ type: "GET_SITE_CONFIG", url });
    if (!res?.site || url !== location.href) return;
    ctx.siteId = res.siteId;
    ctx.site = res.site;
    scan();
  }

  const MSG_HANDLERS = {
    async INTAB_QUERY_SOURCE() {
      if (current.name !== "inTab" || !current.querySource) return { ok: false };
      return current.querySource();
    },
    async INTAB_RECONNECT_SENDER() {
      if (current.name === "inTab") current.connectSender?.();
      return { ok: true };
    },
    async INTAB_FORCE_IDLE() {
      if (current.name === "inTab" || current.name === "remoteInTab") go("idle");
      return { ok: true };
    },
    async INTAB_SKIP_AD() {
      triggerSkipAd(ctx.video);
      return { ok: true };
    },
    async REMOTE_INTAB_START(msg) {
      await settingsReady;
      if (!ctx.settings.enabled) return { ok: false };
      if (current.name === "remoteInTab" && current.video?.isConnected) {
        current.kick?.(msg);
        return { ok: true };
      }
      if (current.name !== "idle") return { ok: false };
      go("remoteInTab", msg);
      return current.name === "remoteInTab" && current.ready ? current.ready : { ok: false };
    },
    async REMOTE_INTAB_STOP() {
      if (current.name === "remoteInTab") go("idle");
      return { ok: true };
    },
    async PIP_HOVER(msg) {
      if (current.name === "docPip") current.setHovered?.(Boolean(msg?.hovered));
      return { ok: true };
    },
    async PIP_TOGGLE_CHAT() {
      if (current.name === "docPip") current.toggleChat?.();
      return { ok: true };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = MSG_HANDLERS[msg?.type];
    if (!fn) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  const globalAc = new AbortController();

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement && (current.name === "inTab" || current.name === "remoteInTab")) go("idle");
  }, { signal: globalAc.signal });

  window.addEventListener("keydown", (e) => {
    if (!ctx.settings.enabled || !e.isTrusted || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      return;
    }
    const combo = Settings.formatKeyEvent?.(e);
    if (!combo) return;
    const upper = combo.toUpperCase();
    const hk = ctx.settings.hotkeys;
    let intent = null;
    if (hk.clickThrough && hk.clickThrough.toUpperCase() === upper && upper !== "ALT+G") {
      intent = "TOGGLE_CLICK_THROUGH";
    } else if (hk.dodge && hk.dodge.toUpperCase() === upper && upper !== "ALT+SHIFT+D") {
      intent = "TOGGLE_DODGE";
    } else if (hk.mute && hk.mute.toUpperCase() === upper && upper !== "ALT+M") {
      intent = "TOGGLE_MUTE";
    }
    if (intent) {
      e.preventDefault();
      send({ type: "INTENT", intent });
    }
  }, { capture: true, signal: globalAc.signal });

  let scanQueued = false;
  const mutObs = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, SCAN_THROTTLE_MS);
  });
  mutObs.observe(document.documentElement, { childList: true, subtree: true });
  const scanTimer = setInterval(scan, 1000);

  globalThis.__ghostpipCleanup = () => {
    try {
      globalAc.abort();
      mutObs.disconnect();
      clearInterval(scanTimer);
      current.exit();
      launcher.hide();
      controller.hide();
      webChat.hide();
      launcher.host.remove();
      controller.host.remove();
      webChat.host.remove();
      document.querySelectorAll("canvas[data-gp-remote]").forEach((el) => el.remove());
    } catch {}
  };

  go("idle");
  loadSite();
})();
