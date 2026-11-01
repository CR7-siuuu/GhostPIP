(() => {
  const Settings = globalThis.GhostPiPSettings;
  const DEFAULT_ENGINE = {
    connected: false,
    installed: false,
    engineVersion: null,
    elevated: false,
    hotkeyErrors: [],
    protocolMismatch: false,
  };

  const els = {
    modeBadge: document.getElementById("modeBadge"),
    engineWarning: document.getElementById("engineWarning"),
    enabled: document.getElementById("enabled"),
    clickThrough: document.getElementById("clickThrough"),
    dodgeEnabled: document.getElementById("dodgeEnabled"),
    showChat: document.getElementById("showChat"),
    allSites: document.getElementById("allSites"),
    opacity: document.getElementById("opacity"),
    opacityValue: document.getElementById("opacityValue"),
    wheelSubHint: document.getElementById("wheelSubHint"),
    toggleMute: document.getElementById("toggleMute"),
    kbdClickThrough: document.getElementById("kbdClickThrough"),
    kbdDodge: document.getElementById("kbdDodge"),
    kbdMute: document.getElementById("kbdMute"),
    tipHoldKey: document.getElementById("tipHoldKey"),
    hotkeyBtns: [...document.querySelectorAll("button[data-hotkey]")],
    resetHotkeys: document.getElementById("resetHotkeys"),
    corners: [...document.querySelectorAll("input[data-corner]")],
    home: document.getElementById("home"),
    axis: document.getElementById("axis"),
    style: document.getElementById("style"),
    autoReturn: document.getElementById("autoReturn"),
    hold: document.getElementById("hold"),
    engineBanner: document.getElementById("engineBanner"),
  };

  let recordingTarget = null;

  let state = {
    settings: Settings.merge(undefined),
    engine: { ...DEFAULT_ENGINE },
  };

  function send(msg) {
    return chrome.runtime.sendMessage({ v: 1, ...msg });
  }

  function render() {
    const { settings, engine } = state;
    const { dodge, hotkeys } = settings;
    const isEnabled = Boolean(settings.enabled);

    document.body.toggleAttribute("data-disabled", !isEnabled);
    els.modeBadge.textContent = !isEnabled ? "꺼짐" : engine.connected ? "엔진 연결됨" : "웹 모드";
    els.modeBadge.toggleAttribute("data-active", isEnabled && Boolean(engine.connected));
    els.modeBadge.toggleAttribute("data-disabled", !isEnabled);
    els.engineBanner.hidden = Boolean(engine.connected || engine.installed);

    const warnings = [];
    if (engine.protocolMismatch) {
      warnings.push("엔진 프로토콜 버전 불일치");
    }
    if (Array.isArray(engine.hotkeyErrors) && engine.hotkeyErrors.length > 0) {
      warnings.push(`단축키 충돌: ${engine.hotkeyErrors.join(", ")}`);
    }
    els.engineWarning.hidden = warnings.length === 0;
    els.engineWarning.textContent = warnings.join(" · ");

    if (els.enabled) els.enabled.checked = isEnabled;
    els.clickThrough.checked = settings.clickThrough;
    els.dodgeEnabled.checked = dodge.enabled;
    if (els.showChat) els.showChat.checked = Boolean(settings.showChat);
    els.allSites.checked = settings.allSites;

    showOpacity(Math.round(settings.opacity * 100));

    for (const input of els.corners) {
      const corner = input.dataset.corner;
      const checked = dodge.allowed.includes(corner);
      input.checked = checked;
      const nextAllowed = dodge.allowed.filter((c) => c !== corner);
      input.disabled = checked && !Settings.isValidDodge(nextAllowed, dodge.axis, dodge.home);
    }

    for (const opt of els.home.options) {
      opt.disabled = !Settings.isValidDodge(dodge.allowed, dodge.axis, opt.value);
    }
    els.home.value = dodge.home;

    for (const opt of els.axis.options) {
      opt.disabled = !Settings.isValidDodge(dodge.allowed, opt.value, dodge.home);
    }
    els.axis.value = dodge.axis;

    els.style.value = dodge.style;
    els.autoReturn.checked = dodge.autoReturn;
    els.hold.value = hotkeys.hold;
    if (els.wheelSubHint) {
      els.wheelSubHint.textContent = `영상 위 휠로도 조절 · 클릭 통과 중엔 ${hotkeys.hold} + 휠`;
    }
    if (els.tipHoldKey) {
      els.tipHoldKey.textContent = hotkeys.hold;
    }
    if (els.kbdClickThrough) els.kbdClickThrough.textContent = hotkeys.clickThrough;
    if (els.kbdDodge) els.kbdDodge.textContent = hotkeys.dodge;
    if (els.kbdMute) els.kbdMute.textContent = hotkeys.mute;
    for (const btn of els.hotkeyBtns) {
      const key = btn.dataset.hotkey;
      const isRec = recordingTarget === key;
      btn.toggleAttribute("data-recording", isRec);
      btn.textContent = isRec ? "키 입력 · Esc 취소" : hotkeys[key];
    }
  }

  function showOpacity(pct) {
    els.opacity.value = String(pct);
    els.opacity.style.setProperty("--fill", `${((pct - 10) / 90) * 100}%`);
    els.opacityValue.textContent = `${pct}%`;
  }

  async function applyPatch(partial) {
    const local = Settings.patch(state.settings, partial);
    if (local.ok) {
      state.settings = local.settings;
      render();
    }
    const res = await send({ type: "PATCH_SETTINGS", patch: partial });
    if (res?.settings) {
      state.settings = Settings.merge(res.settings);
      render();
    }
  }

  async function applyIntent(intent) {
    const res = await send({ type: "INTENT", intent });
    if (res?.settings) {
      state.settings = Settings.merge(res.settings);
      render();
    }
  }

  els.enabled?.addEventListener("change", () => applyPatch({ enabled: els.enabled.checked }));
  els.clickThrough.addEventListener("change", () => applyIntent("TOGGLE_CLICK_THROUGH"));
  els.dodgeEnabled.addEventListener("change", () => applyIntent("TOGGLE_DODGE"));
  els.showChat?.addEventListener("change", () => applyPatch({ showChat: els.showChat.checked }));
  els.allSites.addEventListener("change", () => applyPatch({ allSites: els.allSites.checked }));

  els.opacity.addEventListener("input", () => {
    const val = Number(els.opacity.value);
    showOpacity(val);
    applyPatch({ opacity: val / 100 });
  });

  els.toggleMute.addEventListener("click", () => applyIntent("TOGGLE_MUTE"));

  for (const input of els.corners) {
    input.addEventListener("change", () => {
      const corner = input.dataset.corner;
      const current = state.settings.dodge.allowed;
      const nextAllowed = input.checked
        ? Settings.CORNERS.filter((c) => current.includes(c) || c === corner)
        : current.filter((c) => c !== corner);
      applyPatch({ dodge: { allowed: nextAllowed } });
    });
  }

  els.home.addEventListener("change", () => applyPatch({ dodge: { home: els.home.value } }));
  els.axis.addEventListener("change", () => applyPatch({ dodge: { axis: els.axis.value } }));
  els.style.addEventListener("change", () => applyPatch({ dodge: { style: els.style.value } }));
  els.autoReturn.addEventListener("change", () => applyPatch({ dodge: { autoReturn: els.autoReturn.checked } }));
  els.hold.addEventListener("change", () => applyPatch({ hotkeys: { hold: els.hold.value } }));

  for (const btn of els.hotkeyBtns) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.hotkey;
      recordingTarget = recordingTarget === key ? null : key;
      render();
    });
  }

  window.addEventListener("keydown", (e) => {
    if (!recordingTarget) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      recordingTarget = null;
      render();
      return;
    }
    const combo = Settings.formatKeyEvent(e);
    if (!combo) return;
    const target = recordingTarget;
    recordingTarget = null;
    applyPatch({ hotkeys: { [target]: combo } });
  }, true);

  els.resetHotkeys?.addEventListener("click", () => {
    recordingTarget = null;
    applyPatch({ hotkeys: { ...Settings.DEFAULTS.hotkeys } });
  });

  els.engineBanner.addEventListener("click", async () => {
    const res = await send({ type: "RECONNECT_ENGINE" });
    if (res?.engine) {
      state.engine = { ...DEFAULT_ENGINE, ...res.engine };
      render();
    }
    setTimeout(() => {
      if (!state.engine.connected) chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html#engineCard") });
    }, 800);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      state.settings = Settings.merge(changes.settings.newValue);
      render();
    } else if (area === "session" && changes.engine) {
      const nextEngine = changes.engine.newValue ?? {};
      state.engine = {
        ...DEFAULT_ENGINE,
        ...nextEngine,
        installed: Boolean(nextEngine.connected || nextEngine.installed),
      };
      render();
    }
  });

  send({ type: "GET_STATE" }).then((res) => {
    if (!res) return;
    state.settings = Settings.merge(res.settings);
    const nextEngine = res.engine ?? {};
    state.engine = {
      ...DEFAULT_ENGINE,
      ...nextEngine,
      installed: Boolean(nextEngine.connected || nextEngine.installed),
    };
    render();
  });
})();
