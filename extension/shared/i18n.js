(() => {
  const TAG_RE = /<(b|code|kbd)(?:\s+class="(hold)")?>([\s\S]*?)<\/\1>/g;

  const t = (key, subs) => {
    try {
      return chrome.i18n.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  };

  function setSafeMarkup(el, text) {
    const nodes = [];
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
      if (m.index > last) nodes.push(text.slice(last, m.index));
      const child = document.createElement(m[1]);
      if (m[2]) child.className = m[2];
      child.textContent = m[3];
      nodes.push(child);
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    el.replaceChildren(...nodes);
  }

  function apply(root = document) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    document.documentElement.dir = t("@@bidi_dir");
    for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll("[data-i18n-html]")) setSafeMarkup(el, t(el.dataset.i18nHtml));
    for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }

  globalThis.GhostPiPI18n = { t, apply };
})();
