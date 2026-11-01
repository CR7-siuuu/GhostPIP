(() => {
  const CORNERS = Object.freeze(["TL", "TR", "BL", "BR"]);
  const HOLD_KEYS = Object.freeze(["Ctrl+Alt", "Ctrl+Shift", "Alt+Shift", "Ctrl", "Alt", "Shift"]);
  const SPECIAL_KEYS = Object.freeze([
    "SPACE", "TAB", "ESC", "ESCAPE", "LEFT", "UP", "RIGHT", "DOWN",
    "HOME", "END", "PAGEUP", "PAGEDOWN", "INSERT", "DELETE",
    "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  ]);

  // Same rule as SPEC 3.3 / content/dodge.js isValidDodge. Duplicated so the service worker
  // and popup can validate settings without loading the content-side solver.
  const PAIRS = {
    free: [["TL", "TR"], ["TL", "BL"], ["TL", "BR"], ["TR", "BL"], ["TR", "BR"], ["BL", "BR"]],
    vertical: [["TL", "BL"], ["TR", "BR"]],
    horizontal: [["TL", "TR"], ["BL", "BR"]],
  };

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
    hotkeys: { clickThrough: "Alt+G", dodge: "Alt+Shift+D", mute: "Alt+M", hold: "Ctrl+Alt" },
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

  function isValidHotkey(spec) {
    if (typeof spec !== "string" || !spec.trim()) return false;
    const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    let mods = 0;
    let key = null;
    for (const part of parts) {
      const u = part.toUpperCase();
      if (u === "CTRL" || u === "CONTROL") mods |= 1;
      else if (u === "ALT") mods |= 2;
      else if (u === "SHIFT") mods |= 4;
      else if (u === "WIN" || u === "META") mods |= 8;
      else {
        if (key !== null || !isValidKeyToken(part)) return false;
        key = part;
      }
    }
    if (!key) return false;
    const isFn = /^F([1-9]|1[0-2])$/i.test(key);
    return mods !== 0 || isFn;
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
    if (typeof e?.key === "string" && e.key.length === 1) {
      const c = e.key.toUpperCase();
      if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) return c;
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
    const isFn = /^F([1-9]|1[0-2])$/.test(key);
    if (mods.length === 0 && !isFn) return null;
    return [...mods, key].join("+");
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

  function validDodge(d) {
    return ["move", "fade"].includes(d.style) && isValidDodge(d.allowed, d.axis, d.home);
  }

  function validHotkeys(hk) {
    return (
      hk &&
      HOLD_KEYS.includes(hk.hold) &&
      isValidHotkey(hk.clickThrough) &&
      isValidHotkey(hk.dodge) &&
      isValidHotkey(hk.mute)
    );
  }

  function merge(stored) {
    const s = shaped(DEFAULTS, stored);
    s.opacity = Math.min(1, Math.max(0.1, s.opacity));
    if (!validDodge(s.dodge)) s.dodge = shaped(DEFAULTS.dodge);
    if (!HOLD_KEYS.includes(s.hotkeys.hold)) s.hotkeys.hold = DEFAULTS.hotkeys.hold;
    for (const k of ["clickThrough", "dodge", "mute"]) {
      if (!isValidHotkey(s.hotkeys[k])) s.hotkeys[k] = DEFAULTS.hotkeys[k];
    }
    return s;
  }

  function patch(current, partial) {
    const base = merge(current);
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      return { ok: false, settings: base };
    }
    if (partial.dodge && "allowed" in partial.dodge && !Array.isArray(partial.dodge.allowed)) {
      return { ok: false, settings: base };
    }
    const raw = {
      ...base,
      ...partial,
      dodge: { ...base.dodge, ...(partial.dodge && typeof partial.dodge === "object" ? partial.dodge : {}) },
      hotkeys: { ...base.hotkeys, ...(partial.hotkeys && typeof partial.hotkeys === "object" ? partial.hotkeys : {}) },
    };
    const next = shaped(base, raw);
    next.opacity = Math.min(1, Math.max(0.1, next.opacity));
    if (!validDodge(next.dodge) || !validHotkeys(next.hotkeys)) {
      return { ok: false, settings: base };
    }
    return { ok: true, settings: next };
  }

  globalThis.GhostPiPSettings = {
    CORNERS,
    HOLD_KEYS,
    DEFAULTS,
    isValidDodge,
    isValidHotkey,
    formatKeyEvent,
    merge,
    patch,
  };
})();
