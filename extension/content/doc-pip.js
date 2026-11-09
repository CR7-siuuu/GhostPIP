(() => {
  "use strict";

  const Protocol = globalThis.GhostPiPProtocol;
  const Settings = globalThis.GhostPiPSettings;
  const Subtitles = globalThis.GhostPiPSubtitles;
  const OverlayUI = globalThis.GhostPiPOverlayUI;
  const Relay = globalThis.GhostPiPRelay;

  const {
    DEFAULT_WIDTH: DEFAULT_FLOAT_WIDTH,
    MIN_WIDTH: MIN_FLOAT_WIDTH,
    MAX_WIDTH: MAX_FLOAT_WIDTH,
    MIN_HEIGHT: MIN_FLOAT_HEIGHT,
    MAX_HEIGHT: MAX_FLOAT_HEIGHT,
    MIN_CHAT_HEIGHT,
    PIP_CHAT_HEIGHT,
    CHAT_SIZE_STEP,
    WHEEL_OPACITY_STEP,
  } = Protocol.LAYOUT;

  const {
    DOCPIP_SOURCE_CLASS,
    RESIZE_DIRS,
    ICON_CHAT,
    PIP_CSS,
    t,
    svgIcon,
  } = OverlayUI;

  const HOLD = Settings.HOLD_MATCH;
  const resizeDocPipWindow = Protocol.resizePipWindow;

  function buildPipDocument(
    win,
    stream,
    chatUrl,
    showChat,
    { ctx, persistLayout, onClosePip, onToggleChat, onResizeChat, onSkipAd, isClickThrough, isHoldEvent } = {},
  ) {
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
      chatBtn.append(svgIcon(ICON_CHAT, doc), chatLabel);
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
    let chatH = Number.isFinite(ctx?.layout?.pipChatHeight) ? ctx.layout.pipChatHeight : PIP_CHAT_HEIGHT;
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
      persistLayout?.({ pipChatHeight: chatH });
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
        persistLayout?.({ pipChatHeight: chatH });
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
        const startedOnBottomEdge = Protocol.isBottomEdgeChatResize({
          chatShown,
          frameConnected: Boolean(frame?.isConnected),
          pointerAgeMs: now - lastPointerAt,
          pointerX: lastPointerX,
          pointerY: lastPointerY,
          prevW,
          prevH,
          dw,
          dh,
        });
        resizeMode = startedOnBottomEdge ? "chat" : "window";
        if (startedOnBottomEdge) {
          lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, prevH - activeChatH);
        }
      } else if (Math.abs(dw) >= 1 && resizeMode === "chat") {
        resizeMode = "window";
        chatH = gestureStartChatH;
        applyChatH(chatH);
        persistLayout?.({ pipChatHeight: chatH });
      }

      if (resizeMode === "chat" && chatShown && frame?.isConnected) {
        chatH = Math.max(MIN_CHAT_HEIGHT, win.innerHeight - lockedVideoH);
        applyChatH(chatH);
        persistLayout?.({ pipChatHeight: chatH });
        return;
      }

      // Window resizes never touch the chat height; the video takes all of the change.
      lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, win.innerHeight - (chatShown && frame?.isConnected ? activeChatH : 0));
      if (win.innerWidth >= MIN_FLOAT_WIDTH && win.innerWidth <= MAX_FLOAT_WIDTH) {
        clearTimeout(persistWidthTimer);
        persistWidthTimer = setTimeout(() => {
          if (!win.closed && win.innerWidth >= MIN_FLOAT_WIDTH && win.innerWidth <= MAX_FLOAT_WIDTH) {
            persistLayout?.({ pipWidth: Math.round(win.innerWidth) });
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
                !(ctx?.testHooks && document.documentElement.hasAttribute("data-gp-force-chat")) &&
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

  function enterDocPip({ stream: firstStream, chatUrl, win: winPromise }, leave, env) {
    const {
      ctx,
      send,
      persistLayout,
      stepOpacity,
      isPeeking,
      canSkipAd,
      triggerSkipAd,
      attachPeekAndShortcutListeners,
    } = env;
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
        ctx,
        persistLayout,
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
      attachPeekAndShortcutListeners(w, ac.signal, ctx.myTabId, {
        onHoldKey: (hovered) => setHovered?.(hovered),
      });
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
            if (Protocol.moveWindowWithinScreen(w, ctx.layout.pipPos)) {
              lastRectPos = { x: w.screenX, y: w.screenY };
            }
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

  function enterPopupPip({ width, height, ratio, chatUrl, showChat }, leave, env) {
    const { ctx, send, canSkipAd, triggerSkipAd, chatUrlFor } = env;
    const video = ctx.video;
    const originalHasClass = video.hasAttribute("class");
    video.classList.add(DOCPIP_SOURCE_CLASS);
    let closed = false;
    const mediaSender = Relay.createMediaSender(video, {
      canSkipAd,
      triggerSkipAd,
      getChatUrl: () => chatUrlFor(ctx.site),
    });

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

  function enterNativePip(request, leave, env) {
    const { ctx, send, videoRatio } = env;
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

  // DRM or an uncapturable element falls back to native PiP. Both checks are synchronous so the
  // click's user activation is still unspent when requestWindow/requestPictureInPicture runs.
  function startPip({ ctx, go, chatUrlFor, floatSize, videoRatio }) {
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

  globalThis.GhostPiPDocPip = Object.freeze({
    resizeDocPipWindow,
    buildPipDocument,
    enterDocPip,
    enterPopupPip,
    enterNativePip,
    startPip,
  });
})();
