(() => {
  "use strict";

  const Protocol = globalThis.GhostPiPProtocol;
  const MIN_FLOAT_HEIGHT = Protocol?.LAYOUT?.MIN_HEIGHT ?? 90;
  const PIP_CHAT_HEIGHT = Protocol?.LAYOUT?.PIP_CHAT_HEIGHT ?? 420;

  const FLOAT_CLASS = "ghostpip-inpage-target";
  const DOCPIP_SOURCE_CLASS = "ghostpip-docpip-source";
  const GP_VARS = Object.freeze(["--gp-x", "--gp-y", "--gp-w", "--gp-h", "--gp-opacity"]);
  const RESIZE_DIRS = Object.freeze(["nw", "ne", "sw", "se", "n", "s", "e", "w"]);
  const SVG_NS = "http://www.w3.org/2000/svg";

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
    .surface { position: absolute; inset: 0; box-sizing: border-box; pointer-events: none; border-radius: 6px;
      border: 2px solid rgba(56, 189, 248, 0.92);
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      box-shadow: 0 0 18px rgba(56, 189, 248, 0.22), inset 0 0 12px rgba(56, 189, 248, 0.12); }
    .handle { position: absolute; z-index: 2; pointer-events: auto; }
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
    .skip-ad { position: absolute; bottom: 12px; right: 12px; z-index: 4; pointer-events: auto;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.92); border: 1.5px solid rgba(56, 189, 248, 0.78);
      color: #f8fafc; font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.65); cursor: pointer; backdrop-filter: blur(8px); }
    .skip-ad:hover { background: linear-gradient(135deg, rgba(56, 189, 248, 0.35) 0%, rgba(99, 102, 241, 0.4) 100%);
      border-color: #7dd3fc; color: #fff; }
    .skip-ad[hidden] { display: none !important; }
    .hud { position: absolute; bottom: 10px; left: 10px; z-index: 3; pointer-events: none;
      padding: 5px 10px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(125, 211, 252, 0.35); color: #e0f2fe;
      font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 4px 12px rgba(2, 6, 23, 0.55); backdrop-filter: blur(8px); }
    :host([data-bar-only]) .surface,
    :host([data-bar-only]) .handle { display: none; }
    :host([data-bar-only]:not([data-has-toast])) .hud { display: none; }
    :host([data-toast-only]) .surface,
    :host([data-toast-only]) .handle,
    :host([data-toast-only]) .bar,
    :host([data-toast-only]) .skip-ad { display: none !important; }
    :host([data-peek-silhouette]) .surface { border: 1px solid rgba(56, 189, 248, 0.35); background: none; box-shadow: none; }
    :host([data-peek-silhouette]) .handle,
    :host([data-peek-silhouette]) .bar,
    :host([data-peek-silhouette]) .skip-ad { display: none !important; }
    :host([data-peek-silhouette]:not([data-has-toast])) .hud { display: none; }
    :host([data-click-through]) *,
    :host([data-click-through]) .bar,
    :host([data-click-through]) .handle,
    :host([data-click-through]) .skip-ad { pointer-events: none !important; }
    :host([data-remote]) button[data-mode="local"],
    :host(:not([data-remote])) button[data-mode="remote"] { display: none; }`;

  const WEB_CHAT_CSS = `
    :host { box-sizing: border-box; background: #0f172a; box-shadow: 0 8px 24px rgba(2, 6, 23, 0.55); }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .chat-resize { position: absolute; left: 14px; right: 14px; bottom: 0; height: 12px; z-index: 2; cursor: ns-resize; touch-action: none; }
    .chat-resize::after { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 4px; border-radius: 4px;
      transform: translate(-50%, -50%); background: rgba(125, 211, 252, 0.9); box-shadow: 0 0 6px rgba(56, 189, 248, 0.7);
      opacity: 0; transition: opacity 0.14s ease; }
    :host(:hover) .chat-resize::after, :host([data-interactive]) .chat-resize::after, .chat-resize[data-active]::after { opacity: 1; }
    :host([data-resizing]) iframe,
    :host([data-click-through]) iframe,
    :host([data-click-through]) .chat-resize { pointer-events: none !important; }`;

  const SUBTITLES_CSS = `
    :host { pointer-events: none !important; }
    .gp-sub-box { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); max-width: 92%;
      padding: 2px 6px; background: transparent; border: 0; outline: none; color: #fff;
      font: 700 clamp(12px, calc(var(--gp-w, 480px) * 0.04), 26px)/1.36 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      text-align: center; white-space: pre-line; word-break: keep-all; overflow-wrap: break-word;
      text-shadow: -1.5px -1.5px 0 rgba(0, 0, 0, 0.96), 1.5px -1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 0 -1.5px 0 rgba(0, 0, 0, 0.96), 0 1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 0 0 rgba(0, 0, 0, 0.96), 1.5px 0 0 rgba(0, 0, 0, 0.96), 0 2px 6px rgba(0, 0, 0, 0.85);
      pointer-events: none; box-sizing: border-box; }`;

  const PIP_CSS = `
    ${BASE_CSS}
    html, body { margin: 0; height: 100%; background: #000; color: #fff; font: 13px system-ui, "Malgun Gothic", sans-serif; overflow: hidden; }
    body { display: flex; flex-direction: column; position: relative; }
    .pip-stage { position: relative; flex: 1 1 auto; min-height: ${MIN_FLOAT_HEIGHT}px; width: 100%; height: 100%; background: #000; }
    video { width: 100%; height: 100%; display: block; object-fit: fill; background: #000; }
    iframe { flex: 0 0 var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px); height: var(--gp-chat-h, ${PIP_CHAT_HEIGHT}px); min-height: 0; max-height: calc(100% - ${MIN_FLOAT_HEIGHT}px); width: 100%; border: 0; background: #fff; }
    body[data-chat-resizing] iframe { pointer-events: none; }
    .pip-subtitles { position: absolute; left: 50%; bottom: 8%; transform: translateX(-50%); max-width: 92%; pointer-events: none;
      z-index: 2; padding: 2px 6px; background: transparent; border: 0; outline: none; color: #fff;
      font: 700 clamp(12px, 4vw, 26px)/1.36 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      text-align: center; white-space: pre-line; word-break: keep-all; overflow-wrap: break-word;
      text-shadow: -1.5px -1.5px 0 rgba(0, 0, 0, 0.96), 1.5px -1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 1.5px 1.5px 0 rgba(0, 0, 0, 0.96), 0 -1.5px 0 rgba(0, 0, 0, 0.96), 0 1.5px 0 rgba(0, 0, 0, 0.96), -1.5px 0 0 rgba(0, 0, 0, 0.96), 1.5px 0 0 rgba(0, 0, 0, 0.96), 0 2px 6px rgba(0, 0, 0, 0.85);
      box-sizing: border-box; }
    .pip-subtitles[hidden] { display: none !important; }
    .pip-bar { position: absolute; bottom: 14px; left: 50%; z-index: 12; opacity: 0; pointer-events: auto;
      transform: translateX(-50%); transition: opacity 0.14s ease; }
    .pip-bar button { padding: 7px 14px; font-size: 12.5px; pointer-events: auto; }
    .pip-bar button[hidden] { display: none !important; }
    body:not([data-click-through]):hover .pip-bar,
    body[data-hovered] .pip-bar { opacity: 1; pointer-events: auto; }
    .pip-handle { position: fixed; z-index: 11; pointer-events: none; opacity: 0; transition: opacity 0.16s ease; }
    body:not([data-click-through]):hover .pip-handle,
    body[data-hovered] .pip-handle,
    body[data-chat-resizing] .pip-handle.s { pointer-events: auto; opacity: 1; }
    .pip-handle.n { top: 0; left: 16px; right: 16px; height: 8px; cursor: ns-resize; }
    .pip-handle.s { bottom: 0; left: 16px; right: 16px; height: 10px; cursor: ns-resize; touch-action: none; }
    body[data-chat-open] .pip-handle.s { height: 14px; }
    body[data-chat-open] .pip-handle.s::after {
      content: ""; position: absolute; left: 50%; bottom: 3px; width: 48px; height: 4px; border-radius: 4px;
      transform: translateX(-50%); background: rgba(125, 211, 252, 0.95);
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
    .pip-handle.w { left: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
    .pip-handle.e { right: 0; top: 16px; bottom: 16px; width: 8px; cursor: ew-resize; }
    .pip-handle.nw { top: 0; left: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .pip-handle.ne { top: 0; right: 0; width: 16px; height: 16px; cursor: nesw-resize; }
    .pip-handle.sw { bottom: 0; left: 0; width: 16px; height: 16px; cursor: nesw-resize; }
    .pip-handle.se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .pip-handle.nw::after, .pip-handle.ne::after, .pip-handle.sw::after, .pip-handle.se::after {
      content: ""; position: absolute; width: 8px; height: 8px; border-radius: 2.5px;
      background: linear-gradient(135deg, #bae6fd 0%, #38bdf8 100%);
      border: 1.5px solid #0f172a; box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }
    .pip-handle.nw::after { top: 3px; left: 3px; }
    .pip-handle.ne::after { top: 3px; right: 3px; }
    .pip-handle.sw::after { bottom: 3px; left: 3px; }
    .pip-handle.se::after { bottom: 3px; right: 3px; }
    .pip-skip-ad { position: absolute; right: 12px; bottom: 12px; z-index: 12; opacity: 0; pointer-events: none;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px;
      background: rgba(15, 23, 42, 0.92); border: 1.5px solid rgba(56, 189, 248, 0.78);
      color: #f8fafc; font: 700 11.5px/1 "Pretendard", system-ui, "Malgun Gothic", sans-serif;
      box-shadow: 0 6px 18px rgba(2, 6, 23, 0.65); cursor: pointer; transition: opacity 0.16s ease; }
    .pip-skip-ad[hidden] { display: none !important; }
    body:not([data-click-through]) .pip-skip-ad,
    body[data-hovered] .pip-skip-ad { opacity: 1; pointer-events: auto; }
    .pip-hud { position: absolute; top: 8px; left: 8px; z-index: 10; padding: 4px 8px; border-radius: 5px; pointer-events: none;
      background: rgba(18, 18, 22, 0.85); color: #fff; font: 600 12px/1 system-ui, "Malgun Gothic", sans-serif;
      opacity: 0; transition: opacity 0.15s ease-out; }
    .pip-hud[data-show] { opacity: 1; }`;

  const t = (key, subs) => {
    try {
      return chrome.i18n.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  };

  const px = (n) => `${Math.round(n)}px`;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  function setVars(el, vars) {
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(`--gp-${k}`, v);
  }

  function svgIcon(d, doc = document) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  const activeOverlayHosts = new Set();

  // Closed shadow root by default; open when test hooks are enabled. Popover renders in the top layer.
  function overlayHost({ id, className = "", css, onAction, blockPointer = true, testHooks = false, canShow }, ...content) {
    if (id) document.getElementById(id)?.remove();
    const attrs = { popover: "manual" };
    if (id) attrs.id = id;
    if (className) attrs.class = className;
    const host = h("div", attrs);
    const root = host.attachShadow({ mode: testHooks ? "open" : "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style, ...content);
    if (blockPointer) {
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
        host.addEventListener(type, (e) => e.stopPropagation());
      }
    }
    if (onAction) {
      root.addEventListener("click", (e) => {
        const act = e.target.closest?.("[data-action]")?.dataset.action;
        if (act) onAction(act);
      });
    }
    activeOverlayHosts.add(host);
    return {
      host,
      root,
      get open() {
        return host.matches(":popover-open");
      },
      show(vars) {
        if (canShow && !canShow()) return;
        setVars(host, vars);
        if (!host.isConnected) document.documentElement.append(host);
        if (!this.open) host.showPopover();
      },
      hide() {
        if (this.open) {
          try {
            host.hidePopover();
          } catch {}
        }
      },
      destroy() {
        this.hide();
        activeOverlayHosts.delete(host);
        host.remove();
      },
    };
  }

  function removeStrayOverlays() {
    for (const el of document.querySelectorAll(
      "#ghostpip-launcher, #ghostpip-controller, .ghostpip-controller, #ghostpip-chat, .ghostpip-chat, .ghostpip-subtitles",
    )) {
      if (!activeOverlayHosts.has(el)) el.remove();
    }
  }

  function createLauncherOverlay({ testHooks = false, canShow, onAction }) {
    return overlayHost(
      {
        id: "ghostpip-launcher",
        css: BASE_CSS,
        onAction,
        testHooks,
        canShow,
      },
      h(
        "div",
        { class: "bar" },
        h("button", { "data-action": "inTab", title: t("modeWebTitle") }, svgIcon(ICON_WEB_MODE), t("modeWeb")),
        h("button", { "data-action": "docPip", title: t("modeFullTitle") }, svgIcon(ICON_FULL_MODE), t("modeFull")),
      ),
    );
  }

  function createFloatingOverlays({ ctrlId, chatId, subId, isRemote = false, testHooks = false, canShow, onAction }) {
    const hudEl = h("div", { class: "hud" }, "");
    const webChatLabel = h("span", {}, t("chatShow"));
    const webChatBtn = h("button", { "data-action": "toggleWebChat" }, svgIcon(ICON_CHAT), webChatLabel);
    const skipAdBtn = h("button", { class: "skip-ad", "data-action": "skipAd", hidden: "" }, t("skipAd"));
    const webChatFrame = h("iframe", {});
    const webChatResize = h("div", { class: "chat-resize", title: t("chatResizeTitle") });
    const subtitleBox = h("div", { class: "gp-sub-box" }, "");

    const webChat = overlayHost(
      { id: chatId, className: "ghostpip-chat", css: WEB_CHAT_CSS, testHooks, canShow },
      webChatFrame,
      webChatResize,
    );
    const subtitleHost = overlayHost(
      { id: subId, className: "ghostpip-subtitles", css: SUBTITLES_CSS, blockPointer: false, testHooks, canShow },
      subtitleBox,
    );
    const controller = overlayHost(
      {
        id: ctrlId,
        className: "ghostpip-controller",
        css: BASE_CSS + CONTROLLER_CSS,
        onAction,
        testHooks,
        canShow,
      },
      h("div", { class: "surface" }),
      ...RESIZE_DIRS.map((dir) => h("div", { class: `handle ${dir}`, "data-resize": dir })),
      hudEl,
      skipAdBtn,
      h(
        "div",
        { class: "bar" },
        h("button", { "data-action": "idle" }, t("btnReturn")),
        h("button", { "data-action": "docPip", "data-mode": "local" }, svgIcon(ICON_FULL_MODE), t("modeFull")),
        h("button", { "data-action": "focusSource", "data-mode": "remote" }, t("btnSourceTab")),
        webChatBtn,
      ),
    );
    controller.host.toggleAttribute("data-remote", Boolean(isRemote));

    return {
      controller,
      webChat,
      subtitleHost,
      hudEl,
      webChatLabel,
      webChatBtn,
      skipAdBtn,
      webChatFrame,
      webChatResize,
      subtitleBox,
    };
  }

  function enterIdle({ ctx, ensureAlive, canShow, isPointerOnPlayer, onAction }) {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    let pointerOver = false;
    let launcherOver = false;
    let idleTimer = null;

    const launcher = createLauncherOverlay({
      testHooks: ctx.testHooks,
      canShow,
      onAction,
    });

    function update() {
      if (!ensureAlive()) return;
      if (!ctx.settings.enabled) {
        pointerOver = false;
        launcherOver = false;
        clearTimeout(idleTimer);
        return launcher.hide();
      }
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

    launcher.host.addEventListener(
      "pointerenter",
      () => {
        if (!ensureAlive() || !ctx.settings.enabled) return;
        launcherOver = true;
        clearTimeout(idleTimer);
        update();
      },
      on,
    );
    launcher.host.addEventListener(
      "pointerleave",
      () => {
        launcherOver = false;
        armIdleHide();
        update();
      },
      on,
    );

    window.addEventListener(
      "pointermove",
      (e) => {
        if (!e.isTrusted || !ensureAlive()) return;
        if (!ctx.settings.enabled) {
          if (pointerOver || launcherOver || launcher.open) update();
          return;
        }
        pointerOver = Boolean(ctx.video) && isPointerOnPlayer(ctx.video, e);
        if (pointerOver) armIdleHide();
        else clearTimeout(idleTimer);
        update();
      },
      { capture: true, ...on },
    );

    document.documentElement.addEventListener(
      "mouseleave",
      () => {
        pointerOver = false;
        launcherOver = false;
        clearTimeout(idleTimer);
        update();
      },
      on,
    );

    const timer = setInterval(update, 500);

    return {
      settingsChanged: update,
      exit() {
        ac.abort();
        clearInterval(timer);
        clearTimeout(idleTimer);
        launcher.destroy();
      },
    };
  }

  function renderFloatingOverlays(
    overlays,
    {
      video,
      r,
      b,
      w,
      hPx,
      webChatOpen,
      peekHidden,
      idleOpacity,
      forcePass,
      interactive,
      hovered,
      hasSkipAd,
      opacity,
      anim,
      dragging,
      chatResizing,
      subtitleText,
      toastText,
      settingOpacity,
    },
  ) {
    const {
      controller,
      webChat,
      subtitleHost,
      hudEl,
      webChatLabel,
      webChatBtn,
      skipAdBtn,
      webChatFrame,
      subtitleBox,
    } = overlays;
    const canShowChat = Boolean(b.chatUrl);
    const showChatNow = Boolean(webChatOpen && canShowChat);
    webChatBtn.style.display = canShowChat ? "inline-flex" : "none";
    webChatLabel.textContent = showChatNow ? t("chatHide") : t("chatShow");
    skipAdBtn.hidden = !hasSkipAd;

    const showBarOnly = !interactive && !forcePass && (hovered || hasSkipAd);
    const videoGeo = { x: px(r.l), y: px(b.videoT), w: px(w), h: px(hPx) };
    const passNow = !interactive && forcePass;
    const peekOutline = !interactive && peekHidden && idleOpacity > 0;
    const shouldAnim = Boolean(anim && !document.hidden && !dragging);
    video.toggleAttribute("data-gp-anim", shouldAnim);
    setVars(video, { ...videoGeo, opacity: String(opacity) });
    video.toggleAttribute("data-gp-pass", passNow);
    video.toggleAttribute("data-click-through", passNow);
    video.toggleAttribute("data-gp-peek-outline", peekOutline);
    video.toggleAttribute("data-gp-drag", dragging);

    if (canShowChat) {
      if (!webChat.host.isConnected) document.documentElement.append(webChat.host);
      if (webChatFrame.getAttribute("src") !== b.chatUrl) {
        webChatFrame.setAttribute("src", b.chatUrl);
      }
    }
    if (showChatNow && b.chatH > 0 && !(peekHidden && idleOpacity === 0)) {
      webChat.host.toggleAttribute("data-gp-anim", shouldAnim && !chatResizing);
      webChat.host.toggleAttribute("data-gp-pass", passNow);
      webChat.host.toggleAttribute("data-click-through", passNow);
      webChat.host.toggleAttribute("data-gp-drag", dragging);
      webChat.host.toggleAttribute("data-interactive", interactive);
      webChat.show({
        x: px(r.l),
        y: px(b.chatT),
        w: px(w),
        h: px(b.chatH),
        opacity: String(opacity),
      });
    } else {
      webChat.hide();
    }

    if (subtitleText && !(peekHidden && idleOpacity === 0)) {
      subtitleBox.textContent = subtitleText;
      subtitleHost.host.toggleAttribute("data-gp-anim", shouldAnim);
      subtitleHost.host.toggleAttribute("data-gp-drag", dragging);
      subtitleHost.show({ ...videoGeo, opacity: String(opacity) });
    } else {
      subtitleHost.hide();
    }

    const hasToast = Boolean(toastText) && !(peekHidden && idleOpacity === 0);
    hudEl.textContent = hasToast
      ? toastText
      : t("hudOpacityWheel", [String(Math.round(settingOpacity * 100)), `${w}×${hPx}`]);
    const toastOnly = hasToast && !interactive && !showBarOnly && !peekOutline;
    controller.host.toggleAttribute("data-hovered", hovered && !passNow);
    controller.host.toggleAttribute("data-bar-only", showBarOnly);
    controller.host.toggleAttribute("data-has-toast", hasToast);
    controller.host.toggleAttribute("data-toast-only", toastOnly);
    controller.host.toggleAttribute("data-peek-silhouette", peekOutline);
    controller.host.toggleAttribute("data-click-through", passNow);
    if (interactive || showBarOnly || peekOutline || toastOnly) controller.show(videoGeo);
    else controller.hide();
  }

  globalThis.GhostPiPOverlayUI = Object.freeze({
    FLOAT_CLASS,
    DOCPIP_SOURCE_CLASS,
    GP_VARS,
    RESIZE_DIRS,
    ICON_WEB_MODE,
    ICON_FULL_MODE,
    ICON_CHAT,
    BASE_CSS,
    CONTROLLER_CSS,
    WEB_CHAT_CSS,
    SUBTITLES_CSS,
    PIP_CSS,
    t,
    px,
    h,
    setVars,
    svgIcon,
    activeOverlayHosts,
    overlayHost,
    removeStrayOverlays,
    createLauncherOverlay,
    createFloatingOverlays,
    enterIdle,
    renderFloatingOverlays,
  });
})();
