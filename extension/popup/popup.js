(() => {
  const Settings = globalThis.GhostPiPSettings;
  const DEFAULT_ENGINE = {
    connected: false,
    engineVersion: null,
    elevated: false,
    hotkeyErrors: [],
    protocolMismatch: false,
  };

  const els = {
    modeBadge: document.getElementById("modeBadge"),
    engineWarning: document.getElementById("engineWarning"),
    clickThrough: document.getElementById("clickThrough"),
    dodgeEnabled: document.getElementById("dodgeEnabled"),
    showChat: document.getElementById("showChat"),
    opacity: document.getElementById("opacity"),
    opacityValue: document.getElementById("opacityValue"),
    wheelSubHint: document.getElementById("wheelSubHint"),
    toggleMute: document.getElementById("toggleMute"),
    corners: [...document.querySelectorAll("input[data-corner]")],
    home: document.getElementById("home"),
    axis: document.getElementById("axis"),
    style: document.getElementById("style"),
    autoReturn: document.getElementById("autoReturn"),
    hold: document.getElementById("hold"),
    engineBanner: document.getElementById("engineBanner"),
  };

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

    els.modeBadge.textContent = engine.connected ? "Engine Active" : "In-Tab Mode";
    els.modeBadge.toggleAttribute("data-active", Boolean(engine.connected));
    els.engineBanner.hidden = Boolean(engine.connected);

    const warnings = [];
    if (engine.protocolMismatch) {
      warnings.push("엔진 프로토콜 버전 불일치");
    }
    if (Array.isArray(engine.hotkeyErrors) && engine.hotkeyErrors.length > 0) {
      warnings.push(`단축키 충돌: ${engine.hotkeyErrors.join(", ")}`);
    }
    els.engineWarning.hidden = warnings.length === 0;
    els.engineWarning.textContent = warnings.join(" · ");

    els.clickThrough.checked = settings.clickThrough;
    els.dodgeEnabled.checked = dodge.enabled;
    if (els.showChat) els.showChat.checked = Boolean(settings.showChat);

    const pct = Math.round(settings.opacity * 100);
    els.opacity.value = String(pct);
    els.opacityValue.textContent = `${pct}%`;

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
      els.wheelSubHint.textContent = `클릭 통과 시 ${hotkeys.hold} + 휠`;
    }
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

  els.clickThrough.addEventListener("change", () => applyIntent("TOGGLE_CLICK_THROUGH"));
  els.dodgeEnabled.addEventListener("change", () => applyIntent("TOGGLE_DODGE"));
  els.showChat?.addEventListener("change", () => applyPatch({ showChat: els.showChat.checked }));

  els.opacity.addEventListener("input", () => {
    const val = Number(els.opacity.value);
    els.opacityValue.textContent = `${val}%`;
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

  els.engineBanner.addEventListener("click", async () => {
    const res = await send({ type: "RECONNECT_ENGINE" });
    if (res?.engine) {
      state.engine = { ...DEFAULT_ENGINE, ...res.engine };
      render();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      state.settings = Settings.merge(changes.settings.newValue);
      render();
    } else if (area === "session" && changes.engine) {
      state.engine = { ...DEFAULT_ENGINE, ...(changes.engine.newValue ?? {}) };
      render();
    }
  });

  send({ type: "GET_STATE" }).then((res) => {
    if (!res) return;
    state.settings = Settings.merge(res.settings);
    state.engine = { ...DEFAULT_ENGINE, ...(res.engine ?? {}) };
    render();
  });
})();
