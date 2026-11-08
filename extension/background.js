importScripts("shared/settings.js");

const HOST_NAME = "app.ghostpip.engine";
const GENERIC_SITE = { siteId: "generic", site: { video: null, chatPopoutUrl: null } };
const DEFAULT_ENGINE = {
  connected: false,
  installed: false,
  engineVersion: null,
  hotkeyErrors: [],
  protocolMismatch: false,
};

let settingsQueue = Promise.resolve();
let pipQueue = Promise.resolve();
let sitesPromise = null;
let nativePort = null;
let engineAllowed = true;
let engineInstalled = false;
let enginePeekActive = false;

let inTabSeq = 0;
let inTabOrderSeq = 0;
let inTabLoaded = false;
let latestInTabSourceId = null;
const inTabSessions = new Map();
const lastFramesByTab = new Map();
const lastSubtitlesByTab = new Map();
const senderStreamPorts = new Map();
let receiverPortSeq = 0;
const receiverStreamPorts = new Map();

const popupPipBySource = new Map();
const sourceByPopupWindow = new Map();
const sourceByPopupTab = new Map();

function refreshLatestInTabSourceId() {
  let bestId = null;
  let bestOrder = -1;
  for (const [id, s] of inTabSessions.entries()) {
    const ord = s.order ?? 0;
    if (ord >= bestOrder) {
      bestOrder = ord;
      bestId = id;
    }
  }
  latestInTabSourceId = bestId;
  return bestId;
}

async function ensureInTabSessions() {
  if (inTabLoaded) return inTabSessions;
  inTabLoaded = true;
  try {
    const { inTabSessions: storedMap, inTab } = await chrome.storage.session.get(["inTabSessions", "inTab"]);
    if (storedMap && typeof storedMap === "object") {
      for (const s of Object.values(storedMap)) {
        if (s && Number.isFinite(s.sourceTabId)) {
          inTabSessions.set(s.sourceTabId, s);
          inTabSeq = Math.max(inTabSeq, s.connId || 0);
          inTabOrderSeq = Math.max(inTabOrderSeq, s.order || 0);
        }
      }
    } else if (inTab && Number.isFinite(inTab.sourceTabId)) {
      const migrated = { ...inTab, order: ++inTabOrderSeq };
      inTabSessions.set(inTab.sourceTabId, migrated);
      inTabSeq = Math.max(inTabSeq, inTab.connId || 0);
    }
    refreshLatestInTabSourceId();
  } catch {}
  return inTabSessions;
}

async function persistInTabSessions() {
  refreshLatestInTabSourceId();
  if (inTabSessions.size === 0) {
    try {
      await chrome.storage.session.remove?.(["inTabSessions", "inTab"]);
    } catch {}
    return;
  }
  const obj = Object.fromEntries(inTabSessions.entries());
  const latest = latestInTabSourceId != null ? inTabSessions.get(latestInTabSourceId) || null : null;
  await chrome.storage.session.set({ inTabSessions: obj, inTab: latest }).catch(() => {});
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.inTab && !changes.inTab.newValue && !changes.inTabSessions) {
    inTabSessions.clear();
    lastFramesByTab.clear();
    lastSubtitlesByTab.clear();
    latestInTabSourceId = null;
    syncEngineSessionState();
  }
  if (changes.engine) {
    broadcastEngineState(Boolean(changes.engine.newValue?.connected));
  }
});

function sendTab(tabId, msg) {
  if (!Number.isFinite(tabId)) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, { v: 1, ...msg }).catch(() => null);
}

function isNormalWebTab(tab) {
  return Boolean(tab && tab.id != null && !sourceByPopupTab.has(tab.id) && (!tab.url || /^https?:/i.test(tab.url)));
}

function toRemotePayload(session) {
  const srcId = session.sourceTabId;
  return {
    connId: session.connId,
    sourceTabId: srcId,
    ratio: session.ratio || 9 / 16,
    vw: session.vw || 0,
    vh: session.vh || 0,
    chatUrl: session.chatUrl || null,
    initialFrame: lastFramesByTab.get(srcId) || null,
    initialSubtitle: lastSubtitlesByTab.get(srcId) ?? session.subtitle ?? "",
  };
}

function remoteSessionsForTab(tabId) {
  return [...inTabSessions.values()]
    .filter((s) => Number.isFinite(s.sourceTabId) && s.sourceTabId !== tabId)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(toRemotePayload);
}

function syncTabRemoteOverlays(tabId) {
  if (!Number.isFinite(tabId) || sourceByPopupTab.has(tabId)) return Promise.resolve(null);
  const sessions = remoteSessionsForTab(tabId);
  return sendTab(tabId, { type: "REMOTE_INTAB_SYNC", sessions });
}

async function broadcastRemoteStop(excludeTabId = null, sourceTabId = null) {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && t.id !== excludeTabId && !sourceByPopupTab.has(t.id)) {
        const msg = Number.isFinite(sourceTabId)
          ? { type: "REMOTE_INTAB_STOP", sourceTabId }
          : { type: "REMOTE_INTAB_STOP" };
        sendTab(t.id, msg);
      }
    }
  } catch {}
}

function prewarmTab(tabId, session) {
  if (!Number.isFinite(tabId) || !session?.sourceTabId || tabId === session.sourceTabId || sourceByPopupTab.has(tabId)) {
    return Promise.resolve(null);
  }
  return sendTab(tabId, {
    type: "REMOTE_INTAB_START",
    ...toRemotePayload(session),
  });
}

async function prewarmRemoteTabs(session) {
  if (!session?.sourceTabId || !chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (isNormalWebTab(t) && t.id !== session.sourceTabId) {
        prewarmTab(t.id, session);
      }
    }
  } catch {}
}

async function syncActiveTab(activeTabId, windowId = null) {
  if (!Number.isFinite(activeTabId) || sourceByPopupTab.has(activeTabId)) return;
  if (windowId != null && sourceByPopupWindow.has(windowId)) return;
  const playerPrefix = chrome.runtime.getURL("player/");
  const activeTabInfo = await chrome.tabs?.get?.(activeTabId).catch(() => null);
  if (
    activeTabInfo &&
    (sourceByPopupWindow.has(activeTabInfo.windowId) ||
      activeTabInfo.url?.startsWith(playerPrefix) ||
      activeTabInfo.pendingUrl?.startsWith(playerPrefix))
  ) {
    return;
  }
  await ensureInTabSessions();
  if (inTabSessions.size === 0) return;

  const remoteList = [...inTabSessions.values()].filter((s) => s.sourceTabId !== activeTabId);
  if (remoteList.length === 0) {
    sendTab(activeTabId, { type: "REMOTE_INTAB_SYNC", sessions: [] });
    return;
  }

  for (const s of remoteList) {
    s.connId = ++inTabSeq;
  }
  await persistInTabSessions();

  const immediateStart = syncTabRemoteOverlays(activeTabId);

  let updatedAny = false;
  await Promise.all(
    remoteList.map(async (s) => {
      const info = await sendTab(s.sourceTabId, { type: "INTAB_QUERY_SOURCE" });
      const live = inTabSessions.get(s.sourceTabId);
      if (!info?.ok || !live) return;
      if (info.ratio) live.ratio = info.ratio;
      if (info.vw > 0 && info.vh > 0) {
        live.vw = info.vw;
        live.vh = info.vh;
      }
      if (info.chatUrl !== undefined) live.chatUrl = info.chatUrl;
      if (typeof info.subtitle === "string") {
        live.subtitle = info.subtitle;
        lastSubtitlesByTab.set(s.sourceTabId, info.subtitle);
      }
      if (info.frame?.dataUrl) {
        lastFramesByTab.set(s.sourceTabId, { ...info.frame, sourceTabId: s.sourceTabId });
      }
      updatedAny = true;
    }),
  );

  if (updatedAny) await persistInTabSessions();
  const started = await immediateStart;
  if (!started?.ok || updatedAny) {
    await syncTabRemoteOverlays(activeTabId);
  }
}

function parseReceiverSourceId(portName) {
  if (typeof portName !== "string" || !portName.startsWith("ghostpip-receiver:")) return null;
  const n = Number(portName.slice("ghostpip-receiver:".length));
  return Number.isFinite(n) ? n : null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ghostpip-sender") {
    const sourceTabId = port.sender?.tab?.id;
    if (!Number.isFinite(sourceTabId)) return;
    senderStreamPorts.set(sourceTabId, port);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      const taggedOut = { ...msg, sourceTabId };
      if (msg.type === "FRAME" && msg.dataUrl) {
        lastFramesByTab.set(sourceTabId, taggedOut);
        const sess = inTabSessions.get(sourceTabId);
        if (sess && msg.vw > 0 && msg.vh > 0) {
          sess.vw = msg.vw;
          sess.vh = msg.vh;
          sess.ratio = msg.vh / msg.vw;
        }
      } else if (msg.type === "SUBTITLE") {
        const text = typeof msg.text === "string" ? msg.text : "";
        lastSubtitlesByTab.set(sourceTabId, text);
        const sess = inTabSessions.get(sourceTabId);
        if (sess) sess.subtitle = text;
      }
      if (msg.portId && receiverStreamPorts.has(msg.portId)) {
        try {
          receiverStreamPorts.get(msg.portId).port.postMessage(taggedOut);
        } catch {}
        return;
      }
      const fallbackId = refreshLatestInTabSourceId();
      for (const rp of receiverStreamPorts.values()) {
        if (rp.sourceTabId === sourceTabId || (rp.sourceTabId == null && fallbackId === sourceTabId)) {
          try {
            rp.port.postMessage(taggedOut);
          } catch {}
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (senderStreamPorts.get(sourceTabId) === port) {
        senderStreamPorts.delete(sourceTabId);
      }
    });
  } else if (port.name === "ghostpip-receiver" || port.name?.startsWith("ghostpip-receiver:")) {
    const portId = ++receiverPortSeq;
    const parsedSrcId = parseReceiverSourceId(port.name);
    const entry = {
      port,
      sourceTabId: parsedSrcId,
    };
    receiverStreamPorts.set(portId, entry);
    const receiverTabId = port.sender?.tab?.id;
    if (
      Number.isFinite(parsedSrcId) &&
      Number.isFinite(receiverTabId) &&
      port.sender?.url?.startsWith(chrome.runtime.getURL("player/"))
    ) {
      sourceByPopupTab.set(receiverTabId, parsedSrcId);
      const popupInfo = popupPipBySource.get(parsedSrcId);
      if (popupInfo && popupInfo.popupTabId == null) popupInfo.popupTabId = receiverTabId;
    }

    const sendInitialSnapshot = (srcId) => {
      if (!Number.isFinite(srcId)) return;
      const cachedFrame = lastFramesByTab.get(srcId);
      if (cachedFrame) {
        try {
          port.postMessage(cachedFrame);
        } catch {}
      }
      const cachedSub = lastSubtitlesByTab.get(srcId);
      if (cachedSub) {
        try {
          port.postMessage({ type: "SUBTITLE", text: cachedSub, sourceTabId: srcId });
        } catch {}
      }
    };

    const initialTarget = entry.sourceTabId ?? refreshLatestInTabSourceId();
    if (Number.isFinite(initialTarget)) sendInitialSnapshot(initialTarget);

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (Number.isFinite(msg.sourceTabId) && entry.sourceTabId !== msg.sourceTabId) {
        entry.sourceTabId = msg.sourceTabId;
        sendInitialSnapshot(entry.sourceTabId);
      }
      const targetSrcId = entry.sourceTabId ?? refreshLatestInTabSourceId();
      if (Number.isFinite(targetSrcId) && entry.sourceTabId == null) {
        entry.sourceTabId = targetSrcId;
      }
      const tagged = { ...msg, portId, sourceTabId: targetSrcId };
      const senderPort = Number.isFinite(targetSrcId) ? senderStreamPorts.get(targetSrcId) : null;
      if (senderPort) {
        try {
          senderPort.postMessage(tagged);
        } catch {}
      } else if (Number.isFinite(targetSrcId)) {
        sendTab(targetSrcId, { type: "INTAB_RECONNECT_SENDER" });
      } else {
        ensureInTabSessions().then(() => {
          const recovered = entry.sourceTabId ?? refreshLatestInTabSourceId();
          if (Number.isFinite(recovered)) {
            entry.sourceTabId = recovered;
            sendTab(recovered, { type: "INTAB_RECONNECT_SENDER" });
          }
        });
      }
    });
    port.onDisconnect.addListener(() => {
      receiverStreamPorts.delete(portId);
      const targetSrcId = entry.sourceTabId ?? refreshLatestInTabSourceId();
      const senderPort = Number.isFinite(targetSrcId) ? senderStreamPorts.get(targetSrcId) : null;
      if (senderPort) {
        try {
          senderPort.postMessage({ type: "RTC_CLOSE", portId });
        } catch {}
      }
    });
  }
});

function postToEngine(msg) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

async function syncEngineSessionState(pipOverride = null) {
  if (!nativePort) return;
  const [pip] = await Promise.all([
    pipOverride
      ? Promise.resolve(pipOverride)
      : chrome.storage.session
          .get("pip")
          .then((r) => r?.pip || {})
          .catch(() => ({})),
    ensureInTabSessions(),
  ]);
  postToEngine({
    v: 1,
    type: "SESSION_STATE",
    active: Object.keys(pip || {}).length > 0 || inTabSessions.size > 0,
  });
}

async function broadcastPeekState(active) {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) {
        sendTab(t.id, { type: "PEEK_STATE", active: Boolean(active) });
      }
    }
  } catch {}
}

async function broadcastEngineState(connected) {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) {
        sendTab(t.id, { type: "ENGINE_STATE", connected: Boolean(connected) });
      }
    }
  } catch {}
}

async function broadcastSettings(settings) {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) {
        sendTab(t.id, { type: "SETTINGS_CHANGED", settings });
      }
    }
  } catch {}
}

function getDocPipStatus(pip) {
  const docEntry = Object.values(pip || {}).find((e) => e && e.kind === "document");
  return {
    hasActiveDocPip: Boolean(docEntry),
    docPipTabId: docEntry ? (docEntry.sourceTabId ?? docEntry.tabId) : null,
  };
}

async function broadcastPipSessionsChanged(pip) {
  if (!chrome.tabs?.query) return;
  const status = getDocPipStatus(pip);
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && !sourceByPopupTab.has(t.id)) {
        sendTab(t.id, { type: "PIP_SESSIONS_CHANGED", ...status });
      }
    }
  } catch {}
}

function buildPipOpenedEngineMsg(saved, pip, pipBounds) {
  const payload = {
    v: 1,
    type: "PIP_OPENED",
    tabId: saved.tabId,
    kind: saved.kind,
    rect: saved.rect,
    dpr: saved.dpr,
  };
  const activeCount = Object.keys(pip || {}).length;
  if (
    pipBounds &&
    typeof pipBounds === "object" &&
    Number.isFinite(pipBounds.x) &&
    Number.isFinite(pipBounds.y) &&
    activeCount === 1
  ) {
    if (saved.kind === "native") {
      payload.savedBounds = {
        x: pipBounds.x,
        y: pipBounds.y,
        w: pipBounds.kind === "native" && Number.isFinite(pipBounds.w) ? pipBounds.w : 0,
        h: pipBounds.kind === "native" && Number.isFinite(pipBounds.h) ? pipBounds.h : 0,
      };
    } else if (saved.kind === "document" || saved.kind === "popup") {
      payload.savedBounds = {
        x: pipBounds.x,
        y: pipBounds.y,
        w: 0,
        h: 0,
      };
    }
  }
  return payload;
}

function updateSettings(mutator) {
  const run = settingsQueue.then(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    const current = GhostPiPSettings.merge(settings);
    const res = mutator(current);
    if (res.ok) {
      await chrome.storage.local.set({ settings: res.settings });
      if (res.settings.enabled && !nativePort) connectEngine();
      postToEngine({ v: 1, type: "STATE", settings: res.settings });
      if ((current.peek.enabled || enginePeekActive) && (!res.settings.enabled || !res.settings.peek.enabled)) {
        enginePeekActive = false;
        broadcastPeekState(false);
      }
      broadcastSettings(res.settings);
    }
    return res;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

function updatePipEntry(tabId, mutator) {
  const run = pipQueue.then(async () => {
    const { pip = {} } = await chrome.storage.session.get("pip");
    const prev = pip[tabId];
    const next = mutator(prev);
    const prevDocId = getDocPipStatus(pip).docPipTabId;
    if (next) pip[tabId] = next;
    else delete pip[tabId];
    await chrome.storage.session.set({ pip });
    const nextDocId = getDocPipStatus(pip).docPipTabId;
    if (prevDocId !== nextDocId) {
      broadcastPipSessionsChanged(pip);
    }
    return { saved: next, pip };
  });
  pipQueue = run.catch(() => {});
  return run;
}

function pipChanged(tabId, entry) {
  const run = updatePipEntry(tabId, () => entry).then(async ({ saved, pip }) => {
    if (!nativePort) connectEngine();
    if (saved) {
      const { pipBounds } = await chrome.storage.local.get("pipBounds").catch(() => ({}));
      postToEngine(buildPipOpenedEngineMsg(saved, pip, pipBounds));
    } else {
      postToEngine({ v: 1, type: "PIP_CLOSED", tabId });
    }
    await syncEngineSessionState(pip);
    return { saved, pip };
  });
  return run;
}

async function closePopupPipForSource(sourceTabId, { notifySource = false } = {}) {
  const info = popupPipBySource.get(sourceTabId);
  if (!info) return;
  popupPipBySource.delete(sourceTabId);
  if (info.popupWindowId != null) sourceByPopupWindow.delete(info.popupWindowId);
  if (info.popupTabId != null) {
    sourceByPopupTab.delete(info.popupTabId);
    await pipChanged(info.popupTabId, null);
  }
  if (info.popupWindowId != null) {
    await chrome.windows?.remove?.(info.popupWindowId).catch(() => {});
  }
  if (notifySource) {
    sendTab(sourceTabId, { type: "POPUP_PIP_CLOSED" });
  }
}

async function closeAllPopupPips() {
  const sources = [...popupPipBySource.keys()];
  for (const srcId of sources) {
    await closePopupPipForSource(srcId, { notifySource: true });
  }
}

function onEngineMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "HELLO": {
      if (nativePort) nativePort.__gotHello = true;
      engineInstalled = true;
      chrome.storage.local.set({ engineInstalled: true }).catch(() => {});
      const engine = {
        connected: true,
        installed: true,
        engineVersion: typeof msg.engineVersion === "string" ? msg.engineVersion : null,
        hotkeyErrors: Array.isArray(msg.hotkeyErrors) ? msg.hotkeyErrors.map(String) : [],
        protocolMismatch: msg.v !== 1,
      };
      chrome.storage.session.set({ engine });
      broadcastEngineState(true);
      break;
    }
    case "INTENT": {
      if (msg.intent === "SET_HOME" && typeof msg.corner === "string") {
        updateSettings((s) => GhostPiPSettings.patch(s, { dodge: { home: msg.corner } }));
      } else if (msg.intent === "SET_OPACITY" && Number.isFinite(msg.opacity)) {
        updateSettings((s) => GhostPiPSettings.patch(s, { opacity: msg.opacity }));
      } else if (msg.intent === "TOGGLE_PIP_CHAT") {
        chrome.storage.session
          .get("pip")
          .then(({ pip = {} }) => {
            const ids = Object.keys(pip).map(Number).filter(Number.isFinite);
            if (ids.length) {
              const targetId = Number.isFinite(msg.tabId) && pip[msg.tabId] ? msg.tabId : null;
              if (targetId != null) {
                sendTab(targetId, { type: "PIP_TOGGLE_CHAT" });
              } else {
                for (const id of ids) sendTab(id, { type: "PIP_TOGGLE_CHAT" });
              }
            } else if (chrome.tabs?.query) {
              chrome.tabs
                .query({})
                .then((tabs) => {
                  for (const t of tabs) {
                    if (isNormalWebTab(t)) {
                      sendTab(t.id, { type: "PIP_TOGGLE_CHAT" });
                    }
                  }
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      } else if (msg.intent === "MEDIA_VOLUME") {
        executeMediaAction("VOLUME", {
          deltaVolume: Number(msg.delta) || 0,
          tabId: Number.isFinite(msg.tabId) ? msg.tabId : null,
        });
      } else if (INTENTS[msg.intent]) {
        INTENTS[msg.intent](msg);
      }
      break;
    }
    case "PEEK_STATE": {
      enginePeekActive = Boolean(msg.active);
      broadcastPeekState(enginePeekActive);
      break;
    }
    case "PIP_BOUND": {
      if (Number.isFinite(msg.tabId)) {
        updatePipEntry(msg.tabId, (prev) => (prev ? { ...prev, bound: true, lostReason: null } : null));
      }
      break;
    }
    case "PIP_LOST": {
      if (Number.isFinite(msg.tabId)) {
        const reason = typeof msg.reason === "string" ? msg.reason : "unknown";
        updatePipEntry(msg.tabId, (prev) => (prev ? { ...prev, bound: false, lostReason: reason } : null));
      }
      break;
    }
    case "PIP_BOUNDS": {
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y) && Number.isFinite(msg.w) && Number.isFinite(msg.h)) {
        const bounds = {
          x: Math.round(msg.x),
          y: Math.round(msg.y),
          w: Math.round(msg.w),
          h: Math.round(msg.h),
          kind: typeof msg.kind === "string" ? msg.kind : "document",
        };
        chrome.storage.local.set({ pipBounds: bounds }).catch(() => {});
        if (bounds.kind === "document" || bounds.kind === "popup") {
          Promise.all([chrome.storage.local.get("floatLayout"), chrome.storage.session.get("pip")])
            .then(([{ floatLayout }, { pip = {} }]) => {
              const entry = Number.isFinite(msg.tabId) ? pip[msg.tabId] : null;
              const dpr = Number.isFinite(entry?.dpr) && entry.dpr > 0 ? entry.dpr : 1;
              const cssW = Math.round(bounds.w / dpr);
              if (cssW < 140 || cssW > 2560) return;
              const base = floatLayout && typeof floatLayout === "object" ? floatLayout : {};
              if (Math.abs((base.pipWidth ?? 0) - cssW) > 1) {
                return chrome.storage.local.set({ floatLayout: { ...base, pipWidth: cssW } });
              }
            })
            .catch(() => {});
        }
      }
      break;
    }
    case "PIP_HOVER": {
      const hovered = Boolean(msg.hovered);
      if (Number.isFinite(msg.tabId) && msg.tabId >= 0) {
        sendTab(msg.tabId, { type: "PIP_HOVER", hovered });
      } else {
        chrome.storage.session
          .get("pip")
          .then(({ pip = {} }) => {
            const ids = Object.keys(pip).map(Number).filter(Number.isFinite);
            if (ids.length) {
              for (const id of ids) sendTab(id, { type: "PIP_HOVER", hovered });
            } else if (chrome.tabs?.query) {
              chrome.tabs
                .query({})
                .then((tabs) => {
                  for (const t of tabs) {
                    if (isNormalWebTab(t)) {
                      sendTab(t.id, { type: "PIP_HOVER", hovered });
                    }
                  }
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      }
      break;
    }
  }
}

let reconnectTimer = null;
let pingTimer = null;

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (!postToEngine({ v: 1, type: "PING" })) stopPing();
  }, 20000);
}

function disconnectEngine() {
  stopPing();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const port = nativePort;
  nativePort = null;
  if (port) {
    port.__intentionalDisconnect = true;
    try {
      port.disconnect();
    } catch {}
  }
  if (enginePeekActive) {
    enginePeekActive = false;
    broadcastPeekState(false);
  }
  chrome.storage.session.set({ engine: { ...DEFAULT_ENGINE, installed: engineInstalled } });
  broadcastEngineState(false);
}

function onEngineDisconnect(port) {
  void chrome.runtime.lastError;
  stopPing();
  if (nativePort === port) nativePort = null;
  if (enginePeekActive) {
    enginePeekActive = false;
    broadcastPeekState(false);
  }
  if (!port?.__gotHello && !port?.__intentionalDisconnect && engineAllowed) {
    engineInstalled = false;
    chrome.storage.local.set({ engineInstalled: false }).catch(() => {});
  }
  chrome.storage.session.set({ engine: { ...DEFAULT_ENGINE, installed: engineInstalled } });
  broadcastEngineState(false);
  chrome.storage.session
    .get("pip")
    .then(({ pip = {} }) => {
      let changed = false;
      for (const k of Object.keys(pip)) {
        if (pip[k]?.bound) {
          pip[k] = { ...pip[k], bound: false };
          changed = true;
        }
      }
      if (changed) chrome.storage.session.set({ pip });
    })
    .catch(() => {});
  clearTimeout(reconnectTimer);
  if (!engineAllowed) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (engineAllowed) connectEngine();
  }, 1000);
}

function connectEngine() {
  if (!engineAllowed) return null;
  if (nativePort) return nativePort;
  if (typeof chrome.runtime?.connectNative !== "function") return null;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    return null;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  nativePort = port;
  port.onMessage.addListener(onEngineMessage);
  port.onDisconnect.addListener(() => onEngineDisconnect(port));
  startPing();

  Promise.all([
    chrome.storage.local.get(["settings", "engineInstalled", "pipBounds"]),
    chrome.storage.session.get("pip"),
    ensureInTabSessions(),
  ])
    .then(([{ settings, engineInstalled: storedInstalled, pipBounds }, { pip = {} }]) => {
      if (typeof storedInstalled === "boolean" && !engineInstalled) {
        engineInstalled = storedInstalled;
      }
      const merged = GhostPiPSettings.merge(settings);
      engineAllowed = Boolean(merged.enabled);
      if (nativePort !== port) return;
      postToEngine({ v: 1, type: "STATE", settings: merged });
      syncEngineSessionState(pip);
      postToEngine({
        v: 1,
        type: "LOCALE",
        strings: {
          trayTip: chrome.i18n.getMessage("engineTrayTip"),
          trayActive: chrome.i18n.getMessage("engineTrayActive"),
          trayEmergency: chrome.i18n.getMessage("engineTrayEmergency"),
          trayExit: chrome.i18n.getMessage("engineTrayExit"),
        },
      });
      if (!engineAllowed) {
        disconnectEngine();
        return;
      }
      for (const entry of Object.values(pip)) {
        if (entry && Number.isFinite(entry.tabId) && entry.rect) {
          postToEngine(buildPipOpenedEngineMsg(entry, pip, pipBounds));
        }
      }
    })
    .catch(() => {});

  return port;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Only store installs carry update_url; unpacked/dev installs (and test runs) skip onboarding.
  if (reason === "install" && chrome.runtime.getManifest().update_url) {
    chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html") }).catch(() => {});
  }
  updateSettings((s) => ({ ok: true, settings: s }));
  connectEngine();
  if (chrome.tabs?.query && chrome.scripting?.executeScript) {
    chrome.tabs
      .query({})
      .then((tabs) => {
        for (const t of tabs) {
          if (t.id != null && t.url && /^https?:/i.test(t.url)) {
            chrome.scripting
              .insertCSS({
                target: { tabId: t.id },
                files: ["content/overlay.css"],
              })
              .catch(() => {});
            chrome.scripting
              .executeScript({
                target: { tabId: t.id },
                files: ["shared/settings.js", "content/dodge.js", "content/subtitles.js", "content/content.js"],
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener(() => {
  connectEngine();
});

connectEngine();

function loadSites() {
  sitesPromise ??= fetch(chrome.runtime.getURL("config/selectors.json"))
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.schema !== 1) throw new Error(`selectors.json schema ${cfg.schema}`);
      return Object.entries(cfg.sites).map(([siteId, { match, ...site }]) => ({
        siteId,
        re: new RegExp(match),
        site,
      }));
    });
  return sitesPromise;
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  syncActiveTab(tabId, windowId);
});

chrome.tabs.onUpdated?.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || sourceByPopupTab.has(tabId)) return;
  await ensureInTabSessions();
  if (inTabSessions.size > 0) {
    syncTabRemoteOverlays(tabId);
  }
});

chrome.windows?.onRemoved?.addListener(async (windowId) => {
  const sourceTabId = sourceByPopupWindow.get(windowId);
  if (sourceTabId != null) {
    await closePopupPipForSource(sourceTabId, { notifySource: true });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (sourceByPopupTab.has(tabId)) {
    const srcId = sourceByPopupTab.get(tabId);
    await closePopupPipForSource(srcId, { notifySource: true });
    return;
  }
  if (popupPipBySource.has(tabId)) {
    await closePopupPipForSource(tabId, { notifySource: false });
  }
  pipChanged(tabId, null);
  await ensureInTabSessions();
  if (inTabSessions.has(tabId)) {
    inTabSessions.delete(tabId);
    lastFramesByTab.delete(tabId);
    lastSubtitlesByTab.delete(tabId);
    await persistInTabSessions();
    syncEngineSessionState();
    await broadcastRemoteStop(tabId, tabId);
  }
});

async function findMuteTargetTab() {
  const { pip = {} } = await chrome.storage.session.get("pip");
  const pipEntries = Object.values(pip);
  for (let i = pipEntries.length - 1; i >= 0; i--) {
    const entry = pipEntries[i];
    const targetId = Number.isFinite(entry?.sourceTabId) ? entry.sourceTabId : entry?.tabId;
    if (Number.isFinite(targetId)) {
      try {
        return await chrome.tabs.get(targetId);
      } catch {}
    }
  }
  await ensureInTabSessions();
  const srcId = refreshLatestInTabSourceId();
  if (Number.isFinite(srcId)) {
    try {
      return await chrome.tabs.get(srcId);
    } catch {}
  }
  const tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter(isNormalWebTab);
  const sites = await loadSites().catch(() => []);
  const isSite = (t) => Boolean(t.url) && sites.some(({ re }) => re.test(t.url));
  return (
    webTabs.find((t) => t.active && isSite(t)) ||
    webTabs.find((t) => t.audible && isSite(t)) ||
    webTabs.find(isSite) ||
    webTabs.find((t) => t.active) ||
    webTabs.find((t) => t.audible) ||
    webTabs[0] ||
    null
  );
}

async function findMediaTargetTab(preferredTabId = null) {
  const [{ pip = {} }] = await Promise.all([chrome.storage.session.get("pip"), ensureInTabSessions()]);
  if (Number.isFinite(preferredTabId) && preferredTabId >= 0) {
    const mappedId = sourceByPopupTab.get(preferredTabId) ?? pip?.[preferredTabId]?.sourceTabId ?? preferredTabId;
    if (Number.isFinite(mappedId)) {
      const preferred = await chrome.tabs.get(mappedId).catch(() => null);
      if (preferred) return preferred;
    }
  }
  const pipEntries = Object.values(pip);
  for (let i = pipEntries.length - 1; i >= 0; i--) {
    const entry = pipEntries[i];
    const targetId = Number.isFinite(entry?.sourceTabId) ? entry.sourceTabId : entry?.tabId;
    if (Number.isFinite(targetId)) {
      const tab = await chrome.tabs.get(targetId).catch(() => null);
      if (tab) return tab;
    }
  }
  const srcId = refreshLatestInTabSourceId();
  if (Number.isFinite(srcId)) {
    const tab = await chrome.tabs.get(srcId).catch(() => null);
    if (tab) return tab;
  }
  return findMuteTargetTab();
}

async function executeMediaAction(action, { deltaSec = 0, deltaVolume = 0, tabId = null } = {}) {
  const { settings: rawSettings } = await chrome.storage.local.get("settings");
  const settings = GhostPiPSettings.merge(rawSettings);
  if (!settings.enabled || !settings.media.enabled) return { ok: false };
  const tab = await findMediaTargetTab(tabId);
  if (!tab?.id) return { ok: false };

  if (action === "VOLUME" && deltaVolume > 0 && tab.mutedInfo?.muted) {
    await chrome.tabs.update(tab.id, { muted: false }).catch(() => {});
  }

  let handledSeekInMain = false;
  if (action === "SEEK" && chrome.scripting?.executeScript) {
    let host = "";
    try {
      host = new URL(tab.url || "https://example.com").hostname;
    } catch {}
    if (/\.netflix\.com$/i.test(host) || /^netflix\.com$/i.test(host)) {
      const nfRes = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          args: [deltaSec],
          func: (stepSec) => {
            try {
              const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
              const sid = vp?.getAllPlayerSessionIds?.()?.[0];
              const player = sid ? vp.getVideoPlayerBySessionId(sid) : null;
              if (player && typeof player.getCurrentTime === "function" && typeof player.seek === "function") {
                const dur = typeof player.getDuration === "function" ? player.getDuration() : Infinity;
                const nextMs = Math.max(0, Math.min(dur, player.getCurrentTime() + stepSec * 1000));
                player.seek(nextMs);
                return true;
              }
            } catch {}
            return false;
          },
        })
        .catch(() => null);
      handledSeekInMain = Boolean(nfRes?.[0]?.result);
    }
  }

  const res = await sendTab(tab.id, {
    type: "MEDIA_CONTROL",
    action,
    deltaSec,
    deltaVolume,
    handledSeekInMain,
  });

  if (res?.hudText) {
    const popupTabId = popupPipBySource.get(tab.id)?.popupTabId;
    if (Number.isFinite(popupTabId)) {
      sendTab(popupTabId, { type: "MEDIA_HUD", sourceTabId: tab.id, text: res.hudText });
    }
    await ensureInTabSessions();
    if (inTabSessions.has(tab.id) && chrome.tabs?.query) {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      for (const t of tabs) {
        if (t.id != null && t.id !== tab.id && !sourceByPopupTab.has(t.id)) {
          sendTab(t.id, { type: "MEDIA_HUD", sourceTabId: tab.id, text: res.hudText });
        }
      }
    }
  }

  return res || { ok: false };
}

const INTENTS = {
  TOGGLE_CLICK_THROUGH: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { clickThrough: !s.clickThrough })),
  TOGGLE_DODGE: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { dodge: { enabled: !s.dodge.enabled } })),
  TOGGLE_PEEK: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { peek: { enabled: !s.peek.enabled } })),
  TOGGLE_MUTE: async () => {
    const tab = await findMuteTargetTab();
    if (!tab) return { ok: false };
    const muted = !tab.mutedInfo?.muted;
    const updated = await chrome.tabs.update(tab.id, { muted });
    return { ok: true, tabId: tab.id, muted: updated?.mutedInfo?.muted ?? muted };
  },
  MEDIA_PLAY_PAUSE: (msg) =>
    executeMediaAction("PLAY_PAUSE", { tabId: Number.isFinite(msg?.tabId) ? msg.tabId : null }),
  MEDIA_SEEK_BACK: async (msg) => {
    const { settings } = await chrome.storage.local.get("settings");
    const step = GhostPiPSettings.merge(settings).media.seekSec;
    return executeMediaAction("SEEK", {
      deltaSec: -step,
      tabId: Number.isFinite(msg?.tabId) ? msg.tabId : null,
    });
  },
  MEDIA_SEEK_FORWARD: async (msg) => {
    const { settings } = await chrome.storage.local.get("settings");
    const step = GhostPiPSettings.merge(settings).media.seekSec;
    return executeMediaAction("SEEK", {
      deltaSec: step,
      tabId: Number.isFinite(msg?.tabId) ? msg.tabId : null,
    });
  },
};

const COMMAND_TO_INTENT = {
  "toggle-click-through": "TOGGLE_CLICK_THROUGH",
  "toggle-dodge": "TOGGLE_DODGE",
  "toggle-mute": "TOGGLE_MUTE",
};

function dispatchCommand(command) {
  const intent = COMMAND_TO_INTENT[command];
  return intent ? INTENTS[intent]() : Promise.resolve({ ok: false });
}

globalThis.GhostPiPBackground = {
  dispatchCommand,
  connectEngine,
  onEngineMessage,
  postToEngine,
  executeMediaAction,
  syncEngineSessionState,
  patchSettings: (patch) => updateSettings((s) => GhostPiPSettings.patch(s, patch)),
};

chrome.commands.onCommand.addListener((command) => {
  dispatchCommand(command);
});

const handlers = {
  async GET_SITE_CONFIG({ url }, sender) {
    const [found, { pip = {}, engine }] = await Promise.all([
      loadSites().then((list) => list.find(({ re }) => re.test(url))),
      chrome.storage.session.get(["pip", "engine"]),
    ]);
    await ensureInTabSessions();
    const senderTabId = sender?.tab?.id ?? null;
    if (senderTabId != null && !sourceByPopupTab.has(senderTabId)) {
      if (sender.tab.active) {
        syncActiveTab(senderTabId);
      } else if (inTabSessions.size > 0) {
        syncTabRemoteOverlays(senderTabId);
      }
    }
    const base = found ? { siteId: found.siteId, site: found.site } : GENERIC_SITE;
    return {
      ...base,
      tabId: senderTabId,
      engineConnected: Boolean(engine?.connected),
      peekActive: Boolean(enginePeekActive),
      ...getDocPipStatus(pip),
    };
  },
  async INTAB_OPENED({ ratio, vw, vh, chatUrl, frame, subtitle } = {}, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return { ok: false };
    await ensureInTabSessions();
    if (frame?.dataUrl) {
      lastFramesByTab.set(tabId, { ...frame, sourceTabId: tabId });
    }
    if (typeof subtitle === "string") {
      lastSubtitlesByTab.set(tabId, subtitle);
    }
    const existing = inTabSessions.get(tabId);
    const next = {
      sourceTabId: tabId,
      connId: ++inTabSeq,
      order: existing?.order ?? ++inTabOrderSeq,
      ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 9 / 16,
      vw: Number.isFinite(vw) && vw > 0 ? vw : frame?.vw || 0,
      vh: Number.isFinite(vh) && vh > 0 ? vh : frame?.vh || 0,
      chatUrl: chatUrl || null,
      subtitle: typeof subtitle === "string" ? subtitle : lastSubtitlesByTab.get(tabId) || "",
    };
    inTabSessions.set(tabId, next);
    await persistInTabSessions();
    if (!nativePort) connectEngine();
    syncEngineSessionState();
    prewarmRemoteTabs(next);
    if (chrome.tabs?.query) {
      const activeTabs = await chrome.tabs.query({ active: true }).catch(() => []);
      for (const activeTab of activeTabs) {
        if (isNormalWebTab(activeTab)) {
          syncActiveTab(activeTab.id);
        }
      }
    }
    return { ok: true };
  },
  async INTAB_CLOSED(_msg, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return { ok: true };
    await ensureInTabSessions();
    if (inTabSessions.has(tabId)) {
      inTabSessions.delete(tabId);
      lastFramesByTab.delete(tabId);
      lastSubtitlesByTab.delete(tabId);
      await persistInTabSessions();
      syncEngineSessionState();
      await broadcastRemoteStop(tabId, tabId);
    }
    return { ok: true };
  },
  async INTAB_STOP_SINGLE({ sourceTabId } = {}) {
    await ensureInTabSessions();
    const targetId = Number.isFinite(sourceTabId) ? sourceTabId : refreshLatestInTabSourceId();
    if (Number.isFinite(targetId) && inTabSessions.has(targetId)) {
      inTabSessions.delete(targetId);
      lastFramesByTab.delete(targetId);
      lastSubtitlesByTab.delete(targetId);
      await persistInTabSessions();
      syncEngineSessionState();
      sendTab(targetId, { type: "INTAB_FORCE_IDLE" });
      await broadcastRemoteStop(null, targetId);
    }
    return { ok: true };
  },
  async INTAB_STOP_ALL() {
    await ensureInTabSessions();
    const srcIds = [...inTabSessions.keys()];
    inTabSessions.clear();
    lastFramesByTab.clear();
    lastSubtitlesByTab.clear();
    await persistInTabSessions();
    syncEngineSessionState();
    for (const srcId of srcIds) {
      sendTab(srcId, { type: "INTAB_FORCE_IDLE" });
    }
    await broadcastRemoteStop();
    return { ok: true };
  },
  async FOCUS_SOURCE_TAB({ sourceTabId } = {}, sender) {
    await ensureInTabSessions();
    const senderTabId = sender?.tab?.id;
    const mappedPopupSrc = senderTabId != null ? sourceByPopupTab.get(senderTabId) : null;
    const targetTabId = Number.isFinite(sourceTabId)
      ? sourceTabId
      : mappedPopupSrc ?? refreshLatestInTabSourceId() ?? senderTabId;
    if (Number.isFinite(targetTabId)) {
      const tab = await chrome.tabs.update(targetTabId, { active: true }).catch(() => null);
      if (tab?.windowId != null) {
        await chrome.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      }
    }
    return { ok: true };
  },
  async SKIP_AD({ sourceTabId } = {}, sender) {
    await ensureInTabSessions();
    const senderTabId = sender?.tab?.id;
    const mappedPopupSrc = senderTabId != null ? sourceByPopupTab.get(senderTabId) : null;
    const targetTabId = Number.isFinite(sourceTabId)
      ? sourceTabId
      : mappedPopupSrc ?? refreshLatestInTabSourceId();
    if (Number.isFinite(targetTabId)) {
      await sendTab(targetTabId, { type: "INTAB_SKIP_AD" });
    }
    return { ok: true };
  },
  async OPEN_POPUP_PIP({ width, height, ratio, chatUrl, showChat, subtitle } = {}, sender) {
    const sourceTabId = sender?.tab?.id;
    if (!Number.isFinite(sourceTabId) || !chrome.windows?.create) return { ok: false };
    await closePopupPipForSource(sourceTabId, { notifySource: false });
    if (typeof subtitle === "string") {
      lastSubtitlesByTab.set(sourceTabId, subtitle);
    }
    const w = Math.max(200, Math.round(Number(width) || 480));
    const h = Math.max(150, Math.round(Number(height) || 270));
    const qs = new URLSearchParams({
      sourceTabId: String(sourceTabId),
      showChat: showChat ? "1" : "0",
      w: String(w),
      h: String(h),
    });
    if (chatUrl) qs.set("chatUrl", chatUrl);
    if (Number.isFinite(ratio) && ratio > 0) qs.set("ratio", String(ratio));
    const url = chrome.runtime.getURL(`player/player.html?${qs.toString()}`);
    let win;
    try {
      win = await chrome.windows.create({
        url,
        type: "popup",
        width: w,
        height: h,
      });
    } catch {
      return { ok: false };
    }
    const popupWindowId = win?.id ?? null;
    const popupTabId = win?.tabs?.[0]?.id ?? null;
    if (popupWindowId == null) return { ok: false };
    popupPipBySource.set(sourceTabId, { popupWindowId, popupTabId, chatUrl: chatUrl || null });
    sourceByPopupWindow.set(popupWindowId, sourceTabId);
    if (popupTabId != null) sourceByPopupTab.set(popupTabId, sourceTabId);
    return { ok: true, popupWindowId, popupTabId };
  },
  async CLOSE_POPUP_PIP({ sourceTabId } = {}, sender) {
    const senderTabId = sender?.tab?.id;
    const targetSrcId = Number.isFinite(sourceTabId)
      ? sourceTabId
      : senderTabId != null && sourceByPopupTab.has(senderTabId)
        ? sourceByPopupTab.get(senderTabId)
        : senderTabId;
    if (Number.isFinite(targetSrcId)) {
      const fromSource = senderTabId === targetSrcId;
      await closePopupPipForSource(targetSrcId, { notifySource: !fromSource });
    }
    return { ok: true };
  },
  async PIP_OPENED({ kind, rect, dpr, sourceTabId }, sender) {
    const pipTabId = sender?.tab?.id;
    if (!Number.isFinite(pipTabId)) return { ok: false };
    const effectiveSourceTabId = Number.isFinite(sourceTabId)
      ? sourceTabId
      : sourceByPopupTab.get(pipTabId) ?? pipTabId;
    if (kind === "popup" && Number.isFinite(effectiveSourceTabId)) {
      const info = popupPipBySource.get(effectiveSourceTabId);
      if (info && info.popupTabId == null) {
        info.popupTabId = pipTabId;
        sourceByPopupTab.set(pipTabId, effectiveSourceTabId);
      }
    }
    const { pip } = await pipChanged(pipTabId, {
      v: 1,
      type: "PIP_OPENED",
      tabId: pipTabId,
      sourceTabId: effectiveSourceTabId,
      kind,
      rect,
      dpr,
    });
    const { engine } = await chrome.storage.session.get("engine");
    return {
      ok: true,
      engineConnected: Boolean(engine?.connected),
      peekActive: Boolean(enginePeekActive),
      multiPip: Object.keys(pip || {}).length > 1,
    };
  },
  async PIP_RECT_UPDATED({ rect }, sender) {
    if (sender?.tab?.id != null && rect) {
      if (!nativePort && engineAllowed) connectEngine();
      const { saved, pip } = await updatePipEntry(sender.tab.id, (prev) => (prev ? { ...prev, rect } : null));
      if (saved && !saved.bound) {
        const { pipBounds } = await chrome.storage.local.get("pipBounds").catch(() => ({}));
        postToEngine(buildPipOpenedEngineMsg(saved, pip, pipBounds));
      }
    }
    return { ok: true };
  },
  async PIP_CLOSED(_msg, sender) {
    if (sender?.tab?.id != null) {
      await pipChanged(sender.tab.id, null);
    }
    return { ok: true };
  },
  async PIP_SUBTITLE({ text } = {}, sender) {
    const tabId = sender?.tab?.id;
    if (Number.isFinite(tabId)) {
      postToEngine({
        v: 1,
        type: "PIP_SUBTITLE",
        tabId,
        text: typeof text === "string" ? text : "",
      });
    }
    return { ok: true };
  },
  async PIP_RESIZE({ deltaH, dpr }, sender) {
    if (!nativePort) connectEngine();
    const tabId = sender?.tab?.id;
    const msg = { v: 1, type: "PIP_RESIZE", deltaH, dpr };
    if (Number.isFinite(tabId)) msg.tabId = tabId;
    const handledByEngine = postToEngine(msg);
    return { ok: true, handledByEngine };
  },
  async GET_STATE() {
    const [{ settings, engineInstalled: storedInstalled }, { pip = {}, engine }] = await Promise.all([
      chrome.storage.local.get(["settings", "engineInstalled"]),
      chrome.storage.session.get(["pip", "engine"]),
    ]);
    if (typeof storedInstalled === "boolean") engineInstalled = storedInstalled;
    const merged = GhostPiPSettings.merge(settings);
    if (merged.enabled && !nativePort) connectEngine();
    const baseEngine =
      engine && typeof engine === "object"
        ? { ...DEFAULT_ENGINE, ...engine, installed: Boolean(engine.connected || engine.installed) }
        : { ...DEFAULT_ENGINE, installed: !merged.enabled && Boolean(engineInstalled) };
    return {
      settings: merged,
      pip,
      engine: baseEngine,
      peekActive: Boolean(enginePeekActive),
      ...getDocPipStatus(pip),
    };
  },
  async PATCH_SETTINGS({ patch, keepLayoutPos }) {
    const res = await updateSettings((current) => GhostPiPSettings.patch(current, patch));
    if (res.ok && patch?.enabled === false) {
      engineAllowed = false;
      await handlers.INTAB_STOP_ALL();
      await closeAllPopupPips();
      await chrome.storage.session.set({ pip: {} });
      syncEngineSessionState({});
      broadcastPipSessionsChanged({});
      setTimeout(() => {
        if (!engineAllowed) disconnectEngine();
      }, 60);
    } else if (res.ok && patch?.enabled === true) {
      engineAllowed = true;
      connectEngine();
    }
    if (res.ok && patch?.dodge?.home && !keepLayoutPos) {
      const { floatLayout } = await chrome.storage.local.get("floatLayout");
      if (floatLayout && (floatLayout.pos || floatLayout.pipPos)) {
        await chrome.storage.local.set({ floatLayout: { ...floatLayout, pos: null, pipPos: null } });
      }
      await chrome.storage.local.remove("pipBounds").catch(() => {});
    }
    return res;
  },
  async INTENT({ intent }) {
    const fn = INTENTS[intent];
    return fn ? fn() : { ok: false };
  },
  async MEDIA_ACTION({ action, deltaSec = 0, deltaVolume = 0, sourceTabId = null } = {}) {
    if (!["PLAY_PAUSE", "SEEK", "VOLUME"].includes(action)) return { ok: false };
    return executeMediaAction(action, {
      deltaSec: Number(deltaSec) || 0,
      deltaVolume: Number(deltaVolume) || 0,
      tabId: Number.isFinite(sourceTabId) ? sourceTabId : null,
    });
  },
  async RECONNECT_ENGINE() {
    connectEngine();
    const { engine } = await chrome.storage.session.get("engine");
    return {
      ok: true,
      engine: { ...DEFAULT_ENGINE, ...(engine && typeof engine === "object" ? engine : {}) },
    };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
