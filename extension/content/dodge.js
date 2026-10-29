(() => {
  "use strict";

  const CORNERS = Object.freeze(["TL", "TR", "BL", "BR"]);

  const PAIRS = {
    free: [["TL", "TR"], ["TL", "BL"], ["TL", "BR"], ["TR", "BL"], ["TR", "BR"], ["BL", "BR"]],
    vertical: [["TL", "BL"], ["TR", "BR"]],
    horizontal: [["TL", "TR"], ["BL", "BR"]],
  };

  const isTop = (corner) => corner[0] === "T";
  const isLeft = (corner) => corner[1] === "L";

  const REACHABLE = {
    free: () => true,
    vertical: (from, to) => isLeft(from) === isLeft(to),
    horizontal: (from, to) => isTop(from) === isTop(to),
  };

  function isValidDodge(allowed, axis, home) {
    return allowed.includes(home) && PAIRS[axis].some(([a, b]) => allowed.includes(a) && allowed.includes(b));
  }

  function cornerRect(corner, size, area, inset) {
    const l = isLeft(corner) ? area.l + inset : area.r - inset - size.w;
    const t = isTop(corner) ? area.t + inset : area.b - inset - size.h;
    return { l, t, r: l + size.w, b: t + size.h };
  }

  function nearestCorner(rect, area) {
    const top = rect.t + rect.b <= area.t + area.b;
    const left = rect.l + rect.r <= area.l + area.r;
    return (top ? "T" : "B") + (left ? "L" : "R");
  }

  function initialState(corner) {
    return { corner, hoverSince: null, lastMoveAt: -Infinity, outsideHomeSince: null, faded: false };
  }

  const containsWithMargin = (rect, margin, p) =>
    p.x >= rect.l - margin && p.x < rect.r + margin && p.y >= rect.t - margin && p.y < rect.b + margin;

  const nearAreaEdge = (p, area, d) =>
    p.x < area.l + d || p.x >= area.r - d || p.y < area.t + d || p.y >= area.b - d;

  const distSqToCenter = (rect, p) => {
    const dx = (rect.l + rect.r) / 2 - p.x;
    const dy = (rect.t + rect.b) / 2 - p.y;
    return dx * dx + dy * dy;
  };

  function step(state, input, cfg) {
    const { now, cursor, size, area } = input;
    const s = { ...state };
    const rectOf = (corner) => cornerRect(corner, size, area, cfg.edgeInsetPx);
    const covers = (corner) => containsWithMargin(rectOf(corner), cfg.marginPx, cursor);

    const stay = () => ({ state: s, action: { type: "stay" } });
    const fade = (on) => {
      s.faded = on;
      return { state: s, action: { type: "fade", on } };
    };
    const moveTo = (corner) => {
      s.corner = corner;
      s.lastMoveAt = now;
      s.hoverSince = null;
      s.outsideHomeSince = null;
      return { state: s, action: { type: "move", corner } };
    };

    if (!cfg.enabled) {
      s.hoverSince = null;
      return s.faded ? fade(false) : stay();
    }
    if (cursor === null || (cfg.ignoreScreenEdgePx > 0 && nearAreaEdge(cursor, area, cfg.ignoreScreenEdgePx))) {
      s.hoverSince = null;
      return stay();
    }

    const cooledDown = now - s.lastMoveAt >= cfg.cooldownMs;

    if (covers(s.corner)) {
      s.hoverSince ??= now;
      if (now - s.hoverSince < cfg.hoverDelayMs || !cooledDown) return stay();
      if (cfg.style === "move") {
        let best = null;
        let bestDist = -1;
        for (const c of CORNERS) {
          if (c === s.corner || !cfg.allowed.includes(c) || !REACHABLE[cfg.axis](s.corner, c) || covers(c)) continue;
          const d = distSqToCenter(rectOf(c), cursor);
          if (d > bestDist) {
            best = c;
            bestDist = d;
          }
        }
        if (best !== null) return moveTo(best);
      }
      return s.faded ? stay() : fade(true);
    }

    s.hoverSince = null;
    if (s.faded) return fade(false);

    if (!cfg.autoReturn || s.corner === cfg.home || !cfg.allowed.includes(cfg.home) || !cooledDown) return stay();
    if (covers(cfg.home)) {
      s.outsideHomeSince = null;
      return stay();
    }
    s.outsideHomeSince ??= now;
    return now - s.outsideHomeSince >= cfg.returnDelayMs ? moveTo(cfg.home) : stay();
  }

  globalThis.GhostPiPDodge = Object.freeze({
    CORNERS,
    isValidDodge,
    cornerRect,
    nearestCorner,
    initialState,
    step,
  });
})();
