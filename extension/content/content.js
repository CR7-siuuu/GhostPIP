(() => {
  const Dodge = globalThis.GhostPiPDodge;
  const Settings = globalThis.GhostPiPSettings;

  const FLOAT_CLASS = "ghostpip-inpage-target";
  const FLOAT_WIDTH = 480;
  const FADED_OPACITY = 0.1;
  const DODGE_TICK_MS = 50;
  const SCAN_THROTTLE_MS = 250;
  const PIP_CHAT_HEIGHT = 420;
  const PIP_TOGGLE_HEIGHT = 28;
  const GP_VARS = ["--gp-x", "--gp-y", "--gp-w", "--gp-h", "--gp-opacity"];
  const HOLD = {
    "Ctrl+Alt": (e) => e.ctrlKey && e.altKey,
    "Ctrl+Shift": (e) => e.ctrlKey && e.shiftKey,
  };

  const ctx = {
    settings: Settings.merge(undefined),
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

  function floatSize(video, maxHeight) {
    const ratio = video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
    const height = Math.round(FLOAT_WIDTH * ratio);
    if (height <= maxHeight) return { w: FLOAT_WIDTH, h: height };
    return { w: Math.round(maxHeight / ratio), h: Math.round(maxHeight) };
  }

  const BASE_CSS = `
    .bar { display: flex; gap: 6px; font: 600 13px/1 system-ui, "Malgun Gothic", sans-serif; color: #fff; }
    button { all: unset; cursor: pointer; padding: 7px 10px; border-radius: 6px; white-space: nowrap;
      background: rgba(18, 18, 22, 0.85); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45); }
    button:hover { background: rgba(70, 70, 84, 0.95); }
    :host([data-pinned]) .bar:not(:hover) { opacity: 0.55; }`;

  const CONTROLLER_CSS = `
    .surface { position: absolute; inset: 0; box-sizing: border-box; cursor: move; border-radius: 3px;
      border: 2px solid rgba(110, 170, 255, 0.95); background: rgba(110, 170, 255, 0.08); }
    .bar { position: absolute; top: 8px; right: 8px; }`;

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
      h("button", { "data-action": "inTab" }, "띄우기"),
      h("button", { "data-action": "docPip" }, "PiP + 채팅")),
  );

  const controller = overlayHost(
    "ghostpip-controller",
    BASE_CSS + CONTROLLER_CSS,
    h("div", { class: "surface" }),
    h("div", { class: "bar" },
      h("button", { "data-action": "idle" }, "복귀"),
      h("button", { "data-action": "docPip" }, "PiP + 채팅")),
  );

  let dragSink = null;
  const surface = controller.root.querySelector(".surface");
  surface.addEventListener("pointerdown", (e) => {
    if (!dragSink || e.button !== 0) return;
    surface.setPointerCapture(e.pointerId);
    dragSink.start(e);
  });
  surface.addEventListener("pointermove", (e) => {
    if (surface.hasPointerCapture(e.pointerId)) dragSink?.move(e);
  });
  surface.addEventListener("lostpointercapture", () => dragSink?.end());

  function findVideo() {
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const pick = (list) => [...list].filter((v) => v.videoWidth > 0).sort((a, b) => area(b) - area(a))[0] ?? null;
    return (ctx.site.video && pick(document.querySelectorAll(ctx.site.video))) || pick(document.querySelectorAll("video"));
  }

  function chatUrlFor(site) {
    if (!site.chatPopoutUrl || !site.idFrom) return null;
    const id = "param" in site.idFrom
      ? new URLSearchParams(location.search).get(site.idFrom.param)
      : location.pathname.split("/")[site.idFrom.pathIndex];
    return id ? site.chatPopoutUrl.replace(/\{(?:videoId|channelId|channel)\}/g, encodeURIComponent(id)) : null;
  }

  function persistHome(corner) {
    send({ type: "PATCH_SETTINGS", patch: { dodge: { home: corner } } });
  }

  function enterIdle() {
    const ac = new AbortController();
    let pointerOver = false;

    function update() {
      const r = ctx.video?.getBoundingClientRect();
      if (!r || r.width === 0) return launcher.hide();
      const anchor = { x: r.right - 8, y: Math.max(r.top, 0) + 8 };
      // Pointer events over an iframe (e.g. Twitch's extension overlay covering the player) never reach
      // this document, so a launcher spot covered by an iframe keeps the launcher pinned.
      const below = document.elementsFromPoint(anchor.x - 16, anchor.y + 8).find((el) => el !== launcher.host);
      const pinned = below?.tagName === "IFRAME";
      launcher.host.toggleAttribute("data-pinned", pinned && !pointerOver);
      if (pointerOver || pinned) launcher.show({ x: px(anchor.x), y: px(anchor.y) });
      else launcher.hide();
    }

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      const r = ctx.video?.getBoundingClientRect();
      pointerOver = !!r && inside(r, e.clientX, e.clientY);
      update();
    }, { capture: true, signal: ac.signal });
    const timer = setInterval(update, 500);

    return {
      exit() {
        ac.abort();
        clearInterval(timer);
        launcher.hide();
      },
    };
  }

  function enterInTab(_arg, leave) {
    const video = ctx.video;
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const original = {
      popover: video.getAttribute("popover"),
      class: video.hasAttribute("class"),
      style: video.hasAttribute("style"),
    };
    const viewport = () => ({
      l: 0,
      t: 0,
      r: document.documentElement.clientWidth,
      b: document.documentElement.clientHeight,
    });
    const cfg = () => ctx.settings.dodge;

    let corner = cfg().home;
    let dodge = Dodge.initialState(corner);
    let faded = false;
    let held = false;
    let drag = null;
    let cursor = null;

    const size = () => floatSize(video, viewport().b * 0.6);
    function rect() {
      const s = size();
      if (drag) return { l: drag.x, t: drag.y, r: drag.x + s.w, b: drag.y + s.h };
      return Dodge.cornerRect(corner, s, viewport(), cfg().edgeInsetPx);
    }

    function render() {
      const r = rect();
      const interactive = held || drag !== null;
      const geometry = { x: px(r.l), y: px(r.t), w: px(r.r - r.l), h: px(r.b - r.t) };
      const opacity = interactive ? 1 : faded ? FADED_OPACITY : ctx.settings.opacity;
      setVars(video, { ...geometry, opacity: String(opacity) });
      video.toggleAttribute("data-gp-pass", !interactive && ctx.settings.clickThrough);
      video.toggleAttribute("data-gp-drag", drag !== null);
      if (interactive) controller.show(geometry);
      else controller.hide();
    }

    function tick() {
      if (held || drag) return;
      const out = Dodge.step(dodge, { now: performance.now(), cursor, size: size(), area: viewport() }, cfg());
      dodge = out.state;
      if (out.action.type === "move") corner = out.action.corner;
      else if (out.action.type === "fade") faded = out.action.on;
      else return;
      render();
    }

    function setHeld(next) {
      if (next === held) return;
      held = next;
      render();
    }
    const holdFrom = (e) => e.isTrusted && setHeld(HOLD[ctx.settings.hotkeys.hold](e));

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted) return;
      cursor = { x: e.clientX, y: e.clientY };
      holdFrom(e);
      tick();
    }, { capture: true, ...on });
    document.documentElement.addEventListener("mouseleave", () => (cursor = null), on);
    window.addEventListener("keydown", holdFrom, { capture: true, ...on });
    window.addEventListener("keyup", holdFrom, { capture: true, ...on });
    window.addEventListener("blur", () => setHeld(false), on);
    document.addEventListener("visibilitychange", () => setHeld(false), on);
    window.addEventListener("resize", render, on);
    video.addEventListener("resize", render, on);
    const timer = setInterval(tick, DODGE_TICK_MS);

    dragSink = {
      start(e) {
        const r = rect();
        drag = { x: r.l, y: r.t, dx: e.clientX - r.l, dy: e.clientY - r.t };
        render();
      },
      move(e) {
        drag.x = e.clientX - drag.dx;
        drag.y = e.clientY - drag.dy;
        render();
      },
      end() {
        if (!drag) return;
        const r = rect();
        drag = null;
        corner = Dodge.nearestCorner(r, viewport());
        dodge = Dodge.initialState(corner);
        faded = false;
        if (cfg().allowed.includes(corner) && corner !== cfg().home) persistHome(corner);
        render();
      },
    };

    function exit() {
      ac.abort();
      clearInterval(timer);
      dragSink = null;
      controller.hide();
      if (video.matches(":popover-open")) video.hidePopover();
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

    video.setAttribute("popover", "manual");
    video.classList.add(FLOAT_CLASS);
    render();
    try {
      video.showPopover();
    } catch {
      queueMicrotask(leave);
    }

    return { exit, settingsChanged: render };
  }

  const PIP_CSS = `
    html, body { margin: 0; height: 100%; background: #000; color: #fff; font: 13px system-ui, "Malgun Gothic", sans-serif; }
    body { display: flex; flex-direction: column; }
    video { flex: 1 1 auto; min-height: 0; width: 100%; object-fit: contain; background: #000; }
    button { flex: none; height: ${PIP_TOGGLE_HEIGHT}px; border: 0; background: #222; color: #fff; font: inherit; cursor: pointer; }
    iframe { flex: 0 0 ${PIP_CHAT_HEIGHT}px; width: 100%; border: 0; background: #fff; }
    iframe[hidden] { display: none; }`;

  function buildPipDocument(win, stream, chatUrl) {
    const doc = win.document;
    const style = doc.createElement("style");
    style.textContent = PIP_CSS;
    doc.head.append(style);
    const mirror = doc.createElement("video");
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.srcObject = stream;
    doc.body.append(mirror);
    if (chatUrl) {
      const frame = doc.createElement("iframe");
      frame.src = chatUrl;
      const toggle = doc.createElement("button");
      toggle.textContent = "채팅 숨기기";
      toggle.addEventListener("click", () => {
        frame.hidden = !frame.hidden;
        toggle.textContent = frame.hidden ? "채팅 보기" : "채팅 숨기기";
      });
      doc.body.append(toggle, frame);
    }
    mirror.play().catch(() => {});
    return mirror;
  }

  function enterDocPip({ stream: firstStream, chatUrl, win: winPromise }, leave) {
    const video = ctx.video;
    const ac = new AbortController();
    let stream = firstStream;
    let win = null;
    let mirror = null;

    winPromise.then((w) => {
      if (ac.signal.aborted) return w.close();
      win = w;
      mirror = buildPipDocument(w, stream, chatUrl);
      w.addEventListener("pagehide", leave, { signal: ac.signal });
      // Until its first resize the PiP window reports the opener's placeholder geometry, so the
      // rect handshake waits for it, with a timeout in case the platform never resizes.
      new Promise((placed) => {
        w.addEventListener("resize", placed, { once: true, signal: ac.signal });
        setTimeout(placed, 1000);
      }).then(() => {
        if (ac.signal.aborted) return;
        send({
          type: "PIP_OPENED",
          kind: "document",
          rect: { x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight },
          dpr: w.devicePixelRatio,
        });
      });
    }, leave);

    video.addEventListener("loadeddata", () => {
      for (const t of stream.getTracks()) t.stop();
      stream = video.captureStream();
      if (mirror) mirror.srcObject = stream;
    }, { signal: ac.signal });

    return {
      exit() {
        ac.abort();
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
    video.addEventListener("enterpictureinpicture", (e) => {
      opened = true;
      const pw = e.pictureInPictureWindow;
      // The native PiP window's screen position is not exposed to pages; the opener's position is a
      // placeholder and the engine matches on size.
      send({
        type: "PIP_OPENED",
        kind: "native",
        rect: { x: window.screenX, y: window.screenY, w: pw.width, h: pw.height },
        dpr: devicePixelRatio,
      });
    }, { signal: ac.signal });
    video.addEventListener("leavepictureinpicture", leave, { signal: ac.signal });
    request.catch(leave);
    return {
      exit() {
        ac.abort();
        if (opened) send({ type: "PIP_CLOSED" });
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      },
    };
  }

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
    const size = floatSize(video, FLOAT_WIDTH);
    const height = size.h + (chatUrl ? PIP_TOGGLE_HEIGHT + PIP_CHAT_HEIGHT : 0);
    go("docPip", { stream, chatUrl, win: documentPictureInPicture.requestWindow({ width: size.w, height }) });
  }

  const ACTIONS = {
    inTab: () => go("inTab"),
    docPip: startPip,
    idle: () => go("idle"),
  };

  const ENTER = { idle: enterIdle, inTab: enterInTab, docPip: enterDocPip, nativePip: enterNativePip };
  const TRANSITIONS = {
    idle: ["idle", "inTab", "docPip", "nativePip"],
    inTab: ["idle", "docPip", "nativePip"],
    docPip: ["idle"],
    nativePip: ["idle"],
  };
  const noop = () => {};
  let current = { name: "idle", video: null, exit: noop, settingsChanged: noop };

  function go(next, arg) {
    if (!TRANSITIONS[current.name].includes(next)) return;
    if (next !== "idle" && !ctx.video) return;
    current.exit();
    const inst = { name: next, video: ctx.video, exit: noop, settingsChanged: noop };
    current = inst;
    Object.assign(inst, ENTER[next](arg, () => current === inst && go("idle")));
  }

  function scan() {
    if (location.href !== ctx.url) {
      ctx.url = location.href;
      ctx.video = null;
      go("idle");
      loadSite();
      return;
    }
    if (current.name === "idle") ctx.video = findVideo();
    else if (!current.video.isConnected) go("idle");
  }

  async function loadSite() {
    const url = location.href;
    const res = await send({ type: "GET_SITE_CONFIG", url });
    if (!res?.site || url !== location.href) return;
    ctx.siteId = res.siteId;
    ctx.site = res.site;
    scan();
  }

  function applySettings(stored) {
    ctx.settings = Settings.merge(stored);
    current.settingsChanged();
  }

  chrome.storage.local.get("settings").then(({ settings }) => applySettings(settings), noop);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
  });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement && current.name === "inTab") go("idle");
  });

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
