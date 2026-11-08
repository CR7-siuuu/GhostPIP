(() => {
  const CORNERS = Object.freeze(["TL", "TR", "BL", "BR"]);
  const HOLD_KEYS = Object.freeze(["Ctrl+Alt", "Ctrl+Shift", "Alt+Shift", "Ctrl", "Alt", "Shift"]);
  const PEEK_KEYS = Object.freeze(["Alt", "Mouse4", "Mouse5", "Backquote", "Ctrl", "Shift", "Ctrl+Alt"]);
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
    next.peek.idleOpacity = Math.min(0.2, Math.max(0, next.peek.idleOpacity));
    next.peek.activeOpacity = Math.min(1, Math.max(0.1, next.peek.activeOpacity));
    if (!validDodge(next.dodge) || !validMedia(next.media) || !validPeek(next.peek) || !validHotkeys(next.hotkeys)) {
      return { ok: false, settings: base };
    }
    return { ok: true, settings: next };
  }

  globalThis.GhostPiPSettings = {
    CORNERS,
    HOLD_KEYS,
    PEEK_KEYS,
    SEEK_STEPS,
    DEFAULTS,
    isValidDodge,
    isValidHotkey,
    validMedia,
    validPeek,
    validHotkeys,
    formatKeyEvent,
    merge,
    patch,
  };
})();
