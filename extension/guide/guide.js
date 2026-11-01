(() => {
  const $ = (id) => document.getElementById(id);
  const send = (msg) => chrome.runtime.sendMessage({ v: 1, ...msg }).catch(() => null);

  function renderEngine(engine) {
    const on = Boolean(engine?.connected);
    $("status").dataset.state = on ? "on" : "off";
    $("status").textContent = on ? "엔진 연결됨" : "엔진 미설치";
  }

  function renderHotkeys(stored) {
    const s = globalThis.GhostPiPSettings.merge(stored);
    for (const el of [$("holdKey"), ...document.querySelectorAll("kbd.hold")]) el.textContent = s.hotkeys.hold;
    $("hkClick").textContent = s.hotkeys.clickThrough;
    $("hkDodge").textContent = s.hotkeys.dodge;
    $("hkMute").textContent = s.hotkeys.mute;
  }

  $("retry").addEventListener("click", async () => {
    $("status").textContent = "확인 중…";
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
