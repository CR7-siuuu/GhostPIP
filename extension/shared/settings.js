(() => {
  const CORNERS = Object.freeze(["TL", "TR", "BL", "BR"]);
  const HOLD_KEYS = Object.freeze(["Ctrl+Alt", "Ctrl+Shift", "Alt+Shift", "Ctrl", "Alt", "Shift"]);
  const PEEK_KEYS = Object.freeze(["Alt", "Mouse4", "Mouse5", "Backquote", "Ctrl", "Shift", "Ctrl+Alt"]);
  const HOLD_MATCH = Object.freeze({
    "Ctrl+Alt": (e) => Boolean(e?.ctrlKey && e?.altKey),
    "Ctrl+Shift": (e) => Boolean(e?.ctrlKey && e?.shiftKey),
    "Alt+Shift": (e) => Boolean(e?.altKey && e?.shiftKey),
    Ctrl: (e) => Boolean(e?.ctrlKey),
    Alt: (e) => Boolean(e?.altKey),
    Shift: (e) => Boolean(e?.shiftKey),
  });
  const PEEK_MATCH = Object.freeze({
    Alt: (s) => Boolean(s?.alt),
    Ctrl: (s) => Boolean(s?.ctrl),
    Shift: (s) => Boolean(s?.shift),
    "Ctrl+Alt": (s) => Boolean(s?.ctrl && s?.alt),
    Backquote: (s) => Boolean(s?.backquote),
    Mouse4: (s) => ((s?.buttons ?? 0) & 8) !== 0,
    Mouse5: (s) => ((s?.buttons ?? 0) & 16) !== 0,
  });
  const SEEK_STEPS = Object.freeze([5, 10]);
  const HOTKEY_FIELDS = Object.freeze([
    "clickThrough",
    "dodge",
    "mute",
    "playPause",
    "seekBack",
    "seekForward",
    "peek",
  ]);
  const SPECIAL_KEYS = Object.freeze([
    "SPACE", "TAB", "ESC", "ESCAPE", "LEFT", "UP", "RIGHT", "DOWN",
    "HOME", "END", "PAGEUP", "PAGEDOWN", "INSERT", "DELETE",
    "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  ]);

  // SPEC 3.3. content/dodge.js reuses this table; settings.js loads first wherever dodge.js does.
  const PAIRS = Object.freeze({
    free: Object.freeze([["TL", "TR"], ["TL", "BL"], ["TL", "BR"], ["TR", "BL"], ["TR", "BR"], ["BL", "BR"]]),
    vertical: Object.freeze([["TL", "BL"], ["TR", "BR"]]),
    horizontal: Object.freeze([["TL", "TR"], ["BL", "BR"]]),
  });

  const DODGE_RANGES = Object.freeze({
    marginPx: [0, 200],
    edgeInsetPx: [0, 200],
    hoverDelayMs: [0, 5000],
    cooldownMs: [0, 10000],
    returnDelayMs: [0, 60000],
    ignoreScreenEdgePx: [0, 200],
  });

  // Mirrors shared/hotkey-vectors.json "reserved"; test/unit asserts they stay equal.
  const RESERVED_HOTKEYS = Object.freeze([
    "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+S", "Ctrl+F", "Ctrl+P",
    "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+TAB", "Ctrl+Shift+TAB", "Ctrl+ESC", "Ctrl+ESCAPE",
    "Ctrl+Shift+ESC", "Ctrl+Shift+ESCAPE", "Alt+TAB", "Alt+Shift+TAB", "Alt+F4", "Alt+ESC",
    "Alt+ESCAPE", "Ctrl+Alt+DELETE",
  ]);

  const DEFAULTS = {
    enabled: true,
    clickThrough: false,
    opacity: 0.7,
    showChat: true,
    allSites: true,
    dodge: {
      enabled: true,
      axis: "free",
      allowed: ["TL", "TR", "BL", "BR"],
      home: "BR",
      autoReturn: true,
      returnDelayMs: 2500,
      marginPx: 20,
      edgeInsetPx: 16,
      hoverDelayMs: 100,
      cooldownMs: 300,
      style: "move",
      ignoreScreenEdgePx: 0,
    },
    media: {
      enabled: true,
      seekSec: 5,
      wheelVolume: true,
    },
    peek: {
      enabled: false,
      key: "Alt",
      idleOpacity: 0,
      activeOpacity: 0.8,
    },
    hotkeys: {
      clickThrough: "Alt+G",
      dodge: "Alt+Shift+D",
      mute: "Alt+M",
      playPause: "Alt+Space",
      seekBack: "Alt+Left",
      seekForward: "Alt+Right",
      peek: "Alt+P",
      hold: "Ctrl+Alt",
    },
  };

  function isValidKeyToken(token) {
    if (typeof token !== "string" || !token) return false;
    if (token.length === 1) {
      const c = token.toUpperCase();
      if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) return true;
      return SPECIAL_KEYS.includes(token);
    }
    if (/^F([1-9]|1[0-2])$/i.test(token)) return true;
    return SPECIAL_KEYS.includes(token.toUpperCase());
  }

  const MOD_NAMES = [[1, "Ctrl"], [2, "Alt"], [4, "Shift"], [8, "Win"]];

  function normalizeHotkey(spec) {
    if (typeof spec !== "string" || !spec.trim()) return null;
    let mods = 0;
    let key = null;
    for (const part of spec.split("+").map((p) => p.trim()).filter(Boolean)) {
      const u = part.toUpperCase();
      if (u === "CTRL" || u === "CONTROL") mods |= 1;
      else if (u === "ALT") mods |= 2;
      else if (u === "SHIFT") mods |= 4;
      else if (u === "WIN" || u === "META") mods |= 8;
      else {
        if (key !== null || !isValidKeyToken(part)) return null;
        key = u;
      }
    }
    if (!key) return null;
    const names = MOD_NAMES.filter(([bit]) => mods & bit).map(([, name]) => name);
    return { mods, key, combo: [...names, key].join("+") };
  }

  // Shift alone never qualifies: Shift+letter would block typing.
  function isValidHotkey(spec) {
    const n = normalizeHotkey(spec);
    if (!n) return false;
    const isFn = /^F([1-9]|1[0-2])$/.test(n.key);
    return (isFn || (n.mods & (1 | 2 | 8)) !== 0) && !RESERVED_HOTKEYS.includes(n.combo);
  }

  function keyTokenFromEvent(e) {
    const code = e?.code || "";
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^Digit([0-9])$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    const map = {
      Space: "Space",
      Tab: "Tab",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      Delete: "Delete",
      Backquote: "`",
      Minus: "-",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
    };
    if (map[code]) return map[code];
    const rawKey = typeof e?.key === "string" ? e.key : "";
    if (rawKey === " ") return "Space";
    if (map[rawKey]) return map[rawKey];
    if (/^F([1-9]|1[0-2])$/i.test(rawKey)) return rawKey.toUpperCase();
    if (rawKey.length === 1) {
      const c = rawKey.toUpperCase();
      if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) return c;
      if (SPECIAL_KEYS.includes(rawKey)) return rawKey;
    }
    return null;
  }

  function formatKeyEvent(e) {
    const key = keyTokenFromEvent(e);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const combo = [...mods, key].join("+");
    return isValidHotkey(combo) ? combo : null;
  }

  function shaped(def, val) {
    if (Array.isArray(def)) return Array.isArray(val) ? [...val] : [...def];
    if (def && typeof def === "object") {
      return Object.fromEntries(Object.keys(def).map((k) => [k, shaped(def[k], val?.[k])]));
    }
    if (typeof val !== typeof def) return def;
    return typeof val === "number" && !Number.isFinite(val) ? def : val;
  }

  function isValidDodge(allowed, axis, home) {
    return (
      Array.isArray(allowed) &&
      Object.hasOwn(PAIRS, axis) &&
      allowed.every((c) => CORNERS.includes(c)) &&
      allowed.includes(home) &&
      PAIRS[axis].some(([a, b]) => allowed.includes(a) && allowed.includes(b))
    );
  }

  function clampDodgeNumbers(d) {
    for (const [k, [min, max]] of Object.entries(DODGE_RANGES)) d[k] = Math.min(max, Math.max(min, d[k]));
  }

  function validDodge(d) {
    return (
      ["move", "fade"].includes(d.style) &&
      Object.entries(DODGE_RANGES).every(([k, [min, max]]) => Number.isFinite(d[k]) && d[k] >= min && d[k] <= max) &&
      isValidDodge(d.allowed, d.axis, d.home)
    );
  }

  function validMedia(m) {
    return Boolean(
      m &&
        typeof m.enabled === "boolean" &&
        SEEK_STEPS.includes(m.seekSec) &&
        typeof m.wheelVolume === "boolean",
    );
  }

  function validPeek(p) {
    return Boolean(
      p &&
        typeof p.enabled === "boolean" &&
        PEEK_KEYS.includes(p.key) &&
        Number.isFinite(p.idleOpacity) &&
        p.idleOpacity >= 0 &&
        p.idleOpacity <= 0.2 &&
        Number.isFinite(p.activeOpacity) &&
        p.activeOpacity >= 0.1 &&
        p.activeOpacity <= 1,
    );
  }

  function validHotkeys(hk) {
    return Boolean(
      hk &&
        HOLD_KEYS.includes(hk.hold) &&
        HOTKEY_FIELDS.every((k) => isValidHotkey(hk[k])),
    );
  }

  function matchesTypes(def, obj) {
    for (const k of Object.keys(def)) {
      if (!(k in obj) || obj[k] === undefined) continue;
      const dv = def[k];
      const v = obj[k];
      if (Array.isArray(dv)) {
        if (!Array.isArray(v)) return false;
      } else if (dv && typeof dv === "object") {
        if (!v || typeof v !== "object" || Array.isArray(v) || !matchesTypes(dv, v)) return false;
      } else if (typeof dv === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) return false;
      } else if (typeof v !== typeof dv) {
        return false;
      }
    }
    return true;
  }

  function merge(stored) {
    const s = shaped(DEFAULTS, stored);
    s.opacity = Math.min(1, Math.max(0.1, s.opacity));
    clampDodgeNumbers(s.dodge);
    if (!validDodge(s.dodge)) s.dodge = shaped(DEFAULTS.dodge);
    if (!SEEK_STEPS.includes(s.media.seekSec)) s.media.seekSec = DEFAULTS.media.seekSec;
    if (!validMedia(s.media)) s.media = shaped(DEFAULTS.media);
    s.peek.idleOpacity = Math.min(0.2, Math.max(0, s.peek.idleOpacity));
    s.peek.activeOpacity = Math.min(1, Math.max(0.1, s.peek.activeOpacity));
    if (!PEEK_KEYS.includes(s.peek.key)) s.peek.key = DEFAULTS.peek.key;
    if (!validPeek(s.peek)) s.peek = shaped(DEFAULTS.peek);
    if (!HOLD_KEYS.includes(s.hotkeys.hold)) s.hotkeys.hold = DEFAULTS.hotkeys.hold;
    for (const k of HOTKEY_FIELDS) {
      if (!isValidHotkey(s.hotkeys[k])) s.hotkeys[k] = DEFAULTS.hotkeys[k];
    }
    return s;
  }

  function patch(current, partial) {
    const base = merge(current);
    if (!partial || typeof partial !== "object" || Array.isArray(partial) || !matchesTypes(DEFAULTS, partial)) {
      return { ok: false, settings: base };
    }
    const raw = {
      ...base,
      ...partial,
      dodge: { ...base.dodge, ...(partial.dodge || {}) },
      media: { ...base.media, ...(partial.media || {}) },
      peek: { ...base.peek, ...(partial.peek || {}) },
      hotkeys: { ...base.hotkeys, ...(partial.hotkeys || {}) },
    };
    const next = shaped(base, raw);
    next.opacity = Math.min(1, Math.max(0.1, next.opacity));
    clampDodgeNumbers(next.dodge);
    next.peek.idleOpacity = Math.min(0.2, Math.max(0, next.peek.idleOpacity));
    next.peek.activeOpacity = Math.min(1, Math.max(0.1, next.peek.activeOpacity));
    if (!validDodge(next.dodge) || !validMedia(next.media) || !validPeek(next.peek) || !validHotkeys(next.hotkeys)) {
      return { ok: false, settings: base };
    }
    return { ok: true, settings: next };
  }

  function isEditableTarget(tgt) {
    return Boolean(
      tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" ||
          tgt.isContentEditable),
    );
  }

  function isMousePeekButton(settings, button, hasOverlay = true) {
    if (!settings?.enabled || !settings?.peek?.enabled || !hasOverlay) return false;
    return (
      (settings.peek.key === "Mouse4" && button === 3) ||
      (settings.peek.key === "Mouse5" && button === 4)
    );
  }

  function createPeekInput() {
    return { alt: false, ctrl: false, shift: false, backquote: false, buttons: 0 };
  }

  function stepPeekInput(state, type, e) {
    if (type === "reset") return createPeekInput();
    const next = { ...state };
    if (type === "keydown") {
      next.alt = Boolean(e?.altKey || e?.key === "Alt");
      next.ctrl = Boolean(e?.ctrlKey || e?.key === "Control");
      next.shift = Boolean(e?.shiftKey || e?.key === "Shift");
      if (e?.code === "Backquote" || e?.key === "`" || e?.key === "~") next.backquote = true;
      return next;
    }
    if (type === "keyup") {
      next.alt = e?.key === "Alt" ? false : Boolean(e?.altKey);
      next.ctrl = e?.key === "Control" ? false : Boolean(e?.ctrlKey);
      next.shift = e?.key === "Shift" ? false : Boolean(e?.shiftKey);
      if (e?.code === "Backquote" || e?.key === "`" || e?.key === "~") next.backquote = false;
      return next;
    }
    if (typeof e?.altKey === "boolean") next.alt = e.altKey;
    if (typeof e?.ctrlKey === "boolean") next.ctrl = e.ctrlKey;
    if (typeof e?.shiftKey === "boolean") next.shift = e.shiftKey;
    if (type === "buttondown") {
      if (typeof e?.buttons === "number" && e.buttons !== 0) next.buttons = e.buttons;
      else if (e?.button === 3) next.buttons |= 8;
      else if (e?.button === 4) next.buttons |= 16;
    } else if (type === "buttonup") {
      if (e?.button === 3) next.buttons &= ~8;
      else if (e?.button === 4) next.buttons &= ~16;
      else if (typeof e?.buttons === "number") next.buttons = e.buttons;
    } else if (type === "mousemove") {
      if (typeof e?.buttons === "number") next.buttons = e.buttons;
    }
    return next;
  }

  function matchShortcut(e, settings, { engineConnected = false, hasOverlay = true } = {}) {
    if (!settings?.enabled || e?.repeat || isEditableTarget(e?.target)) return null;
    const combo = formatKeyEvent(e);
    if (!combo) return null;
    const upper = combo.toUpperCase();
    const hk = settings.hotkeys || {};
    if (e?.isTrusted) {
      if (hk.clickThrough && hk.clickThrough.toUpperCase() === upper && upper !== "ALT+G") {
        return { type: "INTENT", intent: "TOGGLE_CLICK_THROUGH" };
      }
      if (hk.dodge && hk.dodge.toUpperCase() === upper && upper !== "ALT+SHIFT+D") {
        return { type: "INTENT", intent: "TOGGLE_DODGE" };
      }
      if (hk.mute && hk.mute.toUpperCase() === upper && upper !== "ALT+M") {
        return { type: "INTENT", intent: "TOGGLE_MUTE" };
      }
    }
    if (engineConnected || !hasOverlay) return null;
    if (hk.peek && hk.peek.toUpperCase() === upper) {
      return { type: "INTENT", intent: "TOGGLE_PEEK" };
    }
    if (!settings.media?.enabled) return null;
    if (hk.playPause && hk.playPause.toUpperCase() === upper) {
      return { type: "MEDIA_ACTION", action: "PLAY_PAUSE" };
    }
    if (hk.seekBack && hk.seekBack.toUpperCase() === upper) {
      return { type: "MEDIA_ACTION", action: "SEEK", deltaSec: -settings.media.seekSec };
    }
    if (hk.seekForward && hk.seekForward.toUpperCase() === upper) {
      return { type: "MEDIA_ACTION", action: "SEEK", deltaSec: settings.media.seekSec };
    }
    return null;
  }

  function bindPeekAndShortcuts(
    targetWin,
    {
      signal,
      peekState,
      getSettings,
      hasOverlay = () => true,
      onPeekInput,
      onShortcut,
      onHoldKey,
      onVisibility,
    },
  ) {
    const opt = signal ? { capture: true, signal } : true;
    const update = (type, e) => {
      Object.assign(peekState, stepPeekInput(peekState, type, e));
      onPeekInput?.();
    };
    targetWin.addEventListener(
      "keydown",
      (e) => {
        update("keydown", e);
        const s = getSettings();
        if (HOLD_MATCH[s.hotkeys?.hold]?.(e)) onHoldKey?.(true, e);
        onShortcut?.(e);
      },
      opt,
    );
    targetWin.addEventListener(
      "keyup",
      (e) => {
        update("keyup", e);
        const s = getSettings();
        if (s.clickThrough && !HOLD_MATCH[s.hotkeys?.hold]?.(e)) onHoldKey?.(false, e);
      },
      opt,
    );
    const onBtn = (type) => (e) => {
      update(type, e);
      if (isMousePeekButton(getSettings(), e.button, hasOverlay())) e.preventDefault();
    };
    const down = onBtn("buttondown");
    const up = onBtn("buttonup");
    targetWin.addEventListener("pointerdown", down, opt);
    targetWin.addEventListener("mousedown", down, opt);
    targetWin.addEventListener("pointerup", up, opt);
    targetWin.addEventListener("mouseup", up, opt);
    targetWin.addEventListener(
      "auxclick",
      (e) => {
        if (isMousePeekButton(getSettings(), e.button, hasOverlay())) e.preventDefault();
      },
      opt,
    );
    targetWin.addEventListener("mousemove", (e) => update("mousemove", e), opt);
    targetWin.addEventListener(
      "blur",
      () => {
        update("reset");
        if (getSettings().clickThrough) onHoldKey?.(false);
      },
      signal ? { signal } : false,
    );
    targetWin.document?.addEventListener(
      "visibilitychange",
      () => {
        if (targetWin.document.hidden) update("reset");
        onVisibility?.(!targetWin.document.hidden);
      },
      signal ? { signal } : false,
    );
  }

  globalThis.GhostPiPSettings = {
    CORNERS,
    HOLD_KEYS,
    PEEK_KEYS,
    HOLD_MATCH,
    PEEK_MATCH,
    SEEK_STEPS,
    PAIRS,
    DODGE_RANGES,
    RESERVED_HOTKEYS,
    DEFAULTS,
    isValidDodge,
    isValidHotkey,
    normalizeHotkey,
    validMedia,
    validPeek,
    validHotkeys,
    formatKeyEvent,
    merge,
    patch,
    isEditableTarget,
    isMousePeekButton,
    createPeekInput,
    stepPeekInput,
    matchShortcut,
    bindPeekAndShortcuts,
  };
})();
