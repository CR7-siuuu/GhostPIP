(() => {
  "use strict";

  const IGNORED_ANCESTOR =
    'button, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="dialog"], [role="listbox"], [role="option"], .ytp-settings-menu, .ytp-panel, [id^="ghostpip-"], .ghostpip-subtitles, .pip-subtitles';

  const PLATFORM_SELECTORS = [
    ".ytp-caption-window-container .caption-visual-line",
    ".ytp-caption-window-container .ytp-caption-segment",
    ".player-timedtext-text-container",
    ".player-timedtext",
    ".dss-hls-subtitle-overlay",
    ".hive-subtitle-renderer-line",
    ".atvwebplayersdk-captions-text",
    ".fgm83k",
    ".vjs-text-track-cue",
    ".jw-text-track-cue",
    ".plyr__caption",
    ".shaka-text-container",
    '[data-testid*="subtitle" i]',
    '[data-testid*="caption" i]',
    '[class*="subtitle-text" i]',
    '[class*="caption-text" i]',
  ];

  const ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  function decodeEntities(raw) {
    return raw.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  }

  function stripCueMarkup(raw) {
    if (typeof raw !== "string" || !raw) return "";
    const withNewlines = raw.replace(/<br\s*\/?>/gi, "\n");
    const noTags = withNewlines.replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "");
    return decodeEntities(noTags);
  }

  function isElementHidden(el) {
    let cur = el;
    for (let depth = 0; cur && cur instanceof Element && depth < 5; depth++, cur = cur.parentElement) {
      if (cur === document.body || cur === document.documentElement) break;
      if (cur.hidden) return true;
      const cs = getComputedStyle(cur);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.01) return true;
    }
    return false;
  }

  function isValidSubtitleNode(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest?.(IGNORED_ANCESTOR)) return false;
    return !isElementHidden(el);
  }

  function collectLeafText(node, chunks) {
    if (!node) return;
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (tag === "BR") {
      chunks.push("\n");
      return;
    }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "BUTTON" || tag === "RT" || tag === "RP") return;
    if (el.hidden) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.01) return;
    const isBlock = tag === "DIV" || tag === "P";
    if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1].endsWith("\n")) {
      chunks.push("\n");
    }
    for (let child = el.firstChild; child; child = child.nextSibling) {
      collectLeafText(child, chunks);
    }
    if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1].endsWith("\n")) {
      chunks.push("\n");
    }
  }

  function normalizeLines(rawLines) {
    const out = [];
    for (const raw of rawLines) {
      if (typeof raw !== "string" || !raw) continue;
      for (const part of raw.split(/\r?\n/)) {
        const cleaned = part.replace(/\s+/g, " ").trim();
        if (!cleaned) continue;
        if (out[out.length - 1] !== cleaned) out.push(cleaned);
        if (out.length >= 4) return out.join("\n");
      }
    }
    return out.join("\n");
  }

  function readDomSubtitles() {
    for (const sel of PLATFORM_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      if (!nodes.length) continue;
      const valid = [];
      for (const el of nodes) {
        if (isValidSubtitleNode(el)) valid.push(el);
      }
      if (!valid.length) continue;
      const topLevel = valid.filter((el) => !valid.some((other) => other !== el && other.contains(el)));
      const lines = [];
      for (const el of topLevel) {
        const chunks = [];
        collectLeafText(el, chunks);
        const text = chunks.join("");
        if (text.trim()) lines.push(text);
      }
      const normalized = normalizeLines(lines);
      if (normalized) return normalized;
    }
    return "";
  }

  function isCaptionTrack(track) {
    if (!track) return false;
    const kind = track.kind || "";
    return kind === "subtitles" || kind === "captions" || (kind !== "metadata" && kind !== "chapters");
  }

  function observe(getVideoInput, onSubtitle) {
    const resolveVideo = typeof getVideoInput === "function" ? getVideoInput : () => getVideoInput;
    const emit = typeof onSubtitle === "function" ? onSubtitle : () => {};
    const suppressedTracks = new Set();
    const listenedTracks = new Set();
    let boundTrackList = null;
    let currentText = "";
    let stopped = false;
    let throttleTimer = null;

    function syncTracks(video) {
      const list = video?.textTracks;
      if (!list) return [];
      if (boundTrackList !== list) {
        if (boundTrackList) {
          try {
            boundTrackList.removeEventListener("change", scheduleCheck);
            boundTrackList.removeEventListener("addtrack", scheduleCheck);
          } catch {}
        }
        boundTrackList = list;
        try {
          list.addEventListener("change", scheduleCheck);
          list.addEventListener("addtrack", scheduleCheck);
        } catch {}
      }
      const active = [];
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (!isCaptionTrack(track)) continue;
        if (!listenedTracks.has(track)) {
          listenedTracks.add(track);
          try {
            track.addEventListener("cuechange", scheduleCheck);
          } catch {}
        }
        if (track.mode === "showing") {
          suppressedTracks.add(track);
          try {
            track.mode = "hidden";
          } catch {}
          active.push(track);
        } else if (suppressedTracks.has(track)) {
          if (track.mode === "hidden") active.push(track);
          else suppressedTracks.delete(track);
        }
      }
      return active;
    }

    function readTrackSubtitles(tracks) {
      const lines = [];
      for (const track of tracks) {
        const cues = track.activeCues;
        if (!cues || !cues.length) continue;
        for (let i = 0; i < cues.length; i++) {
          const cue = cues[i];
          const text = stripCueMarkup(cue?.text || "");
          if (text) lines.push(text);
        }
      }
      return normalizeLines(lines);
    }

    function check() {
      if (stopped) return;
      throttleTimer = null;
      const video = resolveVideo();
      const tracks = syncTracks(video);
      let nextText = readDomSubtitles();
      if (!nextText && tracks.length) {
        nextText = readTrackSubtitles(tracks);
      }
      if (nextText !== currentText) {
        currentText = nextText;
        emit(currentText);
      }
    }

    function scheduleCheck() {
      if (stopped || throttleTimer !== null) return;
      throttleTimer = setTimeout(check, 60);
    }

    const mutObs = new MutationObserver(scheduleCheck);
    const rootTarget = document.body || document.documentElement;
    if (rootTarget) {
      mutObs.observe(rootTarget, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    }

    const pollTimer = setInterval(check, 200);
    check();

    return {
      refresh() {
        check();
        return currentText;
      },
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(throttleTimer);
        throttleTimer = null;
        clearInterval(pollTimer);
        mutObs.disconnect();
        if (boundTrackList) {
          try {
            boundTrackList.removeEventListener("change", scheduleCheck);
            boundTrackList.removeEventListener("addtrack", scheduleCheck);
          } catch {}
          boundTrackList = null;
        }
        for (const track of listenedTracks) {
          try {
            track.removeEventListener("cuechange", scheduleCheck);
          } catch {}
        }
        listenedTracks.clear();
        for (const track of suppressedTracks) {
          try {
            if (track.mode === "hidden") track.mode = "showing";
          } catch {}
        }
        suppressedTracks.clear();
      },
    };
  }

  globalThis.GhostPiPSubtitles = Object.freeze({ observe });
})();
