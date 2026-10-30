(() => {
  const Dodge = globalThis.GhostPiPDodge;
  const Settings = globalThis.GhostPiPSettings;

  const FLOAT_CLASS = "ghostpip-inpage-target";
  const DOCPIP_SOURCE_CLASS = "ghostpip-docpip-source";
  const DEFAULT_FLOAT_WIDTH = 480;
  const MIN_FLOAT_WIDTH = 140;
  const MAX_FLOAT_WIDTH = 2560;
  const MIN_FLOAT_HEIGHT = 90;
  const MAX_FLOAT_HEIGHT = 2160;
  const CORNER_SNAP_PX = 8;
  const WHEEL_OPACITY_STEP = 0.05;
  const FADED_OPACITY = 0.1;
  const DODGE_TICK_MS = 50;
  const SCAN_THROTTLE_MS = 250;
  const PIP_CHAT_HEIGHT = 420;
  const GP_VARS = ["--gp-x", "--gp-y", "--gp-w", "--gp-h", "--gp-opacity"];
  const RESIZE_DIRS = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
  const HOLD = {
    "Ctrl+Alt": (e) => e.ctrlKey && e.altKey,
    "Ctrl+Shift": (e) => e.ctrlKey && e.shiftKey,
    "Alt+Shift": (e) => e.altKey && e.shiftKey,
    Ctrl: (e) => e.ctrlKey,
    Alt: (e) => e.altKey,
    Shift: (e) => e.shiftKey,
  };

  const ctx = {
    settings: Settings.merge(undefined),
    layout: { width: DEFAULT_FLOAT_WIDTH, height: null, pos: null },
    siteId: "generic",
    site: { video: null, chatPopoutUrl: null },
    video: null,
    url: location.href,
  };

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage({ v: 1, ...msg });
    } catch {
      return null;
    }
  }

  const px = (n) => `${Math.round(n)}px`;
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  function setVars(el, vars) {
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(`--gp-${k}`, v);
  }

  function videoRatio(video, ratioFallback = 9 / 16) {
    return video.videoWidth ? video.videoHeight / video.videoWidth : ratioFallback;
  }

  function floatSize(video, targetWidth, maxHeight, ratioFallback = 9 / 16, maxWidth = MAX_FLOAT_WIDTH) {
    const ratio = videoRatio(video, ratioFallback);
    const clampedW = Math.min(Math.max(MIN_FLOAT_WIDTH, targetWidth), Math.max(MIN_FLOAT_WIDTH, maxWidth));
    const height = Math.round(clampedW * ratio);
    if (height <= maxHeight) return { w: Math.round(clampedW), h: height };
    const h = Math.round(Math.max(120, maxHeight));
    return { w: Math.round(h / ratio), h };
  }

  function sanitizeLayout(raw) {
    const width =
      Number.isFinite(raw?.width) && raw.width >= MIN_FLOAT_WIDTH && raw.width <= MAX_FLOAT_WIDTH
        ? Math.round(raw.width)
        : DEFAULT_FLOAT_WIDTH;
    const height =
      Number.isFinite(raw?.height) && raw.height >= MIN_FLOAT_HEIGHT && raw.height <= MAX_FLOAT_HEIGHT
        ? Math.round(raw.height)
        : null;
    const pos =
      raw?.pos &&
      typeof raw.pos === "object" &&
      Number.isFinite(raw.pos.rx) &&
      Number.isFinite(raw.pos.ry)
        ? { rx: Math.min(1, Math.max(0, raw.pos.rx)), ry: Math.min(1, Math.max(0, raw.pos.ry)) }
        : null;
    return { width, height, pos };
  }

  function toRelPos(l, t, s, vp) {
    const maxL = Math.max(1, vp.r - s.w);
    const maxT = Math.max(1, vp.b - s.h);
    return {
      rx: Math.min(1, Math.max(0, l / maxL)),
      ry: Math.min(1, Math.max(0, t / maxT)),
    };
  }

  function fromRelPos(pos, s, vp) {
    const maxL = Math.max(0, vp.r - s.w);
    const maxT = Math.max(0, vp.b - s.h);
    const l = Math.round(Math.min(1, Math.max(0, pos.rx)) * maxL);
    const t = Math.round(Math.min(1, Math.max(0, pos.ry)) * maxT);
    return { l, t, r: l + s.w, b: t + s.h };
  }

  function persistLayout(next) {
    ctx.layout = sanitizeLayout(next);
    chrome.storage.local.set({ floatLayout: ctx.layout }).catch(() => {});
  }

  function stepOpacity(delta) {
    const next = Math.round(Math.min(1, Math.max(0.1, ctx.settings.opacity + delta)) * 100) / 100;
    if (next === ctx.settings.opacity) return next;
    ctx.settings = { ...ctx.settings, opacity: next };
    send({ type: "PATCH_SETTINGS", patch: { opacity: next } });
    return next;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(d) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  const ICON_WEB_MODE =
    "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9ZM3.5 3.2a.3.3 0 0 0-.3.3v9a.3.3 0 0 0 .3.3h9a.3.3 0 0 0 .3-.3v-9a.3.3 0 0 0-.3-.3h-9ZM8 8.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v2.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5V8.5Z";
  const ICON_FULL_MODE =
    "M2.5 3A1.5 1.5 0 0 0 1 4.5v7A1.5 1.5 0 0 0 2.5 13h5a.6.6 0 0 0 0-1.2h-5a.3.3 0 0 1-.3-.3v-7a.3.3 0 0 1 .3-.3h7a.3.3 0 0 1 .3.3v2a.6.6 0 1 0 1.2 0v-2A1.5 1.5 0 0 0 9.5 3h-7Zm6.5 5.5A1.5 1.5 0 0 1 10.5 7h3A1.5 1.5 0 0 1 15 8.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 11.5v-3Z";
  const ICON_CHAT =
    "M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12h2.2v2.1a.5.5 0 0 0 .82.38L8.4 12h5.1A1.5 1.5 0 0 0 15 10.5v-7A1.5 1.5 0 0 0 13.5 2h-11Zm2 3.2h7a.6.6 0 1 1 0 1.2h-7a.6.6 0 0 1 0-1.2Zm0 2.6h4.5a.6.6 0 1 1 0 1.2H4.5a.6.6 0 0 1 0-1.2Z";

  const BASE_CSS = `
    .bar { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px;
      background: linear-gradient(180deg, rgba(22, 27, 42, 0.9) 0%, rgba(13, 16, 26, 0.94) 100%);
      border: 1px solid rgba(125, 211, 252, 0.28);
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.6), 0 0 12px rgba(56, 189, 248, 0.14);
      backdrop-filter: blur(10px) saturate(150%);
      font: 600 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif; color: #f8fafc; }
    button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 999px; white-space: nowrap; color: rgba(241, 245, 249, 0.94);
      transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease; }
    button svg { width: 12px; height: 12px; fill: #7dd3fc; flex: none; transition: fill 0.14s ease; }
    button:hover { background: linear-gradient(135deg, rgba(56, 189, 248, 0.28) 0%, rgba(99, 102, 241, 0.32) 100%);
      color: #fff; box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.35); }
    button:hover svg { fill: #fff; }
    :host([data-pinned]) .bar:not(:hover) { opacity: 0.65; }`;

  const CONTROLLER_CSS = `
    .surface { position: absolute; inset: 0; box-sizing: border-box; cursor: move; border-radius: 6px;
      border: 2px solid rgba(56, 189, 248, 0.92);
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      box-shadow: 0 0 18px rgba(56, 189, 248, 0.22), inset 0 0 12px rgba(56, 189, 248, 0.12); }
    .handle { position: absolute; z-index: 2; }
    .handle.n { top: -4px; left: 14px; right: 14px; height: 10px; cursor: ns-resize; }
    .handle.s { bottom: -4px; left: 14px; right: 14px; height: 10px; cursor: ns-resize; }
    .handle.w { left: -4px; top: 14px; bottom: 14px; width: 10px; cursor: ew-resize; }
    .handle.e { right: -4px; top: 14px; bottom: 14px; width: 10px; cursor: ew-resize; }
    .handle.nw { top: -5px; left: -5px; width: 18px; height: 18px; cursor: nwse-resize; }
    .handle.ne { top: -5px; right: -5px; width: 18px; height: 18px; cursor: nesw-resize; }
    .handle.sw { bottom: -5px; left: -5px; width: 18px; height: 18px; cursor: nesw-resize; }
    .handle.se { bottom: -5px; right: -5px; width: 18px; height: 18px; cursor: nwse-resize; }
    .handle.nw::after, .handle.ne::after, .handle.sw::after, .handle.se::after {
      content: ""; position: absolute; width: 9px; height: 9px; border-radius: 3px;
      background: linear-gradient(135deg, #bae6fd 0%, #38bdf8 100%);
      border: 1.5px solid #0f172a;
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
    .handle.nw::after { top: 4px; left: 4px; }
    .handle.ne::after { top: 4px; right: 4px; }
    .handle.sw::after { bottom: 4px; left: 4px; }
    .handle.se::after { bottom: 4px; right: 4px; }
    .bar { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 3;
      pointer-events: auto; }
    .hud { position: absolute; bottom: 10px; left: 10px; z-index: 3; pointer-events: none;
      padding: 5px 10px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(125, 211, 252, 0.35); color: #e0f2fe;
      font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 4px 12px rgba(2, 6, 23, 0.55); backdrop-filter: blur(8px); }
    :host([data-bar-only]) .surface,
    :host([data-bar-only]) .handle,
    :host([data-bar-only]) .hud { display: none; }
    :host([data-remote]) button[data-mode="local"],
    :host(:not([data-remote])) button[data-mode="remote"] { display: none; }`;

  // Open shadow root so tests can pierce it; popover so it renders in the top layer above site overlays.
  function overlayHost(id, css, ...content) {
    const host = h("div", { id, popover: "manual" });
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style, ...content);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    root.addEventListener("click", (e) => ACTIONS[e.target.closest?.("[data-action]")?.dataset.action]?.());
    return {
      host,
      root,
      get open() {
        return host.matches(":popover-open");
      },
      show(vars) {
        setVars(host, vars);
        if (!host.isConnected) document.documentElement.append(host);
        if (!this.open) host.showPopover();
      },
      hide() {
        if (this.open) host.hidePopover();
      },
    };
  }

  const launcher = overlayHost(
    "ghostpip-launcher",
    BASE_CSS,
    h("div", { class: "bar" },
      h("button", { "data-action": "inTab", title: "웹 모드 (브라우저 탭 내 오버레이)" },
        svgIcon(ICON_WEB_MODE),
        "웹 모드"),
      h("button", { "data-action": "docPip", title: "전체 모드 (데스크톱 PiP 창)" },
        svgIcon(ICON_FULL_MODE),
        "전체 모드")),
  );

  const hudEl = h("div", { class: "hud" }, "");
  const controller = overlayHost(
    "ghostpip-controller",
    BASE_CSS + CONTROLLER_CSS,
    h("div", { class: "surface" }),
    ...RESIZE_DIRS.map((dir) => h("div", { class: `handle ${dir}`, "data-resize": dir })),
    hudEl,
    h("div", { class: "bar" },
      h("button", { "data-action": "idle" }, "복귀"),
      h("button", { "data-action": "docPip", "data-mode": "local" },
        svgIcon(ICON_FULL_MODE),
        "전체 모드"),
      h("button", { "data-action": "focusSource", "data-mode": "remote" }, "원본 탭")),
  );

  let dragSink = null;
  controller.root.addEventListener("pointerdown", (e) => {
    if (!dragSink || e.button !== 0 || e.target.closest?.(".bar")) return;
    const target = e.target;
    const resizeDir = target.dataset?.resize || null;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {}
    dragSink.start(e, resizeDir);
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragSink?.active()) return;
    if (e.isTrusted && (e.buttons & 1) === 0) {
      dragSink.end();
      return;
    }
    dragSink.move(e);
  }, true);
  window.addEventListener("pointerup", () => {
    if (dragSink?.active()) dragSink.end();
  }, true);
  window.addEventListener("pointercancel", () => {
    if (dragSink?.active()) dragSink.end();
  }, true);

  function findVideo() {
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const pick = (list, minW = 0, minH = 0) =>
      [...list]
        .filter((v) => {
          if (v.videoWidth <= 0 || v.hasAttribute("data-gp-remote")) return false;
          if (!minW && !minH) return true;
          const r = v.getBoundingClientRect();
          return r.width >= minW && r.height >= minH;
        })
        .sort((a, b) => area(b) - area(a))[0] ?? null;
    if (ctx.site.video) {
      return pick(document.querySelectorAll(ctx.site.video)) || pick(document.querySelectorAll("video"));
    }
    return pick(document.querySelectorAll("video"), 200, 120);
  }

  function chatUrlFor(site) {
    if (!site.chatPopoutUrl || !site.idFrom) return null;
    const id = "param" in site.idFrom
      ? new URLSearchParams(location.search).get(site.idFrom.param)
      : location.pathname.split("/")[site.idFrom.pathIndex];
    return id ? site.chatPopoutUrl.replace(/\{(?:videoId|channelId|channel)\}/g, encodeURIComponent(id)) : null;
  }

  function persistHome(corner, keepLayoutPos = false) {
    send({ type: "PATCH_SETTINGS", patch: { dodge: { home: corner } }, keepLayoutPos });
  }

  function enterIdle() {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    let pointerOver = false;
    let launcherOver = false;
    let idleTimer = null;

    function update() {
      const r = ctx.video?.getBoundingClientRect();
      if (!r || r.width === 0) return launcher.hide();
      const anchor = { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 6 };
      if (pointerOver || launcherOver) launcher.show({ x: px(anchor.x), y: px(anchor.y) });
      else launcher.hide();
    }

    function armIdleHide() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!launcherOver) {
          pointerOver = false;
          update();
        }
      }, 2000);
    }

    launcher.host.addEventListener("pointerenter", () => {
      launcherOver = true;
      clearTimeout(idleTimer);
      update();
    }, on);
    launcher.host.addEventListener("pointerleave", () => {
      launcherOver = false;
      armIdleHide();
      update();
    }, on);

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      const r = ctx.video?.getBoundingClientRect();
      pointerOver = !!r && inside(r, e.clientX, e.clientY);
      if (pointerOver) armIdleHide();
      else clearTimeout(idleTimer);
      update();
    }, { capture: true, ...on });

    document.documentElement.addEventListener("mouseleave", () => {
      pointerOver = false;
      launcherOver = false;
      clearTimeout(idleTimer);
      update();
    }, on);

    const timer = setInterval(update, 500);

    return {
      exit() {
        ac.abort();
        clearInterval(timer);
        clearTimeout(idleTimer);
        launcher.hide();
      },
    };
  }

  function enterFloating({ video, ratioFallback = 9 / 16, isRemote = false }, leave) {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const viewport = () => ({
      l: 0,
      t: 0,
      r: document.documentElement.clientWidth || window.innerWidth,
      b: document.documentElement.clientHeight || window.innerHeight,
    });
    const cfg = () => ctx.settings.dodge;

    let floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
    let floatHeight = ctx.layout.height || null;
    let customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
    let lastHome = cfg().home;
    let corner = lastHome;
    let dodge = Dodge.initialState(corner);
    let faded = false;
    let held = false;
    let wheelPreview = false;
    let waitCursorLeave = false;
    let drag = null;
    let cursor = null;

    controller.host.toggleAttribute("data-remote", Boolean(isRemote));

    function size() {
      const vp = viewport();
      const maxW = Math.max(MIN_FLOAT_WIDTH, vp.r);
      const maxH = Math.max(MIN_FLOAT_HEIGHT, vp.b);
      if (Number.isFinite(floatHeight) && floatHeight > 0) {
        return {
          w: Math.round(Math.min(Math.max(MIN_FLOAT_WIDTH, floatWidth), maxW)),
          h: Math.round(Math.min(Math.max(MIN_FLOAT_HEIGHT, floatHeight), maxH)),
        };
      }
      const defaultMaxH = floatWidth === DEFAULT_FLOAT_WIDTH ? vp.b * 0.6 : maxH;
      return floatSize(video, floatWidth, defaultMaxH, ratioFallback, Math.max(MIN_FLOAT_WIDTH, vp.r - 16));
    }

    function rect() {
      if (drag) return { l: drag.x, t: drag.y, r: drag.x + drag.w, b: drag.y + drag.h };
      const s = size();
      const vp = viewport();
      if (customPos) return fromRelPos(customPos, s, vp);
      return Dodge.cornerRect(corner, s, vp, cfg().edgeInsetPx);
    }

    function isInteractive() {
      if (held || drag !== null) return true;
      if (!ctx.settings.clickThrough && !cfg().enabled && cursor) {
        const r = rect();
        return cursor.x >= r.l && cursor.x <= r.r && cursor.y >= r.t && cursor.y <= r.b;
      }
      return false;
    }

    function render() {
      const r = rect();
      const w = Math.round(r.r - r.l);
      const h = Math.round(r.b - r.t);
      const interactive = isInteractive();
      const hovered =
        drag !== null ||
        (cursor !== null && cursor.x >= r.l && cursor.x <= r.r && cursor.y >= r.t && cursor.y <= r.b);
      const showBarOnly = !interactive && hovered;
      const geometry = { x: px(r.l), y: px(r.t), w: px(w), h: px(h) };
      const opacity = interactive && !wheelPreview ? 1 : faded ? FADED_OPACITY : ctx.settings.opacity;
      setVars(video, { ...geometry, opacity: String(opacity) });
      video.toggleAttribute("data-gp-pass", !interactive && ctx.settings.clickThrough);
      video.toggleAttribute("data-gp-drag", drag !== null);
      hudEl.textContent = `투명도 ${Math.round(ctx.settings.opacity * 100)}% (휠 조절) · ${w}×${h}`;
      controller.host.toggleAttribute("data-hovered", hovered);
      controller.host.toggleAttribute("data-bar-only", showBarOnly);
      if (interactive || showBarOnly) controller.show(geometry);
      else controller.hide();
    }

    function settingsChanged() {
      if (cfg().home !== lastHome) {
        lastHome = cfg().home;
        corner = lastHome;
        customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
        dodge = Dodge.initialState(corner);
        faded = false;
      }
      render();
    }

    function layoutChanged() {
      if (drag) return;
      floatWidth = ctx.layout.width || DEFAULT_FLOAT_WIDTH;
      floatHeight = ctx.layout.height || null;
      customPos = ctx.layout.pos ? { ...ctx.layout.pos } : null;
      render();
    }

    function tick() {
      if (isInteractive()) return;
      const vp = viewport();
      const s = size();
      const r = rect();
      const m = cfg().marginPx;
      const cursorInCurrent =
        cursor !== null &&
        cursor.x >= r.l - m &&
        cursor.x < r.r + m &&
        cursor.y >= r.t - m &&
        cursor.y < r.b + m;

      if (waitCursorLeave) {
        if (cursorInCurrent) {
          dodge = { ...dodge, hoverSince: null };
          return;
        }
        waitCursorLeave = false;
      }

      let stepCursor = cursor;
      if (customPos !== null) {
        if (cursorInCurrent) {
          const cr = Dodge.cornerRect(dodge.corner, s, vp, cfg().edgeInsetPx);
          stepCursor = { x: (cr.l + cr.r) / 2, y: (cr.t + cr.b) / 2 };
        } else {
          stepCursor = null;
        }
      }

      const out = Dodge.step(dodge, { now: performance.now(), cursor: stepCursor, size: s, area: vp }, cfg());
      dodge = out.state;
      if (out.action.type === "move") {
        customPos = null;
        corner = out.action.corner;
      } else if (out.action.type === "fade") {
        faded = out.action.on;
      } else {
        return;
      }
      render();
    }

    function setHeld(next) {
      if (next === held) return;
      if (held && !next) {
        wheelPreview = false;
        if (cursor) {
          const r = rect();
          const m = cfg().marginPx;
          if (cursor.x >= r.l - m && cursor.x < r.r + m && cursor.y >= r.t - m && cursor.y < r.b + m) {
            waitCursorLeave = true;
            dodge = { ...dodge, hoverSince: null };
          }
        }
      }
      held = next;
      render();
    }
    const holdFrom = (e) => e.isTrusted && setHeld(HOLD[ctx.settings.hotkeys.hold](e));

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      const prevInteractive = isInteractive();
      const prevHovered = controller.host.hasAttribute("data-hovered");
      cursor = { x: e.clientX, y: e.clientY };
      holdFrom(e);
      const r = rect();
      const nowHovered =
        drag !== null || (cursor.x >= r.l && cursor.x <= r.r && cursor.y >= r.t && cursor.y <= r.b);
      if (prevInteractive !== isInteractive() || prevHovered !== nowHovered) render();
      tick();
    }, { capture: true, ...on });

    window.addEventListener("wheel", (e) => {
      const r = rect();
      const overRect = e.clientX >= r.l && e.clientX <= r.r && e.clientY >= r.t && e.clientY <= r.b;
      if (!overRect && e.target !== video && e.target !== controller.host) return;
      const modHeld = held || HOLD[ctx.settings.hotkeys.hold](e);
      if (!modHeld && ctx.settings.clickThrough) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.deltaY) return;
      wheelPreview = true;
      waitCursorLeave = true;
      dodge = { ...dodge, hoverSince: null };
      stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
      render();
    }, { capture: true, passive: false, ...on });

    document.documentElement.addEventListener("mouseleave", () => {
      cursor = null;
      render();
    }, on);
    window.addEventListener("keydown", holdFrom, { capture: true, ...on });
    window.addEventListener("keyup", holdFrom, { capture: true, ...on });
    window.addEventListener("blur", () => setHeld(false), on);
    document.addEventListener("visibilitychange", () => setHeld(false), on);
    window.addEventListener("resize", render, on);
    video.addEventListener("resize", render, on);
    const timer = setInterval(tick, DODGE_TICK_MS);

    dragSink = {
      active() {
        return drag !== null;
      },
      start(e, resizeDir) {
        wheelPreview = false;
        const r = rect();
        if (resizeDir) {
          drag = {
            mode: "resize",
            dir: resizeDir,
            startRect: r,
            startX: e.clientX,
            startY: e.clientY,
            x: r.l,
            y: r.t,
            w: r.r - r.l,
            h: r.b - r.t,
          };
        } else {
          drag = {
            mode: "move",
            x: r.l,
            y: r.t,
            w: r.r - r.l,
            h: r.b - r.t,
            dx: e.clientX - r.l,
            dy: e.clientY - r.t,
          };
        }
        render();
      },
      move(e) {
        if (!drag) return;
        const vp = viewport();
        if (drag.mode === "move") {
          const s = size();
          drag.w = s.w;
          drag.h = s.h;
          drag.x = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, vp.r - s.w));
          drag.y = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, vp.b - s.h));
        } else {
          const sr = drag.startRect;
          const startW = sr.r - sr.l;
          const startH = sr.b - sr.t;
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          const hasW = drag.dir.includes("w");
          const hasE = drag.dir.includes("e");
          const hasN = drag.dir.includes("n");
          const hasS = drag.dir.includes("s");

          const maxW = hasW ? sr.r : hasE ? vp.r - sr.l : vp.r;
          const maxH = hasN ? sr.b : hasS ? vp.b - sr.t : vp.b;

          const rawW = hasE ? startW + dx : hasW ? startW - dx : startW;
          const rawH = hasS ? startH + dy : hasN ? startH - dy : startH;

          const nextW = Math.round(
            Math.min(Math.max(MIN_FLOAT_WIDTH, rawW), Math.max(MIN_FLOAT_WIDTH, Math.min(MAX_FLOAT_WIDTH, maxW))),
          );
          const nextH = Math.round(
            Math.min(Math.max(MIN_FLOAT_HEIGHT, rawH), Math.max(MIN_FLOAT_HEIGHT, Math.min(MAX_FLOAT_HEIGHT, maxH))),
          );

          const nextX = hasW ? sr.r - nextW : sr.l;
          const nextY = hasN ? sr.b - nextH : sr.t;

          floatWidth = nextW;
          floatHeight = nextH;
          drag.x = Math.max(0, nextX);
          drag.y = Math.max(0, nextY);
          drag.w = nextW;
          drag.h = nextH;
        }
        render();
      },
      end() {
        if (!drag) return;
        const vp = viewport();
        const r = { l: drag.x, t: drag.y, r: drag.x + drag.w, b: drag.y + drag.h };
        const s = { w: drag.w, h: drag.h };
        drag = null;
        waitCursorLeave = true;

        const nearest = Dodge.nearestCorner(r, vp);
        const cr = Dodge.cornerRect(nearest, s, vp, cfg().edgeInsetPx);
        const nearCorner = Math.hypot(r.l - cr.l, r.t - cr.t) <= CORNER_SNAP_PX;

        corner = nearest;
        dodge = Dodge.initialState(corner);
        faded = false;
        customPos = nearCorner ? null : toRelPos(r.l, r.t, s, vp);

        persistLayout({ width: floatWidth, height: floatHeight, pos: customPos });
        if (cfg().allowed.includes(nearest) && nearest !== cfg().home) {
          lastHome = nearest;
          persistHome(nearest, true);
        }
        render();
      },
    };

    function exit() {
      ac.abort();
      clearInterval(timer);
      dragSink = null;
      controller.hide();
      if (video.matches(":popover-open")) video.hidePopover();
    }

    video.setAttribute("popover", "manual");
    video.classList.add(FLOAT_CLASS);
    render();
    try {
      video.showPopover();
    } catch {
      queueMicrotask(leave);
    }

    return { exit, settingsChanged, layoutChanged };
  }

  function boostVideoSdp(sdp) {
    if (typeof sdp !== "string") return sdp;
    let out = sdp.replace(/(m=video .*\r\n)/, "$1b=AS:12000\r\n");
    out = out.replace(
      /(a=fmtp:\d+ )([^\r\n]*)/g,
      (_m, p1, p2) =>
        `${p1}${p2};x-google-min-bitrate=4000;x-google-start-bitrate=8000;x-google-max-bitrate=12000`,
    );
    return out;
  }

  function enterInTab(_arg, leave) {
    const video = ctx.video;
    const original = {
      popover: video.getAttribute("popover"),
      class: video.hasAttribute("class"),
      style: video.hasAttribute("style"),
    };
    const floating = enterFloating({ video, isRemote: false }, leave);
    const capCanvas = document.createElement("canvas");
    const capCtx = capCanvas.getContext("2d", { alpha: false });
    let alive = true;
    let senderPort = null;
    let keepAlivePc1 = null;
    let keepAlivePc2 = null;
    let keepAliveSink = null;
    let keepAliveTracks = [];
    let rtcPeer = null;
    let rtcTrack = null;

    function stopRtcPeer() {
      if (rtcPeer) {
        rtcPeer.close();
        rtcPeer = null;
      }
      if (rtcTrack) {
        rtcTrack.stop();
        rtcTrack = null;
      }
    }

    function stopKeepAlive() {
      stopRtcPeer();
      if (keepAlivePc1) {
        keepAlivePc1.close();
        keepAlivePc1 = null;
      }
      if (keepAlivePc2) {
        keepAlivePc2.close();
        keepAlivePc2 = null;
      }
      if (keepAliveSink) {
        keepAliveSink.srcObject = null;
        keepAliveSink = null;
      }
      for (const t of keepAliveTracks) t.stop();
      keepAliveTracks = [];
    }

    // Chromium's WebMediaPlayerImpl suspends the video decoder when a tab is hidden unless an active
    // captureStream() WebRTC sink is attached while the tab is still visible.
    async function startKeepAlive() {
      stopKeepAlive();
      if (!alive || video.mediaKeys) return;
      try {
        const stream = video.captureStream();
        keepAliveTracks = stream.getVideoTracks();
        if (!keepAliveTracks.length) return;
        for (const t of keepAliveTracks) t.contentHint = "detail";
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        keepAlivePc1 = pc1;
        keepAlivePc2 = pc2;
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
        const sink = document.createElement("video");
        sink.muted = true;
        sink.playsInline = true;
        keepAliveSink = sink;
        pc2.ontrack = (e) => {
          sink.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          sink.play().catch(() => {});
        };
        for (const t of keepAliveTracks) pc1.addTrack(t, stream);
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
      } catch {}
    }

    async function startRtcSender() {
      stopRtcPeer();
      if (!alive || !senderPort || video.mediaKeys) return;
      try {
        const baseTrack = keepAliveTracks[0] ?? video.captureStream().getVideoTracks()[0];
        if (!baseTrack) return;
        const track = baseTrack.clone();
        track.contentHint = "detail";
        rtcTrack = track;
        const pc = new RTCPeerConnection();
        rtcPeer = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && senderPort) {
            try {
              senderPort.postMessage({ type: "RTC_CANDIDATE", candidate: e.candidate.toJSON() });
            } catch {}
          }
        };
        const stream = new MediaStream([track]);
        const sender = pc.addTrack(track, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        try {
          const params = sender.getParameters();
          params.degradationPreference = "maintain-resolution";
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 12_000_000;
          params.encodings[0].maxFramerate = 60;
          params.encodings[0].scaleResolutionDownBy = 1;
          await sender.setParameters(params);
        } catch {}
        if (rtcPeer === pc && senderPort) {
          senderPort.postMessage({ type: "RTC_OFFER", sdp: boostVideoSdp(pc.localDescription.sdp) });
        }
      } catch {}
    }

    function captureFrame(targetW) {
      if (!alive || !senderPort) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const desiredW = Math.max(960, Math.min(1280, Number(targetW) || 960));
      const cw = Math.min(desiredW, vw);
      const ch = Math.max(1, Math.round((cw * vh) / vw));
      if (capCanvas.width !== cw || capCanvas.height !== ch) {
        capCanvas.width = cw;
        capCanvas.height = ch;
      }
      try {
        capCtx.drawImage(video, 0, 0, cw, ch);
        const dataUrl = capCanvas.toDataURL("image/jpeg", 0.9);
        senderPort.postMessage({ type: "FRAME", dataUrl, vw, vh });
      } catch {}
    }

    function connectSender() {
      if (!alive || senderPort) return;
      try {
        const port = chrome.runtime.connect({ name: "ghostpip-sender" });
        senderPort = port;
        port.onMessage.addListener((msg) => {
          if (msg?.type === "PULL_FRAME") {
            captureFrame(msg.targetW);
          } else if (msg?.type === "RTC_INIT") {
            startRtcSender();
          } else if (msg?.type === "RTC_ANSWER" && rtcPeer && msg.sdp) {
            rtcPeer.setRemoteDescription({ type: "answer", sdp: boostVideoSdp(msg.sdp) }).catch(() => {});
          } else if (msg?.type === "RTC_CANDIDATE" && rtcPeer && msg.candidate) {
            rtcPeer.addIceCandidate(msg.candidate).catch(() => {});
          }
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (senderPort === port) senderPort = null;
        });
      } catch {}
    }

    const onLoadedData = () => {
      if (!alive) return;
      startKeepAlive().then(() => {
        if (senderPort) startRtcSender();
      });
    };
    video.addEventListener("loadeddata", onLoadedData);
    startKeepAlive();
    connectSender();

    function querySource() {
      connectSender();
      const ratio = video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
      return { ok: true, ratio };
    }

    function exit() {
      alive = false;
      video.removeEventListener("loadeddata", onLoadedData);
      if (senderPort) {
        try {
          senderPort.disconnect();
        } catch {}
        senderPort = null;
      }
      stopKeepAlive();
      send({ type: "INTAB_CLOSED" });
      floating.exit();
      if (original.popover === null) video.removeAttribute("popover");
      else video.setAttribute("popover", original.popover);
      video.classList.remove(FLOAT_CLASS);
      video.removeAttribute("data-gp-pass");
      video.removeAttribute("data-gp-drag");
      for (const name of GP_VARS) video.style.removeProperty(name);
      for (const attr of ["class", "style"]) {
        if (!original[attr] && !video.getAttribute(attr)) video.removeAttribute(attr);
      }
    }

    send({ type: "INTAB_OPENED" });
    return {
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      querySource,
      connectSender,
    };
  }

  function enterRemoteInTab({ ratio }, leave) {
    const initRatio = ratio || 9 / 16;
    const canvas = h("canvas", {
      class: FLOAT_CLASS,
      "data-gp-remote": "",
      popover: "manual",
    });
    canvas.width = DEFAULT_FLOAT_WIDTH;
    canvas.height = Math.max(1, Math.round(DEFAULT_FLOAT_WIDTH * initRatio));
    canvas.videoWidth = canvas.width;
    canvas.videoHeight = canvas.height;
    let framesRendered = 0;
    canvas.getVideoPlaybackQuality = () => ({ totalVideoFrames: framesRendered });
    const ctx2d = canvas.getContext("2d", { alpha: false });
    document.documentElement.append(canvas);

    const floating = enterFloating({ video: canvas, ratioFallback: initRatio, isRemote: true }, leave);

    let alive = true;
    let receiverPort = null;
    let pulling = false;
    let lastPullAt = 0;
    let pullTimer = null;
    let rtcPeer = null;
    let rtcVideo = null;
    let rtcActive = false;

    function drawRtcFrame() {
      if (!alive || !rtcVideo || rtcVideo.readyState < 2 || !rtcVideo.videoWidth || !rtcVideo.videoHeight) {
        return false;
      }
      const vw = rtcVideo.videoWidth;
      const vh = rtcVideo.videoHeight;
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }
      const aspectChanged = canvas.videoWidth !== vw || canvas.videoHeight !== vh;
      canvas.videoWidth = vw;
      canvas.videoHeight = vh;
      canvas.dataset.gpVw = String(vw);
      canvas.dataset.gpVh = String(vh);
      try {
        ctx2d.drawImage(rtcVideo, 0, 0, vw, vh);
        framesRendered++;
        canvas.dataset.gpFrames = String(framesRendered);
        rtcActive = true;
        if (aspectChanged) canvas.dispatchEvent(new Event("resize"));
        return true;
      } catch {
        return false;
      }
    }

    function stopRtcReceiver() {
      rtcActive = false;
      if (rtcPeer) {
        rtcPeer.close();
        rtcPeer = null;
      }
      if (rtcVideo) {
        rtcVideo.srcObject = null;
        rtcVideo = null;
      }
    }

    async function handleRtcOffer(sdp) {
      stopRtcReceiver();
      if (!alive || !receiverPort) return;
      try {
        const pc = new RTCPeerConnection();
        rtcPeer = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && receiverPort) {
            try {
              receiverPort.postMessage({ type: "RTC_CANDIDATE", candidate: e.candidate.toJSON() });
            } catch {}
          }
        };
        const vid = document.createElement("video");
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        rtcVideo = vid;
        pc.ontrack = (e) => {
          vid.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          vid.play().catch(() => {});
        };
        await pc.setRemoteDescription({ type: "offer", sdp: boostVideoSdp(sdp) });
        const answer = await pc.createAnswer();
        const boostedAnswer = boostVideoSdp(answer.sdp);
        await pc.setLocalDescription({ type: "answer", sdp: boostedAnswer });
        if (rtcPeer === pc && receiverPort) {
          receiverPort.postMessage({ type: "RTC_ANSWER", sdp: boostedAnswer });
        }
      } catch {}
    }

    function requestFrame() {
      if (!alive) return;
      if (drawRtcFrame()) return;
      if (!receiverPort) connectReceiver();
      if (!receiverPort) return;
      const now = performance.now();
      if (pulling && now - lastPullAt < 250) return;
      pulling = true;
      lastPullAt = now;
      const targetW = Math.round((ctx.layout.width || DEFAULT_FLOAT_WIDTH) * (window.devicePixelRatio || 1) * 1.5);
      try {
        receiverPort.postMessage({ type: "PULL_FRAME", targetW });
      } catch {
        pulling = false;
      }
    }

    async function handleFrame(msg) {
      if (!alive || !msg?.dataUrl || rtcActive) {
        pulling = false;
        return;
      }
      try {
        const comma = msg.dataUrl.indexOf(",");
        const b64 = comma >= 0 ? msg.dataUrl.slice(comma + 1) : msg.dataUrl;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (!alive || rtcActive) {
          bmp.close();
          pulling = false;
          return;
        }
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        const aspectChanged =
          msg.vw > 0 && msg.vh > 0 && (canvas.videoWidth !== msg.vw || canvas.videoHeight !== msg.vh);
        if (msg.vw > 0 && msg.vh > 0) {
          canvas.videoWidth = msg.vw;
          canvas.videoHeight = msg.vh;
          canvas.dataset.gpVw = String(msg.vw);
          canvas.dataset.gpVh = String(msg.vh);
        }
        ctx2d.drawImage(bmp, 0, 0);
        bmp.close();
        framesRendered++;
        canvas.dataset.gpFrames = String(framesRendered);
        if (aspectChanged) canvas.dispatchEvent(new Event("resize"));
      } catch {}
      pulling = false;
      if (alive && !rtcActive) {
        clearTimeout(pullTimer);
        pullTimer = setTimeout(requestFrame, 33);
      }
    }

    function connectReceiver() {
      if (!alive || receiverPort) return;
      try {
        const port = chrome.runtime.connect({ name: "ghostpip-receiver" });
        receiverPort = port;
        port.onMessage.addListener((msg) => {
          if (msg?.type === "FRAME") {
            handleFrame(msg);
          } else if (msg?.type === "RTC_OFFER" && msg.sdp) {
            handleRtcOffer(msg.sdp);
          } else if (msg?.type === "RTC_CANDIDATE" && rtcPeer && msg.candidate) {
            rtcPeer.addIceCandidate(msg.candidate).catch(() => {});
          }
        });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (receiverPort === port) {
            receiverPort = null;
            pulling = false;
          }
        });
        port.postMessage({ type: "RTC_INIT" });
      } catch {}
    }

    connectReceiver();
    requestFrame();
    const renderTick = setInterval(() => {
      if (!drawRtcFrame()) requestFrame();
    }, 16);

    function exit() {
      alive = false;
      clearInterval(renderTick);
      clearTimeout(pullTimer);
      stopRtcReceiver();
      if (receiverPort) {
        try {
          receiverPort.disconnect();
        } catch {}
        receiverPort = null;
      }
      floating.exit();
      canvas.remove();
    }

    return {
      video: canvas,
      exit,
      settingsChanged: floating.settingsChanged,
      layoutChanged: floating.layoutChanged,
      kick: () => {
        if (!rtcActive && receiverPort) {
          try {
            receiverPort.postMessage({ type: "RTC_INIT" });
          } catch {}
        }
        requestFrame();
      },
      ready: Promise.resolve({ ok: true }),
    };
  }

  const PIP_CSS = `
    ${BASE_CSS}
    html, body { margin: 0; height: 100%; background: #000; color: #fff; font: 13px system-ui, "Malgun Gothic", sans-serif; overflow: hidden; }
    body { display: flex; flex-direction: column; position: relative; }
    video { flex: 1 1 auto; min-height: 0; width: 100%; height: 100%; object-fit: fill; background: #000; }
    iframe { flex: 0 0 ${PIP_CHAT_HEIGHT}px; width: 100%; border: 0; background: #fff; }
    .pip-bar { position: fixed; top: 8px; left: 50%; z-index: 10; opacity: 0; pointer-events: none;
      transform: translateX(-50%) translateY(-4px); transition: opacity 0.16s ease, transform 0.16s ease; }
    body:hover .pip-bar,
    body[data-hovered] .pip-bar { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
    .pip-hud { position: fixed; top: 8px; left: 8px; z-index: 10; padding: 4px 8px; border-radius: 5px; pointer-events: none;
      background: rgba(18, 18, 22, 0.85); color: #fff; font: 600 12px/1 system-ui, "Malgun Gothic", sans-serif;
      opacity: 0; transition: opacity 0.15s ease-out; }
    .pip-hud[data-show] { opacity: 1; }`;

  function resizeDocPipWindow(w, deltaH) {
    if (!w || w.closed) return;
    try {
      const prevH = w.outerHeight;
      const nextH = Math.max(180, prevH + deltaH);
      const availTop = w.screen?.availTop ?? 0;
      const availH = w.screen?.availHeight ?? 1080;
      const inBottomHalf = w.screenY + prevH / 2 > availTop + availH / 2;
      if (inBottomHalf && deltaH > 0) {
        w.moveTo(w.screenX, Math.max(availTop, w.screenY - deltaH));
        w.resizeTo(w.outerWidth, nextH);
      } else if (inBottomHalf && deltaH < 0) {
        w.resizeTo(w.outerWidth, nextH);
        w.moveTo(w.screenX, w.screenY - deltaH);
      } else {
        w.resizeTo(w.outerWidth, nextH);
      }
    } catch {}
  }

  function buildPipDocument(win, stream, chatUrl, showChat, { onToggleChat, onResizeChat } = {}) {
    const doc = win.document;
    const style = doc.createElement("style");
    style.textContent = PIP_CSS;
    doc.head.append(style);
    const mirror = doc.createElement("video");
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.srcObject = stream;
    const pipHud = doc.createElement("div");
    pipHud.className = "pip-hud";
    doc.body.append(mirror, pipHud);

    let chatBtn = null;
    let chatLabel = null;
    if (chatUrl) {
      chatLabel = doc.createElement("span");
      chatBtn = doc.createElement("button");
      chatBtn.type = "button";
      chatBtn.dataset.action = "toggleChat";
      chatBtn.append(svgIcon(ICON_CHAT), chatLabel);
      chatBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleChat?.();
      });
      const pipBar = doc.createElement("div");
      pipBar.className = "bar pip-bar";
      pipBar.append(chatBtn);
      doc.body.append(pipBar);
    }

    doc.documentElement.addEventListener("pointerenter", () => doc.body.setAttribute("data-hovered", ""));
    doc.documentElement.addEventListener("pointermove", () => doc.body.setAttribute("data-hovered", ""));
    doc.documentElement.addEventListener("mouseleave", () => doc.body.removeAttribute("data-hovered"));

    let frame = null;
    let chatShown = Boolean(showChat && chatUrl);

    function syncChat(enabled, resizeWin = false) {
      if (!chatUrl) return;
      const nextShown = Boolean(enabled);
      const changed = nextShown !== chatShown;
      chatShown = nextShown;
      if (chatLabel) chatLabel.textContent = nextShown ? "채팅창 숨기기" : "채팅창 보기";
      if (chatBtn) chatBtn.toggleAttribute("data-active", nextShown);
      if (nextShown) {
        if (!frame) {
          frame = doc.createElement("iframe");
          frame.src = chatUrl;
        }
        if (!frame.isConnected) doc.body.append(frame);
      } else if (frame) {
        frame.remove();
      }
      if (resizeWin && changed) {
        onResizeChat?.(nextShown ? PIP_CHAT_HEIGHT : -PIP_CHAT_HEIGHT);
      }
    }

    function setHovered(hovered) {
      doc.body.toggleAttribute("data-hovered", Boolean(hovered));
    }

    syncChat(showChat, false);
    mirror.play().catch(() => {});
    return { mirror, pipHud, syncChat, setHovered };
  }

  function enterDocPip({ stream: firstStream, chatUrl, win: winPromise }, leave) {
    const video = ctx.video;
    const originalHasClass = video.hasAttribute("class");
    video.classList.add(DOCPIP_SOURCE_CLASS);
    const ac = new AbortController();
    let stream = firstStream;
    let win = null;
    let mirror = null;
    let pipHud = null;
    let syncChat = null;
    let setHovered = null;
    let hudTimer = null;
    let engineConnected = true;

    function syncPipOpacity(showToast = false) {
      if (!mirror) return;
      mirror.style.opacity = engineConnected ? "1" : String(ctx.settings.opacity);
      if (showToast && pipHud) {
        pipHud.textContent = `투명도 ${Math.round(ctx.settings.opacity * 100)}%`;
        pipHud.setAttribute("data-show", "");
        clearTimeout(hudTimer);
        hudTimer = setTimeout(() => pipHud?.removeAttribute("data-show"), 900);
      }
    }

    function handleResizeChat(deltaH) {
      if (!win || win.closed) return;
      if (!engineConnected) {
        resizeDocPipWindow(win, deltaH);
        return;
      }
      send({
        type: "PIP_RESIZE",
        deltaH,
        dpr: win.devicePixelRatio || 1,
      }).then((res) => {
        if (!res?.handledByEngine) resizeDocPipWindow(win, deltaH);
      });
    }

    function handleToggleChat() {
      const next = !ctx.settings.showChat;
      ctx.settings = { ...ctx.settings, showChat: next };
      syncChat?.(next, true);
      send({ type: "PATCH_SETTINGS", patch: { showChat: next } });
    }

    winPromise.then((w) => {
      if (ac.signal.aborted) return w.close();
      win = w;
      const built = buildPipDocument(w, stream, chatUrl, Boolean(ctx.settings.showChat), {
        onToggleChat: handleToggleChat,
        onResizeChat: handleResizeChat,
      });
      mirror = built.mirror;
      pipHud = built.pipHud;
      syncChat = built.syncChat;
      setHovered = built.setHovered;
      w.addEventListener("pagehide", leave, { signal: ac.signal });
      w.addEventListener("wheel", (e) => {
        if (e.target !== mirror && !HOLD[ctx.settings.hotkeys.hold](e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.deltaY) return;
        stepOpacity(e.deltaY < 0 ? WHEEL_OPACITY_STEP : -WHEEL_OPACITY_STEP);
        syncPipOpacity(true);
      }, { capture: true, passive: false, signal: ac.signal });
      // Until its first resize the PiP window reports the opener's placeholder geometry, so the
      // rect handshake waits for it, with a timeout in case the platform never resizes.
      new Promise((placed) => {
        w.addEventListener("resize", placed, { once: true, signal: ac.signal });
        setTimeout(placed, 1000);
      }).then(() => {
        if (ac.signal.aborted) return;
        const readRect = () => ({ x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight });
        send({
          type: "PIP_OPENED",
          kind: "document",
          rect: readRect(),
          dpr: w.devicePixelRatio,
        }).then((res) => {
          engineConnected = Boolean(res?.engineConnected);
          syncPipOpacity(false);
        });
        setTimeout(() => {
          if (!ac.signal.aborted) send({ type: "PIP_RECT_UPDATED", rect: readRect() });
        }, 600);
      });
    }, leave);

    video.addEventListener("loadeddata", () => {
      for (const t of stream.getTracks()) t.stop();
      stream = video.captureStream();
      if (mirror) mirror.srcObject = stream;
    }, { signal: ac.signal });

    return {
      settingsChanged: () => {
        syncPipOpacity(false);
        syncChat?.(Boolean(ctx.settings.showChat), true);
      },
      setHovered: (hovered) => {
        setHovered?.(hovered);
      },
      exit() {
        ac.abort();
        clearTimeout(hudTimer);
        video.classList.remove(DOCPIP_SOURCE_CLASS);
        if (!originalHasClass && !video.getAttribute("class")) video.removeAttribute("class");
        for (const t of stream.getTracks()) t.stop();
        if (!win) return;
        send({ type: "PIP_CLOSED" });
        win.close();
      },
    };
  }

  function enterNativePip(request, leave) {
    const video = ctx.video;
    const ac = new AbortController();
    let opened = false;
    function reportOpened(pw) {
      if (opened || !pw) return;
      opened = true;
      // The native PiP window's screen position is not exposed to pages; the opener's position is a
      // placeholder and the engine matches on size.
      send({
        type: "PIP_OPENED",
        kind: "native",
        rect: { x: window.screenX, y: window.screenY, w: pw.width, h: pw.height },
        dpr: devicePixelRatio,
      });
    }
    video.addEventListener("enterpictureinpicture", (e) => reportOpened(e.pictureInPictureWindow), { signal: ac.signal });
    video.addEventListener("leavepictureinpicture", leave, { signal: ac.signal });
    Promise.resolve(request).then(reportOpened, leave);
    return {
      exit() {
        ac.abort();
        if (opened) send({ type: "PIP_CLOSED" });
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      },
    };
  }

  document.addEventListener("enterpictureinpicture", (e) => {
    if (current.name !== "idle" || !(e.target instanceof HTMLVideoElement)) return;
    ctx.video = e.target;
    go("nativePip", Promise.resolve(e.pictureInPictureWindow));
  }, true);

  // DRM or an uncapturable element falls back to native PiP. Both checks are synchronous so the
  // click's user activation is still unspent when requestWindow/requestPictureInPicture runs.
  function startPip() {
    const video = ctx.video;
    let stream = null;
    if (!video.mediaKeys) {
      try {
        stream = video.captureStream();
      } catch {}
    }
    if (!stream) return go("nativePip", video.requestPictureInPicture());
    const chatUrl = chatUrlFor(ctx.site);
    const showChat = Boolean(ctx.settings.showChat && chatUrl);
    const size = floatSize(video, DEFAULT_FLOAT_WIDTH, DEFAULT_FLOAT_WIDTH);
    const height = size.h + (showChat ? PIP_CHAT_HEIGHT : 0);
    go("docPip", { stream, chatUrl, win: documentPictureInPicture.requestWindow({ width: size.w, height }) });
  }

  const ACTIONS = {
    inTab: () => go("inTab"),
    docPip: startPip,
    idle: () => {
      send({ type: "INTAB_STOP_ALL" });
      go("idle");
    },
    focusSource: () => {
      send({ type: "FOCUS_SOURCE_TAB" });
    },
  };

  const ENTER = {
    idle: enterIdle,
    inTab: enterInTab,
    remoteInTab: enterRemoteInTab,
    docPip: enterDocPip,
    nativePip: enterNativePip,
  };
  const TRANSITIONS = {
    idle: ["idle", "inTab", "remoteInTab", "docPip", "nativePip"],
    inTab: ["idle", "docPip", "nativePip"],
    remoteInTab: ["idle", "remoteInTab"],
    docPip: ["idle"],
    nativePip: ["idle"],
  };
  const noop = () => {};
  let current = { name: "idle", video: null, exit: noop, settingsChanged: noop, layoutChanged: noop };

  function go(next, arg) {
    if (!TRANSITIONS[current.name].includes(next)) return;
    if (next !== "idle" && next !== "remoteInTab" && !ctx.video) return;
    current.exit();
    const inst = { name: next, video: ctx.video, exit: noop, settingsChanged: noop, layoutChanged: noop };
    current = inst;
    Object.assign(inst, ENTER[next](arg, () => current === inst && go("idle")));
  }

  function scan() {
    if (location.href !== ctx.url) {
      ctx.url = location.href;
      if (current.name === "idle") {
        ctx.video = null;
        go("idle");
      } else if (current.video && !current.video.isConnected) {
        ctx.video = null;
        go("idle");
      }
      loadSite();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (current.video && !current.video.isConnected) go("idle");
  }

  function applySettings(stored) {
    ctx.settings = Settings.merge(stored);
    current.settingsChanged();
  }

  function applyLayout(stored) {
    ctx.layout = sanitizeLayout(stored);
    current.layoutChanged?.();
  }

  const settingsReady = chrome.storage.local
    .get(["settings", "floatLayout"])
    .then(({ settings, floatLayout }) => {
      applyLayout(floatLayout);
      applySettings(settings);
    }, noop);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.floatLayout) applyLayout(changes.floatLayout.newValue);
    if (changes.settings) applySettings(changes.settings.newValue);
  });

  async function loadSite() {
    const url = location.href;
    await settingsReady;
    const res = await send({ type: "GET_SITE_CONFIG", url });
    if (!res?.site || url !== location.href) return;
    ctx.siteId = res.siteId;
    ctx.site = res.site;
    scan();
  }

  const MSG_HANDLERS = {
    async INTAB_QUERY_SOURCE() {
      if (current.name !== "inTab" || !current.querySource) return { ok: false };
      return current.querySource();
    },
    async INTAB_RECONNECT_SENDER() {
      if (current.name === "inTab") current.connectSender?.();
      return { ok: true };
    },
    async INTAB_FORCE_IDLE() {
      if (current.name === "inTab" || current.name === "remoteInTab") go("idle");
      return { ok: true };
    },
    async REMOTE_INTAB_START(msg) {
      await settingsReady;
      if (current.name === "remoteInTab" && current.video?.isConnected) {
        current.kick?.();
        return { ok: true };
      }
      if (current.name !== "idle") return { ok: false };
      go("remoteInTab", msg);
      return current.name === "remoteInTab" && current.ready ? current.ready : { ok: false };
    },
    async REMOTE_INTAB_STOP() {
      if (current.name === "remoteInTab") go("idle");
      return { ok: true };
    },
    async PIP_HOVER(msg) {
      if (current.name === "docPip") current.setHovered?.(Boolean(msg?.hovered));
      return { ok: true };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = MSG_HANDLERS[msg?.type];
    if (!fn) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement && (current.name === "inTab" || current.name === "remoteInTab")) go("idle");
  });

  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      return;
    }
    const combo = Settings.formatKeyEvent?.(e);
    if (!combo) return;
    const upper = combo.toUpperCase();
    const hk = ctx.settings.hotkeys;
    let intent = null;
    if (hk.clickThrough && hk.clickThrough.toUpperCase() === upper && upper !== "ALT+G") {
      intent = "TOGGLE_CLICK_THROUGH";
    } else if (hk.dodge && hk.dodge.toUpperCase() === upper && upper !== "ALT+SHIFT+D") {
      intent = "TOGGLE_DODGE";
    } else if (hk.mute && hk.mute.toUpperCase() === upper && upper !== "ALT+M") {
      intent = "TOGGLE_MUTE";
    }
    if (intent) {
      e.preventDefault();
      send({ type: "INTENT", intent });
    }
  }, true);

  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, SCAN_THROTTLE_MS);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1000);

  go("idle");
  loadSite();
})();
