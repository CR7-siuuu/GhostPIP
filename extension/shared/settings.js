(() => {
  const CORNERS = ["TL", "TR", "BL", "BR"];

  // Same rule as SPEC 3.3 / content/dodge.js isValidDodge. Duplicated so the service worker
  // can validate stored settings without loading the content-side solver.
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

  function validDodge(d) {
    return (
      Object.hasOwn(PAIRS, d.axis) &&
      ["move", "fade"].includes(d.style) &&
      d.allowed.every((c) => CORNERS.includes(c)) &&
      d.allowed.includes(d.home) &&
      PAIRS[d.axis].some(([a, b]) => d.allowed.includes(a) && d.allowed.includes(b))
    );
  }

  function merge(stored) {
    const s = shaped(DEFAULTS, stored);
    s.opacity = Math.min(1, Math.max(0.1, s.opacity));
    if (!validDodge(s.dodge)) s.dodge = shaped(DEFAULTS.dodge);
    if (!["Ctrl+Alt", "Ctrl+Shift"].includes(s.hotkeys.hold)) s.hotkeys.hold = DEFAULTS.hotkeys.hold;
    return s;
  }

  globalThis.GhostPiPSettings = { DEFAULTS, merge };
})();
