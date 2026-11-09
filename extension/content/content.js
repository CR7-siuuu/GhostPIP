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

  const Dodge = globalThis.GhostPiPDodge;
  const Protocol = globalThis.GhostPiPProtocol;
  const Heuristics = globalThis.GhostPiPHeuristics;
  const Settings = globalThis.GhostPiPSettings;
  const OverlayUI = globalThis.GhostPiPOverlayUI;
  const Relay = globalThis.GhostPiPRelay;
  const DocPip = globalThis.GhostPiPDocPip;

  const {
    DEFAULT_WIDTH: DEFAULT_FLOAT_WIDTH,
    MIN_WIDTH: MIN_FLOAT_WIDTH,
    MAX_WIDTH: MAX_FLOAT_WIDTH,
    MIN_HEIGHT: MIN_FLOAT_HEIGHT,
    MIN_CHAT_HEIGHT,
    WHEEL_OPACITY_STEP,
  } = Protocol.LAYOUT;

  const {
    FLOAT_CLASS,
    t,
    removeStrayOverlays,
    createFloatingOverlays,
    renderFloatingOverlays,
  } = OverlayUI;

  const CORNER_SNAP_PX = 8;
  const FADED_OPACITY = 0.1;
  const DODGE_TICK_MS = 50;
  const SCAN_THROTTLE_MS = 250;
  const MULTI_CORNER_ORDER = ["BR", "TR", "BL", "TL"];
  const HOLD = Settings.HOLD_MATCH;
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

  function persistHome(corner, keepLayoutPos = false) {
    send({ type: "PATCH_SETTINGS", patch: { dodge: { home: corner } }, keepLayoutPos });
  }

  const activeFloatings = new Set();
  let overlaySeq = 0;

  const canSkipAd = (video, force = false) => Heuristics.canSkipAd(video, force);
  const triggerSkipAd = (video) => Heuristics.triggerSkipAd(video || ctx.video || findVideo());

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
    return pick(document.querySelectorAll("video"), (v) => isRenderedVideo(v, 280, 158) && !Heuristics.isGifLike(v));
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
    inTab: () => go("inTab"),
    docPip: () => startPip(),
  };

  function pickUnoccupiedCorner(preferredHome) {
    const used = new Set();
    for (const fl of activeFloatings) used.add(fl.getCorner());
    const candidates = [preferredHome, ...MULTI_CORNER_ORDER.filter((c) => c !== preferredHome)];
    for (const c of candidates) {
      if (!used.has(c)) return c;
    }
    return MULTI_CORNER_ORDER[activeFloatings.size % MULTI_CORNER_ORDER.length];
  }

  function promotePrimaryOverlayIds() {
    if (document.getElementById("ghostpip-controller")) return;
    activeFloatings.values().next().value?.promoteToPrimary?.();
  }

  function enterFloating(
    { video, ratioFallback = 9 / 16, isRemote = false, chatUrl = null, sourceTabId = null, initialSubtitle = "" },
    leave,
  ) {
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
      focusSource: () => send({ type: "FOCUS_SOURCE_TAB", sourceTabId }),
      toggleWebChat: () => {
        if (!resolveChatUrl()) return;
        webChatOpen = !webChatOpen;
        if (activeFloatings.size <= 1) {
          persistLayout({
            width: floatWidth,
            height: floatHeight,
            aspectRatio: savedAspectRatio,
            pos: customPos,
            chatOpen: webChatOpen,
          });
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

    const overlays = createFloatingOverlays({
      ctrlId,
      chatId,
      subId,
      isRemote,
      testHooks: ctx.testHooks,
      canShow: canShowOverlays,
      onAction: (act) => instanceActions[act]?.(),
    });
    const { controller, webChat, subtitleHost, skipAdBtn, webChatFrame, webChatResize } = overlays;

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
      persistLayout(activeFloatings.size <= 1 ? { pos: customPos, chatHeight } : { chatHeight });
      render();
    };
    webChatResize.addEventListener("pointerup", endChatResize, on);
    webChatResize.addEventListener("pointercancel", endChatResize, on);

    let toastText = "";
    let toastTimer = null;
    const effectiveClickThrough = () => Boolean(ctx.settings.clickThrough || ctx.settings.peek?.enabled);

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
      const peekOn = Boolean(ctx.settings.peek?.enabled);
      const peeking = isPeeking();
      const interactive = isInteractive();
      const hovered =
        drag !== null ||
        (cursor !== null && cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
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
      renderFloatingOverlays(overlays, {
        video,
        r,
        b,
        w,
        hPx,
        webChatOpen,
        peekHidden: peekOn && !peeking,
        idleOpacity: ctx.settings.peek?.idleOpacity ?? 0,
        forcePass: effectiveClickThrough(),
        interactive,
        hovered,
        hasSkipAd: isRemote ? Boolean(remoteHasAd) : canSkipAd(video),
        opacity,
        anim,
        dragging: drag !== null,
        chatResizing: chatResize !== null,
        subtitleText,
        toastText,
        settingOpacity: ctx.settings.opacity,
      });
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
      if (isInteractive()) return clearFadeIfActive();
      if (ctx.settings.peek?.enabled && !isPeeking() && ctx.settings.peek.idleOpacity <= 0.05) {
        return clearFadeIfActive();
      }
      const vp = viewport();
      const s = size();
      const r = rect();
      if (!effectiveClickThrough() && cursor !== null) {
        const b = boundsWithChat(r);
        if (
          webChatOpen &&
          b.chatH > 0 &&
          cursor.x >= r.l &&
          cursor.x <= r.r &&
          cursor.y >= b.chatT &&
          cursor.y <= b.chatT + b.chatH
        ) {
          return clearFadeIfActive();
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
        if (cursorInCurrent) return clearFadeIfActive();
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
      active: () => drag !== null,
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
        drag = resizeDir
          ? {
              mode: "resize",
              dir: resizeDir,
              startRect: r,
              startX: e.clientX,
              startY: e.clientY,
              x: r.l,
              y: r.t,
              w: r.r - r.l,
              h: r.b - r.t,
            }
          : {
              mode: "move",
              x: r.l,
              y: r.t,
              w: r.r - r.l,
              h: r.b - r.t,
              dx: e.clientX - r.l,
              dy: e.clientY - r.t,
            };
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
          const next = Protocol.computeResizeRect(
            drag.startRect,
            drag.dir,
            e.clientX - drag.startX,
            e.clientY - drag.startY,
            vp,
          );
          floatWidth = next.w;
          floatHeight = next.h;
          resizedInSession = true;
          drag.x = next.x;
          drag.y = next.y;
          drag.w = next.w;
          drag.h = next.h;
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
        if (wasResize) savedAspectRatio = videoRatio(video, ratioFallback);

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
            persistLayout({ width: floatWidth, height: floatHeight, aspectRatio: savedAspectRatio });
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

    const syncCursorAndHover = (e) => {
      const prevInteractive = isInteractive();
      const prevHovered = controller.host.hasAttribute("data-hovered");
      cursor = { x: e.clientX, y: e.clientY };
      holdFrom(e);
      const b = boundsWithChat(rect());
      const nowHovered =
        drag !== null || (cursor.x >= b.l && cursor.x <= b.r && cursor.y >= b.t && cursor.y <= b.b);
      if (prevInteractive !== isInteractive() || prevHovered !== nowHovered) render();
      tick();
    };

    window.addEventListener(
      "pointermove",
      (e) => {
        dragController.pointerMove(e);
        if (dragController.active()) {
          if (e.isTrusted && (e.buttons & 1) === 0) return dragController.end();
          dragController.move(e);
        }
        if (e.isTrusted) syncCursorAndHover(e);
      },
      { capture: true, ...on },
    );

    const endActiveDrag = () => {
      dragController.pointerUp();
      if (dragController.active()) dragController.end();
    };
    window.addEventListener("pointerup", endActiveDrag, { capture: true, ...on });
    window.addEventListener("pointercancel", endActiveDrag, { capture: true, ...on });

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
        if (rawTarget?.tagName === "IFRAME") return clearCursor();
        syncCursorAndHover(e);
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
      getSourceTabId: () => (Number.isFinite(sourceTabId) ? sourceTabId : ctx.myTabId),
      getCorner: () => corner,
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

  const remoteOverlays = new Map();
  const remoteKeyOf = (msg) => (Number.isFinite(msg?.sourceTabId) ? msg.sourceTabId : "default");

  function closeRemoteOverlay(key) {
    const inst = remoteOverlays.get(key);
    if (!inst) return;
    remoteOverlays.delete(key);
    inst.exit();
  }

  function stopAllRemoteOverlays() {
    for (const key of [...remoteOverlays.keys()]) closeRemoteOverlay(key);
  }

  function upsertRemoteOverlay(msg) {
    if (!ctx.settings.enabled) return null;
    if (Number.isFinite(msg?.sourceTabId) && ctx.myTabId != null && msg.sourceTabId === ctx.myTabId) {
      return null;
    }
    if (!Number.isFinite(msg?.sourceTabId) && current.name === "inTab") return null;
    const key = remoteKeyOf(msg);
    const existing = remoteOverlays.get(key);
    if (existing && existing.video?.isConnected) {
      existing.kick(msg);
      return existing;
    }
    if (existing) closeRemoteOverlay(key);
    const created = Relay.enterRemoteInTab(msg, () => closeRemoteOverlay(key), {
      getLayoutWidth: () => ctx.layout.width,
      enterFloating,
    });
    remoteOverlays.set(key, created);
    return created;
  }

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
    enterFloating,
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
    inTab: (arg, leave) => Relay.enterInTab(arg, leave, pipEnv),
    docPip: (arg, leave) => DocPip.enterDocPip(arg, leave, pipEnv),
    popupPip: (arg, leave) => DocPip.enterPopupPip(arg, leave, pipEnv),
    nativePip: (arg, leave) => DocPip.enterNativePip(arg, leave, pipEnv),
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
      stopAllRemoteOverlays();
      current.settingsChanged?.();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (current.video && !current.video.isConnected) go("idle");
  }

  const hasActiveOverlayOnPage = () => current.name !== "idle" || remoteOverlays.size > 0;

  function preferredSourceTabId() {
    if (current.name !== "idle" && Number.isFinite(ctx.myTabId)) return ctx.myTabId;
    for (const inst of [...remoteOverlays.values()].reverse()) {
      if (Number.isFinite(inst?.sourceTabId)) return inst.sourceTabId;
    }
    return null;
  }

  function notifyPeekChanged() {
    current.peekChanged?.();
    for (const inst of remoteOverlays.values()) inst.peekChanged?.();
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
      stopAllRemoteOverlays();
      if (current.name !== "idle") return go("idle");
    } else if (current.name === "idle") {
      ctx.video = findVideo();
    }
    current.settingsChanged();
    for (const inst of remoteOverlays.values()) inst.settingsChanged?.();
  }

  function applyLayout(stored) {
    const nextLayout = sanitizeLayout(stored);
    const json = JSON.stringify(nextLayout);
    if (json === lastLayoutJson) return;
    lastLayoutJson = json;
    ctx.layout = nextLayout;
    current.layoutChanged?.();
    for (const inst of remoteOverlays.values()) inst.layoutChanged?.();
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
      if (Number.isFinite(msg?.sourceTabId)) closeRemoteOverlay(msg.sourceTabId);
      else stopAllRemoteOverlays();
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
    async MEDIA_HUD(msg) {
      if (msg?.text) remoteOverlays.get(remoteKeyOf(msg))?.showHud?.(msg.text);
      return { ok: true };
    },
  };

  const onRuntimeMessage = (msg, _sender, sendResponse) => {
    const fn = MSG_HANDLERS[msg?.type];
    if (!fn) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

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
      stopAllRemoteOverlays();
      current.exit();
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
