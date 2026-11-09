(() => {
  "use strict";

  const SKIP_WORD = /건너뛰기|스킵|skip/i;
  const AD_WORD = /광고|스폰서|\bads?\b|advert|sponsor/i;
  // Skip buttons for show content (intro, recap, next episode) share the "skip" wording with ad buttons.
  const CONTENT_SKIP = /오프닝|인트로|엔딩|요약|줄거리|다음\s*(화|회|편|에피소드)|이전\s*(화|회)|intro|opening|recap|credits|outro|ending|next\s*episode|previously/i;
  const MAX_LABEL_LEN = 40;

  const normalize = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

  function isContentSkipLabel(text) {
    return CONTENT_SKIP.test(normalize(text));
  }

  function isAdSkipLabel(text) {
    const t = normalize(text);
    if (!t || t.length > MAX_LABEL_LEN || CONTENT_SKIP.test(t)) return false;
    return SKIP_WORD.test(t) && AD_WORD.test(t);
  }

  // GIF-style clips (X/Reddit/Imgur "gifv", hero backgrounds) are silent and loop or end quickly;
  // real playback either decodes audio, is live, or runs long enough to be worth floating.
  function isGifLike(v) {
    if (v.webkitAudioDecodedByteCount > 0 || v.audioTracks?.length > 0) return false;
    if (v.loop) return true;
    const d = v.duration;
    if (Number.isFinite(d) && d > 0 && d < 30) return true;
    return Boolean(v.muted && !v.controls && !v.paused && v.currentTime > 1.5);
  }

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
      if (!isVisibleElement(el)) continue;
      const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (isContentSkipLabel(label)) continue;
      return el;
    }
    const container =
      video?.closest?.(
        "#movie_player, .html5-video-player, .pzp, [class*='live_player'], #livePlayer, .video_box, [class*='video-player']",
      ) || video?.parentElement?.parentElement;
    if (container) {
      for (const btn of container.querySelectorAll("button, [role='button']")) {
        if (!isVisibleElement(btn)) continue;
        const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.trim();
        if (isAdSkipLabel(text)) return btn;
      }
    }
    return null;
  }

  let adCheckCache = { video: null, at: -Infinity, value: false };
  function canSkipAd(video, force = false) {
    const now = performance.now();
    if (!force && adCheckCache.video === video && now - adCheckCache.at < 400) {
      return adCheckCache.value;
    }
    const value =
      Boolean(findSkipAdElement(video)) ||
      Boolean(
        document.querySelector(
          "#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing, .ytp-ad-player-overlay, .ytp-ad-player-overlay-layout",
        ),
      );
    adCheckCache = { video, at: now, value };
    return value;
  }

  function triggerSkipAd(video) {
    adCheckCache.at = -Infinity;
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
    if (
      video &&
      (btn ||
        document.querySelector(
          "#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing",
        )) &&
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      video.duration < 600
    ) {
      try {
        video.currentTime = video.duration;
      } catch {}
    }
    adCheckCache.at = -Infinity;
  }

  function hasYouTubeLiveChat(testHooks = false) {
    if (testHooks && document.documentElement.hasAttribute("data-gp-force-chat")) return true;
    const chatEl = document.querySelector("ytd-live-chat-frame:not([hidden]), #chat:not([hidden]) iframe#chatframe");
    if (chatEl && !chatEl.closest("[hidden]")) return true;
    const liveBadge = document.querySelector(".ytp-live-badge:not([disabled])");
    return isVisibleElement(liveBadge);
  }

  globalThis.GhostPiPHeuristics = Object.freeze({
    isAdSkipLabel,
    isAdSkipText: isAdSkipLabel,
    isContentSkipLabel,
    isGifLike,
    isVisibleElement,
    findSkipAdElement,
    canSkipAd,
    triggerSkipAd,
    hasYouTubeLiveChat,
  });
})();
