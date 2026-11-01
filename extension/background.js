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
let inTabSession = null;
let inTabSeq = 0;
let lastInTabFrame = null;
let senderStreamPort = null;
let receiverPortSeq = 0;
const receiverStreamPorts = new Map();

async function getInTab() {
  if (inTabSession) return inTabSession;
  const { inTab } = await chrome.storage.session.get("inTab");
  if (inTab && Number.isFinite(inTab.sourceTabId)) {
    inTabSession = inTab;
    inTabSeq = Math.max(inTabSeq, inTab.connId || 0);
  }
  return inTabSession;
}

async function setInTab(next) {
  inTabSession = next;
  if (!next) lastInTabFrame = null;
  if (next) await chrome.storage.session.set({ inTab: next });
  else await chrome.storage.session.remove("inTab");
}

function sendTab(tabId, msg) {
  if (!Number.isFinite(tabId)) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, { v: 1, ...msg }).catch(() => null);
}

async function broadcastRemoteStop(excludeTabId = null) {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && t.id !== excludeTabId) {
        sendTab(t.id, { type: "REMOTE_INTAB_STOP" });
      }
    }
  } catch {}
}

function prewarmTab(tabId, session) {
  if (!Number.isFinite(tabId) || !session?.sourceTabId || tabId === session.sourceTabId) {
    return Promise.resolve(null);
  }
  return sendTab(tabId, {
    type: "REMOTE_INTAB_START",
    connId: session.connId,
    ratio: session.ratio || 9 / 16,
    vw: session.vw || 0,
    vh: session.vh || 0,
    chatUrl: session.chatUrl || null,
    initialFrame: lastInTabFrame,
    sourceTabId: session.sourceTabId,
  });
}

async function prewarmRemoteTabs(session) {
  if (!session?.sourceTabId || !chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && t.id !== session.sourceTabId) {
        prewarmTab(t.id, session);
      }
    }
  } catch {}
}

async function syncActiveTab(activeTabId) {
  if (!Number.isFinite(activeTabId)) return;
  const session = inTabSession || (await getInTab());
  if (!session?.sourceTabId) return;

  if (activeTabId === session.sourceTabId) {
    if (session.receiverTabId) {
      session.receiverTabId = null;
      session.connId = ++inTabSeq;
      setInTab(session);
    }
    return;
  }

  const connId = ++inTabSeq;
  const sourceTabId = session.sourceTabId;
  session.receiverTabId = activeTabId;
  session.connId = connId;
  setInTab(session);

  const immediateStart = prewarmTab(activeTabId, session);

  const info = await sendTab(sourceTabId, { type: "INTAB_QUERY_SOURCE" });
  if (!info?.ok || inTabSession?.sourceTabId !== sourceTabId || inTabSession?.receiverTabId !== activeTabId) {
    return;
  }

  if (info.ratio) session.ratio = info.ratio;
  if (info.vw > 0 && info.vh > 0) {
    session.vw = info.vw;
    session.vh = info.vh;
  }
  if (info.chatUrl !== undefined) session.chatUrl = info.chatUrl;
  if (info.frame?.dataUrl) lastInTabFrame = info.frame;

  const started = (await immediateStart) || (await prewarmTab(activeTabId, session));
  if (!started?.ok && inTabSession?.connId === connId) {
    inTabSession.receiverTabId = null;
    await setInTab(inTabSession);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ghostpip-sender") {
    senderStreamPort = port;
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "FRAME" && msg.dataUrl) {
        lastInTabFrame = msg;
        if (inTabSession && msg.vw > 0 && msg.vh > 0) {
          inTabSession.vw = msg.vw;
          inTabSession.vh = msg.vh;
          inTabSession.ratio = msg.vh / msg.vw;
        }
      }
      if (msg.portId && receiverStreamPorts.has(msg.portId)) {
        try {
          receiverStreamPorts.get(msg.portId).postMessage(msg);
        } catch {}
        return;
      }
      for (const rp of receiverStreamPorts.values()) {
        try {
          rp.postMessage(msg);
        } catch {}
      }
    });
    port.onDisconnect.addListener(() => {
      if (senderStreamPort === port) senderStreamPort = null;
    });
  } else if (port.name === "ghostpip-receiver") {
    const portId = ++receiverPortSeq;
    receiverStreamPorts.set(portId, port);
    if (lastInTabFrame) {
      try {
        port.postMessage(lastInTabFrame);
      } catch {}
    }
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      const tagged = { ...msg, portId };
      if (senderStreamPort) {
        try {
          senderStreamPort.postMessage(tagged);
        } catch {}
      } else {
        getInTab().then((s) => {
          if (s?.sourceTabId) sendTab(s.sourceTabId, { type: "INTAB_RECONNECT_SENDER" });
        });
      }
    });
    port.onDisconnect.addListener(() => {
      receiverStreamPorts.delete(portId);
      if (senderStreamPort) {
        try {
          senderStreamPort.postMessage({ type: "RTC_CLOSE", portId });
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

function updateSettings(mutator) {
  const run = settingsQueue.then(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    const current = GhostPiPSettings.merge(settings);
    const res = mutator(current);
    if (res.ok) {
      await chrome.storage.local.set({ settings: res.settings });
      if (res.settings.enabled && !nativePort) connectEngine();
      postToEngine({ v: 1, type: "STATE", settings: res.settings });
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
    const next = mutator(pip[tabId]);
    if (next) pip[tabId] = next;
    else delete pip[tabId];
    await chrome.storage.session.set({ pip });
    return next;
  });
  pipQueue = run.catch(() => {});
  return run;
}

function pipChanged(tabId, entry) {
  const run = updatePipEntry(tabId, () => entry).then((saved) => {
    if (!nativePort) connectEngine();
    if (saved) {
      postToEngine({
        v: 1,
        type: "PIP_OPENED",
        tabId: saved.tabId,
        kind: saved.kind,
        rect: saved.rect,
        dpr: saved.dpr,
      });
    } else {
      postToEngine({ v: 1, type: "PIP_CLOSED", tabId });
    }
  });
  return run;
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
              for (const id of ids) sendTab(id, { type: "PIP_TOGGLE_CHAT" });
            } else if (chrome.tabs?.query) {
              chrome.tabs
                .query({})
                .then((tabs) => {
                  for (const t of tabs) {
                    if (t.id != null && (!t.url || /^https?:/i.test(t.url))) {
                      sendTab(t.id, { type: "PIP_TOGGLE_CHAT" });
                    }
                  }
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      } else if (INTENTS[msg.intent]) {
        INTENTS[msg.intent]();
      }
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
                    if (t.id != null && (!t.url || /^https?:/i.test(t.url))) {
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
  chrome.storage.session.set({ engine: { ...DEFAULT_ENGINE, installed: engineInstalled } });
}

function onEngineDisconnect(port) {
  void chrome.runtime.lastError;
  stopPing();
  if (nativePort === port) nativePort = null;
  if (!port?.__gotHello && !port?.__intentionalDisconnect && engineAllowed) {
    engineInstalled = false;
    chrome.storage.local.set({ engineInstalled: false }).catch(() => {});
  }
  chrome.storage.session.set({ engine: { ...DEFAULT_ENGINE, installed: engineInstalled } });
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

  Promise.all([chrome.storage.local.get(["settings", "engineInstalled"]), chrome.storage.session.get("pip")])
    .then(([{ settings, engineInstalled: storedInstalled }, { pip = {} }]) => {
      if (typeof storedInstalled === "boolean" && !engineInstalled) {
        engineInstalled = storedInstalled;
      }
      const merged = GhostPiPSettings.merge(settings);
      engineAllowed = Boolean(merged.enabled);
      if (nativePort !== port) return;
      postToEngine({ v: 1, type: "STATE", settings: merged });
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
          postToEngine({
            v: 1,
            type: "PIP_OPENED",
            tabId: entry.tabId,
            kind: entry.kind,
            rect: entry.rect,
            dpr: entry.dpr,
          });
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
                files: ["shared/settings.js", "content/dodge.js", "content/content.js"],
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncActiveTab(tabId);
});

chrome.tabs.onUpdated?.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const session = inTabSession || (await getInTab());
  if (session?.sourceTabId && tabId !== session.sourceTabId) {
    prewarmTab(tabId, session);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  pipChanged(tabId, null);
  const session = await getInTab();
  if (!session) return;
  if (session.sourceTabId === tabId) {
    await setInTab(null);
    await broadcastRemoteStop(tabId);
  } else if (session.receiverTabId === tabId) {
    session.receiverTabId = null;
    session.connId = ++inTabSeq;
    await setInTab(session);
  }
});

async function findMuteTargetTab() {
  const { pip = {} } = await chrome.storage.session.get("pip");
  const pipIds = Object.keys(pip).map(Number).filter(Number.isFinite);
  for (let i = pipIds.length - 1; i >= 0; i--) {
    try {
      return await chrome.tabs.get(pipIds[i]);
    } catch {}
  }
  const session = await getInTab();
  if (session?.sourceTabId) {
    try {
      return await chrome.tabs.get(session.sourceTabId);
    } catch {}
  }
  const tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter((t) => t.id != null && (!t.url || /^https?:/i.test(t.url)));
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

const INTENTS = {
  TOGGLE_CLICK_THROUGH: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { clickThrough: !s.clickThrough })),
  TOGGLE_DODGE: () =>
    updateSettings((s) => GhostPiPSettings.patch(s, { dodge: { enabled: !s.dodge.enabled } })),
  TOGGLE_MUTE: async () => {
    const tab = await findMuteTargetTab();
    if (!tab) return { ok: false };
    const muted = !tab.mutedInfo?.muted;
    const updated = await chrome.tabs.update(tab.id, { muted });
    return { ok: true, tabId: tab.id, muted: updated?.mutedInfo?.muted ?? muted };
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
};

chrome.commands.onCommand.addListener((command) => {
  dispatchCommand(command);
});

const handlers = {
  async GET_SITE_CONFIG({ url }, sender) {
    const found = (await loadSites()).find(({ re }) => re.test(url));
    if (sender?.tab?.id != null) {
      if (sender.tab.active) {
        syncActiveTab(sender.tab.id);
      } else {
        const session = inTabSession || (await getInTab());
        if (session?.sourceTabId && sender.tab.id !== session.sourceTabId) {
          prewarmTab(sender.tab.id, session);
        }
      }
    }
    return found ? { siteId: found.siteId, site: found.site } : GENERIC_SITE;
  },
  async INTAB_OPENED({ ratio, vw, vh, chatUrl, frame } = {}, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return { ok: false };
    const prev = await getInTab();
    if (prev?.sourceTabId && prev.sourceTabId !== tabId) {
      sendTab(prev.sourceTabId, { type: "INTAB_FORCE_IDLE" });
      await broadcastRemoteStop(tabId);
    }
    if (frame?.dataUrl) lastInTabFrame = frame;
    const next = {
      sourceTabId: tabId,
      receiverTabId: null,
      connId: ++inTabSeq,
      ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 9 / 16,
      vw: Number.isFinite(vw) && vw > 0 ? vw : frame?.vw || 0,
      vh: Number.isFinite(vh) && vh > 0 ? vh : frame?.vh || 0,
      chatUrl: chatUrl || null,
    };
    await setInTab(next);
    prewarmRemoteTabs(next);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id != null && activeTab.id !== tabId) {
      syncActiveTab(activeTab.id);
    }
    return { ok: true };
  },
  async INTAB_CLOSED(_msg, sender) {
    const tabId = sender?.tab?.id;
    const session = await getInTab();
    if (session?.sourceTabId === tabId) {
      await setInTab(null);
      await broadcastRemoteStop(tabId);
    }
    return { ok: true };
  },
  async INTAB_STOP_ALL() {
    const session = await getInTab();
    if (session) {
      const srcId = session.sourceTabId;
      await setInTab(null);
      if (srcId) sendTab(srcId, { type: "INTAB_FORCE_IDLE" });
      await broadcastRemoteStop();
    }
    return { ok: true };
  },
  async FOCUS_SOURCE_TAB(_msg, sender) {
    const session = await getInTab();
    const targetTabId = session?.sourceTabId ?? sender?.tab?.id;
    if (Number.isFinite(targetTabId)) {
      const tab = await chrome.tabs.update(targetTabId, { active: true }).catch(() => null);
      if (tab?.windowId != null) {
        await chrome.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      }
    }
    return { ok: true };
  },
  async SKIP_AD() {
    const session = await getInTab();
    if (session?.sourceTabId) {
      await sendTab(session.sourceTabId, { type: "INTAB_SKIP_AD" });
    }
    return { ok: true };
  },
  async PIP_OPENED({ kind, rect, dpr }, sender) {
    await pipChanged(sender.tab.id, { v: 1, type: "PIP_OPENED", tabId: sender.tab.id, kind, rect, dpr });
    const { engine } = await chrome.storage.session.get("engine");
    return { ok: true, engineConnected: Boolean(engine?.connected) };
  },
  async PIP_RECT_UPDATED({ rect }, sender) {
    if (sender?.tab?.id != null && rect) {
      if (!nativePort && engineAllowed) connectEngine();
      const saved = await updatePipEntry(sender.tab.id, (prev) => (prev ? { ...prev, rect } : null));
      if (saved && !saved.bound) {
        postToEngine({
          v: 1,
          type: "PIP_OPENED",
          tabId: saved.tabId,
          kind: saved.kind,
          rect: saved.rect,
          dpr: saved.dpr,
        });
      }
    }
    return { ok: true };
  },
  async PIP_CLOSED(_msg, sender) {
    await pipChanged(sender.tab.id, null);
    return { ok: true };
  },
  async PIP_RESIZE({ deltaH, dpr }) {
    if (!nativePort) connectEngine();
    const handledByEngine = postToEngine({ v: 1, type: "PIP_RESIZE", deltaH, dpr });
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
    };
  },
  async PATCH_SETTINGS({ patch, keepLayoutPos }) {
    const res = await updateSettings((current) => GhostPiPSettings.patch(current, patch));
    if (res.ok && patch?.enabled === false) {
      engineAllowed = false;
      await handlers.INTAB_STOP_ALL();
      await chrome.storage.session.set({ pip: {} });
      setTimeout(() => {
        if (!engineAllowed) disconnectEngine();
      }, 60);
    } else if (res.ok && patch?.enabled === true) {
      engineAllowed = true;
      connectEngine();
    }
    if (res.ok && patch?.dodge?.home && !keepLayoutPos) {
      const { floatLayout } = await chrome.storage.local.get("floatLayout");
      if (floatLayout?.pos) {
        await chrome.storage.local.set({ floatLayout: { ...floatLayout, pos: null } });
      }
    }
    return res;
  },
  async INTENT({ intent }) {
    const fn = INTENTS[intent];
    return fn ? fn() : { ok: false };
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
