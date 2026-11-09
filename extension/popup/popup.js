(() => {
  const Settings = globalThis.GhostPiPSettings;
  const { t, apply: applyI18n } = globalThis.GhostPiPI18n;
  applyI18n();
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
    peekEnabled: document.getElementById("peekEnabled"),
    mediaEnabled: document.getElementById("mediaEnabled"),
    showChat: document.getElementById("showChat"),
    allSites: document.getElementById("allSites"),
    allSitesHint: document.getElementById("allSitesHint"),
    opacity: document.getElementById("opacity"),
    opacityValue: document.getElementById("opacityValue"),
    wheelSubHint: document.getElementById("wheelSubHint"),
    toggleMute: document.getElementById("toggleMute"),
    kbdClickThrough: document.getElementById("kbdClickThrough"),
    kbdDodge: document.getElementById("kbdDodge"),
    kbdPeek: document.getElementById("kbdPeek"),
    kbdMute: document.getElementById("kbdMute"),
    tipHold: document.getElementById("tipHold"),
    tipElevated: document.getElementById("tipElevated"),
    hotkeyBtns: [...document.querySelectorAll("button[data-hotkey]")],
    resetHotkeys: document.getElementById("resetHotkeys"),
    corners: [...document.querySelectorAll("input[data-corner]")],
    home: document.getElementById("home"),
    axis: document.getElementById("axis"),
    style: document.getElementById("style"),
    autoReturn: document.getElementById("autoReturn"),
    peekKey: document.getElementById("peekKey"),
    peekIdleOpacity: document.getElementById("peekIdleOpacity"),
    peekActiveOpacity: document.getElementById("peekActiveOpacity"),
    seekSec: document.getElementById("seekSec"),
    wheelVolume: document.getElementById("wheelVolume"),
    hold: document.getElementById("hold"),
    engineBanner: document.getElementById("engineBanner"),
  };

  if (els.seekSec) {
    for (const opt of els.seekSec.options) {
      opt.textContent = t("mediaSeekSec", [opt.value]);
    }
  }

  const ALL_SITES_ORIGINS = ["http://*/*", "https://*/*"];
  let recordingTarget = null;
  let opacityTimer = null;

  let state = {
    settings: Settings.merge(undefined),
    engine: { ...DEFAULT_ENGINE },
    allSitesGranted: true,
  };

  async function refreshAllSitesPerm() {
    try {
      if (chrome.permissions?.contains) {
        state.allSitesGranted = await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
      }
    } catch {}
  }

  function send(msg) {
    return chrome.runtime.sendMessage({ v: 1, ...msg });
  }

  function selectNearestOption(selectEl, targetNum) {
    if (!selectEl) return;
    const exact = String(targetNum);
    if ([...selectEl.options].some((o) => o.value === exact)) {
      selectEl.value = exact;
      return;
    }
    let bestVal = selectEl.options[0]?.value ?? exact;
    let bestDist = Infinity;
    for (const opt of selectEl.options) {
      const dist = Math.abs(Number(opt.value) - targetNum);
      if (dist < bestDist) {
        bestDist = dist;
        bestVal = opt.value;
      }
    }
    selectEl.value = bestVal;
  }

  function render() {
    const { settings, engine } = state;
    const { dodge, media, peek, hotkeys } = settings;
    const isEnabled = Boolean(settings.enabled);

    document.body.toggleAttribute("data-disabled", !isEnabled);
    els.modeBadge.textContent = !isEnabled ? t("badgeOff") : engine.connected ? t("engineConnected") : t("modeWeb");
    els.modeBadge.toggleAttribute("data-active", isEnabled && Boolean(engine.connected));
    els.modeBadge.toggleAttribute("data-disabled", !isEnabled);
    els.engineBanner.hidden = Boolean(engine.connected || engine.installed);

    const warnings = [];
    if (engine.protocolMismatch) {
      warnings.push(t("warnProtocol"));
    }
    if (Array.isArray(engine.hotkeyErrors) && engine.hotkeyErrors.length > 0) {
      warnings.push(t("warnHotkeyConflict", [engine.hotkeyErrors.join(", ")]));
    }
    els.engineWarning.hidden = warnings.length === 0;
    els.engineWarning.textContent = warnings.join(" · ");

    if (els.enabled) els.enabled.checked = isEnabled;
    els.clickThrough.checked = settings.clickThrough;
    els.dodgeEnabled.checked = dodge.enabled;
    if (els.peekEnabled) els.peekEnabled.checked = Boolean(peek.enabled);
    if (els.mediaEnabled) els.mediaEnabled.checked = Boolean(media.enabled);
    if (els.showChat) els.showChat.checked = Boolean(settings.showChat);
    els.allSites.checked = settings.allSites;
    if (els.allSitesHint) {
      const needsPerm = Boolean(settings.allSites && !state.allSitesGranted);
      els.allSitesHint.textContent = needsPerm ? t("allSitesNeedsPermission") : t("allSitesHint");
      els.allSitesHint.toggleAttribute("data-warn", needsPerm);
    }
    if (els.tipElevated) {
      els.tipElevated.hidden = !(engine.connected && engine.elevated === false);
    }

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
    if (els.peekKey) els.peekKey.value = peek.key;
    selectNearestOption(els.peekIdleOpacity, peek.idleOpacity);
    selectNearestOption(els.peekActiveOpacity, peek.activeOpacity);
    if (els.seekSec) els.seekSec.value = String(media.seekSec);
    if (els.wheelVolume) els.wheelVolume.checked = Boolean(media.wheelVolume);
    els.hold.value = hotkeys.hold;
    if (els.wheelSubHint) {
      els.wheelSubHint.textContent = t("wheelHint", [hotkeys.hold]);
    }
    if (els.tipHold) {
      els.tipHold.textContent = t("tipHold", [hotkeys.hold]);
    }
    if (els.kbdClickThrough) els.kbdClickThrough.textContent = hotkeys.clickThrough;
    if (els.kbdDodge) els.kbdDodge.textContent = hotkeys.dodge;
    if (els.kbdPeek) els.kbdPeek.textContent = hotkeys.peek;
    if (els.kbdMute) els.kbdMute.textContent = hotkeys.mute;
    for (const btn of els.hotkeyBtns) {
      const key = btn.dataset.hotkey;
      const isRec = recordingTarget === key;
      btn.toggleAttribute("data-recording", isRec);
      btn.textContent = isRec ? t("hotkeyRecording") : hotkeys[key];
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
  els.peekEnabled?.addEventListener("change", () => applyPatch({ peek: { enabled: els.peekEnabled.checked } }));
  els.mediaEnabled?.addEventListener("change", () => applyPatch({ media: { enabled: els.mediaEnabled.checked } }));
  els.showChat?.addEventListener("change", () => applyPatch({ showChat: els.showChat.checked }));
  els.allSites.addEventListener("change", async () => {
    const want = els.allSites.checked;
    if (want && chrome.permissions?.request) {
      try {
        const granted = await chrome.permissions.request({ origins: ALL_SITES_ORIGINS });
        state.allSitesGranted = Boolean(granted);
        if (!granted) {
          els.allSites.checked = false;
          render();
          return;
        }
      } catch {
        await refreshAllSitesPerm();
      }
    }
    await applyPatch({ allSites: want });
  });
  els.allSitesHint?.parentElement?.parentElement?.addEventListener("click", async (e) => {
    if (e.target === els.allSites) return;
    if (state.settings.allSites && !state.allSitesGranted && chrome.permissions?.request) {
      e.preventDefault();
      try {
        const granted = await chrome.permissions.request({ origins: ALL_SITES_ORIGINS });
        state.allSitesGranted = Boolean(granted);
        render();
        if (granted) await applyPatch({ allSites: true });
      } catch {}
    }
  });

  els.opacity.addEventListener("input", () => {
    const val = Number(els.opacity.value);
    showOpacity(val);
    const local = Settings.patch(state.settings, { opacity: val / 100 });
    if (local.ok) state.settings = local.settings;
    clearTimeout(opacityTimer);
    opacityTimer = setTimeout(() => {
      send({ type: "PATCH_SETTINGS", patch: { opacity: val / 100 } });
    }, 80);
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
  els.peekKey?.addEventListener("change", () => applyPatch({ peek: { key: els.peekKey.value } }));
  els.peekIdleOpacity?.addEventListener("change", () =>
    applyPatch({ peek: { idleOpacity: Number(els.peekIdleOpacity.value) } }),
  );
  els.peekActiveOpacity?.addEventListener("change", () =>
    applyPatch({ peek: { activeOpacity: Number(els.peekActiveOpacity.value) } }),
  );
  els.seekSec?.addEventListener("change", () => applyPatch({ media: { seekSec: Number(els.seekSec.value) } }));
  els.wheelVolume?.addEventListener("change", () =>
    applyPatch({ media: { wheelVolume: els.wheelVolume.checked } }),
  );
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

  send({ type: "GET_STATE" }).then(async (res) => {
    if (!res) return;
    state.settings = Settings.merge(res.settings);
    const nextEngine = res.engine ?? {};
    state.engine = {
      ...DEFAULT_ENGINE,
      ...nextEngine,
      installed: Boolean(nextEngine.connected || nextEngine.installed),
    };
    if (typeof res.allSitesGranted === "boolean") {
      state.allSitesGranted = res.allSitesGranted;
    } else {
      await refreshAllSitesPerm();
    }
    render();
  });

  chrome.permissions?.onAdded?.addListener(async () => {
    await refreshAllSitesPerm();
    render();
  });
  chrome.permissions?.onRemoved?.addListener(async () => {
    await refreshAllSitesPerm();
    render();
  });
})();
