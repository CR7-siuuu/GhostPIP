(() => {
  const $ = (id) => document.getElementById(id);
  const { t, apply: applyI18n } = globalThis.GhostPiPI18n;
  const send = (msg) => chrome.runtime.sendMessage({ v: 1, ...msg }).catch(() => null);
  applyI18n();

  function renderEngine(engine) {
    const on = Boolean(engine?.connected);
    $("status").dataset.state = on ? "on" : "off";
    $("status").textContent = on ? t("engineConnected") : t("guideEngineMissing");
  }

  function renderHotkeys(stored) {
    const s = globalThis.GhostPiPSettings.merge(stored);
    for (const el of document.querySelectorAll("kbd.hold")) el.textContent = s.hotkeys.hold;
    $("hkClick").textContent = s.hotkeys.clickThrough;
    $("hkDodge").textContent = s.hotkeys.dodge;
    $("hkMute").textContent = s.hotkeys.mute;
  }

  $("retry").addEventListener("click", async () => {
    $("status").textContent = t("guideChecking");
    const res = await send({ type: "RECONNECT_ENGINE" });
    setTimeout(async () => {
      const { engine } = await chrome.storage.session.get("engine");
      renderEngine(engine ?? res?.engine);
    }, 600);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.engine) renderEngine(changes.engine.newValue);
    if (area === "local" && changes.settings) renderHotkeys(changes.settings.newValue);
  });

  chrome.storage.local.get("settings").then(({ settings }) => renderHotkeys(settings));
  send({ type: "GET_STATE" }).then((res) => renderEngine(res?.engine));
})();
