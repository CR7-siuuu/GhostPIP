// Renders the popup, guide and on-page launcher under several Chrome UI languages and checks
// that every string comes from the matching _locales file.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LANGS = [
  { lang: "ja", loc: "ja", launcher: true },
  { lang: "en-US", loc: "en" },
  { lang: "ar", loc: "ar", rtl: true },
  { lang: "zh-CN", loc: "zh_CN" },
  { lang: "pt-BR", loc: "pt_BR" },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, info) => results.push({ name, ok, info });

for (const { lang, loc, rtl, launcher } of LANGS) {
  const msgs = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/_locales", loc, "messages.json"), "utf8"));
  const m = (k) => msgs[k].message;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    enableExtensions: true,
    defaultViewport: null,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-first-run", `--lang=${lang}`],
  });
  try {
    const extId = await browser.installExtension(path.join(ROOT, "extension"));
    const page = (await browser.pages())[0] ?? (await browser.newPage());

    const inspect = () =>
      page.evaluate(() => ({
        uiLang: chrome.i18n.getUILanguage(),
        dir: document.documentElement.dir,
        hangul: (document.body.innerText.match(/[\uAC00-\uD7A3]+/g) ?? []).slice(0, 5),
        empty: [...document.querySelectorAll("[data-i18n],[data-i18n-html]")].filter((el) => !el.textContent.trim()).length,
        unresolved: (document.body.innerText.match(/__MSG_\w+__|\$[A-Z]+\$/g) ?? []).slice(0, 3),
        badge: document.getElementById("modeBadge")?.textContent ?? null,
        h1: document.querySelector("h1")?.textContent ?? null,
        tip: document.getElementById("tipHold")?.textContent ?? null,
      }));

    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await sleep(700);
    const popup = await inspect();
    const badgeOk = [m("modeWeb"), m("engineConnected"), m("badgeOff")].includes(popup.badge);
    record(
      `${loc} popup`,
      popup.hangul.length === 0 && popup.empty === 0 && popup.unresolved.length === 0 && badgeOk &&
        popup.tip === m("tipHold").replace("$HOLD$", "Ctrl+Alt") && (!rtl || popup.dir === "rtl"),
      `ui=${popup.uiLang} badge="${popup.badge}" dir=${popup.dir} hangul=${popup.hangul} empty=${popup.empty} unresolved=${popup.unresolved}`,
    );

    await page.goto(`chrome-extension://${extId}/guide/guide.html`);
    await sleep(500);
    const guide = await inspect();
    record(
      `${loc} guide`,
      guide.hangul.length === 0 && guide.empty === 0 && guide.unresolved.length === 0 && guide.h1 === m("guideTitle"),
      `h1="${guide.h1}" hangul=${guide.hangul} empty=${guide.empty} unresolved=${guide.unresolved}`,
    );

    if (launcher) {
      const swTarget = await browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
      );
      const sw = await swTarget.worker();
      await sw.evaluate(() => chrome.storage.local.set({ gpTestHooks: true }));
      await page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0), { timeout: 25000 });
      await sleep(1200);
      let labels = null;
      for (let i = 0; i < 4 && !labels; i++) {
        const c = await page.evaluate(() => {
          const r = document.querySelector("video").getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(5, 5);
        await page.mouse.move(c.x + i * 10, c.y + i * 10, { steps: 6 });
        await sleep(400);
        labels = await page.evaluate(() => {
          const btns = [...(document.getElementById("ghostpip-launcher")?.shadowRoot?.querySelectorAll("button") ?? [])];
          return btns.length ? btns.map((b) => b.textContent.trim()) : null;
        });
      }
      record(
        `${loc} launcher`,
        labels?.join("|") === `${m("modeWeb")}|${m("modeFull")}`,
        `labels=${JSON.stringify(labels)}`,
      );
    }
  } catch (e) {
    record(`${loc} fatal`, false, String(e?.message ?? e).slice(0, 200));
  } finally {
    await browser.close().catch(() => {});
  }
}

console.log("\n[i18n e2e]");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name.padEnd(16)} ${r.info}`);
process.exit(results.length === LANGS.length * 2 + 1 && results.every((r) => r.ok) ? 0 : 1);
