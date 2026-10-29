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

chrome.tabs.onRemoved.addListener((tabId) => {
  pipChanged(tabId, null);
});

async function findMuteTargetTab() {
  const { pip = {} } = await chrome.storage.session.get("pip");
  const pipIds = Object.keys(pip).map(Number).filter(Number.isFinite);
  for (let i = pipIds.length - 1; i >= 0; i--) {
    try {
      return await chrome.tabs.get(pipIds[i]);
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
  async GET_SITE_CONFIG({ url }) {
    const found = (await loadSites()).find(({ re }) => re.test(url));
    return found ? { siteId: found.siteId, site: found.site } : GENERIC_SITE;
  },
  async PIP_OPENED({ kind, rect, dpr }, sender) {
    await pipChanged(sender.tab.id, { v: 1, type: "PIP_OPENED", tabId: sender.tab.id, kind, rect, dpr });
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
  async PATCH_SETTINGS({ patch }) {
    return updateSettings((current) => GhostPiPSettings.patch(current, patch));
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
