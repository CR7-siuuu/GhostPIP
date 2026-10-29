importScripts("shared/settings.js");

const HOST_NAME = "app.ghostpip.engine";
const GENERIC_SITE = { siteId: "generic", site: { video: null, chatPopoutUrl: null } };
const DEFAULT_ENGINE = {
  connected: false,
  engineVersion: null,
  elevated: false,
  hotkeyErrors: [],
  protocolMismatch: false,
};

let settingsQueue = Promise.resolve();
let pipQueue = Promise.resolve();
let sitesPromise = null;
let nativePort = null;
let inTabSession = null;
let inTabSeq = 0;
let senderStreamPort = null;
let receiverStreamPort = null;

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
  if (next) await chrome.storage.session.set({ inTab: next });
  else await chrome.storage.session.remove("inTab");
}

function sendTab(tabId, msg) {
  if (!Number.isFinite(tabId)) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, { v: 1, ...msg }).catch(() => null);
}

async function syncActiveTab(activeTabId) {
  if (!Number.isFinite(activeTabId)) return;
  const session = await getInTab();
  if (!session?.sourceTabId) return;

  if (activeTabId === session.sourceTabId) {
    if (session.receiverTabId) {
      const oldReceiver = session.receiverTabId;
      session.receiverTabId = null;
      session.connId = ++inTabSeq;
      await setInTab(session);
      sendTab(oldReceiver, { type: "REMOTE_INTAB_STOP" });
    }
    return;
  }

  if (session.receiverTabId && session.receiverTabId !== activeTabId) {
    sendTab(session.receiverTabId, { type: "REMOTE_INTAB_STOP" });
  }
  const connId = ++inTabSeq;
  const sourceTabId = session.sourceTabId;
  session.receiverTabId = activeTabId;
  session.connId = connId;
  await setInTab(session);

  const info = await sendTab(sourceTabId, { type: "INTAB_QUERY_SOURCE" });
  if (!info?.ok || inTabSession?.sourceTabId !== sourceTabId || inTabSession?.receiverTabId !== activeTabId) {
    return;
  }

  const started = await sendTab(activeTabId, {
    type: "REMOTE_INTAB_START",
    connId,
    ratio: info.ratio,
    sourceTabId,
  });
  if (!started?.ok && inTabSession?.connId === connId) {
    inTabSession.receiverTabId = null;
    await setInTab(inTabSession);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ghostpip-sender") {
    senderStreamPort = port;
    port.onMessage.addListener((msg) => {
      if (receiverStreamPort && msg) {
        try {
          receiverStreamPort.postMessage(msg);
        } catch {}
      }
    });
    port.onDisconnect.addListener(() => {
      if (senderStreamPort === port) senderStreamPort = null;
    });
  } else if (port.name === "ghostpip-receiver") {
    receiverStreamPort = port;
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (senderStreamPort) {
        try {
          senderStreamPort.postMessage(msg);
        } catch {}
      } else {
        getInTab().then((s) => {
          if (s?.sourceTabId) sendTab(s.sourceTabId, { type: "INTAB_RECONNECT_SENDER" });
        });
      }
    });
    port.onDisconnect.addListener(() => {
      if (receiverStreamPort === port) receiverStreamPort = null;
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

function updateSettings(mutator) {
  const run = settingsQueue.then(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    const current = GhostPiPSettings.merge(settings);
    const res = mutator(current);
    if (res.ok) {
      await chrome.storage.local.set({ settings: res.settings });
      postToEngine({ v: 1, type: "STATE", settings: res.settings });
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
      const engine = {
        connected: true,
        engineVersion: typeof msg.engineVersion === "string" ? msg.engineVersion : "0.1.0",
        elevated: Boolean(msg.elevated),
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
  }
}

function onEngineDisconnect(port) {
  void chrome.runtime.lastError;
  if (nativePort === port) nativePort = null;
  chrome.storage.session.set({ engine: { ...DEFAULT_ENGINE } });
}

function connectEngine() {
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

  Promise.all([chrome.storage.local.get("settings"), chrome.storage.session.get("pip")])
    .then(([{ settings }, { pip = {} }]) => {
      if (nativePort !== port) return;
      postToEngine({ v: 1, type: "STATE", settings: GhostPiPSettings.merge(settings) });
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

chrome.runtime.onInstalled.addListener(() => {
  updateSettings((s) => ({ ok: true, settings: s }));
  connectEngine();
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  pipChanged(tabId, null);
  const session = await getInTab();
  if (!session) return;
  if (session.sourceTabId === tabId) {
    if (session.receiverTabId) sendTab(session.receiverTabId, { type: "REMOTE_INTAB_STOP" });
    await setInTab(null);
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
    if (sender?.tab?.active && sender.tab.id != null) {
      syncActiveTab(sender.tab.id);
    }
    return found ? { siteId: found.siteId, site: found.site } : GENERIC_SITE;
  },
  async INTAB_OPENED(_msg, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return { ok: false };
    const prev = await getInTab();
    if (prev?.sourceTabId && prev.sourceTabId !== tabId) {
      sendTab(prev.sourceTabId, { type: "INTAB_FORCE_IDLE" });
      if (prev.receiverTabId) sendTab(prev.receiverTabId, { type: "REMOTE_INTAB_STOP" });
    }
    const next = { sourceTabId: tabId, receiverTabId: null, connId: ++inTabSeq };
    await setInTab(next);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id != null && activeTab.id !== tabId) {
      syncActiveTab(activeTab.id, true);
    }
    return { ok: true };
  },
  async INTAB_CLOSED(_msg, sender) {
    const tabId = sender?.tab?.id;
    const session = await getInTab();
    if (session?.sourceTabId === tabId) {
      if (session.receiverTabId) sendTab(session.receiverTabId, { type: "REMOTE_INTAB_STOP" });
      await setInTab(null);
    }
    return { ok: true };
  },
  async INTAB_STOP_ALL() {
    const session = await getInTab();
    if (session) {
      await setInTab(null);
      if (session.sourceTabId) sendTab(session.sourceTabId, { type: "INTAB_FORCE_IDLE" });
      if (session.receiverTabId) sendTab(session.receiverTabId, { type: "REMOTE_INTAB_STOP" });
    }
    return { ok: true };
  },
  async FOCUS_SOURCE_TAB() {
    const session = await getInTab();
    if (session?.sourceTabId) {
      await chrome.tabs.update(session.sourceTabId, { active: true }).catch(() => {});
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
      await updatePipEntry(sender.tab.id, (prev) => (prev ? { ...prev, rect } : null));
    }
    return { ok: true };
  },
  async PIP_CLOSED(_msg, sender) {
    await pipChanged(sender.tab.id, null);
    return { ok: true };
  },
  async GET_STATE() {
    const [{ settings }, { pip = {}, engine }] = await Promise.all([
      chrome.storage.local.get("settings"),
      chrome.storage.session.get(["pip", "engine"]),
    ]);
    return {
      settings: GhostPiPSettings.merge(settings),
      pip,
      engine: { ...DEFAULT_ENGINE, ...(engine && typeof engine === "object" ? engine : {}) },
    };
  },
  async PATCH_SETTINGS({ patch, keepLayoutPos }) {
    const res = await updateSettings((current) => GhostPiPSettings.patch(current, patch));
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
