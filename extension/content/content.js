(() => {
  try {
    globalThis.__ghostpipCleanup?.();
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

  const Protocol = globalThis.GhostPiPProtocol;
  const Heuristics = globalThis.GhostPiPHeuristics;
  const Settings = globalThis.GhostPiPSettings;
  const OverlayUI = globalThis.GhostPiPOverlayUI;
  const DocPip = globalThis.GhostPiPDocPip;

  const {
    MIN_WIDTH: MIN_FLOAT_WIDTH,
    MAX_WIDTH: MAX_FLOAT_WIDTH,
  } = Protocol.LAYOUT;

  const {
    t,
    removeStrayOverlays,
  } = OverlayUI;

  const SCAN_THROTTLE_MS = 250;
  const PEEK_MATCH = Settings.PEEK_MATCH;
  const peekInput = Settings.createPeekInput();
  let localPeekActive = false;

  const ctx = {
    settings: { ...Settings.merge(undefined), enabled: false },
    layout: Protocol.sanitizeLayout(undefined),
    siteId: "generic",
    site: { video: null, chatPopoutUrl: null },
    video: null,
    url: location.href,
    myTabId: null,
    activeDocPipTabId: null,
    engineConnected: false,
    enginePeekActive: false,
    testHooks: Boolean(globalThis.__ghostpipTestMode),
  };
  document.documentElement?.setAttribute("data-gp-disabled", "");

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

  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

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

  const sanitizeLayout = Protocol.sanitizeLayout;

  let lastSettingsJson = "";
  let lastLayoutJson = "";
  let opacityPatchTimer = null;

  function persistLayout(next) {
    ctx.layout = sanitizeLayout({ ...ctx.layout, ...next });
    lastLayoutJson = JSON.stringify(ctx.layout);
    send({ type: "PATCH_FLOAT_LAYOUT", patch: next });
  }

  function stepOpacity(delta) {
    const next = Math.round(Math.min(1, Math.max(0.1, ctx.settings.opacity + delta)) * 100) / 100;
    if (next === ctx.settings.opacity) return next;
    ctx.settings = { ...ctx.settings, opacity: next };
    lastSettingsJson = JSON.stringify(ctx.settings);
    clearTimeout(opacityPatchTimer);
    opacityPatchTimer = setTimeout(() => {
      send({ type: "PATCH_SETTINGS", patch: { opacity: ctx.settings.opacity } });
    }, 100);
    return next;
  }

  const canSkipAd = (video, force = false) => Heuristics.canSkipAd(video, force);
  const triggerSkipAd = (video) => Heuristics.triggerSkipAd(video || ctx.video || findVideo());

  function isRenderedVideo(v, minW, minH) {
    if (v.videoWidth <= 0 || !v.isConnected) return false;
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
    return pick(document.querySelectorAll("video"), (v) => isRenderedVideo(v, 280, 158) && !Heuristics.isGifLike(v));
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

  function chatUrlFor(site) {
    if (
      (location.hostname === "www.youtube.com" || location.hostname === "m.youtube.com") &&
      location.pathname === "/watch" &&
      !Heuristics.hasYouTubeLiveChat(ctx.testHooks)
    ) {
      return null;
    }
    return Protocol.chatUrlFor(site, location.href);
  }

  const canShowOverlays = () => ensureAlive() && Boolean(ctx.settings.enabled);
  const LAUNCHER_ACTIONS = {
    docPip: () => startPip(),
  };

  const globalAc = new AbortController();

  document.addEventListener(
    "enterpictureinpicture",
    (e) => {
      if (!ctx.settings.enabled || current.name !== "idle" || !(e.target instanceof HTMLVideoElement)) return;
      ctx.video = e.target;
      go("nativePip", Promise.resolve(e.pictureInPictureWindow));
    },
    { capture: true, signal: globalAc.signal },
  );

  const pipEnv = {
    ctx,
    send,
    persistLayout,
    stepOpacity,
    isPeeking,
    canSkipAd,
    triggerSkipAd,
    chatUrlFor,
    floatSize,
    videoRatio,
    attachPeekAndShortcutListeners,
  };

  function startPip() {
    return DocPip.startPip({ ...pipEnv, go });
  }

  const ENTER = {
    idle: () =>
      OverlayUI.enterIdle({
        ctx,
        ensureAlive,
        canShow: canShowOverlays,
        isPointerOnPlayer,
        onAction: (act) => LAUNCHER_ACTIONS[act]?.(),
      }),
    docPip: (arg, leave) => DocPip.enterDocPip(arg, leave, pipEnv),
    popupPip: (arg, leave) => DocPip.enterPopupPip(arg, leave, pipEnv),
    nativePip: (arg, leave) => DocPip.enterNativePip(arg, leave, pipEnv),
  };
  const TRANSITIONS = {
    idle: ["idle", "docPip", "popupPip", "nativePip"],
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

  function scan() {
    if (!ensureAlive()) return;
    removeStrayOverlays();
    if (location.href !== ctx.url) {
      ctx.url = location.href;
      if (current.name === "idle" || (current.video && !current.video.isConnected)) {
        ctx.video = null;
        go("idle");
      }
      loadSite();
      return;
    }
    if (!ctx.settings.enabled) {
      ctx.video = null;
      if (current.name !== "idle") go("idle");
      current.settingsChanged?.();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (current.video && !current.video.isConnected) go("idle");
  }

  const hasActiveOverlayOnPage = () => current.name !== "idle";

  function preferredSourceTabId() {
    if (current.name !== "idle" && Number.isFinite(ctx.myTabId)) return ctx.myTabId;
    return null;
  }

  function notifyPeekChanged() {
    current.peekChanged?.();
  }

  function recomputeLocalPeek() {
    const matcher = PEEK_MATCH[ctx.settings.peek?.key];
    const next = Boolean(ctx.settings.enabled && ctx.settings.peek?.enabled && matcher?.(peekInput));
    if (next === localPeekActive) return;
    localPeekActive = next;
    notifyPeekChanged();
  }

  function handleShortcutKeydown(e, sourceTabIdOverride = null) {
    const matched = Settings.matchShortcut(e, ctx.settings, {
      engineConnected: ctx.engineConnected,
      hasOverlay: hasActiveOverlayOnPage(),
    });
    if (!matched) return;
    e.preventDefault();
    if (matched.type === "MEDIA_ACTION") {
      const targetTabId = Number.isFinite(sourceTabIdOverride) ? sourceTabIdOverride : preferredSourceTabId();
      send({ ...matched, sourceTabId: targetTabId });
      return;
    }
    send(matched);
  }

  function attachPeekAndShortcutListeners(targetWin, signal, sourceTabIdOverride = null, { onHoldKey } = {}) {
    Settings.bindPeekAndShortcuts(targetWin, {
      signal,
      peekState: peekInput,
      getSettings: () => ctx.settings,
      hasOverlay: hasActiveOverlayOnPage,
      onPeekInput: recomputeLocalPeek,
      onShortcut: (e) => handleShortcutKeydown(e, sourceTabIdOverride),
      onHoldKey,
    });
  }

  function applySettings(stored) {
    const merged = Settings.merge(stored);
    const json = JSON.stringify(merged);
    if (json === lastSettingsJson) return;
    lastSettingsJson = json;
    ctx.settings = merged;
    document.documentElement?.toggleAttribute("data-gp-disabled", !ctx.settings.enabled);
    if (!ctx.settings.peek?.enabled) ctx.enginePeekActive = false;
    recomputeLocalPeek();
    if (!ctx.settings.enabled) {
      ctx.video = null;
      if (current.name !== "idle") return go("idle");
    } else if (current.name === "idle") {
      ctx.video = findVideo();
    }
    current.settingsChanged();
  }

  function applyLayout(stored) {
    const nextLayout = sanitizeLayout(stored);
    const json = JSON.stringify(nextLayout);
    if (json === lastLayoutJson) return;
    lastLayoutJson = json;
    ctx.layout = nextLayout;
    current.layoutChanged?.();
  }

  const testHooksKey = Protocol?.TEST_HOOKS_KEY || "gpTestHooks";
  function applyTestHooks(val) {
    const next = Boolean(val || globalThis.__ghostpipTestMode);
    if (next === ctx.testHooks) return;
    ctx.testHooks = next;
    if (current.name === "idle") go("idle");
  }

  const settingsReady = chrome.storage.local
    .get(["settings", "floatLayout", testHooksKey])
    .then((res) => {
      applyTestHooks(res?.[testHooksKey]);
      applyLayout(res?.floatLayout);
      applySettings(res?.settings);
    }, noop);
  const onStorageChanged = (changes, area) => {
    if (area !== "local") return;
    if (changes[testHooksKey]) applyTestHooks(changes[testHooksKey].newValue);
    if (changes.floatLayout) applyLayout(changes.floatLayout.newValue);
    if (changes.settings) applySettings(changes.settings.newValue);
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

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
      if (current.name !== "popupPip" || !current.querySource) return { ok: false };
      return current.querySource();
    },
    async INTAB_RECONNECT_SENDER() {
      if (current.name === "popupPip") current.connectSender?.();
      return { ok: true };
    },
    async INTAB_SKIP_AD() {
      triggerSkipAd(current.video || ctx.video);
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
        if (video.paused) await video.play().catch(() => {});
        else video.pause();
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
  };

  const onRuntimeMessage = (msg, _sender, sendResponse) => {
    const fn = MSG_HANDLERS[msg?.type];
    if (!fn) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

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
      e.preventDefault();
      e.stopPropagation();
      if (!e.deltaY) return;
      send({
        type: "MEDIA_ACTION",
        action: "VOLUME",
        deltaVolume: e.deltaY < 0 ? 0.05 : -0.05,
        sourceTabId: preferredSourceTabId(),
      });
    },
    { capture: true, passive: false, signal: globalAc.signal },
  );

  let scanQueued = false;
  let scanTimeout = null;
  let strayCleanupQueued = false;
  const mutObs = new MutationObserver(() => {
    if (!ensureAlive()) return;
    if (!strayCleanupQueued) {
      strayCleanupQueued = true;
      requestAnimationFrame(() => {
        strayCleanupQueued = false;
        if (ensureAlive()) removeStrayOverlays();
      });
    }
    if (scanQueued) return;
    scanQueued = true;
    scanTimeout = setTimeout(() => {
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
      clearTimeout(scanTimeout);
      clearTimeout(opacityPatchTimer);
      chrome.storage?.onChanged?.removeListener?.(onStorageChanged);
      chrome.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
      current.exit();
      document.querySelectorAll("#ghostpip-launcher").forEach((el) => el.remove());
    } catch {}
  };

  go("idle");
  loadSite();
})();
