(() => {
  "use strict";

  const PIP_KINDS = Object.freeze(["native", "document", "popup"]);
  const RECT_POS_MAX = 100000;
  const RECT_SIZE_MIN = 1;
  const RECT_SIZE_MAX = 20000;
  const DPR_MIN = 0.25;
  const DPR_MAX = 8;
  const DELTA_H_MAX = 4000;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 60000;

  const CHAT_FRAME_REGEX =
    "^https://(chzzk\\.naver\\.com/live/[^/?#]+/chat|www\\.youtube\\.com/live_chat|www\\.twitch\\.tv/popout/[^/?#]+/chat)";
  // Only chzzk's chat sends CSP, and its whole policy is frame-ancestors, so removing it loses nothing else.
  const CHAT_CSP_REGEX = "^https://chzzk\\.naver\\.com/live/[^/?#]+/chat";
  const CHAT_HOST_DOMAINS = Object.freeze(["youtube.com", "chzzk.naver.com", "twitch.tv"]);
  const CHAT_ORIGINS = Object.freeze(["https://chzzk.naver.com", "https://www.youtube.com", "https://www.twitch.tv"]);
  const chatFrameRe = new RegExp(CHAT_FRAME_REGEX);

  const ALL_SITES_ORIGINS = Object.freeze(["http://*/*", "https://*/*"]);
  const ALL_SITES_SCRIPT_ID = "ghostpip-all-sites";
  const CONTENT_JS = Object.freeze([
    "shared/settings.js",
    "shared/protocol.js",
    "content/dodge.js",
    "content/subtitles.js",
    "content/heuristics.js",
    "content/overlay-ui.js",
    "content/relay.js",
    "content/doc-pip.js",
    "content/content.js",
  ]);
  const CONTENT_CSS = Object.freeze(["content/overlay.css"]);
  const TEST_HOOKS_KEY = "gpTestHooks";

  const LAYOUT = Object.freeze({
    DEFAULT_WIDTH: 480,
    MIN_WIDTH: 140,
    MAX_WIDTH: 2560,
    MIN_HEIGHT: 90,
    MAX_HEIGHT: 2160,
    MIN_CHAT_HEIGHT: 120,
    PIP_CHAT_HEIGHT: 420,
    CHAT_SIZE_STEP: 80,
    WHEEL_OPACITY_STEP: 0.05,
  });

  const isInt = (v, min) => Number.isInteger(v) && v >= min;
  const isTabId = (v) => isInt(v, -1);
  const isPipKind = (k) => PIP_KINDS.includes(k);
  const isDpr = (v) => Number.isFinite(v) && v >= DPR_MIN && v <= DPR_MAX;

  function sanitizeRect(r) {
    if (!r || typeof r !== "object") return null;
    const { x, y, w, h } = r;
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (Math.abs(x) > RECT_POS_MAX || Math.abs(y) > RECT_POS_MAX) return null;
    if (w < RECT_SIZE_MIN || w > RECT_SIZE_MAX || h < RECT_SIZE_MIN || h > RECT_SIZE_MAX) return null;
    return { x, y, w, h };
  }

  function clampDeltaH(v) {
    return Number.isFinite(v) ? Math.max(-DELTA_H_MAX, Math.min(DELTA_H_MAX, v)) : null;
  }

  function savedBoundsFor(kind, b) {
    if (!b || typeof b !== "object" || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
    if (Math.abs(b.x) > RECT_POS_MAX || Math.abs(b.y) > RECT_POS_MAX) return null;
    const size = (v) => (b.kind === "native" && Number.isFinite(v) && v >= 0 && v <= RECT_SIZE_MAX ? v : 0);
    if (kind === "native") return { x: b.x, y: b.y, w: size(b.w), h: size(b.h) };
    if (kind === "document" || kind === "popup") return { x: b.x, y: b.y, w: 0, h: 0 };
    return null;
  }

  // Returns null when the entry would hand the engine an out-of-contract field.
  function buildPipOpenedEngineMsg(saved, pip, pipBounds) {
    if (!saved || !isInt(saved.tabId, 0) || !isPipKind(saved.kind) || !isDpr(saved.dpr)) return null;
    const rect = sanitizeRect(saved.rect);
    if (!rect) return null;
    const payload = { v: 1, type: "PIP_OPENED", tabId: saved.tabId, kind: saved.kind, rect, dpr: saved.dpr };
    if (Object.keys(pip || {}).length === 1) {
      const savedBounds = savedBoundsFor(saved.kind, pipBounds);
      if (savedBounds) payload.savedBounds = savedBounds;
    }
    return payload;
  }

  function isEngineMessage(msg) {
    return Boolean(msg && typeof msg === "object" && msg.v === 1 && typeof msg.type === "string");
  }

  function reconnectDelayMs(attempt) {
    return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  }

  // "Forbidden" means a host manifest exists but does not list this extension, which is also "not installed for us".
  function isHostMissingError(message) {
    return /native messaging host not found|access to the specified native messaging host is forbidden/i.test(
      String(message || ""),
    );
  }

  function isAllowedChatUrl(url) {
    if (typeof url !== "string" || !chatFrameRe.test(url)) return false;
    try {
      return CHAT_ORIGINS.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  function chatFramingRules(extensionId, tabIds = []) {
    const remove = (...headers) => ({
      type: "modifyHeaders",
      responseHeaders: headers.map((header) => ({ header, operation: "remove" })),
    });
    const scopes = [{ initiatorDomains: [...CHAT_HOST_DOMAINS, extensionId] }];
    if (tabIds.length) scopes.push({ tabIds: [...tabIds] });
    const rules = [];
    for (const scope of scopes) {
      rules.push(
        {
          id: rules.length + 1,
          priority: 1,
          action: remove("x-frame-options", "frame-options"),
          condition: { regexFilter: CHAT_FRAME_REGEX, resourceTypes: ["sub_frame"], ...scope },
        },
        {
          id: rules.length + 2,
          priority: 1,
          action: remove("content-security-policy"),
          condition: { regexFilter: CHAT_CSP_REGEX, resourceTypes: ["sub_frame"], ...scope },
        },
      );
    }
    return rules;
  }

  function siteIdFrom(site, url) {
    for (const src of [].concat(site?.idFrom ?? [])) {
      if (!src || typeof src !== "object") continue;
      if ("param" in src) {
        const id = url.searchParams.get(src.param);
        if (id) return id;
      } else if (Number.isInteger(src.pathIndex)) {
        if (src.pathPrefix && !url.pathname.startsWith(src.pathPrefix)) continue;
        const id = url.pathname.split("/")[src.pathIndex];
        if (id) return id;
      }
    }
    return null;
  }

  function chatUrlFor(site, href) {
    if (!site?.chatPopoutUrl) return null;
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const id = siteIdFrom(site, url);
    if (!id) return null;
    const out = site.chatPopoutUrl.replace(/\{(?:videoId|channelId|channel)\}/g, encodeURIComponent(id));
    return isAllowedChatUrl(out) ? out : null;
  }

  function mediaTargetCandidates({ preferredTabId = null, sourceByPopupTab = new Map(), pip = {} }) {
    const out = [];
    const push = (id) => {
      if (isInt(id, 0) && !out.includes(id)) out.push(id);
    };
    if (isInt(preferredTabId, 0)) {
      push(sourceByPopupTab.get(preferredTabId) ?? pip?.[preferredTabId]?.sourceTabId ?? preferredTabId);
    }
    const entries = Object.values(pip || {});
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      push(Number.isFinite(e?.sourceTabId) ? e.sourceTabId : e?.tabId);
    }
    return out;
  }

  function pickFallbackTab(tabs, isSite) {
    return (
      tabs.find((t) => t.active && isSite(t)) ||
      tabs.find((t) => t.audible && isSite(t)) ||
      tabs.find(isSite) ||
      tabs.find((t) => t.active) ||
      tabs.find((t) => t.audible) ||
      tabs[0] ||
      null
    );
  }

  function sanitizeLayout(raw) {
    const L = LAYOUT;
    const inRange = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
    const pos =
      raw?.pos && typeof raw.pos === "object" && Number.isFinite(raw.pos.rx) && Number.isFinite(raw.pos.ry)
        ? { rx: Math.min(1, Math.max(0, raw.pos.rx)), ry: Math.min(1, Math.max(0, raw.pos.ry)) }
        : null;
    const pipPos =
      raw?.pipPos && typeof raw.pipPos === "object" && Number.isFinite(raw.pipPos.x) && Number.isFinite(raw.pipPos.y)
        ? { x: Math.round(raw.pipPos.x), y: Math.round(raw.pipPos.y) }
        : null;
    const chatSize = (v) => (inRange(v, L.MIN_CHAT_HEIGHT, L.MAX_HEIGHT) ? Math.round(v) : null);
    return {
      width: inRange(raw?.width, L.MIN_WIDTH, L.MAX_WIDTH) ? Math.round(raw.width) : L.DEFAULT_WIDTH,
      height: inRange(raw?.height, L.MIN_HEIGHT, L.MAX_HEIGHT) ? Math.round(raw.height) : null,
      aspectRatio: Number.isFinite(raw?.aspectRatio) && raw.aspectRatio > 0.05 && raw.aspectRatio < 20 ? Number(raw.aspectRatio) : null,
      pos,
      chatOpen: Boolean(raw?.chatOpen),
      chatHeight: chatSize(raw?.chatHeight),
      pipChatHeight: chatSize(raw?.pipChatHeight),
      pipWidth: inRange(raw?.pipWidth, L.MIN_WIDTH, L.MAX_WIDTH) ? Math.round(raw.pipWidth) : null,
      pipPos,
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

  function resizePipWindow(w, deltaH) {
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

  function isBottomEdgeChatResize({ chatShown, frameConnected, pointerAgeMs, pointerX, pointerY, prevW, prevH, dw, dh }) {
    return Boolean(
      chatShown &&
        frameConnected &&
        pointerAgeMs < 1500 &&
        pointerY >= prevH - 24 &&
        pointerX > 16 &&
        pointerX < prevW - 16 &&
        dw === 0 &&
        Math.abs(dh) >= 1,
    );
  }

  function computeResizeRect(sr, dir, dx, dy, vp) {
    const startW = sr.r - sr.l;
    const startH = sr.b - sr.t;
    const hasW = dir.includes("w");
    const hasE = dir.includes("e");
    const hasN = dir.includes("n");
    const hasS = dir.includes("s");
    const maxW = hasW ? sr.r : hasE ? vp.r - sr.l : vp.r;
    const maxH = hasN ? sr.b : hasS ? vp.b - sr.t : vp.b;
    const rawW = hasE ? startW + dx : hasW ? startW - dx : startW;
    const rawH = hasS ? startH + dy : hasN ? startH - dy : startH;
    const w = Math.round(
      Math.min(Math.max(LAYOUT.MIN_WIDTH, rawW), Math.max(LAYOUT.MIN_WIDTH, Math.min(LAYOUT.MAX_WIDTH, maxW))),
    );
    const h = Math.round(
      Math.min(Math.max(LAYOUT.MIN_HEIGHT, rawH), Math.max(LAYOUT.MIN_HEIGHT, Math.min(LAYOUT.MAX_HEIGHT, maxH))),
    );
    const x = Math.max(0, hasW ? sr.r - w : sr.l);
    const y = Math.max(0, hasN ? sr.b - h : sr.t);
    return { x, y, w, h };
  }

  function moveWindowWithinScreen(w, pipPos) {
    if (!w || w.closed || !pipPos || !Number.isFinite(pipPos.x) || !Number.isFinite(pipPos.y)) return false;
    try {
      const availL = w.screen?.availLeft ?? 0;
      const availT = w.screen?.availTop ?? 0;
      const availW = w.screen?.availWidth ?? 1920;
      const availH = w.screen?.availHeight ?? 1080;
      const cx = Math.min(Math.max(availL, pipPos.x), Math.max(availL, availL + availW - w.outerWidth));
      const cy = Math.min(Math.max(availT, pipPos.y), Math.max(availT, availT + availH - w.outerHeight));
      w.moveTo(cx, cy);
      return true;
    } catch {
      return false;
    }
  }

  globalThis.GhostPiPProtocol = Object.freeze({
    PIP_KINDS,
    CHAT_FRAME_REGEX,
    CHAT_CSP_REGEX,
    CHAT_HOST_DOMAINS,
    ALL_SITES_ORIGINS,
    ALL_SITES_SCRIPT_ID,
    CONTENT_JS,
    CONTENT_CSS,
    TEST_HOOKS_KEY,
    LAYOUT,
    isTabId,
    isPipKind,
    isDpr,
    sanitizeRect,
    clampDeltaH,
    buildPipOpenedEngineMsg,
    isEngineMessage,
    reconnectDelayMs,
    isHostMissingError,
    isAllowedChatUrl,
    chatFramingRules,
    chatUrlFor,
    mediaTargetCandidates,
    pickFallbackTab,
    sanitizeLayout,
    boostVideoSdp,
    resizePipWindow,
    isBottomEdgeChatResize,
    computeResizeRect,
    moveWindowWithinScreen,
  });
})();
