(() => {
  const CORNERS = Object.freeze(["TL", "TR", "BL", "BR"]);

  // Same rule as SPEC 3.3 / content/dodge.js isValidDodge. Duplicated so the service worker
  // and popup can validate settings without loading the content-side solver.
  const PAIRS = {
    free: [["TL", "TR"], ["TL", "BL"], ["TL", "BR"], ["TR", "BL"], ["TR", "BR"], ["BL", "BR"]],
    vertical: [["TL", "BL"], ["TR", "BR"]],
    horizontal: [["TL", "TR"], ["BL", "BR"]],
  };

  const DEFAULTS = {
    clickThrough: false,
    opacity: 0.7,
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

  function merge(stored) {
    const s = shaped(DEFAULTS, stored);
    s.opacity = Math.min(1, Math.max(0.1, s.opacity));
    if (!validDodge(s.dodge)) s.dodge = shaped(DEFAULTS.dodge);
    if (!["Ctrl+Alt", "Ctrl+Shift"].includes(s.hotkeys.hold)) s.hotkeys.hold = DEFAULTS.hotkeys.hold;
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
    if (!validDodge(next.dodge) || !["Ctrl+Alt", "Ctrl+Shift"].includes(next.hotkeys.hold)) {
      return { ok: false, settings: base };
    }
    return { ok: true, settings: next };
  }

  globalThis.GhostPiPSettings = { CORNERS, DEFAULTS, isValidDodge, merge, patch };
})();
