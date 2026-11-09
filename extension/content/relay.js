(() => {
  "use strict";

  const Protocol = globalThis.GhostPiPProtocol;
  const Subtitles = globalThis.GhostPiPSubtitles;
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

  globalThis.GhostPiPRelay = Object.freeze({
    boostVideoSdp,
    createMediaSender,
  });
})();
