(() => {
  try {
    globalThis.__ghostpipCleanup?.();
  } catch {}
  try {
    document.documentElement?.dispatchEvent(new CustomEvent("ghostpip:cleanup"));
  } catch {}

  let cleanedUp = false;
  function isContextAlive() {
    if (cleanedUp) return false;
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }
  function ensureAlive() {
    if (isContextAlive()) return true;
    globalThis.__ghostpipCleanup?.();
    return false;
  }

  const Dodge = globalThis.GhostPiPDodge;
  const Subtitles = globalThis.GhostPiPSubtitles;
  const t = (key, subs) => {
    try {
      return chrome.i18n.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  };
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
  const CHAT_SIZE_STEP = 80;
  const MULTI_CORNER_ORDER = ["BR", "TR", "BL", "TL"];
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
  const PEEK_MATCH = {
    Alt: (s) => s.alt,
    Ctrl: (s) => s.ctrl,
    Shift: (s) => s.shift,
    "Ctrl+Alt": (s) => s.ctrl && s.alt,
    Backquote: (s) => s.backquote,
    Mouse4: (s) => (s.buttons & 8) !== 0,
    Mouse5: (s) => (s.buttons & 16) !== 0,
  };
  const peekInput = {
    alt: false,
    ctrl: false,
    shift: false,
    backquote: false,
    buttons: 0,
  };
  let localPeekActive = false;

  const ctx = {
    settings: { ...Settings.merge(undefined), enabled: false },
    layout: {
      width: DEFAULT_FLOAT_WIDTH,
      height: null,
      aspectRatio: null,
      pos: null,
      chatOpen: false,
      chatHeight: null,
      pipChatHeight: null,
      pipWidth: null,
      pipPos: null,
    },
    siteId: "generic",
    site: { video: null, chatPopoutUrl: null },
    video: null,
    url: location.href,
    myTabId: null,
    activeDocPipTabId: null,
    engineConnected: false,
    enginePeekActive: false,
  };
  document.documentElement?.setAttribute("data-gp-disabled", "");

  function isEditableTarget(tgt) {
    return Boolean(
      tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" ||
          tgt.isContentEditable),
    );
  }

  function isPeeking() {
    return Boolean(ctx.settings.peek?.enabled && (ctx.enginePeekActive || localPeekActive));
  }

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
    const clampedH = Math.round(Math.max(120, maxHeight));
    return { w: Math.round(clampedH / ratio), h: clampedH };
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
    const aspectRatio =
      Number.isFinite(raw?.aspectRatio) && raw.aspectRatio > 0.05 && raw.aspectRatio < 20
        ? Number(raw.aspectRatio)
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
    const pipWidth =
      Number.isFinite(raw?.pipWidth) && raw.pipWidth >= MIN_FLOAT_WIDTH && raw.pipWidth <= MAX_FLOAT_WIDTH
        ? Math.round(raw.pipWidth)
        : null;
    const pipPos =
      raw?.pipPos &&
      typeof raw.pipPos === "object" &&
      Number.isFinite(raw.pipPos.x) &&
      Number.isFinite(raw.pipPos.y)
        ? { x: Math.round(raw.pipPos.x), y: Math.round(raw.pipPos.y) }
        : null;
    return {
      width,
      height,
      aspectRatio,
      pos,
      chatOpen,
      chatHeight: sizeOrNull(raw?.chatHeight),
      pipChatHeight: sizeOrNull(raw?.pipChatHeight),
      pipWidth,
      pipPos,
    };
  }

  function toRelPos(l, topY, s, vp) {
    const maxL = Math.max(1, vp.r - s.w);
    const maxT = Math.max(1, vp.b - s.h);
    return {
      rx: Math.min(1, Math.max(0, l / maxL)),
      ry: Math.min(1, Math.max(0, topY / maxT)),
    };
  }

  function fromRelPos(pos, s, vp) {
    const maxL = Math.max(0, vp.r - s.w);
    const maxT = Math.max(0, vp.b - s.h);
    const l = Math.round(Math.min(1, Math.max(0, pos.rx)) * maxL);
    const topY = Math.round(Math.min(1, Math.max(0, pos.ry)) * maxT);
    return { l, t: topY, r: l + s.w, b: topY + s.h };
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
    :host([data-bar-only]) .handle { display: none; }
    :host([data-bar-only]:not([data-has-toast])) .hud { display: none; }
    :host([data-toast-only]) .surface,
    :host([data-toast-only]) .handle,
    :host([data-toast-only]) .bar,
    :host([data-toast-only]) .skip-ad { display: none !important; }
    :host([data-peek-silhouette]) .surface { border: 1px solid rgba(56, 189, 248, 0.35); background: none; box-shadow: none; }
    :host([data-peek-silhouette]) .handle,
    :host([data-peek-silhouette]) .bar,
    :host([data-peek-silhouette]) .skip-ad { display: none !important; }
    :host([data-peek-silhouette]:not([data-has-toast])) .hud { display: none; }
    :host([data-click-through]) *,
    :host([data-click-through]) .bar,
    :host([data-click-through]) .handle,
    :host([data-click-through]) .skip-ad { pointer-events: none !important; }
    :host([data-remote]) button[data-mode="local"],
    :host(:not([data-remote])) button[data-mode="remote"] { display: none; }`;

  const WEB_CHAT_CSS = `
    :host { box-sizing: border-box; background: #0f172a; box-shadow: 0 8px 24px rgba(2, 6, 23, 0.55); }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .chat-resize { position: absolute; left: 14px; right: 14px; bottom: 0; height: 12px; z-index: 2; cursor: ns-resize; touch-action: none; }
    .chat-resize::after { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 4px; border-radius: 4px;
      transform: translate(-50%, -50%); background: rgba(125, 211, 252, 0.9); box-shadow: 0 0 6px rgba(56, 189, 248, 0.7);
      opacity: 0; transition: opacity 0.14s ease; }
    :host(:hover) .chat-resize::after, :host([data-interactive]) .chat-resize::after, .chat-resize[data-active]::after { opacity: 1; }
    :host([data-resizing]) iframe,
    :host([data-click-through]) iframe,
    :host([data-click-through]) .chat-resize { pointer-events: none !important; }`;

  const SUBTITLES_CSS = `
    :host { pointer-events: none !important; }
    .gp-sub-box { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); max-width: 92%;
      padding: 2px 6px; background: transparent; border: 0; outline: none; color: #fff;
      font: 700 clamp(12px, calc(var(--gp-w, 480px) * 0.04), 26px)/1.36 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      text-align: center; white-space: pre-line; word-break: keep-all; overflow-wrap: break-word;
      text-shadow: -1.5px -1.5px 0 rgba(0, 0, 0, 0.96), 1.5px -1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 0 -1.5px 0 rgba(0, 0, 0, 0.96), 0 1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 0 0 rgba(0, 0, 0, 0.96), 1.5px 0 0 rgba(0, 0, 0, 0.96), 0 2px 6px rgba(0, 0, 0, 0.85);
      pointer-events: none; box-sizing: border-box; }`;

  const activeOverlayHosts = new Set();
  const activeFloatings = new Set();
  let overlaySeq = 0;

  // Open shadow root so tests can pierce it; popover so it renders in the top layer above site overlays.
  function overlayHost({ id, className = "", css, onAction, blockPointer = true }, ...content) {
    if (id) document.getElementById(id)?.remove();
    const attrs = { popover: "manual" };
    if (id) attrs.id = id;
    if (className) attrs.class = className;
    const host = h("div", attrs);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style, ...content);
    if (blockPointer) {
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
        host.addEventListener(type, (e) => e.stopPropagation());
      }
    }
    if (onAction) {
      root.addEventListener("click", (e) => {
        const act = e.target.closest?.("[data-action]")?.dataset.action;
        if (act) onAction(act);
      });
    }
    activeOverlayHosts.add(host);
    return {
      host,
      root,
      get open() {
        return host.matches(":popover-open");
      },
      show(vars) {
        if (!ensureAlive() || !ctx.settings.enabled) return;
        setVars(host, vars);
        if (!host.isConnected) document.documentElement.append(host);
        if (!this.open) host.showPopover();
      },
      hide() {
        if (this.open) {
          try {
            host.hidePopover();
          } catch {}
        }
      },
      destroy() {
        this.hide();
        activeOverlayHosts.delete(host);
        host.remove();
      },
    };
  }

  const LAUNCHER_ACTIONS = {
    inTab: () => go("inTab"),
    docPip: () => startPip(),
  };

  const launcher = overlayHost(
    {
      id: "ghostpip-launcher",
      css: BASE_CSS,
      onAction: (act) => LAUNCHER_ACTIONS[act]?.(),
    },
    h(
      "div",
      { class: "bar" },
      h("button", { "data-action": "inTab", title: t("modeWebTitle") }, svgIcon(ICON_WEB_MODE), t("modeWeb")),
      h("button", { "data-action": "docPip", title: t("modeFullTitle") }, svgIcon(ICON_FULL_MODE), t("modeFull")),
    ),
  );

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
    return cs.visibility !== "hidden" && cs.display !== "none" && (v.classList.contains(FLOAT_CLASS) || Number(cs.opacity) > 0.05);
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

  function findFloatingUnderPointer(e) {
    for (const fl of activeFloatings) {
      if (fl.containsPoint(e.clientX, e.clientY)) return fl;
    }
    return null;
  }

  function isPointerOnAnyFloating(e) {
    return findFloatingUnderPointer(e) !== null;
  }

  // The pointer must be on the player itself, not on an image or card that merely overlaps the
  // video's rect: some element on the composed path has to be the video or a tight wrapper of it.
  function isPointerOnPlayer(video, e) {
    if (isPointerOnAnyFloating(e)) return false;
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
      const id =
        "param" in site.idFrom
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
      if (!ensureAlive()) return;
      if (!ctx.settings.enabled) {
        pointerOver = false;
        launcherOver = false;
        clearTimeout(idleTimer);
        return launcher.hide();
      }
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

    launcher.host.addEventListener(
      "pointerenter",
      () => {
        if (!ensureAlive() || !ctx.settings.enabled) return;
        launcherOver = true;
        clearTimeout(idleTimer);
        update();
      },
      on,
    );
    launcher.host.addEventListener(
      "pointerleave",
      () => {
        launcherOver = false;
        armIdleHide();
        update();
      },
      on,
    );

    window.addEventListener(
      "pointermove",
      (e) => {
        if (!e.isTrusted || !ensureAlive()) return;
        if (!ctx.settings.enabled) {
          if (pointerOver || launcherOver || launcher.open) update();
          return;
        }
        pointerOver = Boolean(ctx.video) && isPointerOnPlayer(ctx.video, e);
        if (pointerOver) armIdleHide();
        else clearTimeout(idleTimer);
        update();
      },
      { capture: true, ...on },
    );

    document.documentElement.addEventListener(
      "mouseleave",
      () => {
        pointerOver = false;
        launcherOver = false;
        clearTimeout(idleTimer);
        update();
      },
      on,
    );

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

  function pickUnoccupiedCorner(preferredHome) {
    const used = new Set();
    for (const fl of activeFloatings) {
      used.add(fl.getCorner());
    }
    const candidates = [preferredHome, ...MULTI_CORNER_ORDER.filter((c) => c !== preferredHome)];
    for (const c of candidates) {
      if (!used.has(c)) return c;
    }
    return MULTI_CORNER_ORDER[activeFloatings.size % MULTI_CORNER_ORDER.length];
  }

  function promotePrimaryOverlayIds() {
    if (document.getElementById("ghostpip-controller")) return;
    const first = activeFloatings.values().next().value;
    first?.promoteToPrimary?.();
  }

  function enterFloating({ video, ratioFallback = 9 / 16, isRemote = false, chatUrl = null, sourceTabId = null, initialSubtitle = "" }, leave) {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const viewport = () => ({
      l: 0,
      t: 0,
      r: document.documentElement.clientWidth || window.innerWidth,
      b: document.documentElement.clientHeight || window.innerHeight,
    });
    const cfg = () => ctx.settings.dodge;

    const slotIndex = activeFloatings.size;
    const isPrimaryDom = !document.getElementById("ghostpip-controller");
    const suffix = Number.isFinite(sourceTabId) ? String(sourceTabId) : String(++overlaySeq);
    const ctrlId = isPrimaryDom ? "ghostpip-controller" : `ghostpip-controller-${suffix}`;
    const chatId = isPrimaryDom ? "ghostpip-chat" : `ghostpip-chat-${suffix}`;
    const subId = isPrimaryDom ? "ghostpip-subtitles" : `ghostpip-subtitles-${suffix}`;

    let floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
    let floatHeight = ctx.layout.height || null;
    let savedAspectRatio = ctx.layout.aspectRatio;
    let resizedInSession = false;
    let lastHome = cfg().home;
    let corner = slotIndex > 0 ? pickUnoccupiedCorner(lastHome) : lastHome;
    let customPos = slotIndex > 0 ? null : ctx.layout.pos ? { ...ctx.layout.pos } : null;
    let hasIndependentSlotPos = slotIndex > 0;
    let dodge = Dodge.initialState(corner);
    let held = false;
    let wheelPreview = false;
    let waitCursorLeave = false;
    let drag = null;
    let pendingMove = null;
    let cursor = null;
    let remoteChatUrl = chatUrl;
    let remoteHasAd = false;
    let webChatOpen = slotIndex === 0 ? Boolean(ctx.layout.chatOpen) : false;
    let chatHeight = ctx.layout.chatHeight;
    let chatResize = null;
    let subtitleText = typeof initialSubtitle === "string" ? initialSubtitle.trim() : "";

    const resolveChatUrl = () =>
      ctx.settings.showChat ? (remoteChatUrl || (!isRemote ? chatUrlFor(ctx.site) : null)) : null;

    const hudEl = h("div", { class: "hud" }, "");
    const webChatLabel = h("span", {}, t("chatShow"));
    const webChatBtn = h("button", { "data-action": "toggleWebChat" }, svgIcon(ICON_CHAT), webChatLabel);
    const skipAdBtn = h("button", { class: "skip-ad", "data-action": "skipAd", hidden: "" }, t("skipAd"));
    const webChatFrame = h("iframe", {});
    const webChatResize = h("div", { class: "chat-resize", title: t("chatResizeTitle") });
    const subtitleBox = h("div", { class: "gp-sub-box" }, "");

    const instanceActions = {
      idle: () => {
        if (isRemote) {
          send({ type: "INTAB_STOP_SINGLE", sourceTabId });
          leave();
        } else {
          go("idle");
        }
      },
      docPip: () => startPip(),
      focusSource: () => {
        send({ type: "FOCUS_SOURCE_TAB", sourceTabId });
      },
      toggleWebChat: () => {
        if (!resolveChatUrl()) return;
        webChatOpen = !webChatOpen;
        if (activeFloatings.size <= 1) {
          persistLayout({ width: floatWidth, height: floatHeight, aspectRatio: savedAspectRatio, pos: customPos, chatOpen: webChatOpen });
        }
        render();
      },
      skipAd: () => {
        if (isRemote) {
          send({ type: "SKIP_AD", sourceTabId });
          remoteHasAd = false;
          render();
        } else {
          triggerSkipAd(video);
          render();
        }
      },
    };

    const webChat = overlayHost(
      { id: chatId, className: "ghostpip-chat", css: WEB_CHAT_CSS },
      webChatFrame,
      webChatResize,
    );
    const subtitleHost = overlayHost(
      { id: subId, className: "ghostpip-subtitles", css: SUBTITLES_CSS, blockPointer: false },
      subtitleBox,
    );
    const controller = overlayHost(
      {
        id: ctrlId,
        className: "ghostpip-controller",
        css: BASE_CSS + CONTROLLER_CSS,
        onAction: (act) => instanceActions[act]?.(),
      },
      h("div", { class: "surface" }),
      ...RESIZE_DIRS.map((dir) => h("div", { class: `handle ${dir}`, "data-resize": dir })),
      hudEl,
      skipAdBtn,
      h(
        "div",
        { class: "bar" },
        h("button", { "data-action": "idle" }, t("btnReturn")),
        h("button", { "data-action": "docPip", "data-mode": "local" }, svgIcon(ICON_FULL_MODE), t("modeFull")),
        h("button", { "data-action": "focusSource", "data-mode": "remote" }, t("btnSourceTab")),
        webChatBtn,
      ),
    );

    controller.host.toggleAttribute("data-remote", Boolean(isRemote));

    function shouldUseSavedHeight() {
      if (!(Number.isFinite(floatHeight) && floatHeight > 0)) return false;
      if (resizedInSession || drag?.mode === "resize") return true;
      if (Number.isFinite(savedAspectRatio) && savedAspectRatio > 0) {
        const curRatio = videoRatio(video, ratioFallback);
        if (Number.isFinite(curRatio) && curRatio > 0 && Math.abs(curRatio - savedAspectRatio) > 0.08) {
          return false;
        }
      }
      return true;
    }

    function size() {
      const vp = viewport();
      const maxW = Math.max(MIN_FLOAT_WIDTH, vp.r);
      const maxH = Math.max(MIN_FLOAT_HEIGHT, vp.b);
      if (shouldUseSavedHeight()) {
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
        return { l: r.l, t: r.t, r: r.r, b: r.b, videoT: r.t, chatT: r.b, chatH: 0, chatUrl: curChatUrl };
      }
      const vp = viewport();
      const hPx = Math.round(r.b - r.t);
      const wanted = chatHeight ?? Math.min(320, Math.max(160, Math.round(vp.b * 0.36)));
      const chatH = Math.round(Math.max(MIN_CHAT_HEIGHT, Math.min(wanted, vp.b - hPx - 16)));
      const fitsBelow = r.b + chatH <= vp.b - 8;
      const videoT = fitsBelow ? r.t : Math.max(8, r.b - hPx - chatH);
      const chatT = videoT + hPx;
      return { l: r.l, t: videoT, r: r.r, b: chatT + chatH, videoT, chatT, chatH, chatUrl: curChatUrl };
    }

    webChatResize.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = rect();
        const b = boundsWithChat(r);
        const vp = viewport();
        const w = Math.round(r.r - r.l);
        const hPx = Math.round(r.b - r.t);
        customPos = toRelPos(r.l, b.videoT, { w, h: hPx }, vp);
        const maxH = Math.max(MIN_CHAT_HEIGHT, vp.b - hPx - 16);
        chatResize = { startY: e.clientY, startH: b.chatH, maxH };
        try {
          webChatResize.setPointerCapture(e.pointerId);
        } catch {}
        webChatResize.toggleAttribute("data-active", true);
        webChat.host.toggleAttribute("data-resizing", true);
      },
      on,
    );
    webChatResize.addEventListener(
      "pointermove",
      (e) => {
        if (!chatResize) return;
        const dy = e.clientY - chatResize.startY;
        chatHeight = Math.round(Math.min(chatResize.maxH, Math.max(MIN_CHAT_HEIGHT, chatResize.startH + dy)));
        render();
      },
      on,
    );
    const endChatResize = () => {
      if (!chatResize) return;
      chatResize = null;
      webChatResize.removeAttribute("data-active");
      webChat.host.removeAttribute("data-resizing");
      if (activeFloatings.size <= 1) {
        persistLayout({ pos: customPos, chatHeight });
      } else {
        persistLayout({ chatHeight });
      }
      render();
    };
    webChatResize.addEventListener("pointerup", endChatResize, on);
    webChatResize.addEventListener("pointercancel", endChatResize, on);

    let toastText = "";
    let toastTimer = null;

    function effectiveClickThrough() {
      return Boolean(ctx.settings.clickThrough || ctx.settings.peek?.enabled);
    }

    function showToast(text) {
      if (!text) return;
      if (ctx.settings.peek?.enabled && !isPeeking() && ctx.settings.peek.idleOpacity === 0) return;
      toastText = String(text);
      clearTimeout(toastTimer);
      render();
      toastTimer = setTimeout(() => {
        toastText = "";
        render();
      }, 900);
    }

    function isInteractive() {
      if (held || drag !== null || chatResize !== null) return true;
      if (!effectiveClickThrough() && !cfg().enabled && cursor) {
        const b = boundsWithChat(rect());
        return cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b;
      }
      return false;
    }

    function render(anim = false) {
      const r = rect();
      const b = boundsWithChat(r);
      const w = Math.round(r.r - r.l);
      const hPx = Math.round(r.b - r.t);
      const canShowChat = Boolean(b.chatUrl);
      const showChatNow = Boolean(webChatOpen && canShowChat);
      webChatBtn.style.display = canShowChat ? "inline-flex" : "none";
      webChatLabel.textContent = showChatNow ? t("chatHide") : t("chatShow");

      const peekOn = Boolean(ctx.settings.peek?.enabled);
      const peeking = isPeeking();
      const peekHidden = peekOn && !peeking;
      const forcePass = effectiveClickThrough();
      const interactive = isInteractive();
      const hovered =
        drag !== null ||
        (cursor !== null && cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
      const hasSkipAd = isRemote ? Boolean(remoteHasAd) : canSkipAd(video);
      skipAdBtn.hidden = !hasSkipAd;
      const showBarOnly = !interactive && !forcePass && (hovered || hasSkipAd);
      const videoGeo = { x: px(r.l), y: px(b.videoT), w: px(w), h: px(hPx) };
      const ctrlGeo = videoGeo;
      let opacity;
      if (interactive && !wheelPreview) {
        opacity = 1;
      } else if (peekOn) {
        opacity = peeking
          ? (dodge.faded ? Math.min(FADED_OPACITY, ctx.settings.peek.activeOpacity) : ctx.settings.peek.activeOpacity)
          : ctx.settings.peek.idleOpacity;
      } else {
        opacity = dodge.faded ? FADED_OPACITY : ctx.settings.opacity;
      }
      const passNow = !interactive && forcePass;
      const peekOutline = !interactive && peekHidden && ctx.settings.peek.idleOpacity > 0;
      const shouldAnim = Boolean(anim && !document.hidden && drag === null);
      video.toggleAttribute("data-gp-anim", shouldAnim);
      setVars(video, { ...videoGeo, opacity: String(opacity) });
      video.toggleAttribute("data-gp-pass", passNow);
      video.toggleAttribute("data-click-through", passNow);
      video.toggleAttribute("data-gp-peek-outline", peekOutline);
      video.toggleAttribute("data-gp-drag", drag !== null);

      if (canShowChat) {
        if (!webChat.host.isConnected) document.documentElement.append(webChat.host);
        if (webChatFrame.getAttribute("src") !== b.chatUrl) {
          webChatFrame.setAttribute("src", b.chatUrl);
        }
      }
      if (showChatNow && b.chatH > 0 && !(peekHidden && ctx.settings.peek.idleOpacity === 0)) {
        webChat.host.toggleAttribute("data-gp-anim", shouldAnim && !chatResize);
        webChat.host.toggleAttribute("data-gp-pass", passNow);
        webChat.host.toggleAttribute("data-click-through", passNow);
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

      if (subtitleText && !(peekHidden && ctx.settings.peek.idleOpacity === 0)) {
        subtitleBox.textContent = subtitleText;
        subtitleHost.host.toggleAttribute("data-gp-anim", shouldAnim);
        subtitleHost.host.toggleAttribute("data-gp-drag", drag !== null);
        subtitleHost.show({ ...videoGeo, opacity: String(opacity) });
      } else {
        subtitleHost.hide();
      }

      const hasToast = Boolean(toastText) && !(peekHidden && ctx.settings.peek.idleOpacity === 0);
      hudEl.textContent = hasToast
        ? toastText
        : t("hudOpacityWheel", [String(Math.round(ctx.settings.opacity * 100)), `${w}×${hPx}`]);
      const toastOnly = hasToast && !interactive && !showBarOnly && !peekOutline;
      controller.host.toggleAttribute("data-hovered", hovered && !passNow);
      controller.host.toggleAttribute("data-bar-only", showBarOnly);
      controller.host.toggleAttribute("data-has-toast", hasToast);
      controller.host.toggleAttribute("data-toast-only", toastOnly);
      controller.host.toggleAttribute("data-peek-silhouette", peekOutline);
      controller.host.toggleAttribute("data-click-through", passNow);
      if (interactive || showBarOnly || peekOutline || toastOnly) controller.show(ctrlGeo);
      else controller.hide();
    }

    function settingsChanged() {
      if (cfg().home !== lastHome) {
        lastHome = cfg().home;
        if (!hasIndependentSlotPos || activeFloatings.size <= 1) {
          corner = lastHome;
          customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
          dodge = Dodge.initialState(corner);
        }
      }
      if (!cfg().enabled || cfg().style !== "fade") {
        dodge = { ...dodge, hoverSince: null, faded: false };
      }
      render();
    }

    function layoutChanged() {
      if (drag) return;
      floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
      floatHeight = ctx.layout.height || null;
      savedAspectRatio = ctx.layout.aspectRatio;
      if (!hasIndependentSlotPos || activeFloatings.size <= 1) {
        customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
        webChatOpen = Boolean(ctx.layout.chatOpen);
      }
      if (!chatResize) chatHeight = ctx.layout.chatHeight;
      render();
    }

    function clearFadeIfActive() {
      if (!dodge.faded && dodge.hoverSince === null) return;
      const wasFaded = dodge.faded;
      dodge = { ...dodge, hoverSince: null, faded: false };
      if (wasFaded) render(true);
    }

    function tick() {
      if (!isRemote) {
        const nowHasAd = canSkipAd(video);
        if (nowHasAd !== !skipAdBtn.hidden) render();
      }
      if (isInteractive()) {
        clearFadeIfActive();
        return;
      }
      if (ctx.settings.peek?.enabled && !isPeeking() && ctx.settings.peek.idleOpacity <= 0.05) {
        clearFadeIfActive();
        return;
      }
      const vp = viewport();
      const s = size();
      const r = rect();
      if (!effectiveClickThrough() && cursor !== null) {
        const b = boundsWithChat(r);
        if (webChatOpen && b.chatH > 0 && cursor.x >= r.l && cursor.x <= r.r && cursor.y >= b.chatT && cursor.y <= b.chatT + b.chatH) {
          clearFadeIfActive();
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
          clearFadeIfActive();
          return;
        }
        waitCursorLeave = false;
      }

      const stepCfg = customPos !== null && cfg().autoReturn ? { ...cfg(), autoReturn: false } : cfg();
      const out = Dodge.step(dodge, { now: performance.now(), cursor, size: s, area: vp, rect: r }, stepCfg);
      dodge = out.state;
      if (out.action.type === "move") {
        customPos = null;
        corner = out.action.corner;
      } else if (out.action.type !== "fade") {
        return;
      }
      render(true);
    }

    function setHeld(next) {
      if (next === held) return;
      if (held && !next) {
        wheelPreview = false;
        dodge = { ...dodge, hoverSince: null, faded: false };
        if (cursor) {
          const r = rect();
          const m = cfg().marginPx;
          if (cursor.x >= r.l - m && cursor.x < r.r + m && cursor.y >= r.t - m && cursor.y < r.b + m) {
            waitCursorLeave = true;
          }
        }
      }
      held = next;
      render();
    }
    const holdFrom = (e) => e.isTrusted && setHeld(HOLD[ctx.settings.hotkeys.hold](e));

    const dragController = {
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
          resizedInSession = true;
          drag.x = Math.max(0, nextX);
          drag.y = Math.max(0, nextY);
          drag.w = nextW;
          drag.h = nextH;
        }
        render();
      },
      end() {
        if (!drag) return;
        const wasResize = drag.mode === "resize";
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
        customPos = nearCorner ? null : toRelPos(r.l, r.t, s, vp);
        if (wasResize) {
          savedAspectRatio = videoRatio(video, ratioFallback);
        }

        if (activeFloatings.size <= 1) {
          persistLayout({
            width: floatWidth,
            height: floatHeight,
            aspectRatio: savedAspectRatio,
            pos: customPos,
            chatOpen: webChatOpen,
          });
          if (cfg().allowed.includes(nearest) && nearest !== cfg().home) {
            lastHome = nearest;
            persistHome(nearest, true);
          }
        } else {
          hasIndependentSlotPos = true;
          if (wasResize) {
            persistLayout({
              width: floatWidth,
              height: floatHeight,
              aspectRatio: savedAspectRatio,
            });
          }
        }
        render();
      },
    };

    controller.root.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || e.target.closest?.(".bar") || e.target.closest?.(".skip-ad")) return;
        const target = e.target;
        const resizeDir = target.dataset?.resize || null;
        if (!resizeDir) return;
        try {
          target.setPointerCapture?.(e.pointerId);
        } catch {}
        dragController.start(e, resizeDir);
      },
      on,
    );

    window.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || drag !== null) return;
        if (e.target === controller.host || controller.host.contains(e.target)) return;
        if (webChat.open && (e.target === webChat.host || webChat.host.contains(e.target))) return;
        const modHeld = held || HOLD[ctx.settings.hotkeys.hold](e);
        if (!modHeld && effectiveClickThrough()) return;
        const r = rect();
        const b = boundsWithChat(r);
        const hPx = Math.round(r.b - r.t);
        if (e.clientX >= r.l && e.clientX <= r.r && e.clientY >= b.videoT && e.clientY <= b.videoT + hPx) {
          pendingMove = { startX: e.clientX, startY: e.clientY };
        }
      },
      { capture: true, ...on },
    );

    window.addEventListener(
      "pointermove",
      (e) => {
        dragController.pointerMove(e);
        if (dragController.active()) {
          if (e.isTrusted && (e.buttons & 1) === 0) {
            dragController.end();
            return;
          }
          dragController.move(e);
        }
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
      },
      { capture: true, ...on },
    );

    window.addEventListener(
      "pointerup",
      () => {
        dragController.pointerUp();
        if (dragController.active()) dragController.end();
      },
      { capture: true, ...on },
    );

    window.addEventListener(
      "pointercancel",
      () => {
        dragController.pointerUp();
        if (dragController.active()) dragController.end();
      },
      { capture: true, ...on },
    );

    window.addEventListener(
      "wheel",
      (e) => {
        const b = boundsWithChat(rect());
        const overRect = e.clientX >= b.l && e.clientX <= b.r && e.clientY >= b.t && e.clientY <= b.b;
        if (!overRect && e.target !== video && e.target !== controller.host) return;
        const modHeld = held || HOLD[ctx.settings.hotkeys.hold](e);
        if (!modHeld && effectiveClickThrough()) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.deltaY) return;
        wheelPreview = true;
        waitCursorLeave = true;
        dodge = { ...dodge, hoverSince: null, faded: false };
        stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
        render();
      },
      { capture: true, passive: false, ...on },
    );

    const clearCursor = () => {
      const wasFaded = dodge.faded;
      cursor = null;
      waitCursorLeave = false;
      tick();
      if (!wasFaded) render();
    };

    document.documentElement.addEventListener("mouseleave", clearCursor, on);
    window.addEventListener(
      "pointerout",
      (e) => {
        if (e.isTrusted && !e.relatedTarget) clearCursor();
      },
      { capture: true, ...on },
    );
    window.addEventListener(
      "pointerover",
      (e) => {
        if (!e.isTrusted) return;
        const rawTarget = e.composedPath?.()?.[0] || e.target;
        if (rawTarget?.tagName === "IFRAME") {
          clearCursor();
          return;
        }
        const prevInteractive = isInteractive();
        const prevHovered = controller.host.hasAttribute("data-hovered");
        cursor = { x: e.clientX, y: e.clientY };
        holdFrom(e);
        const b = boundsWithChat(rect());
        const nowHovered =
          drag !== null || (cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
        if (prevInteractive !== isInteractive() || prevHovered !== nowHovered) render();
        tick();
      },
      { capture: true, ...on },
    );
    window.addEventListener("keydown", holdFrom, { capture: true, ...on });
    window.addEventListener("keyup", holdFrom, { capture: true, ...on });
    window.addEventListener(
      "blur",
      () => {
        setHeld(false);
        clearCursor();
      },
      on,
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        setHeld(false);
        if (document.hidden) clearCursor();
      },
      on,
    );
    window.addEventListener("resize", render, on);
    video.addEventListener("resize", render, on);
    const timer = setInterval(tick, DODGE_TICK_MS);

    const floatingHandle = {
      getSourceTabId() {
        return Number.isFinite(sourceTabId) ? sourceTabId : ctx.myTabId;
      },
      getCorner() {
        return corner;
      },
      containsPoint(x, y) {
        const b = boundsWithChat(rect());
        return x >= b.l && x <= b.r && y >= b.t && y <= b.b;
      },
      promoteToPrimary() {
        controller.host.id = "ghostpip-controller";
        webChat.host.id = "ghostpip-chat";
        subtitleHost.host.id = "ghostpip-subtitles";
      },
    };
    activeFloatings.add(floatingHandle);

    function exit() {
      ac.abort();
      clearInterval(timer);
      clearTimeout(toastTimer);
      pendingMove = null;
      activeFloatings.delete(floatingHandle);
      webChatFrame.removeAttribute("src");
      webChat.destroy();
      subtitleHost.destroy();
      controller.destroy();
      promotePrimaryOverlayIds();
      video.removeAttribute("data-gp-anim");
      video.removeAttribute("data-gp-peek-outline");
      video.removeAttribute("data-click-through");
      if (video.matches(":popover-open")) {
        try {
          video.hidePopover();
        } catch {}
      }
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

    function setSubtitle(nextText) {
      const clean = typeof nextText === "string" ? nextText.trim() : "";
      if (clean !== subtitleText) {
        subtitleText = clean;
        render();
      }
    }

    video.setAttribute("popover", "manual");
    video.classList.add(FLOAT_CLASS);
    try {
      video.showPopover();
    } catch {
      queueMicrotask(leave);
    }
    render();

    return {
      exit,
      settingsChanged,
      layoutChanged,
      peekChanged: () => render(true),
      showHud: showToast,
      setChatUrl,
      setHasAd,
      setSubtitle,
    };
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

  function createMediaSender(video, { onSubtitle } = {}) {
    const capCanvas = document.createElement("canvas");
    const capCtx = capCanvas.getContext("2d", { alpha: false });
    let alive = true;
    let senderPort = null;
    let keepAlivePc1 = null;
    let keepAlivePc2 = null;
    let keepAliveSink = null;
    let keepAliveTracks = [];
    let currentSubtitle = "";
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
      for (const tr of keepAliveTracks) tr.stop();
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
        for (const tr of keepAliveTracks) tr.contentHint = "detail";
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
        for (const tr of keepAliveTracks) pc1.addTrack(tr, stream);
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
          if (currentSubtitle) {
            senderPort.postMessage({ type: "SUBTITLE", text: currentSubtitle, portId });
          }
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
        if (currentSubtitle) {
          try {
            port.postMessage({ type: "SUBTITLE", text: currentSubtitle });
          } catch {}
        }
      } catch {}
    }

    const subObs = Subtitles?.observe?.(
      () => video,
      (text) => {
        currentSubtitle = text;
        onSubtitle?.(text);
        if (alive && senderPort) {
          try {
            senderPort.postMessage({ type: "SUBTITLE", text });
          } catch {}
        }
      },
    );

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

    const frameWarmTimer = setInterval(() => {
      if (alive && senderPort) captureFrame(640);
    }, 220);

    function querySource() {
      connectSender();
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      const ratio = vw > 0 && vh > 0 ? vh / vw : 9 / 16;
      return {
        ok: true,
        ratio,
        vw,
        vh,
        chatUrl: chatUrlFor(ctx.site),
        frame: snapshotFrame(640),
        subtitle: currentSubtitle,
      };
    }

    function stop() {
      if (!alive) return;
      alive = false;
      clearInterval(frameWarmTimer);
      subObs?.stop?.();
      video.removeEventListener("loadeddata", onLoadedData);
      if (senderPort) {
        try {
          senderPort.disconnect();
        } catch {}
        senderPort = null;
      }
      stopKeepAlive();
    }

    return {
      connectSender,
      querySource,
      snapshotFrame,
      getSubtitle: () => currentSubtitle,
      stop,
    };
  }

  function enterInTab(_arg, leave) {
    const video = ctx.video;
    const original = {
      popover: video.getAttribute("popover"),
      class: video.hasAttribute("class"),
      style: video.hasAttribute("style"),
    };
    const floating = enterFloating({ video, isRemote: false }, leave);
    const mediaSender = createMediaSender(video, {
      onSubtitle: (text) => floating.setSubtitle(text),
    });
    floating.setSubtitle(mediaSender.getSubtitle());

    function exit() {
      mediaSender.stop();
      send({ type: "INTAB_CLOSED" });
      floating.exit();
      if (original.popover === null) video.removeAttribute("popover");
      else video.setAttribute("popover", original.popover);
      video.classList.remove(FLOAT_CLASS);
      video.removeAttribute("data-gp-pass");
      video.removeAttribute("data-click-through");
      video.removeAttribute("data-gp-peek-outline");
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
      frame: mediaSender.snapshotFrame(640),
      subtitle: mediaSender.getSubtitle(),
    });
    return {
      video,
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      peekChanged: floating.peekChanged,
      showHud: floating.showHud,
      querySource: mediaSender.querySource,
      connectSender: mediaSender.connectSender,
    };
  }

  function enterRemoteInTab({ ratio, vw: initVw, vh: initVh, chatUrl, initialFrame, initialSubtitle = "", sourceTabId = null } = {}, leave) {
    const initRatio = ratio || (initVw > 0 && initVh > 0 ? initVh / initVw : 9 / 16);
    const startW = initVw > 0 ? initVw : initialFrame?.vw > 0 ? initialFrame.vw : DEFAULT_FLOAT_WIDTH;
    const startH =
      initVh > 0
        ? initVh
        : initialFrame?.vh > 0
          ? initialFrame.vh
          : Math.max(1, Math.round(startW * initRatio));
    const canvasAttrs = {
      class: FLOAT_CLASS,
      "data-gp-remote": "",
      popover: "manual",
    };
    if (Number.isFinite(sourceTabId)) canvasAttrs["data-gp-source-tab"] = String(sourceTabId);
    const canvas = h("canvas", canvasAttrs);
    canvas.width = startW;
    canvas.height = startH;
    canvas.videoWidth = startW;
    canvas.videoHeight = startH;
    let framesRendered = 0;
    canvas.getVideoPlaybackQuality = () => ({ totalVideoFrames: framesRendered });
    const ctx2d = canvas.getContext("2d", { alpha: false });
    document.documentElement.append(canvas);

    const floating = enterFloating(
      {
        video: canvas,
        ratioFallback: initRatio,
        isRemote: true,
        chatUrl,
        sourceTabId,
        initialSubtitle,
      },
      leave,
    );

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
              receiverPort.postMessage({ type: "RTC_CANDIDATE", candidate: e.candidate.toJSON(), sourceTabId });
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
          receiverPort.postMessage({ type: "RTC_ANSWER", sdp: boostedAnswer, sourceTabId });
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
        receiverPort.postMessage({ type: "PULL_FRAME", targetW, sourceTabId });
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
        const portName = Number.isFinite(sourceTabId) ? `ghostpip-receiver:${sourceTabId}` : "ghostpip-receiver";
        const port = chrome.runtime.connect({ name: portName });
        receiverPort = port;
        port.onMessage.addListener((msg) => {
          if (Number.isFinite(sourceTabId) && Number.isFinite(msg?.sourceTabId) && msg.sourceTabId !== sourceTabId) {
            return;
          }
          if (msg?.type === "FRAME") {
            handleFrame(msg);
          } else if (msg?.type === "SUBTITLE") {
            floating.setSubtitle?.(msg.text || "");
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
        port.postMessage({ type: "RTC_INIT", sourceTabId });
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
      sourceTabId,
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      peekChanged: floating.peekChanged,
      showHud: floating.showHud,
      kick: (msg) => {
        if (msg?.chatUrl) floating.setChatUrl?.(msg.chatUrl);
        if (typeof msg?.initialSubtitle === "string") floating.setSubtitle?.(msg.initialSubtitle);
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
            receiverPort.postMessage({ type: "RTC_INIT", sourceTabId });
          } catch {}
        }
        if (!drawRtcFrame()) requestFrame();
      },
      ready: Promise.resolve({ ok: true }),
    };
  }

  const remoteOverlays = new Map();

  function remoteKeyOf(msg) {
    return Number.isFinite(msg?.sourceTabId) ? msg.sourceTabId : "default";
  }

  function closeRemoteOverlay(key) {
    const inst = remoteOverlays.get(key);
    if (!inst) return;
    remoteOverlays.delete(key);
    inst.exit();
  }

  function stopAllRemoteOverlays() {
    for (const key of [...remoteOverlays.keys()]) {
      closeRemoteOverlay(key);
    }
  }

  function upsertRemoteOverlay(msg) {
    if (!ctx.settings.enabled) return null;
    if (Number.isFinite(msg?.sourceTabId) && ctx.myTabId != null && msg.sourceTabId === ctx.myTabId) {
      return null;
    }
    if (!Number.isFinite(msg?.sourceTabId) && current.name === "inTab") {
      return null;
    }
    const key = remoteKeyOf(msg);
    const existing = remoteOverlays.get(key);
    if (existing && existing.video?.isConnected) {
      existing.kick(msg);
      return existing;
    }
    if (existing) closeRemoteOverlay(key);
    const created = enterRemoteInTab(msg, () => closeRemoteOverlay(key));
    remoteOverlays.set(key, created);
    return created;
  }

  const PIP_CSS = `
    ${BASE_CSS}
    html, body { margin: 0; height: 100%; background: #000; color: #fff; font: 13px system-ui, "Malgun Gothic", sans-serif; overflow: hidden; }
    body { display: flex; flex-direction: column; position: relative; }
    .pip-stage { position: relative; flex: 1 1 auto; min-height: ${MIN_FLOAT_HEIGHT}px; width: 100%; height: 100%; background: #000; }
    video { width: 100%; height: 100%; display: block; object-fit: fill; background: #000; }
    iframe { flex: 0 0 var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px); height: var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px); min-height: 0; max-height: calc(100% - ${MIN_FLOAT_HEIGHT}px); width: 100%; border: 0; background: #fff; }
    body[data-chat-resizing] iframe { pointer-events: none; }
    .pip-subtitles { position: absolute; left: 50%; bottom: 8%; transform: translateX(-50%); max-width: 92%; pointer-events: none;
      z-index: 2; padding: 2px 6px; background: transparent; border: 0; outline: none; color: #fff;
      font: 700 clamp(12px, 4vw, 26px)/1.36 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      text-align: center; white-space: pre-line; word-break: keep-all; overflow-wrap: break-word;
      text-shadow: -1.5px -1.5px 0 rgba(0, 0, 0, 0.96), 1.5px -1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 0 -1.5px 0 rgba(0, 0, 0, 0.96), 0 1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 0 0 rgba(0, 0, 0, 0.96), 1.5px 0 0 rgba(0, 0, 0, 0.96), 0 2px 6px rgba(0, 0, 0, 0.85);
      box-sizing: border-box; }
    .pip-subtitles[hidden] { display: none !important; }
    .pip-bar { position: absolute; bottom: 14px; left: 50%; z-index: 12; opacity: 0; pointer-events: auto;
      transform: translateX(-50%); transition: opacity 0.14s ease; }
    .pip-bar button { padding: 7px 14px; font-size: 12.5px; pointer-events: auto; }
    .pip-bar button[hidden] { display: none !important; }
    body:not([data-click-through]):hover .pip-bar,
    body[data-hovered] .pip-bar { opacity: 1; pointer-events: auto; }
    .pip-handle { position: fixed; z-index: 11; pointer-events: none; opacity: 0; transition: opacity 0.16s ease; }
    body:not([data-click-through]):hover .pip-handle,
    body[data-hovered] .pip-handle,
    body[data-chat-resizing] .pip-handle.s { pointer-events: auto; opacity: 1; }
    .pip-handle.n { top: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
    .pip-handle.s { bottom: 0; left: 16px; right: 16px; height: 10px; cursor: ns-resize; touch-action: none; }
    body[data-chat-open] .pip-handle.s { height: 14px; }
    body[data-chat-open] .pip-handle.s::after {
      content: ""; position: absolute; left: 50%; bottom: 3px; width: 48px; height: 4px; border-radius: 4px;
      transform: translateX(-50%); background: rgba(125, 211, 252, 0.95);
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
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
    .pip-skip-ad { position: absolute; right: 12px; bottom: 12px; z-index: 12; opacity: 0; pointer-events: none;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.92); border: 1.5px solid rgba(56, 189, 248, 0.78);
      color: #f8fafc; font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.65); cursor: pointer; transition: opacity 0.16s ease; }
    .pip-skip-ad[hidden] { display: none !important; }
    body:not([data-click-through]) .pip-skip-ad,
    body[data-hovered] .pip-skip-ad { opacity: 1; pointer-events: auto; }
    .pip-hud { position: absolute; top: 8px; left: 8px; z-index: 10; padding: 4px 8px; border-radius: 5px; pointer-events: none;
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
    const stage = doc.createElement("div");
    stage.className = "pip-stage";
    const mirror = doc.createElement("video");
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.srcObject = stream;
    const pipSubtitles = doc.createElement("div");
    pipSubtitles.className = "pip-subtitles";
    pipSubtitles.hidden = true;
    const pipHud = doc.createElement("div");
    pipHud.className = "pip-hud";
    const pipSkipAd = doc.createElement("button");
    pipSkipAd.type = "button";
    pipSkipAd.className = "pip-skip-ad";
    pipSkipAd.dataset.action = "skipAd";
    pipSkipAd.hidden = true;
    pipSkipAd.textContent = t("skipAd");
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

    const pipBar = doc.createElement("div");
    pipBar.className = "bar pip-bar";
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.dataset.action = "closePip";
    closeBtn.textContent = t("btnReturn");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClosePip?.();
    });
    pipBar.append(closeBtn);

    let chatBtn = null;
    let chatLabel = null;
    const chatSizeBtns = [];
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
      // Click buttons still work under click-through (the engine replays hold+click), and they can
      // grow the chat by shrinking the video once Chrome's PiP size cap stops the window growing.
      for (const [label, delta, title] of [
        ["−", -CHAT_SIZE_STEP, t("chatSmaller")],
        ["+", CHAT_SIZE_STEP, t("chatBigger")],
      ]) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.dataset.action = delta > 0 ? "chatBigger" : "chatSmaller";
        btn.title = title;
        btn.textContent = label;
        btn.hidden = true;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          resizeChatBy(delta);
        });
        chatSizeBtns.push(btn);
        pipBar.append(btn);
      }
    }
    stage.append(mirror, pipSubtitles, pipHud, pipSkipAd, pipBar);
    doc.body.append(stage, ...handles);

    let engineHovered = false;
    let pointerHovered = false;
    let lastPointerX = -999;
    let lastPointerY = -999;
    let lastPointerAt = 0;
    const syncHovered = () => {
      doc.body.toggleAttribute("data-hovered", Boolean(engineHovered || pointerHovered));
    };
    const onPointerHover = (e) => {
      if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        lastPointerAt = performance.now();
      }
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
    let activeChatH = chatH;
    let togglingUntil = 0;
    const applyChatH = (hVal = activeChatH) => {
      activeChatH = Math.max(MIN_CHAT_HEIGHT, Math.round(hVal));
      doc.body.style.setProperty("--gp-chat-h", `${activeChatH}px`);
    };
    applyChatH(chatH);

    // The south handle sits at the bottom of the chat panel. Dragging it resizes only the chat
    // height while locking the video stage height; dragging any other edge or corner resizes the
    // video stage freely while keeping the chat height fixed.
    const handleS = handles.find((el) => el.dataset.resize === "s");
    handleS.title = t("chatResizeTitle");
    let chatResize = null;
    let lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, win.innerHeight - (chatShown ? activeChatH : 0));
    handleS.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !chatShown) return;
      e.preventDefault();
      e.stopPropagation();
      const curH = Math.round(frame?.getBoundingClientRect().height || activeChatH);
      lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, Math.round(stage.getBoundingClientRect().height || win.innerHeight - curH));
      chatResize = { startScreenY: e.screenY, startClientY: e.clientY, lastDelta: 0, startH: curH };
      try {
        handleS.setPointerCapture(e.pointerId);
      } catch {}
      doc.body.toggleAttribute("data-chat-resizing", true);
    });
    handleS.addEventListener("pointermove", (e) => {
      if (!chatResize || !chatShown) return;
      const rawDy = e.screenY !== chatResize.startScreenY ? e.screenY - chatResize.startScreenY : e.clientY - chatResize.startClientY;
      const targetH = Math.max(MIN_CHAT_HEIGHT, Math.round(chatResize.startH + rawDy));
      const clampedDy = targetH - chatResize.startH;
      const step = clampedDy - chatResize.lastDelta;
      if (Math.abs(step) < 6) return;
      chatResize.lastDelta = clampedDy;
      chatH = targetH;
      applyChatH(chatH);
      togglingUntil = performance.now() + 600;
      onResizeChat?.(step);
    });
    const endChatResize = () => {
      if (!chatResize) return;
      chatResize = null;
      togglingUntil = performance.now() + 600;
      doc.body.removeAttribute("data-chat-resizing");
      persistLayout({ pipChatHeight: chatH });
    };
    handleS.addEventListener("pointerup", endChatResize);
    handleS.addEventListener("pointercancel", endChatResize);

    let persistChatTimer = null;
    function resizeChatBy(delta) {
      if (!chatShown || !frame?.isConnected) return;
      const cur = Math.round(frame.getBoundingClientRect().height || activeChatH);
      chatH = Math.max(MIN_CHAT_HEIGHT, cur + delta);
      applyChatH(chatH);
      togglingUntil = performance.now() + 600;
      onResizeChat?.(chatH - cur);
      clearTimeout(persistChatTimer);
      persistChatTimer = setTimeout(() => {
        const measured = Math.round(frame?.getBoundingClientRect().height || 0);
        if (measured >= MIN_CHAT_HEIGHT) {
          chatH = measured;
          applyChatH(chatH);
        }
        lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, win.innerHeight - activeChatH);
        persistLayout({ pipChatHeight: chatH });
      }, 650);
    }

    let lastW = win.innerWidth;
    let lastH = win.innerHeight;
    let lastResizeAt = 0;
    let resizeMode = "window";
    let gestureStartChatH = chatH;
    let persistWidthTimer = null;
    const openedAt = performance.now();
    win.addEventListener("resize", () => {
      const now = performance.now();
      const prevW = lastW;
      const prevH = lastH;
      const dw = win.innerWidth - prevW;
      const dh = win.innerHeight - prevH;
      lastW = win.innerWidth;
      lastH = win.innerHeight;

      if (chatResize || now < togglingUntil) return;
      if (now - openedAt < 1000) {
        lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, win.innerHeight - (chatShown ? activeChatH : 0));
        return;
      }

      // The mode is decided once per drag gesture: the vertical-only ticks of a corner drag must not
      // flip into chat resizing halfway through.
      const isNewGesture = now - lastResizeAt > 220;
      lastResizeAt = now;
      if (isNewGesture) {
        gestureStartChatH = chatH;
        const startedOnBottomEdge =
          chatShown &&
          Boolean(frame?.isConnected) &&
          now - lastPointerAt < 1500 &&
          lastPointerY >= prevH - 24 &&
          lastPointerX > 16 &&
          lastPointerX < prevW - 16 &&
          dw === 0 &&
          Math.abs(dh) >= 1;
        resizeMode = startedOnBottomEdge ? "chat" : "window";
        if (startedOnBottomEdge) {
          lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, prevH - activeChatH);
        }
      } else if (Math.abs(dw) >= 1 && resizeMode === "chat") {
        resizeMode = "window";
        chatH = gestureStartChatH;
        applyChatH(chatH);
        persistLayout({ pipChatHeight: chatH });
      }

      if (resizeMode === "chat" && chatShown && frame?.isConnected) {
        chatH = Math.max(MIN_CHAT_HEIGHT, win.innerHeight - lockedVideoH);
        applyChatH(chatH);
        persistLayout({ pipChatHeight: chatH });
        return;
      }

      // Window resizes never touch the chat height; the video takes all of the change.
      lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, win.innerHeight - (chatShown && frame?.isConnected ? activeChatH : 0));
      if (win.innerWidth >= MIN_FLOAT_WIDTH && win.innerWidth <= MAX_FLOAT_WIDTH) {
        clearTimeout(persistWidthTimer);
        persistWidthTimer = setTimeout(() => {
          if (!win.closed && win.innerWidth >= MIN_FLOAT_WIDTH && win.innerWidth <= MAX_FLOAT_WIDTH) {
            persistLayout({ pipWidth: Math.round(win.innerWidth) });
          }
        }, 220);
      }
    });

    function syncChat(enabled, resizeWin = false) {
      if (!chatUrl) return;
      const nextShown = Boolean(enabled);
      const changed = nextShown !== chatShown;
      const prevActiveH = activeChatH;
      chatShown = nextShown;
      doc.body.toggleAttribute("data-chat-open", nextShown);
      if (chatLabel) chatLabel.textContent = nextShown ? t("chatHide") : t("chatShow");
      if (chatBtn) chatBtn.toggleAttribute("data-active", nextShown);
      for (const btn of chatSizeBtns) btn.hidden = !nextShown;
      if (nextShown) {
        applyChatH(chatH);
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
        togglingUntil = performance.now() + 800;
        onResizeChat?.(nextShown ? chatH : -prevActiveH);
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

    function setSubtitle(text) {
      const clean = typeof text === "string" ? text.trim() : "";
      pipSubtitles.textContent = clean;
      pipSubtitles.hidden = !clean;
    }

    function setChatOpacity(opStr) {
      if (frame) frame.style.opacity = opStr;
    }

    syncChat(showChat, false);
    mirror.play().catch(() => {});
    return {
      mirror,
      pipHud,
      pipSubtitles,
      syncChat,
      setFeatureEnabled,
      toggleChatOpen,
      setHovered,
      setClickThrough,
      setSkipAdVisible,
      setSubtitle,
      setChatOpacity,
    };
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
    let pipSubtitles = null;
    let setFeatureEnabled = null;
    let toggleChatOpen = null;
    let setHovered = null;
    let setClickThrough = null;
    let setSkipAdVisible = null;
    let setSubtitle = null;
    let setChatOpacity = null;
    let hudTimer = null;
    let rectSyncTimer = null;
    let adPollTimer = null;
    let engineConnected = Boolean(ctx.engineConnected);
    let latestSubtitle = "";

    const subObs = Subtitles?.observe?.(
      () => video,
      (text) => {
        latestSubtitle = text;
        setSubtitle?.(text);
      },
    );

    function showHud(text) {
      if (!text || !pipHud) return;
      if (ctx.settings.peek?.enabled && !isPeeking() && ctx.settings.peek.idleOpacity === 0) return;
      pipHud.textContent = text;
      pipHud.setAttribute("data-show", "");
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => pipHud?.removeAttribute("data-show"), 900);
    }

    function syncPipOpacity(showToast = false) {
      if (!mirror) return;
      let op = 1;
      if (!engineConnected) {
        if (ctx.settings.peek?.enabled) {
          op = isPeeking() ? ctx.settings.peek.activeOpacity : ctx.settings.peek.idleOpacity;
        } else {
          op = ctx.settings.opacity;
        }
      }
      const opStr = String(op);
      mirror.style.opacity = opStr;
      if (pipSubtitles) pipSubtitles.style.opacity = opStr;
      setChatOpacity?.(opStr);
      if (showToast) {
        showHud(t("hudOpacity", [String(Math.round(ctx.settings.opacity * 100))]));
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
      syncPipOpacity(false);
    }

    winPromise.then((w) => {
      if (ac.signal.aborted) return w.close();
      win = w;
      const built = buildPipDocument(w, stream, chatUrl, Boolean(ctx.settings.showChat), {
        onClosePip: () => {
          send({ type: "FOCUS_SOURCE_TAB", sourceTabId: ctx.myTabId });
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
      pipSubtitles = built.pipSubtitles;
      setFeatureEnabled = built.setFeatureEnabled;
      toggleChatOpen = built.toggleChatOpen;
      setHovered = built.setHovered;
      setClickThrough = built.setClickThrough;
      setSkipAdVisible = built.setSkipAdVisible;
      setSubtitle = built.setSubtitle;
      setChatOpacity = built.setChatOpacity;
      setSubtitle(latestSubtitle);
      setSkipAdVisible(canSkipAd(video));
      syncPipOpacity(false);
      adPollTimer = setInterval(() => {
        if (!ac.signal.aborted && !w.closed) setSkipAdVisible?.(canSkipAd(video));
      }, 400);
      w.addEventListener("pagehide", leave, { signal: ac.signal });
      attachPeekAndShortcutListeners(w, ac.signal, ctx.myTabId);
      w.addEventListener(
        "keydown",
        (e) => {
          if (HOLD[ctx.settings.hotkeys.hold]?.(e)) setHovered?.(true);
        },
        { capture: true, signal: ac.signal },
      );
      w.addEventListener(
        "keyup",
        (e) => {
          if (ctx.settings.clickThrough && !HOLD[ctx.settings.hotkeys.hold]?.(e)) setHovered?.(false);
        },
        { capture: true, signal: ac.signal },
      );
      w.addEventListener(
        "blur",
        () => {
          if (ctx.settings.clickThrough) setHovered?.(false);
        },
        { signal: ac.signal },
      );
      w.addEventListener(
        "wheel",
        (e) => {
          if (
            !engineConnected &&
            ctx.settings.enabled &&
            ctx.settings.media?.enabled &&
            ctx.settings.media.wheelVolume &&
            e.altKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            ctx.settings.hotkeys.hold !== "Alt"
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.deltaY) return;
            send({
              type: "MEDIA_ACTION",
              action: "VOLUME",
              deltaVolume: e.deltaY < 0 ? 0.05 : -0.05,
              sourceTabId: ctx.myTabId,
            });
            return;
          }
          if (e.target !== mirror && !HOLD[ctx.settings.hotkeys.hold](e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!e.deltaY) return;
          stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
          syncPipOpacity(true);
        },
        { capture: true, passive: false, signal: ac.signal },
      );
      const openedAt = performance.now();
      // Until its first resize the PiP window reports the opener's placeholder geometry, so the
      // rect handshake waits for it, with a timeout in case the platform never resizes.
      new Promise((placed) => {
        w.addEventListener("resize", placed, { once: true, signal: ac.signal });
        setTimeout(placed, 150);
      }).then(() => {
        if (ac.signal.aborted) return;
        const readRect = () => ({ x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight });
        let lastRectPos = { x: w.screenX, y: w.screenY };
        send({
          type: "PIP_OPENED",
          kind: "document",
          rect: readRect(),
          dpr: w.devicePixelRatio,
        }).then((res) => {
          engineConnected = Boolean(res?.engineConnected);
          ctx.engineConnected = engineConnected;
          if (typeof res?.peekActive === "boolean") {
            ctx.enginePeekActive = res.peekActive;
          }
          syncPipOpacity(false);
          if (!engineConnected && !res?.multiPip && ctx.layout.pipPos) {
            try {
              const availL = w.screen?.availLeft ?? 0;
              const availT = w.screen?.availTop ?? 0;
              const availW = w.screen?.availWidth ?? 1920;
              const availH = w.screen?.availHeight ?? 1080;
              const cx = Math.min(Math.max(availL, ctx.layout.pipPos.x), Math.max(availL, availL + availW - w.outerWidth));
              const cy = Math.min(Math.max(availT, ctx.layout.pipPos.y), Math.max(availT, availT + availH - w.outerHeight));
              w.moveTo(cx, cy);
              lastRectPos = { x: w.screenX, y: w.screenY };
            } catch {}
          }
        });
        for (const delay of [400, 900]) {
          setTimeout(() => {
            if (!ac.signal.aborted && !w.closed) send({ type: "PIP_RECT_UPDATED", rect: readRect() });
          }, delay);
        }
        rectSyncTimer = setInterval(() => {
          if (!ac.signal.aborted && !w.closed) {
            const cur = readRect();
            send({ type: "PIP_RECT_UPDATED", rect: cur });
            if (
              !engineConnected &&
              performance.now() - openedAt >= 1200 &&
              (Math.abs(cur.x - lastRectPos.x) >= 2 || Math.abs(cur.y - lastRectPos.y) >= 2)
            ) {
              lastRectPos = { x: cur.x, y: cur.y };
              persistLayout({ pipPos: { x: Math.round(cur.x), y: Math.round(cur.y) } });
            }
          }
        }, 2000);
      });
    }, leave);

    video.addEventListener(
      "loadeddata",
      () => {
        for (const tr of stream.getTracks()) tr.stop();
        stream = video.captureStream();
        if (mirror) mirror.srcObject = stream;
      },
      { signal: ac.signal },
    );

    let lastShowChat = Boolean(ctx.settings.showChat);

    return {
      video,
      settingsChanged: () => {
        const showChat = Boolean(ctx.settings.showChat);
        if (showChat !== lastShowChat) {
          lastShowChat = showChat;
          setFeatureEnabled?.(showChat);
        }
        syncPipOpacity(false);
        setClickThrough?.(Boolean(ctx.settings.clickThrough));
      },
      peekChanged: () => {
        syncPipOpacity(false);
      },
      engineStateChanged: (connected) => {
        engineConnected = Boolean(connected);
        syncPipOpacity(false);
      },
      showHud,
      toggleChat: () => {
        toggleChatOpen?.();
        syncPipOpacity(false);
      },
      setHovered: (hovered) => {
        setHovered?.(hovered);
      },
      exit() {
        ac.abort();
        subObs?.stop?.();
        clearTimeout(hudTimer);
        clearInterval(rectSyncTimer);
        clearInterval(adPollTimer);
        video.classList.remove(DOCPIP_SOURCE_CLASS);
        if (!originalHasClass && !video.getAttribute("class")) video.removeAttribute("class");
        for (const tr of stream.getTracks()) tr.stop();
        if (!win) return;
        send({ type: "PIP_CLOSED" });
        win.close();
      },
    };
  }

  function enterPopupPip({ width, height, ratio, chatUrl, showChat }, leave) {
    const video = ctx.video;
    const originalHasClass = video.hasAttribute("class");
    video.classList.add(DOCPIP_SOURCE_CLASS);
    let closed = false;
    const mediaSender = createMediaSender(video);

    send({
      type: "OPEN_POPUP_PIP",
      width,
      height,
      ratio,
      chatUrl,
      showChat,
      subtitle: mediaSender.getSubtitle(),
    }).then((res) => {
      if (!closed && !res?.ok) {
        leave();
      }
    });

    return {
      video,
      connectSender: mediaSender.connectSender,
      querySource: mediaSender.querySource,
      exit() {
        if (closed) return;
        closed = true;
        mediaSender.stop();
        video.classList.remove(DOCPIP_SOURCE_CLASS);
        if (!originalHasClass && !video.getAttribute("class")) video.removeAttribute("class");
        send({ type: "CLOSE_POPUP_PIP" });
      },
    };
  }

  function enterNativePip(request, leave) {
    const video = ctx.video;
    const ac = new AbortController();
    let opened = false;
    let currentSubtitle = "";

    const subObs = Subtitles?.observe?.(
      () => video,
      (text) => {
        currentSubtitle = text;
        if (opened) {
          send({ type: "PIP_SUBTITLE", text });
        }
      },
    );

    function readNativeRect(pw) {
      const fallbackH = Math.max(120, Math.round(DEFAULT_FLOAT_WIDTH * videoRatio(video)));
      const w = pw?.width > 0 ? pw.width : DEFAULT_FLOAT_WIDTH;
      const h = pw?.height > 0 ? pw.height : fallbackH;
      return { x: window.screenX, y: window.screenY, w, h };
    }

    function reportOpened(pw) {
      if (opened || !pw) return;
      opened = true;
      pw.addEventListener?.(
        "resize",
        () => {
          if (!ac.signal.aborted && pw.width > 0 && pw.height > 0) {
            send({ type: "PIP_RECT_UPDATED", rect: readNativeRect(pw) });
          }
        },
        { signal: ac.signal },
      );
      // The native PiP window's screen position is not exposed to pages; the opener's position is a
      // placeholder and the engine matches on size.
      send({
        type: "PIP_OPENED",
        kind: "native",
        rect: readNativeRect(pw),
        dpr: devicePixelRatio || 1,
      }).then(() => {
        const sub = currentSubtitle || subObs?.refresh?.() || "";
        if (sub && !ac.signal.aborted) {
          send({ type: "PIP_SUBTITLE", text: sub });
        }
      });
    }
    video.addEventListener("enterpictureinpicture", (e) => reportOpened(e.pictureInPictureWindow), { signal: ac.signal });
    video.addEventListener("leavepictureinpicture", leave, { signal: ac.signal });
    Promise.resolve(request).then(reportOpened, leave);
    return {
      video,
      exit() {
        ac.abort();
        subObs?.stop?.();
        if (opened) {
          send({ type: "PIP_SUBTITLE", text: "" });
          send({ type: "PIP_CLOSED" });
        }
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      },
    };
  }

  document.addEventListener(
    "enterpictureinpicture",
    (e) => {
      if (!ctx.settings.enabled || current.name !== "idle" || !(e.target instanceof HTMLVideoElement)) return;
      ctx.video = e.target;
      go("nativePip", Promise.resolve(e.pictureInPictureWindow));
    },
    true,
  );

  // DRM or an uncapturable element falls back to native PiP. Both checks are synchronous so the
  // click's user activation is still unspent when requestWindow/requestPictureInPicture runs.
  function startPip() {
    const video = ctx.video;
    if (!video) return;
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
    const prefW = ctx.layout.pipWidth ?? DEFAULT_FLOAT_WIDTH;
    const size = floatSize(video, prefW, Math.max(prefW, MAX_FLOAT_HEIGHT));
    const height = size.h + (showChat ? (ctx.layout.pipChatHeight ?? PIP_CHAT_HEIGHT) : 0);
    if (ctx.activeDocPipTabId != null && ctx.activeDocPipTabId !== ctx.myTabId) {
      for (const tr of stream.getTracks()) tr.stop();
      return go("popupPip", { width: size.w, height, ratio: videoRatio(video), chatUrl, showChat });
    }
    go("docPip", { stream, chatUrl, win: documentPictureInPicture.requestWindow({ width: size.w, height }) });
  }

  const ENTER = {
    idle: enterIdle,
    inTab: enterInTab,
    docPip: enterDocPip,
    popupPip: enterPopupPip,
    nativePip: enterNativePip,
  };
  const TRANSITIONS = {
    idle: ["idle", "inTab", "docPip", "popupPip", "nativePip"],
    inTab: ["idle", "docPip", "popupPip", "nativePip"],
    docPip: ["idle"],
    popupPip: ["idle"],
    nativePip: ["idle"],
  };
  const noop = () => {};
  let current = { name: "idle", video: null, exit: noop, settingsChanged: noop, layoutChanged: noop };

  function go(next, arg) {
    if (!TRANSITIONS[current.name].includes(next)) return;
    if (next !== "idle" && !ctx.settings.enabled) return;
    if (next !== "idle" && !ctx.video) return;
    current.exit();
    const inst = { name: next, video: ctx.video, exit: noop, settingsChanged: noop, layoutChanged: noop };
    current = inst;
    Object.assign(inst, ENTER[next](arg, () => current === inst && go("idle")));
  }

  function removeStrayOverlays() {
    for (const el of document.querySelectorAll(
      "#ghostpip-launcher, #ghostpip-controller, .ghostpip-controller, #ghostpip-chat, .ghostpip-chat, .ghostpip-subtitles",
    )) {
      if (!activeOverlayHosts.has(el)) el.remove();
    }
  }

  function scan() {
    if (!ensureAlive()) return;
    removeStrayOverlays();
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
    if (!ctx.settings.enabled) {
      ctx.video = null;
      if (current.name !== "idle") go("idle");
      stopAllRemoteOverlays();
      launcher.hide();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (current.video && !current.video.isConnected) go("idle");
  }

  function hasActiveOverlayOnPage() {
    return current.name !== "idle" || remoteOverlays.size > 0;
  }

  function preferredSourceTabId() {
    if (current.name !== "idle" && Number.isFinite(ctx.myTabId)) return ctx.myTabId;
    for (const inst of [...remoteOverlays.values()].reverse()) {
      if (Number.isFinite(inst?.sourceTabId)) return inst.sourceTabId;
    }
    return null;
  }

  function notifyPeekChanged() {
    current.peekChanged?.();
    for (const inst of remoteOverlays.values()) {
      inst.peekChanged?.();
    }
  }

  function recomputeLocalPeek() {
    const matcher = PEEK_MATCH[ctx.settings.peek?.key];
    const next = Boolean(ctx.settings.enabled && ctx.settings.peek?.enabled && matcher?.(peekInput));
    if (next === localPeekActive) return;
    localPeekActive = next;
    notifyPeekChanged();
  }

  function resetLocalPeekInput() {
    peekInput.alt = false;
    peekInput.ctrl = false;
    peekInput.shift = false;
    peekInput.backquote = false;
    peekInput.buttons = 0;
    recomputeLocalPeek();
  }

  function shouldSuppressMousePeekNav(button) {
    if (!ctx.settings.enabled || !ctx.settings.peek?.enabled || !hasActiveOverlayOnPage()) return false;
    return (
      (ctx.settings.peek.key === "Mouse4" && button === 3) ||
      (ctx.settings.peek.key === "Mouse5" && button === 4)
    );
  }

  function handleShortcutKeydown(e, sourceTabIdOverride = null) {
    if (!ctx.settings.enabled || e.repeat || isEditableTarget(e.target)) return;
    const combo = Settings.formatKeyEvent?.(e);
    if (!combo) return;
    const upper = combo.toUpperCase();
    const hk = ctx.settings.hotkeys;
    if (e.isTrusted) {
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
        return;
      }
    }
    if (ctx.engineConnected || !hasActiveOverlayOnPage()) return;
    if (hk.peek && hk.peek.toUpperCase() === upper) {
      e.preventDefault();
      send({ type: "INTENT", intent: "TOGGLE_PEEK" });
      return;
    }
    if (!ctx.settings.media?.enabled) return;
    const targetTabId = Number.isFinite(sourceTabIdOverride) ? sourceTabIdOverride : preferredSourceTabId();
    if (hk.playPause && hk.playPause.toUpperCase() === upper) {
      e.preventDefault();
      send({ type: "MEDIA_ACTION", action: "PLAY_PAUSE", sourceTabId: targetTabId });
    } else if (hk.seekBack && hk.seekBack.toUpperCase() === upper) {
      e.preventDefault();
      send({
        type: "MEDIA_ACTION",
        action: "SEEK",
        deltaSec: -ctx.settings.media.seekSec,
        sourceTabId: targetTabId,
      });
    } else if (hk.seekForward && hk.seekForward.toUpperCase() === upper) {
      e.preventDefault();
      send({
        type: "MEDIA_ACTION",
        action: "SEEK",
        deltaSec: ctx.settings.media.seekSec,
        sourceTabId: targetTabId,
      });
    }
  }

  function attachPeekAndShortcutListeners(targetWin, signal, sourceTabIdOverride = null) {
    targetWin.addEventListener(
      "keydown",
      (e) => {
        peekInput.alt = Boolean(e.altKey || e.key === "Alt");
        peekInput.ctrl = Boolean(e.ctrlKey || e.key === "Control");
        peekInput.shift = Boolean(e.shiftKey || e.key === "Shift");
        if (e.code === "Backquote" || e.key === "`" || e.key === "~") peekInput.backquote = true;
        recomputeLocalPeek();
        handleShortcutKeydown(e, sourceTabIdOverride);
      },
      { capture: true, signal },
    );
    targetWin.addEventListener(
      "keyup",
      (e) => {
        peekInput.alt = e.key === "Alt" ? false : Boolean(e.altKey);
        peekInput.ctrl = e.key === "Control" ? false : Boolean(e.ctrlKey);
        peekInput.shift = e.key === "Shift" ? false : Boolean(e.shiftKey);
        if (e.code === "Backquote" || e.key === "`" || e.key === "~") peekInput.backquote = false;
        recomputeLocalPeek();
      },
      { capture: true, signal },
    );
    const onButtonDown = (e) => {
      if (typeof e.altKey === "boolean") peekInput.alt = e.altKey;
      if (typeof e.ctrlKey === "boolean") peekInput.ctrl = e.ctrlKey;
      if (typeof e.shiftKey === "boolean") peekInput.shift = e.shiftKey;
      if (typeof e.buttons === "number" && e.buttons !== 0) {
        peekInput.buttons = e.buttons;
      } else if (e.button === 3) {
        peekInput.buttons |= 8;
      } else if (e.button === 4) {
        peekInput.buttons |= 16;
      }
      recomputeLocalPeek();
      if (shouldSuppressMousePeekNav(e.button)) e.preventDefault();
    };
    const onButtonUp = (e) => {
      if (typeof e.altKey === "boolean") peekInput.alt = e.altKey;
      if (typeof e.ctrlKey === "boolean") peekInput.ctrl = e.ctrlKey;
      if (typeof e.shiftKey === "boolean") peekInput.shift = e.shiftKey;
      if (e.button === 3) {
        peekInput.buttons &= ~8;
      } else if (e.button === 4) {
        peekInput.buttons &= ~16;
      } else if (typeof e.buttons === "number") {
        peekInput.buttons = e.buttons;
      }
      recomputeLocalPeek();
      if (shouldSuppressMousePeekNav(e.button)) e.preventDefault();
    };
    targetWin.addEventListener("pointerdown", onButtonDown, { capture: true, signal });
    targetWin.addEventListener("mousedown", onButtonDown, { capture: true, signal });
    targetWin.addEventListener("pointerup", onButtonUp, { capture: true, signal });
    targetWin.addEventListener("mouseup", onButtonUp, { capture: true, signal });
    targetWin.addEventListener(
      "auxclick",
      (e) => {
        if (shouldSuppressMousePeekNav(e.button)) e.preventDefault();
      },
      { capture: true, signal },
    );
    targetWin.addEventListener(
      "mousemove",
      (e) => {
        if (typeof e.altKey === "boolean") peekInput.alt = e.altKey;
        if (typeof e.ctrlKey === "boolean") peekInput.ctrl = e.ctrlKey;
        if (typeof e.shiftKey === "boolean") peekInput.shift = e.shiftKey;
        if (typeof e.buttons === "number") peekInput.buttons = e.buttons;
        recomputeLocalPeek();
      },
      { capture: true, signal },
    );
    targetWin.addEventListener("blur", resetLocalPeekInput, { signal });
    targetWin.document?.addEventListener(
      "visibilitychange",
      () => {
        if (targetWin.document.hidden) resetLocalPeekInput();
      },
      { signal },
    );
  }

  function applySettings(stored) {
    ctx.settings = Settings.merge(stored);
    document.documentElement?.toggleAttribute("data-gp-disabled", !ctx.settings.enabled);
    if (!ctx.settings.peek?.enabled) ctx.enginePeekActive = false;
    recomputeLocalPeek();
    if (!ctx.settings.enabled) {
      ctx.video = null;
      stopAllRemoteOverlays();
      if (current.name !== "idle") {
        go("idle");
        return;
      }
      launcher.hide();
    } else if (current.name === "idle") {
      ctx.video = findVideo();
    }
    current.settingsChanged();
    for (const inst of remoteOverlays.values()) {
      inst.settingsChanged?.();
    }
  }

  function applyLayout(stored) {
    ctx.layout = sanitizeLayout(stored);
    current.layoutChanged?.();
    for (const inst of remoteOverlays.values()) {
      inst.layoutChanged?.();
    }
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
    if (Number.isFinite(res.tabId)) ctx.myTabId = res.tabId;
    ctx.activeDocPipTabId = res.hasActiveDocPip ? (res.docPipTabId ?? null) : null;
    ctx.engineConnected = Boolean(res.engineConnected);
    ctx.enginePeekActive = Boolean(res.peekActive);
    current.engineStateChanged?.(ctx.engineConnected);
    recomputeLocalPeek();
    notifyPeekChanged();
    scan();
  }

  const MSG_HANDLERS = {
    async INTAB_QUERY_SOURCE() {
      if ((current.name !== "inTab" && current.name !== "popupPip") || !current.querySource) return { ok: false };
      return current.querySource();
    },
    async INTAB_RECONNECT_SENDER() {
      if (current.name === "inTab" || current.name === "popupPip") current.connectSender?.();
      return { ok: true };
    },
    async INTAB_FORCE_IDLE() {
      if (current.name === "inTab") go("idle");
      return { ok: true };
    },
    async INTAB_SKIP_AD() {
      triggerSkipAd(current.video || ctx.video);
      return { ok: true };
    },
    async REMOTE_INTAB_SYNC(msg) {
      await settingsReady;
      if (!ctx.settings.enabled) {
        stopAllRemoteOverlays();
        return { ok: false };
      }
      const sessions = Array.isArray(msg?.sessions) ? msg.sessions : [];
      const wantedKeys = new Set();
      for (const s of sessions) {
        if (Number.isFinite(s?.sourceTabId) && ctx.myTabId != null && s.sourceTabId === ctx.myTabId) continue;
        const key = remoteKeyOf(s);
        wantedKeys.add(key);
        upsertRemoteOverlay(s);
      }
      for (const key of [...remoteOverlays.keys()]) {
        if (!wantedKeys.has(key)) closeRemoteOverlay(key);
      }
      return { ok: true };
    },
    async REMOTE_INTAB_START(msg) {
      await settingsReady;
      if (!ctx.settings.enabled) return { ok: false };
      const inst = upsertRemoteOverlay(msg);
      return inst ? inst.ready : { ok: false };
    },
    async REMOTE_INTAB_STOP(msg) {
      if (Number.isFinite(msg?.sourceTabId)) {
        closeRemoteOverlay(msg.sourceTabId);
      } else {
        stopAllRemoteOverlays();
      }
      return { ok: true };
    },
    async PIP_SESSIONS_CHANGED(msg) {
      ctx.activeDocPipTabId = msg?.hasActiveDocPip ? (msg.docPipTabId ?? null) : null;
      return { ok: true };
    },
    async POPUP_PIP_CLOSED() {
      if (current.name === "popupPip") go("idle");
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
    async SETTINGS_CHANGED(msg) {
      if (msg?.settings) applySettings(msg.settings);
      return { ok: true };
    },
    async PEEK_STATE(msg) {
      ctx.enginePeekActive = Boolean(msg?.active);
      notifyPeekChanged();
      return { ok: true };
    },
    async ENGINE_STATE(msg) {
      ctx.engineConnected = Boolean(msg?.connected);
      current.engineStateChanged?.(ctx.engineConnected);
      return { ok: true };
    },
    async MEDIA_CONTROL(msg) {
      const video = current.video || findVideo();
      if (!video) return { ok: false };
      let hudText = "";
      if (msg?.action === "PLAY_PAUSE") {
        if (video.paused) {
          await video.play().catch(() => {});
        } else {
          video.pause();
        }
        hudText = video.paused ? "⏸" : "▶";
      } else if (msg?.action === "SEEK") {
        const deltaSec = Number(msg.deltaSec) || 0;
        if (!msg.handledSeekInMain) {
          let minT = 0;
          let maxT = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
          if (video.seekable?.length > 0) {
            const endT = video.seekable.end(video.seekable.length - 1);
            if (endT > 0) {
              minT = video.seekable.start(0);
              maxT = endT;
            }
          }
          video.currentTime = Math.max(minT, Math.min(maxT, (video.currentTime || 0) + deltaSec));
        }
        const signed = `${deltaSec > 0 ? "+" : ""}${deltaSec}`;
        hudText = t("mediaSeekSec", [signed]);
      } else if (msg?.action === "VOLUME") {
        const deltaVolume = Number(msg.deltaVolume) || 0;
        if (deltaVolume > 0 && video.muted) video.muted = false;
        const nextVol = Math.max(0, Math.min(1, Math.round(((video.volume ?? 1) + deltaVolume) * 100) / 100));
        video.volume = nextVol;
        hudText = t("hudVolume", [String(Math.round(nextVol * 100))]);
      } else {
        return { ok: false };
      }
      current.showHud?.(hudText);
      return {
        ok: true,
        paused: video.paused,
        currentTime: video.currentTime,
        volume: video.volume,
        hudText,
      };
    },
    async MEDIA_HUD(msg) {
      if (msg?.text) {
        const key = remoteKeyOf(msg);
        remoteOverlays.get(key)?.showHud?.(msg.text);
      }
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

  document.documentElement?.addEventListener(
    "ghostpip:cleanup",
    () => {
      globalThis.__ghostpipCleanup?.();
    },
    { signal: globalAc.signal },
  );

  document.addEventListener(
    "fullscreenchange",
    () => {
      if (document.fullscreenElement) {
        if (current.name === "inTab") go("idle");
        stopAllRemoteOverlays();
      }
    },
    { signal: globalAc.signal },
  );

  attachPeekAndShortcutListeners(window, globalAc.signal);

  window.addEventListener(
    "wheel",
    (e) => {
      if (
        ctx.engineConnected ||
        !ctx.settings.enabled ||
        !ctx.settings.media?.enabled ||
        !ctx.settings.media.wheelVolume ||
        !hasActiveOverlayOnPage() ||
        !e.altKey ||
        e.ctrlKey ||
        e.shiftKey
      ) {
        return;
      }
      const fl = findFloatingUnderPointer(e);
      if (fl && ctx.settings.hotkeys.hold === "Alt") return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.deltaY) return;
      const targetTabId = fl?.getSourceTabId?.() ?? preferredSourceTabId();
      send({
        type: "MEDIA_ACTION",
        action: "VOLUME",
        deltaVolume: e.deltaY < 0 ? 0.05 : -0.05,
        sourceTabId: targetTabId,
      });
    },
    { capture: true, passive: false, signal: globalAc.signal },
  );

  let scanQueued = false;
  const mutObs = new MutationObserver(() => {
    if (!ensureAlive()) return;
    removeStrayOverlays();
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, SCAN_THROTTLE_MS);
  });
  mutObs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("loadedmetadata", () => scan(), { capture: true, signal: globalAc.signal });
  document.addEventListener("durationchange", () => scan(), { capture: true, signal: globalAc.signal });
  const scanTimer = setInterval(scan, 1000);

  globalThis.__ghostpipCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      globalAc.abort();
      mutObs.disconnect();
      clearInterval(scanTimer);
      stopAllRemoteOverlays();
      current.exit();
      launcher.destroy();
      document
        .querySelectorAll(
          "#ghostpip-launcher, #ghostpip-controller, .ghostpip-controller, #ghostpip-chat, .ghostpip-chat, .ghostpip-subtitles, canvas[data-gp-remote]",
        )
        .forEach((el) => el.remove());
    } catch {}
  };

  go("idle");
  loadSite();
})();
