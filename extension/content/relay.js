(() => {
  "use strict";

  const Protocol = globalThis.GhostPiPProtocol;
  const Subtitles = globalThis.GhostPiPSubtitles;
  const OverlayUI = globalThis.GhostPiPOverlayUI;

  const DEFAULT_FLOAT_WIDTH = Protocol?.LAYOUT?.DEFAULT_WIDTH ?? 480;
  const FLOAT_CLASS = OverlayUI?.FLOAT_CLASS ?? "ghostpip-inpage-target";
  const h = OverlayUI.h;
  const boostVideoSdp = Protocol.boostVideoSdp;

  function createMediaSender(video, { onSubtitle, canSkipAd, triggerSkipAd, getChatUrl } = {}) {
    const capCanvas = document.createElement("canvas");
    const capCtx = capCanvas.getContext("2d", { alpha: false });
    let alive = true;
    let senderPort = null;
    let receiversActive = false;
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
        return { type: "FRAME", dataUrl, vw, vh, hasAd: Boolean(canSkipAd?.(video)) };
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
            triggerSkipAd?.(video);
          } else if (msg?.type === "RECEIVERS") {
            receiversActive = Boolean(msg.active);
            if (receiversActive) captureFrame(640);
          }
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (senderPort === port) {
            senderPort = null;
            receiversActive = false;
          }
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
      if (alive && senderPort && receiversActive) captureFrame(640);
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
        chatUrl: getChatUrl?.() ?? null,
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

  function enterRemoteInTab(
    { ratio, vw: initVw, vh: initVh, chatUrl, initialFrame, initialSubtitle = "", sourceTabId = null } = {},
    leave,
    { getLayoutWidth, enterFloating } = {},
  ) {
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
        const pumpRtcVideo = () => {
          if (!alive || rtcVideo !== vid) return;
          if (!document.hidden) drawRtcFrame();
          vid.requestVideoFrameCallback?.(pumpRtcVideo);
        };
        vid.addEventListener("loadeddata", () => {
          drawRtcFrame();
          vid.requestVideoFrameCallback?.(pumpRtcVideo);
        });
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
      const layoutW = getLayoutWidth?.() || DEFAULT_FLOAT_WIDTH;
      const targetW = Math.round(layoutW * (window.devicePixelRatio || 1) * 1.5);
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
        port.postMessage({ type: "RECEIVER_STATE", visible: !document.hidden, sourceTabId });
        port.postMessage({ type: "RTC_INIT", sourceTabId });
      } catch {}
    }

    if (initialFrame?.dataUrl) {
      handleFrame(initialFrame);
    }
    connectReceiver();
    requestFrame();
    const onVisChange = () => {
      if (receiverPort) {
        try {
          receiverPort.postMessage({ type: "RECEIVER_STATE", visible: !document.hidden, sourceTabId });
        } catch {}
      }
      if (!document.hidden && alive) {
        if (!receiverPort) connectReceiver();
        if (!drawRtcFrame()) requestFrame();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    const renderTick = setInterval(() => {
      if (document.hidden) return;
      if (!rtcActive || performance.now() - lastRtcDrawAt >= 220) {
        if (!drawRtcFrame()) requestFrame();
      }
    }, 250);

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

  function enterInTab(_arg, leave, { ctx, send, enterFloating, canSkipAd, triggerSkipAd, chatUrlFor } = {}) {
    const video = ctx.video;
    const original = {
      popover: video.getAttribute("popover"),
      class: video.hasAttribute("class"),
      style: video.hasAttribute("style"),
    };
    const floating = enterFloating({ video, isRemote: false }, leave);
    const mediaSender = createMediaSender(video, {
      onSubtitle: (text) => floating.setSubtitle(text),
      canSkipAd,
      triggerSkipAd,
      getChatUrl: () => chatUrlFor(ctx.site),
    });
    floating.setSubtitle(mediaSender.getSubtitle());

    function exit() {
      mediaSender.stop();
      send({ type: "INTAB_CLOSED" });
      floating.exit();
      if (original.popover === null) video.removeAttribute("popover");
      else video.setAttribute("popover", original.popover);
      video.classList.remove(FLOAT_CLASS);
      for (const attr of ["data-gp-pass", "data-click-through", "data-gp-peek-outline", "data-gp-drag", "data-gp-anim"]) {
        video.removeAttribute(attr);
      }
      for (const name of OverlayUI.GP_VARS) video.style.removeProperty(name);
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

  globalThis.GhostPiPRelay = Object.freeze({
    boostVideoSdp,
    createMediaSender,
    enterInTab,
    enterRemoteInTab,
  });
})();
