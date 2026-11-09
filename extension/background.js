importScripts("shared/settings.js", "shared/protocol.js");

const Protocol = globalThis.GhostPiPProtocol;
const HOST_NAME = "app.ghostpip.engine";
const GENERIC_SITE = { siteId: "generic", site: { video: null, chatPopoutUrl: null } };
const DEFAULT_ENGINE = {
  connected: false,
  installed: false,
  engineVersion: null,
  elevated: null,
  hotkeyErrors: [],
  protocolMismatch: false,
};
const MEDIA_ACTIONS = ["PLAY_PAUSE", "SEEK", "VOLUME"];

let settingsQueue = Promise.resolve();
let pipQueue = Promise.resolve();
let framingQueue = Promise.resolve();
let sitesPromise = null;
let nativePort = null;
let engineAllowed = true;
let engineInstalled = false;
let enginePeekActive = false;
let engineHostMissing = false;
let reconnectAttempt = 0;
let lastEngineJson = null;

const lastFramesByTab = new Map();
const lastSubtitlesByTab = new Map();
const senderStreamPorts = new Map();
let receiverPortSeq = 0;
const receiverStreamPorts = new Map();

const popupPipBySource = new Map();
const sourceByPopupWindow = new Map();
const sourceByPopupTab = new Map();
let popupMapsLoaded = null;

function loadPopupMaps() {
  popupMapsLoaded ??= chrome.storage.session
    .get("popupPips")
    .then(({ popupPips }) => {
      for (const [src, info] of Object.entries(popupPips || {})) {
        const sourceTabId = Number(src);
        if (!Number.isInteger(sourceTabId) || !info) continue;
        popupPipBySource.set(sourceTabId, info);
        if (info.popupWindowId != null) sourceByPopupWindow.set(info.popupWindowId, sourceTabId);
        if (info.popupTabId != null) sourceByPopupTab.set(info.popupTabId, sourceTabId);
      }
    })
    .catch(() => {});
  return popupMapsLoaded;
}

function persistPopupMaps() {
  return chrome.storage.session.set({ popupPips: Object.fromEntries(popupPipBySource) }).catch(() => {});
}

function setPopupTab(sourceTabId, popupTabId) {
  const info = popupPipBySource.get(sourceTabId);
  if (!info || info.popupTabId === popupTabId) return;
  info.popupTabId = popupTabId;
  sourceByPopupTab.set(popupTabId, sourceTabId);
  persistPopupMaps();
  allowChatFramingInTab(popupTabId);
}

function ready() {
  return loadPopupMaps();
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    reconcileAllSitesScripts();
    return;
  }
  if (area !== "session") return;
  if (changes.engine && Boolean(changes.engine.oldValue?.connected) !== Boolean(changes.engine.newValue?.connected)) {
    broadcastEngineState(Boolean(changes.engine.newValue?.connected));
  }
});

function sendTab(tabId, msg) {
  if (!Number.isFinite(tabId)) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, { v: 1, ...msg }).catch(() => null);
}

const sameIds = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Session rules outlive the service worker, so they are the record of which tabs may frame chat.
function updateChatFraming(mutate) {
  const run = framingQueue.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const before = [...new Set(rules.flatMap((r) => r.condition.tabIds ?? []))].sort((a, b) => a - b);
    const ids = new Set(before);
    mutate(ids);
    const after = [...ids].sort((a, b) => a - b);
    if (rules.length && sameIds(before, after)) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((r) => r.id),
      addRules: Protocol.chatFramingRules(chrome.runtime.id, after),
    });
  });
  framingQueue = run.catch(() => {});
  return framingQueue;
}

function allowChatFramingInTab(tabId) {
  if (Number.isInteger(tabId) && tabId >= 0) updateChatFraming((ids) => ids.add(tabId));
}

function forgetChatFramingTab(tabId) {
  updateChatFraming((ids) => ids.delete(tabId));
}

function isNormalWebTab(tab) {
  return Boolean(tab && tab.id != null && !sourceByPopupTab.has(tab.id) && (!tab.url || /^https?:/i.test(tab.url)));
}

function parseReceiverSourceId(portName) {
  if (typeof portName !== "string" || !portName.startsWith("ghostpip-receiver:")) return null;
  const n = Number(portName.slice("ghostpip-receiver:".length));
  return Number.isFinite(n) ? n : null;
}

// The source only captures frames while someone is watching them.
function notifySenderReceivers(sourceTabId) {
  const senderPort = senderStreamPorts.get(sourceTabId);
  if (!senderPort) return;
  let active = false;
  for (const rp of receiverStreamPorts.values()) {
    if (rp.sourceTabId === sourceTabId && rp.visible) active = true;
  }
  if (senderPort.__receiversActive === active) return;
  senderPort.__receiversActive = active;
  try {
    senderPort.postMessage({ type: "RECEIVERS", active });
  } catch {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return;
  if (port.name === "ghostpip-sender") {
    const sourceTabId = port.sender?.tab?.id;
    if (!Number.isFinite(sourceTabId)) return;
    senderStreamPorts.set(sourceTabId, port);
    notifySenderReceivers(sourceTabId);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      const taggedOut = { ...msg, sourceTabId };
      if (msg.type === "FRAME" && msg.dataUrl) {
        lastFramesByTab.set(sourceTabId, taggedOut);
      } else if (msg.type === "SUBTITLE") {
        const text = typeof msg.text === "string" ? msg.text : "";
        lastSubtitlesByTab.set(sourceTabId, text);
      }
      if (msg.portId && receiverStreamPorts.has(msg.portId)) {
        try {
          receiverStreamPorts.get(msg.portId).port.postMessage(taggedOut);
        } catch {}
        return;
      }
      for (const rp of receiverStreamPorts.values()) {
        if (rp.sourceTabId === sourceTabId) {
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
    const receiverTabId = port.sender?.tab?.id;
    if (
      Number.isFinite(parsedSrcId) &&
      Number.isFinite(receiverTabId) &&
      port.sender?.url?.startsWith(chrome.runtime.getURL("player/"))
    ) {
      sourceByPopupTab.set(receiverTabId, parsedSrcId);
      if (popupPipBySource.get(parsedSrcId)?.popupTabId == null) setPopupTab(parsedSrcId, receiverTabId);
    }
    const entry = {
      port,
      sourceTabId: parsedSrcId ?? sourceByPopupTab.get(receiverTabId) ?? null,
      visible: true,
    };
    receiverStreamPorts.set(portId, entry);

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

    const initialTarget = entry.sourceTabId ?? sourceByPopupTab.get(receiverTabId);
    if (Number.isFinite(initialTarget)) {
      sendInitialSnapshot(initialTarget);
      notifySenderReceivers(initialTarget);
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      const prevTarget = entry.sourceTabId ?? sourceByPopupTab.get(receiverTabId);
      if (Number.isFinite(msg.sourceTabId) && entry.sourceTabId !== msg.sourceTabId) {
        entry.sourceTabId = msg.sourceTabId;
        sendInitialSnapshot(entry.sourceTabId);
      }
      const targetSrcId = entry.sourceTabId ?? sourceByPopupTab.get(receiverTabId);
      if (Number.isFinite(targetSrcId) && entry.sourceTabId == null) {
        entry.sourceTabId = targetSrcId;
      }
      if (msg.type === "RECEIVER_STATE") {
        entry.visible = msg.visible !== false;
        if (Number.isFinite(prevTarget) && prevTarget !== targetSrcId) notifySenderReceivers(prevTarget);
        if (Number.isFinite(targetSrcId)) notifySenderReceivers(targetSrcId);
        return;
      }
      if (Number.isFinite(prevTarget) && prevTarget !== targetSrcId) notifySenderReceivers(prevTarget);
      if (Number.isFinite(targetSrcId)) notifySenderReceivers(targetSrcId);
      const tagged = { ...msg, portId, sourceTabId: targetSrcId };
      const senderPort = Number.isFinite(targetSrcId) ? senderStreamPorts.get(targetSrcId) : null;
      if (senderPort) {
        try {
          senderPort.postMessage(tagged);
        } catch {}
      } else if (Number.isFinite(targetSrcId)) {
        sendTab(targetSrcId, { type: "INTAB_RECONNECT_SENDER" });
      }
    });
    port.onDisconnect.addListener(() => {
      receiverStreamPorts.delete(portId);
      const targetSrcId = entry.sourceTabId ?? sourceByPopupTab.get(receiverTabId);
      const senderPort = Number.isFinite(targetSrcId) ? senderStreamPorts.get(targetSrcId) : null;
      if (senderPort) {
        try {
          senderPort.postMessage({ type: "RTC_CLOSE", portId });
        } catch {}
      }
      if (Number.isFinite(targetSrcId)) notifySenderReceivers(targetSrcId);
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
  const pip = pipOverride
    ? pipOverride
    : await chrome.storage.session
        .get("pip")
        .then((r) => r?.pip || {})
        .catch(() => ({}));
  postToEngine({
    v: 1,
    type: "SESSION_STATE",
    active: Object.keys(pip || {}).length > 0,
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
      if (current.allSites !== res.settings.allSites) reconcileAllSitesScripts();
    }
    return res;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

// floatLayout has one writer; pages send partial patches that land here in order.
function updateFloatLayout(mutator) {
  const run = settingsQueue.then(async () => {
    const { floatLayout } = await chrome.storage.local.get("floatLayout");
    const current = Protocol.sanitizeLayout(floatLayout);
    const next = mutator(current);
    if (!next) return current;
    const sanitized = Protocol.sanitizeLayout(next);
    if (JSON.stringify(sanitized) !== JSON.stringify(floatLayout ?? null)) {
      await chrome.storage.local.set({ floatLayout: sanitized });
    }
    return sanitized;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

async function hasAllSitesPermission() {
  return chrome.permissions.contains({ origins: [...Protocol.ALL_SITES_ORIGINS] }).catch(() => false);
}

function supportedSiteMatches() {
  return chrome.runtime.getManifest().host_permissions;
}

async function reconcileAllSitesScripts() {
  if (!chrome.scripting?.registerContentScripts) return;
  const [{ settings }, granted, registered] = await Promise.all([
    chrome.storage.local.get("settings"),
    hasAllSitesPermission(),
    chrome.scripting.getRegisteredContentScripts({ ids: [Protocol.ALL_SITES_SCRIPT_ID] }).catch(() => []),
  ]);
  const want = granted && GhostPiPSettings.merge(settings).allSites;
  if (want && registered.length === 0) {
    await chrome.scripting
      .registerContentScripts([
        {
          id: Protocol.ALL_SITES_SCRIPT_ID,
          matches: [...Protocol.ALL_SITES_ORIGINS],
          excludeMatches: supportedSiteMatches(),
          js: [...Protocol.CONTENT_JS],
          css: [...Protocol.CONTENT_CSS],
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ])
      .catch(() => {});
  } else if (!want && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [Protocol.ALL_SITES_SCRIPT_ID] }).catch(() => {});
  }
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

function postPipOpened(saved, pip, pipBounds) {
  const msg = Protocol.buildPipOpenedEngineMsg(saved, pip, pipBounds);
  return msg ? postToEngine(msg) : false;
}

function pipChanged(tabId, entry) {
  const run = updatePipEntry(tabId, () => entry).then(async ({ saved, pip }) => {
    if (!nativePort) connectEngine();
    if (saved) {
      const { pipBounds } = await chrome.storage.local.get("pipBounds").catch(() => ({}));
      postPipOpened(saved, pip, pipBounds);
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
  lastFramesByTab.delete(sourceTabId);
  lastSubtitlesByTab.delete(sourceTabId);
  if (info.popupWindowId != null) sourceByPopupWindow.delete(info.popupWindowId);
  if (info.popupTabId != null) sourceByPopupTab.delete(info.popupTabId);
  await persistPopupMaps();
  if (info.popupTabId != null) {
    forgetChatFramingTab(info.popupTabId);
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

function setEngineState(engine) {
  const json = JSON.stringify(engine);
  if (json === lastEngineJson) return;
  lastEngineJson = json;
  chrome.storage.session.set({ engine }).catch(() => {});
}

function setEngineInstalled(installed) {
  if (engineInstalled === installed) return;
  engineInstalled = installed;
  chrome.storage.local.set({ engineInstalled: installed }).catch(() => {});
}

function onHello(msg) {
  if (nativePort) nativePort.__gotHello = true;
  reconnectAttempt = 0;
  setHostMissing(false);
  setEngineInstalled(true);
  setEngineState({
    connected: true,
    installed: true,
    engineVersion: typeof msg.engineVersion === "string" ? msg.engineVersion : null,
    elevated: typeof msg.elevated === "boolean" ? msg.elevated : null,
    hotkeyErrors: Array.isArray(msg.hotkeyErrors) ? msg.hotkeyErrors.map(String) : [],
    protocolMismatch: msg.v !== 1,
  });
}

function onEngineMessage(msg) {
  if (msg?.type === "HELLO") onHello(msg);
  if (!Protocol.isEngineMessage(msg)) return;
  switch (msg.type) {
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
          chrome.storage.session
            .get("pip")
            .then(({ pip = {} }) => {
              const entry = Number.isFinite(msg.tabId) ? pip[msg.tabId] : null;
              const dpr = Protocol.isDpr(entry?.dpr) ? entry.dpr : 1;
              const cssW = Math.round(bounds.w / dpr);
              if (cssW < Protocol.LAYOUT.MIN_WIDTH || cssW > Protocol.LAYOUT.MAX_WIDTH) return;
              return updateFloatLayout((cur) =>
                Math.abs((cur.pipWidth ?? 0) - cssW) > 1 ? { ...cur, pipWidth: cssW } : null,
              );
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
  setEngineState({ ...DEFAULT_ENGINE, installed: engineInstalled });
}

// Survives service-worker restarts so a missing host is not re-probed on every wake.
function setHostMissing(missing) {
  if (engineHostMissing === missing) return;
  engineHostMissing = missing;
  chrome.storage.session.set({ engineHostMissing: missing }).catch(() => {});
}

function scheduleReconnect(errorMessage) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!engineAllowed) return;
  if (Protocol.isHostMissingError(errorMessage)) {
    setHostMissing(true);
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEngine();
  }, Protocol.reconnectDelayMs(reconnectAttempt++));
}

function onEngineDisconnect(port) {
  const errorMessage = chrome.runtime.lastError?.message;
  stopPing();
  if (nativePort === port) nativePort = null;
  if (enginePeekActive) {
    enginePeekActive = false;
    broadcastPeekState(false);
  }
  if (!port?.__gotHello && !port?.__intentionalDisconnect && engineAllowed) setEngineInstalled(false);
  setEngineState({ ...DEFAULT_ENGINE, installed: engineInstalled });
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
  if (!port?.__intentionalDisconnect) scheduleReconnect(errorMessage);
}

// Implicit callers respect a known-missing host and a pending backoff; explicit user actions go through retryEngine.
function connectEngine() {
  if (!engineAllowed || engineHostMissing || reconnectTimer) return null;
  if (nativePort) return nativePort;
  if (typeof chrome.runtime?.connectNative !== "function") return null;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    return null;
  }
  nativePort = port;
  port.onMessage.addListener(onEngineMessage);
  port.onDisconnect.addListener(() => onEngineDisconnect(port));
  startPing();

  Promise.all([
    chrome.storage.local.get(["settings", "engineInstalled", "pipBounds"]),
    chrome.storage.session.get("pip"),
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
      for (const entry of Object.values(pip)) postPipOpened(entry, pip, pipBounds);
    })
    .catch(() => {});

  return port;
}

function retryEngine() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  setHostMissing(false);
  return connectEngine();
}

function reinjectContentScripts() {
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return;
  chrome.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) {
        if (t.id == null || !t.url || !/^https?:/i.test(t.url)) continue;
        chrome.scripting.insertCSS({ target: { tabId: t.id }, files: [...Protocol.CONTENT_CSS] }).catch(() => {});
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: [...Protocol.CONTENT_JS] }).catch(() => {});
      }
    })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Only store installs carry update_url; unpacked/dev installs (and test runs) skip onboarding.
  if (reason === "install" && chrome.runtime.getManifest().update_url) {
    chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html") }).catch(() => {});
  }
  updateSettings((s) => ({ ok: true, settings: s }));
  retryEngine();
  reconcileAllSitesScripts();
  reinjectContentScripts();
});

chrome.runtime.onStartup?.addListener(() => {
  retryEngine();
  reconcileAllSitesScripts();
});

chrome.permissions?.onAdded?.addListener(() => {
  reconcileAllSitesScripts();
  reinjectContentScripts();
});
chrome.permissions?.onRemoved?.addListener(() => reconcileAllSitesScripts());

updateChatFraming(() => {});
chrome.storage.session
  .get("engineHostMissing")
  .then(({ engineHostMissing: missing }) => {
    engineHostMissing = Boolean(missing);
    connectEngine();
  })
  .catch(() => connectEngine());

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

chrome.windows?.onRemoved?.addListener(async (windowId) => {
  await ready();
  const sourceTabId = sourceByPopupWindow.get(windowId);
  if (sourceTabId != null) {
    await closePopupPipForSource(sourceTabId, { notifySource: true });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready();
  forgetChatFramingTab(tabId);
  lastFramesByTab.delete(tabId);
  lastSubtitlesByTab.delete(tabId);
  if (sourceByPopupTab.has(tabId)) {
    const srcId = sourceByPopupTab.get(tabId);
    await closePopupPipForSource(srcId, { notifySource: true });
    return;
  }
  if (popupPipBySource.has(tabId)) {
    await closePopupPipForSource(tabId, { notifySource: false });
  }
  pipChanged(tabId, null);
});

async function findMuteTargetTab(preferredTabId = null) {
  await ready();
  const { pip = {} } = await chrome.storage.session.get("pip");
  const candidates = Protocol.mediaTargetCandidates({
    preferredTabId,
    sourceByPopupTab,
    pip,
  });
  for (const targetId of candidates) {
    const tab = await chrome.tabs.get(targetId).catch(() => null);
    if (tab) return tab;
  }
  const tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter(isNormalWebTab);
  const sites = await loadSites().catch(() => []);
  const isSite = (t) => Boolean(t.url) && sites.some(({ re }) => re.test(t.url));
  return Protocol.pickFallbackTab(webTabs, isSite);
}

function findMediaTargetTab(preferredTabId = null) {
  return findMuteTargetTab(preferredTabId);
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
  }

  return res || { ok: false };
}

const INTENTS = {
  EMERGENCY_RELEASE: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { clickThrough: false, peek: { enabled: false } })),
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
  connectEngine: retryEngine,
  retryEngine,
  disconnectEngine,
  onEngineMessage,
  postToEngine,
  executeMediaAction,
  syncEngineSessionState,
  reconcileAllSitesScripts,
  patchSettings: (patch) => updateSettings((s) => GhostPiPSettings.patch(s, patch)),
};

chrome.commands.onCommand.addListener((command) => {
  dispatchCommand(command);
});

async function resolveTargetSourceTabId(requestedId, sender, fallbackToSender = false) {
  await ready();
  const senderTabId = sender?.tab?.id;
  const mappedPopupSrc = senderTabId != null ? sourceByPopupTab.get(senderTabId) : null;
  if (Number.isInteger(requestedId) && requestedId >= 0) {
    if (
      senderTabId == null ||
      senderTabId === requestedId ||
      mappedPopupSrc === requestedId ||
      popupPipBySource.has(requestedId)
    ) {
      return requestedId;
    }
    const { pip = {} } = await chrome.storage.session.get("pip");
    if (Object.values(pip).some((e) => (e?.sourceTabId ?? e?.tabId) === requestedId)) {
      return requestedId;
    }
    return null;
  }
  return mappedPopupSrc ?? (fallbackToSender ? senderTabId : null);
}

const handlers = {
  async GET_SITE_CONFIG({ url }, sender) {
    const [found, { pip = {}, engine }] = await Promise.all([
      loadSites().then((list) => list.find(({ re }) => re.test(url))),
      chrome.storage.session.get(["pip", "engine"]),
      ready(),
    ]);
    const senderTabId = sender?.tab?.id ?? null;
    const base = found ? { siteId: found.siteId, site: found.site } : GENERIC_SITE;
    return {
      ...base,
      tabId: senderTabId,
      engineConnected: Boolean(engine?.connected),
      peekActive: Boolean(enginePeekActive),
      ...getDocPipStatus(pip),
    };
  },
  async FOCUS_SOURCE_TAB({ sourceTabId } = {}, sender) {
    const targetTabId = await resolveTargetSourceTabId(sourceTabId, sender, true);
    if (Number.isFinite(targetTabId)) {
      const tab = await chrome.tabs.update(targetTabId, { active: true }).catch(() => null);
      if (tab?.windowId != null) {
        await chrome.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      }
    }
    return { ok: true };
  },
  async SKIP_AD({ sourceTabId } = {}, sender) {
    const targetTabId = await resolveTargetSourceTabId(sourceTabId, sender);
    if (Number.isFinite(targetTabId)) {
      await sendTab(targetTabId, { type: "INTAB_SKIP_AD" });
    }
    return { ok: true };
  },
  async OPEN_POPUP_PIP({ width, height, ratio, chatUrl, showChat, subtitle } = {}, sender) {
    const sourceTabId = sender?.tab?.id;
    if (!Number.isFinite(sourceTabId) || !chrome.windows?.create) return { ok: false };
    await ready();
    await closePopupPipForSource(sourceTabId, { notifySource: false });
    if (typeof subtitle === "string") {
      lastSubtitlesByTab.set(sourceTabId, subtitle);
    }
    const safeChatUrl = Protocol.isAllowedChatUrl(chatUrl) ? chatUrl : null;
    const w = Math.max(200, Math.round(Number(width) || 480));
    const h = Math.max(150, Math.round(Number(height) || 270));
    const qs = new URLSearchParams({
      sourceTabId: String(sourceTabId),
      showChat: showChat ? "1" : "0",
      w: String(w),
      h: String(h),
    });
    if (safeChatUrl) qs.set("chatUrl", safeChatUrl);
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
    popupPipBySource.set(sourceTabId, { popupWindowId, popupTabId, chatUrl: safeChatUrl });
    sourceByPopupWindow.set(popupWindowId, sourceTabId);
    if (popupTabId != null) {
      sourceByPopupTab.set(popupTabId, sourceTabId);
      if (safeChatUrl) allowChatFramingInTab(popupTabId);
    }
    await persistPopupMaps();
    return { ok: true, popupWindowId, popupTabId };
  },
  async CLOSE_POPUP_PIP({ sourceTabId } = {}, sender) {
    await ready();
    const senderTabId = sender?.tab?.id;
    const targetSrcId =
      Number.isFinite(sourceTabId) && (senderTabId === sourceTabId || sourceByPopupTab.get(senderTabId) === sourceTabId)
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
    const safeRect = Protocol.sanitizeRect(rect);
    if (!Number.isInteger(pipTabId) || pipTabId < 0 || !Protocol.isPipKind(kind) || !safeRect || !Protocol.isDpr(dpr)) {
      return { ok: false };
    }
    await ready();
    const effectiveSourceTabId =
      kind === "popup" && Number.isInteger(sourceTabId) && sourceTabId >= 0
        ? sourceTabId
        : sourceByPopupTab.get(pipTabId) ?? pipTabId;
    if (kind === "popup" && Number.isFinite(effectiveSourceTabId)) {
      setPopupTab(effectiveSourceTabId, pipTabId);
    } else if (kind === "document") {
      allowChatFramingInTab(pipTabId);
    }
    const { pip } = await pipChanged(pipTabId, {
      v: 1,
      type: "PIP_OPENED",
      tabId: pipTabId,
      sourceTabId: effectiveSourceTabId,
      kind,
      rect: safeRect,
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
    const safeRect = Protocol.sanitizeRect(rect);
    if (sender?.tab?.id != null && safeRect) {
      if (!nativePort && engineAllowed) connectEngine();
      const { saved, pip } = await updatePipEntry(sender.tab.id, (prev) => (prev ? { ...prev, rect: safeRect } : null));
      if (saved && !saved.bound) {
        const { pipBounds } = await chrome.storage.local.get("pipBounds").catch(() => ({}));
        postPipOpened(saved, pip, pipBounds);
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
    if (Number.isInteger(tabId) && tabId >= 0) {
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
    const clampedDelta = Protocol.clampDeltaH(deltaH);
    if (clampedDelta === null || !Protocol.isDpr(dpr)) {
      return { ok: false, handledByEngine: false };
    }
    if (!nativePort) connectEngine();
    const tabId = sender?.tab?.id;
    const msg = { v: 1, type: "PIP_RESIZE", deltaH: clampedDelta, dpr };
    if (Number.isInteger(tabId) && tabId >= 0) msg.tabId = tabId;
    const handledByEngine = postToEngine(msg);
    return { ok: true, handledByEngine };
  },
  async GET_STATE() {
    const [{ settings, engineInstalled: storedInstalled }, { pip = {}, engine }, allSitesGranted] = await Promise.all([
      chrome.storage.local.get(["settings", "engineInstalled"]),
      chrome.storage.session.get(["pip", "engine"]),
      hasAllSitesPermission(),
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
      allSitesGranted,
      peekActive: Boolean(enginePeekActive),
      ...getDocPipStatus(pip),
    };
  },
  async PATCH_FLOAT_LAYOUT({ patch } = {}) {
    if (!patch || typeof patch !== "object") return { ok: false };
    const floatLayout = await updateFloatLayout((cur) => ({ ...cur, ...patch }));
    return { ok: true, floatLayout };
  },
  async PATCH_SETTINGS({ patch, keepLayoutPos }) {
    const res = await updateSettings((current) => GhostPiPSettings.patch(current, patch));
    if (res.ok && patch?.enabled === false) {
      engineAllowed = false;
      await closeAllPopupPips();
      await chrome.storage.session.set({ pip: {} });
      syncEngineSessionState({});
      broadcastPipSessionsChanged({});
      setTimeout(() => {
        if (!engineAllowed) disconnectEngine();
      }, 60);
    } else if (res.ok && patch?.enabled === true) {
      engineAllowed = true;
      retryEngine();
    }
    if (res.ok && patch?.dodge?.home && !keepLayoutPos) {
      await updateFloatLayout((cur) => (cur.pos || cur.pipPos ? { ...cur, pos: null, pipPos: null } : null));
      await chrome.storage.local.remove("pipBounds").catch(() => {});
    }
    return res;
  },
  async INTENT({ intent }) {
    const fn = INTENTS[intent];
    return fn ? fn() : { ok: false };
  },
  async MEDIA_ACTION({ action, deltaSec = 0, deltaVolume = 0, sourceTabId = null } = {}, sender) {
    if (!MEDIA_ACTIONS.includes(action)) return { ok: false };
    const targetTabId = await resolveTargetSourceTabId(sourceTabId, sender);
    return executeMediaAction(action, {
      deltaSec: Number(deltaSec) || 0,
      deltaVolume: Number(deltaVolume) || 0,
      tabId: targetTabId,
    });
  },
  async RECONNECT_ENGINE() {
    retryEngine();
    const { engine } = await chrome.storage.session.get("engine");
    return {
      ok: true,
      engine: { ...DEFAULT_ENGINE, ...(engine && typeof engine === "object" ? engine : {}) },
    };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id && sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
