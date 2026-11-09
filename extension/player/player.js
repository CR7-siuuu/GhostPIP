(() => {
  "use strict";

  const Settings = globalThis.GhostPiPSettings;
  const Protocol = globalThis.GhostPiPProtocol;
  const { t, apply: applyI18n } = globalThis.GhostPiPI18n;
  applyI18n();

  const {
    MIN_WIDTH: MIN_FLOAT_WIDTH,
    MAX_WIDTH: MAX_FLOAT_WIDTH,
    MIN_HEIGHT: MIN_FLOAT_HEIGHT,
    MAX_HEIGHT: MAX_FLOAT_HEIGHT,
    PIP_CHAT_HEIGHT,
    MIN_CHAT_HEIGHT,
    CHAT_SIZE_STEP,
    WHEEL_OPACITY_STEP,
  } = Protocol.LAYOUT;
  const RESIZE_DIRS = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_CHAT =
    "M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12h2.2v2.1a.5.5 0 0 0 .82.38L8.4 12h5.1A1.5 1.5 0 0 0 15 10.5v-7A1.5 1.5 0 0 0 13.5 2h-11Zm2 3.2h7a.6.6 0 1 1 0 1.2h-7a.6.6 0 0 1 0-1.2Zm0 2.6h4.5a.6.6 0 1 1 0 1.2H4.5a.6.6 0 0 1 0-1.2Z";
  const HOLD = Settings.HOLD_MATCH;
  const PEEK_MATCH = Settings.PEEK_MATCH;
  const peekInput = Settings.createPeekInput();
  let localPeekActive = false;
  let enginePeekActive = false;

  const params = new URLSearchParams(location.search);
  const sourceTabId = Number(params.get("sourceTabId"));
  const chatUrl = params.get("chatUrl") || null;
  const initialShowChat = params.get("showChat") === "1";
  const targetInitW = Number(params.get("w")) || 480;
  const targetInitH = Number(params.get("h")) || 270;

  const stage = document.getElementById("pipStage");
  const stageCanvas = document.getElementById("stageCanvas");
  const stageCtx = stageCanvas.getContext("2d", { alpha: false });
  const stageVideo = document.getElementById("stageVideo");
  const pipSubtitles = document.getElementById("pipSubtitles");
  const pipHud = document.getElementById("pipHud");
  const pipSkipAd = document.getElementById("pipSkipAd");
  const pipBar = document.getElementById("pipBar");

  stageCanvas.width = Math.max(1, Math.round(targetInitW));
  stageCanvas.height = Math.max(1, Math.round(targetInitH));

  let settings = Settings.merge(undefined);
  let layout = {};
  let engineConnected = false;
  let hudTimer = null;
  let alive = true;

  function isPeeking() {
    return Boolean(settings.peek?.enabled && (enginePeekActive || localPeekActive));
  }

  function recomputeLocalPeek() {
    const matcher = PEEK_MATCH[settings.peek?.key];
    const next = Boolean(settings.enabled && settings.peek?.enabled && matcher?.(peekInput));
    if (next === localPeekActive) return;
    localPeekActive = next;
    syncPipOpacity(false);
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage({ v: 1, ...msg });
    } catch {
      return null;
    }
  }

  function persistLayout(patch) {
    layout = { ...layout, ...patch };
    send({ type: "PATCH_FLOAT_LAYOUT", patch });
  }

  function svgIcon(d) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  function handleResizeChat(deltaH) {
    if (!engineConnected) {
      Protocol.resizePipWindow(window, deltaH);
      return;
    }
    send({
      type: "PIP_RESIZE",
      deltaH,
      dpr: window.devicePixelRatio || 1,
    }).then((res) => {
      if (!res?.handledByEngine) Protocol.resizePipWindow(window, deltaH);
    });
  }

  function showHudToast(text) {
    if (!text) return;
    if (settings.peek?.enabled && !isPeeking() && settings.peek.idleOpacity === 0) return;
    pipHud.textContent = text;
    pipHud.setAttribute("data-show", "");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => pipHud.removeAttribute("data-show"), 900);
  }

  function syncPipOpacity(showToast = false) {
    let op = 1;
    if (!engineConnected) {
      if (settings.peek?.enabled) {
        op = isPeeking() ? settings.peek.activeOpacity : settings.peek.idleOpacity;
      } else {
        op = settings.opacity;
      }
    }
    const opStr = String(op);
    stageVideo.style.opacity = opStr;
    stageCanvas.style.opacity = opStr;
    if (pipSubtitles) pipSubtitles.style.opacity = opStr;
    if (frame) frame.style.opacity = opStr;
    if (showToast) {
      showHudToast(t("hudOpacity", [String(Math.round(settings.opacity * 100))]));
    }
  }

  function setSubtitle(text) {
    const clean = typeof text === "string" ? text.trim() : "";
    pipSubtitles.textContent = clean;
    pipSubtitles.hidden = !clean;
  }

  pipSkipAd.textContent = t("skipAd");
  pipSkipAd.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "SKIP_AD", sourceTabId });
    pipSkipAd.hidden = true;
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.dataset.action = "closePip";
  closeBtn.textContent = t("btnReturn");
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    alive = false;
    send({ type: "FOCUS_SOURCE_TAB", sourceTabId });
    send({ type: "CLOSE_POPUP_PIP", sourceTabId });
    window.close();
  });
  pipBar.append(closeBtn);

  let chatBtn = null;
  let chatLabel = null;
  const chatSizeBtns = [];
  let frame = null;
  let chatShown = Boolean(initialShowChat && chatUrl);
  let chatH = PIP_CHAT_HEIGHT;
  let activeChatH = chatH;
  let togglingUntil = 0;

  function applyChatH(h = activeChatH) {
    activeChatH = Math.max(MIN_CHAT_HEIGHT, Math.min(MAX_FLOAT_HEIGHT, Math.round(h)));
    document.body.style.setProperty("--gp-chat-h", `${activeChatH}px`);
  }

  let persistChatTimer = null;
  function resizeChatBy(delta) {
    if (!chatShown || !frame?.isConnected) return;
    const cur = Math.round(frame.getBoundingClientRect().height || activeChatH);
    chatH = Math.max(MIN_CHAT_HEIGHT, cur + delta);
    applyChatH(chatH);
    togglingUntil = performance.now() + 600;
    handleResizeChat(chatH - cur);
    clearTimeout(persistChatTimer);
    persistChatTimer = setTimeout(() => {
      const measured = Math.round(frame?.getBoundingClientRect().height || 0);
      if (measured >= MIN_CHAT_HEIGHT) {
        chatH = measured;
        applyChatH(chatH);
      }
      lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, window.innerHeight - activeChatH);
      persistLayout({ pipChatHeight: chatH });
    }, 650);
  }

  if (chatUrl) {
    chatLabel = document.createElement("span");
    chatBtn = document.createElement("button");
    chatBtn.type = "button";
    chatBtn.dataset.action = "toggleChat";
    chatBtn.hidden = !Boolean(initialShowChat && chatUrl);
    chatBtn.append(svgIcon(ICON_CHAT), chatLabel);
    chatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleChatOpen();
    });
    pipBar.append(chatBtn);

    for (const [label, delta, title] of [
      ["−", -CHAT_SIZE_STEP, t("chatSmaller")],
      ["+", CHAT_SIZE_STEP, t("chatBigger")],
    ]) {
      const btn = document.createElement("button");
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

  const handles = RESIZE_DIRS.map((dir) => {
    const el = document.createElement("div");
    el.className = `pip-handle ${dir}`;
    el.dataset.resize = dir;
    return el;
  });
  document.body.append(...handles);

  function syncChat(enabled, resizeWin = false) {
    if (!chatUrl) return;
    const nextShown = Boolean(enabled);
    const changed = nextShown !== chatShown;
    const prevActiveH = activeChatH;
    chatShown = nextShown;
    document.body.toggleAttribute("data-chat-open", nextShown);
    if (chatLabel) chatLabel.textContent = nextShown ? t("chatHide") : t("chatShow");
    if (chatBtn) chatBtn.toggleAttribute("data-active", nextShown);
    for (const btn of chatSizeBtns) btn.hidden = !nextShown;
    if (nextShown) {
      applyChatH(chatH);
      if (!frame) {
        frame = document.createElement("iframe");
        frame.src = chatUrl;
      }
      if (!frame.isConnected) document.body.append(frame);
      syncPipOpacity(false);
    } else if (frame) {
      frame.remove();
    }
    if (resizeWin && changed) {
      togglingUntil = performance.now() + 800;
      handleResizeChat(nextShown ? chatH : -prevActiveH);
    }
  }

  function toggleChatOpen() {
    if (!chatUrl || (chatBtn && chatBtn.hidden)) return;
    syncChat(!chatShown, true);
  }

  let engineHovered = false;
  let pointerHovered = false;
  let lastPointerX = -999;
  let lastPointerY = -999;
  let lastPointerAt = 0;

  function syncHovered() {
    document.body.toggleAttribute("data-hovered", Boolean(engineHovered || pointerHovered));
  }

  function setHovered(hovered) {
    engineHovered = Boolean(hovered);
    if (!engineHovered) pointerHovered = false;
    syncHovered();
  }

  function setClickThrough(enabled) {
    document.body.toggleAttribute("data-click-through", Boolean(enabled));
    if (enabled) pointerHovered = false;
    syncHovered();
  }

  const onPointerHover = (e) => {
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      lastPointerAt = performance.now();
    }
    pointerHovered = Boolean(!settings.clickThrough || HOLD[settings.hotkeys.hold]?.(e));
    syncHovered();
  };
  document.documentElement.addEventListener("pointerenter", onPointerHover);
  document.documentElement.addEventListener("pointermove", onPointerHover);
  document.documentElement.addEventListener("mouseleave", () => {
    pointerHovered = false;
    syncHovered();
  });

  const handleS = handles.find((el) => el.dataset.resize === "s");
  handleS.title = t("chatResizeTitle");
  let chatResize = null;
  let lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, window.innerHeight - (chatShown ? activeChatH : 0));

  handleS.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !chatShown) return;
    e.preventDefault();
    e.stopPropagation();
    const curH = Math.round(frame?.getBoundingClientRect().height || activeChatH);
    lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, Math.round(stage.getBoundingClientRect().height || window.innerHeight - curH));
    chatResize = { startScreenY: e.screenY, startClientY: e.clientY, lastDelta: 0, startH: curH };
    try {
      handleS.setPointerCapture(e.pointerId);
    } catch {}
    document.body.toggleAttribute("data-chat-resizing", true);
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
    handleResizeChat(step);
  });
  const endChatResize = () => {
    if (!chatResize) return;
    chatResize = null;
    togglingUntil = performance.now() + 600;
    document.body.removeAttribute("data-chat-resizing");
    persistLayout({ pipChatHeight: chatH });
  };
  handleS.addEventListener("pointerup", endChatResize);
  handleS.addEventListener("pointercancel", endChatResize);

  let lastW = window.innerWidth;
  let lastH = window.innerHeight;
  let lastResizeAt = 0;
  let resizeMode = "window";
  let gestureStartChatH = chatH;
  let persistWidthTimer = null;
  const openedAt = performance.now();

  window.addEventListener("resize", () => {
    const now = performance.now();
    const prevW = lastW;
    const prevH = lastH;
    const dw = window.innerWidth - prevW;
    const dh = window.innerHeight - prevH;
    lastW = window.innerWidth;
    lastH = window.innerHeight;

    if (chatResize || now < togglingUntil) return;
    if (now - openedAt < 1000) {
      lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, window.innerHeight - (chatShown ? activeChatH : 0));
      return;
    }

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
      persistLayout({ pipChatHeight: chatH });
    }

    if (resizeMode === "chat" && chatShown && frame?.isConnected) {
      chatH = Math.max(MIN_CHAT_HEIGHT, window.innerHeight - lockedVideoH);
      applyChatH(chatH);
      persistLayout({ pipChatHeight: chatH });
      return;
    }

    lockedVideoH = Math.max(MIN_FLOAT_HEIGHT, window.innerHeight - (chatShown && frame?.isConnected ? activeChatH : 0));
    if (window.innerWidth >= MIN_FLOAT_WIDTH && window.innerWidth <= MAX_FLOAT_WIDTH) {
      clearTimeout(persistWidthTimer);
      persistWidthTimer = setTimeout(() => {
        if (window.innerWidth >= MIN_FLOAT_WIDTH && window.innerWidth <= MAX_FLOAT_WIDTH) {
          persistLayout({ pipWidth: Math.round(window.innerWidth) });
        }
      }, 220);
    }
  });

  let opacityTimer = null;
  Settings.bindPeekAndShortcuts(window, {
    peekState: peekInput,
    getSettings: () => settings,
    onPeekInput: recomputeLocalPeek,
    onHoldKey: (h) => setHovered(h),
    onShortcut: (e) => {
      const act = Settings.matchShortcut(e, settings, { engineConnected });
      if (!act) return;
      e.preventDefault();
      send(act.type === "MEDIA_ACTION" ? { ...act, sourceTabId } : act);
    },
    onVisibility: (visible) => {
      if (receiverPort && Number.isFinite(sourceTabId)) {
        try {
          receiverPort.postMessage({ type: "RECEIVER_STATE", visible, sourceTabId });
        } catch {}
      }
    },
  });
  window.addEventListener(
    "wheel",
    (e) => {
      if (
        !engineConnected &&
        settings.enabled &&
        settings.media?.enabled &&
        settings.media.wheelVolume &&
        e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        settings.hotkeys.hold !== "Alt"
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.deltaY) return;
        send({
          type: "MEDIA_ACTION",
          action: "VOLUME",
          deltaVolume: e.deltaY < 0 ? 0.05 : -0.05,
          sourceTabId,
        });
        return;
      }
      const onStage = e.target === stageVideo || e.target === stageCanvas || stage.contains(e.target);
      if (!onStage && !HOLD[settings.hotkeys.hold]?.(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.deltaY) return;
      const delta = e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP;
      const next = Math.round(Math.min(1, Math.max(0.1, settings.opacity + delta)) * 100) / 100;
      if (next !== settings.opacity) {
        settings = { ...settings, opacity: next };
        lastSettingsJson = JSON.stringify(settings);
        clearTimeout(opacityTimer);
        opacityTimer = setTimeout(() => {
          send({ type: "PATCH_SETTINGS", patch: { opacity: settings.opacity } });
        }, 100);
      }
      syncPipOpacity(true);
    },
    { capture: true, passive: false },
  );

  const boostVideoSdp = Protocol.boostVideoSdp;

  let receiverPort = null;
  let rtcPeer = null;
  let rtcReady = false;
  let pulling = false;
  let lastPullAt = 0;
  let pullTimer = null;

  function stopRtc() {
    rtcReady = false;
    if (rtcPeer) {
      try {
        rtcPeer.close();
      } catch {}
      rtcPeer = null;
    }
    stageVideo.srcObject = null;
    stageVideo.hidden = true;
    stageCanvas.hidden = false;
  }

  async function handleRtcOffer(sdp) {
    stopRtc();
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
      pc.ontrack = (e) => {
        stageVideo.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        stageVideo.play().catch(() => {});
      };
      await pc.setRemoteDescription({ type: "offer", sdp: boostVideoSdp(sdp) });
      const answer = await pc.createAnswer();
      const boosted = boostVideoSdp(answer.sdp);
      await pc.setLocalDescription({ type: "answer", sdp: boosted });
      if (rtcPeer === pc && receiverPort) {
        receiverPort.postMessage({ type: "RTC_ANSWER", sdp: boosted, sourceTabId });
      }
    } catch {}
  }

  const promoteRtcVideo = () => {
    if (stageVideo.videoWidth > 0 && stageVideo.readyState >= 2) {
      rtcReady = true;
      stageVideo.hidden = false;
      stageCanvas.hidden = true;
    }
  };
  stageVideo.addEventListener("loadeddata", promoteRtcVideo);
  stageVideo.addEventListener("playing", promoteRtcVideo);

  function requestFrame() {
    if (!alive || rtcReady) return;
    if (!receiverPort) connectReceiver();
    if (!receiverPort) return;
    const now = performance.now();
    if (pulling && now - lastPullAt < 220) return;
    pulling = true;
    lastPullAt = now;
    const targetW = Math.round(Math.max(480, window.innerWidth) * (window.devicePixelRatio || 1) * 1.3);
    try {
      receiverPort.postMessage({ type: "PULL_FRAME", targetW, sourceTabId });
    } catch {
      pulling = false;
    }
  }

  async function handleFrame(msg) {
    if (msg && typeof msg.hasAd === "boolean") {
      pipSkipAd.hidden = !msg.hasAd;
    }
    if (!alive || !msg?.dataUrl || rtcReady) {
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
      if (!alive || rtcReady) {
        bmp.close();
        pulling = false;
        return;
      }
      const vw = msg.vw > 0 ? msg.vw : bmp.width;
      const vh = msg.vh > 0 ? msg.vh : bmp.height;
      if (stageCanvas.width !== vw || stageCanvas.height !== vh) {
        stageCanvas.width = vw;
        stageCanvas.height = vh;
      }
      stageCtx.drawImage(bmp, 0, 0, stageCanvas.width, stageCanvas.height);
      bmp.close();
    } catch {}
    pulling = false;
    if (alive && !rtcReady) {
      clearTimeout(pullTimer);
      pullTimer = setTimeout(requestFrame, 40);
    }
  }

  function connectReceiver() {
    if (!alive || receiverPort || !Number.isFinite(sourceTabId)) return;
    try {
      const portName = `ghostpip-receiver:${sourceTabId}`;
      const port = chrome.runtime.connect({ name: portName });
      receiverPort = port;
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === "FRAME") {
          handleFrame(msg);
        } else if (msg.type === "SUBTITLE") {
          setSubtitle(msg.text);
        } else if (msg.type === "RTC_OFFER" && msg.sdp) {
          handleRtcOffer(msg.sdp);
        } else if (msg.type === "RTC_CANDIDATE" && rtcPeer && msg.candidate) {
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
      port.postMessage({ type: "RECEIVER_STATE", visible: !document.hidden, sourceTabId });
      port.postMessage({ type: "RTC_INIT", sourceTabId });
    } catch {}
  }

  let lastShowChatSetting = true;
  let lastSettingsJson = "";
  function applySettingsState(raw) {
    const merged = Settings.merge(raw);
    const json = JSON.stringify(merged);
    if (json === lastSettingsJson) return;
    lastSettingsJson = json;
    settings = merged;
    if (!settings.enabled) {
      alive = false;
      window.close();
      return;
    }
    if (!settings.peek?.enabled) enginePeekActive = false;
    recomputeLocalPeek();
    setClickThrough(Boolean(settings.clickThrough));
    const showChatPref = Boolean(settings.showChat);
    if (showChatPref !== lastShowChatSetting) {
      lastShowChatSetting = showChatPref;
      if (chatBtn) chatBtn.hidden = !Boolean(showChatPref && chatUrl);
      syncChat(Boolean(showChatPref && chatUrl), true);
    }
    syncPipOpacity(false);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === "PIP_HOVER") {
      setHovered(Boolean(msg.hovered));
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "PIP_TOGGLE_CHAT") {
      toggleChatOpen();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "SETTINGS_CHANGED") {
      if (msg.settings) applySettingsState(msg.settings);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "PEEK_STATE") {
      enginePeekActive = Boolean(msg.active);
      syncPipOpacity(false);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "ENGINE_STATE") {
      engineConnected = Boolean(msg.connected);
      syncPipOpacity(false);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "MEDIA_HUD") {
      if ((!msg.sourceTabId || msg.sourceTabId === sourceTabId) && msg.text) {
        showHudToast(msg.text);
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.engine) {
      engineConnected = Boolean(changes.engine.newValue?.connected);
      syncPipOpacity(false);
      return;
    }
    if (area !== "local") return;
    if (changes.settings) applySettingsState(changes.settings.newValue);
    if (changes.floatLayout && changes.floatLayout.newValue) {
      layout = changes.floatLayout.newValue;
    }
  });

  const readRect = () => ({
    x: window.screenX,
    y: window.screenY,
    w: window.outerWidth,
    h: window.outerHeight,
  });

  let lastKnownPos = null;
  let rectSyncTimer = null;

  Promise.all([chrome.storage.local.get(["settings", "floatLayout"])])
    .then(([{ settings: storedSettings, floatLayout }]) => {
      layout = floatLayout && typeof floatLayout === "object" ? floatLayout : {};
      if (Number.isFinite(layout.pipChatHeight) && layout.pipChatHeight >= MIN_CHAT_HEIGHT) {
        chatH = Math.round(layout.pipChatHeight);
      }
      applyChatH(chatH);
      lastShowChatSetting = Boolean(Settings.merge(storedSettings).showChat);
      syncChat(Boolean(initialShowChat && chatUrl && lastShowChatSetting), false);
      applySettingsState(storedSettings);

      try {
        const frameW = Math.max(0, window.outerWidth - window.innerWidth);
        const frameH = Math.max(0, window.outerHeight - window.innerHeight);
        if (Math.abs(window.innerWidth - targetInitW) > 2 || Math.abs(window.innerHeight - targetInitH) > 2) {
          togglingUntil = performance.now() + 450;
          window.resizeTo(Math.round(targetInitW + frameW), Math.round(targetInitH + frameH));
        }
      } catch {}

      connectReceiver();
      requestFrame();

      setTimeout(() => {
        if (!alive) return;
        const r0 = readRect();
        lastKnownPos = { x: r0.x, y: r0.y };
        send({
          type: "PIP_OPENED",
          kind: "popup",
          sourceTabId,
          rect: r0,
          dpr: window.devicePixelRatio || 1,
        }).then((res) => {
          engineConnected = Boolean(res?.engineConnected);
          if (typeof res?.peekActive === "boolean") {
            enginePeekActive = res.peekActive;
          }
          syncPipOpacity(false);
          if (!engineConnected && !res?.multiPip && Protocol.moveWindowWithinScreen(window, layout?.pipPos)) {
            lastKnownPos = { x: window.screenX, y: window.screenY };
          }
        });

        for (const delay of [400, 900]) {
          setTimeout(() => {
            if (alive && !window.closed) send({ type: "PIP_RECT_UPDATED", rect: readRect() });
          }, delay);
        }

        rectSyncTimer = setInterval(() => {
          if (!alive || window.closed) return;
          if (!rtcReady) requestFrame();
          const cur = readRect();
          send({ type: "PIP_RECT_UPDATED", rect: cur });
          if (
            !engineConnected &&
            performance.now() - openedAt >= 1200 &&
            lastKnownPos &&
            (Math.abs(cur.x - lastKnownPos.x) >= 2 || Math.abs(cur.y - lastKnownPos.y) >= 2)
          ) {
            lastKnownPos = { x: cur.x, y: cur.y };
            persistLayout({ pipPos: { x: Math.round(cur.x), y: Math.round(cur.y) } });
          }
        }, 1200);
      }, 150);
    })
    .catch(() => {});

  window.addEventListener("pagehide", () => {
    alive = false;
    clearInterval(rectSyncTimer);
    stopRtc();
    if (receiverPort) {
      try {
        receiverPort.disconnect();
      } catch {}
      receiverPort = null;
    }
    send({ type: "PIP_CLOSED" });
    send({ type: "CLOSE_POPUP_PIP", sourceTabId });
  });
})();
