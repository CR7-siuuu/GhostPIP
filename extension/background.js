importScripts("shared/settings.js");

const GENERIC_SITE = { siteId: "generic", site: { video: null, chatPopoutUrl: null } };

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: GhostPiPSettings.DEFAULTS });
});

let sitesPromise = null;

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

// Single place PiP lifecycle lands; Phase 4 also forwards these to the engine port from here.
async function pipChanged(tabId, entry) {
  const { pip = {} } = await chrome.storage.session.get("pip");
  if (entry) pip[tabId] = entry;
  else delete pip[tabId];
  await chrome.storage.session.set({ pip });
}

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
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
