import fs from "node:fs";
import path from "node:path";
import { STORE_LOCALES } from "./check-locales.mjs";
import { DESCRIPTIONS_PART1 } from "./store-descriptions-part1.mjs";
import { DESCRIPTIONS_PART2 } from "./store-descriptions-part2.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "store-assets");
fs.mkdirSync(OUT_DIR, { recursive: true });

const ALL = { ...DESCRIPTIONS_PART1, ...DESCRIPTIONS_PART2 };

const errors = [];
for (const loc of STORE_LOCALES) {
  const entry = ALL[loc];
  if (!entry || typeof entry.text !== "string" || !entry.text.trim()) {
    errors.push(`${loc}: missing description`);
    continue;
  }
  if (!entry.text.includes("https://github.com/CR7-siuuu/GhostPIP/releases")) {
    errors.push(`${loc}: missing GitHub releases link`);
  }
  if (/youtube|twitch|chzzk|soop|afreeca|netflix|disney|prime video|coupang|tving|wavve|watcha|laftel|hulu|paramount|peacock|crunchyroll|유튜브|치지직|트위치|넷플릭스/i.test(entry.text)) {
    errors.push(`${loc}: must not mention third-party brand names`);
  }
  if (/web mode|in-tab mode|웹 모드|modo web|ウェブモード|网页模式|網頁模式/i.test(entry.text)) {
    errors.push(`${loc}: must not mention removed Web Mode`);
  }
  if (entry.text.length > 3500) {
    errors.push(`${loc}: description too long (${entry.text.length} chars)`);
  }
}

for (const k of Object.keys(ALL)) {
  if (!STORE_LOCALES.includes(k)) {
    errors.push(`${k}: unknown locale key`);
  }
}

if (errors.length) {
  console.error("[store-descriptions] Validation failed:\n  " + errors.join("\n  "));
  process.exit(1);
}

// 1. Write JSON
const jsonPath = path.join(OUT_DIR, "store-descriptions-52.json");
fs.writeFileSync(jsonPath, JSON.stringify(ALL, null, 2) + "\n", "utf8");

// 2. Write Markdown
const mdLines = [
  "# GhostPiP — Chrome Web Store 52개국 상세 설명 (v1.1.2 최신·단축판)",
  "",
  "- **반영 사항**: 웹 모드 삭제(데스크톱 PiP 단일화), 다중 PiP, 창 위치·크기 기억, 실시간 자막 오버레이(DRM OTT 기본 PiP 포함), 포커스 유지 리모컨(`Alt+Space`, `Alt+←/→`, `Alt+휠`), 역 투명화(`Alt+P`), 사이트·브라우저 기본 PiP 호환, Windows용 GhostPiP Engine 및 SmartScreen·백신 오탐 안내.",
  "- **분량 단축**: 기존 약 65줄(2,100자)에서 핵심만 남긴 **23줄(약 950~1,100자)** 스캔형 구성.",
  "- **상표권 정책 준수**: 특정 서드파티 플랫폼명 직접 언급 제거.",
  "",
];

for (const loc of STORE_LOCALES) {
  const { nameKo, nameEn, text } = ALL[loc];
  mdLines.push(`## \`${loc}\` — ${nameKo} (${nameEn})`);
  mdLines.push("");
  mdLines.push("```text");
  mdLines.push(text);
  mdLines.push("```");
  mdLines.push("");
}
const mdPath = path.join(OUT_DIR, "store-descriptions-52.md");
fs.writeFileSync(mdPath, mdLines.join("\n"), "utf8");

// 3. Write DevTools Console Auto-Fill Script
const autofillScript = `(() => {
  const DATA = ${JSON.stringify(ALL, null, 2)};
  const LOCALES = ${JSON.stringify(STORE_LOCALES)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").toLowerCase().replace(/[\\s()（）_\\-–—·•:：]/g, "");

  function matchLocaleFromElement(el) {
    if (!el) return null;
    const dv = el.getAttribute?.("data-value") || el.getAttribute?.("value") || el.dataset?.value || el.dataset?.locale || "";
    if (dv) {
      const dvNorm = dv.replace("-", "_");
      if (DATA[dvNorm]) return dvNorm;
      const byExactDv = LOCALES.find((k) => k.toLowerCase() === dvNorm.toLowerCase());
      if (byExactDv) return byExactDv;
    }
    const rawText = (el.innerText || el.textContent || "").trim();
    if (!rawText) return null;
    const nText = norm(rawText);
    // Exact alias match first
    for (const loc of LOCALES) {
      const aliases = DATA[loc].aliases || [];
      for (const a of aliases) {
        if (norm(a) === nText) return loc;
      }
    }
    // Prefix/contains match (e.g. "한국어 - Korean" or "한국어 (ko)")
    const sorted = [...LOCALES].sort((a, b) => (DATA[b].nameKo.length - DATA[a].nameKo.length));
    for (const loc of sorted) {
      const { nameKo, nameEn, aliases = [] } = DATA[loc];
      for (const candidate of [nameKo, nameEn, ...aliases]) {
        if (candidate.length >= 2 && nText.includes(norm(candidate))) {
          // Disambiguate es vs es_419, pt_BR vs pt_PT, zh_CN vs zh_TW
          if (loc === "es" && (nText.includes("419") || nText.includes("라틴") || nText.includes("latin"))) continue;
          if (loc === "pt_PT" && (nText.includes("브라질") || nText.includes("brasil") || nText.includes("brazil"))) continue;
          if (loc === "pt_BR" && (nText.includes("포르투갈어포르투갈") || nText.includes("portugal"))) continue;
          if (loc === "zh_CN" && (nText.includes("번체") || nText.includes("traditional") || nText.includes("繁體") || nText.includes("tw"))) continue;
          if (loc === "zh_TW" && (nText.includes("간체") || nText.includes("simplified") || nText.includes("简体") || nText.includes("cn"))) continue;
          return loc;
        }
      }
    }
    return null;
  }

  function findDescriptionTextarea() {
    const visible = [...document.querySelectorAll("textarea")].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 100 && r.height > 40 && !t.disabled && !t.readOnly;
    });
    if (!visible.length) return null;
    const byLabel = visible.find((t) => {
      const label = [
        t.getAttribute("aria-label"),
        t.getAttribute("placeholder"),
        t.closest("label")?.innerText,
        t.parentElement?.parentElement?.innerText,
      ].join(" ");
      return /상세\\s*설명|설명|detailed\\s*description|description/i.test(label);
    });
    if (byLabel) return byLabel;
    return visible.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
  }

  function setTextareaValue(ta, value) {
    if (!ta) return false;
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(ta, value);
    else ta.value = value;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, data: value, inputType: "insertText" }));
    ta.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
    ta.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function triggerClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }

  function findLanguageOptions() {
    const candidates = [
      ...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], mat-option, option, li[data-value], div[data-value]'),
    ];
    const map = new Map();
    for (const el of candidates) {
      const loc = matchLocaleFromElement(el);
      if (loc && !map.has(loc)) {
        map.set(loc, el);
      }
    }
    return map;
  }

  function findLanguageDropdownTrigger() {
    const triggers = [
      ...document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], select'),
    ].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && !el.closest("#ghostpip-cws-helper");
    });
    for (const t of triggers) {
      if (matchLocaleFromElement(t)) return t;
    }
    return triggers[0] || null;
  }

  // Remove old panel if re-run
  document.getElementById("ghostpip-cws-helper")?.remove();

  const panel = document.createElement("div");
  panel.id = "ghostpip-cws-helper";
  panel.style.cssText = [
    "position:fixed",
    "right:20px",
    "bottom:20px",
    "z-index:2147483647",
    "width:360px",
    "background:#0f172a",
    "color:#f8fafc",
    "border:1px solid #38bdf8",
    "border-radius:12px",
    "padding:14px",
    "box-shadow:0 20px 40px rgba(0,0,0,0.45)",
    "font-family:system-ui,-apple-system,sans-serif",
    "font-size:13px",
    "line-height:1.45",
  ].join(";");

  panel.innerHTML = \`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong style="font-size:14px;color:#38bdf8;">👻 GhostPiP 스토어 52개국 자동 입력기</strong>
      <button id="gp-cws-close" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div id="gp-cws-status" style="background:#1e293b;padding:8px 10px;border-radius:8px;margin-bottom:10px;color:#e2e8f0;font-size:12px;">
      준비 완료 (52개 언어 로드됨)
    </div>
    <button id="gp-cws-run-all" style="width:100%;padding:9px 12px;border:none;border-radius:8px;background:#0284c7;color:#fff;font-weight:700;cursor:pointer;margin-bottom:8px;">
      ⚡ 52개 언어 드롭다운 자동 순회 입력
    </button>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <select id="gp-cws-select" style="flex:1;background:#1e293b;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:6px;"></select>
      <button id="gp-cws-fill-one" style="padding:6px 10px;border:none;border-radius:6px;background:#334155;color:#fff;cursor:pointer;white-space:nowrap;">
        현재 칸 입력
      </button>
      <button id="gp-cws-copy-one" style="padding:6px 10px;border:none;border-radius:6px;background:#334155;color:#fff;cursor:pointer;white-space:nowrap;">
        복사
      </button>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;">
      <input type="checkbox" id="gp-cws-autofill-watch" checked />
      언어 드롭다운 변경 시 해당 언어로 자동 채우기
    </label>
  \`;
  document.body.appendChild(panel);

  const sel = panel.querySelector("#gp-cws-select");
  for (const loc of LOCALES) {
    const opt = document.createElement("option");
    opt.value = loc;
    opt.textContent = \`\${DATA[loc].nameKo} (\${loc} · \${DATA[loc].nameEn})\`;
    if (loc === "ko") opt.selected = true;
    sel.appendChild(opt);
  }

  const statusEl = panel.querySelector("#gp-cws-status");
  const setStatus = (msg, color = "#e2e8f0") => {
    statusEl.textContent = msg;
    statusEl.style.color = color;
  };

  panel.querySelector("#gp-cws-close").onclick = () => panel.remove();

  panel.querySelector("#gp-cws-fill-one").onclick = () => {
    const loc = sel.value;
    const ta = findDescriptionTextarea();
    if (!ta) {
      setStatus("❌ 상세 설명 입력창(textarea)을 찾지 못했습니다. '스토어 등록 정보' 탭인지 확인하세요.", "#fca5a5");
      return;
    }
    setTextareaValue(ta, DATA[loc].text);
    setStatus(\`✅ [\${DATA[loc].nameKo} (\${loc})] 상세 설명 입력 완료!\`, "#86efac");
  };

  panel.querySelector("#gp-cws-copy-one").onclick = async () => {
    const loc = sel.value;
    await navigator.clipboard.writeText(DATA[loc].text);
    setStatus(\`📋 [\${DATA[loc].nameKo} (\${loc})] 클립보드 복사 완료!\`, "#86efac");
  };

  let runningBatch = false;
  panel.querySelector("#gp-cws-run-all").onclick = async () => {
    if (runningBatch) return;
    runningBatch = true;
    try {
      const trigger = findLanguageDropdownTrigger();
      if (trigger) {
        triggerClick(trigger);
        await sleep(350);
      }
      let optionMap = findLanguageOptions();
      if (optionMap.size < 5) {
        setStatus("💡 상단 '언어 선택 드롭다운'을 한 번 클릭해 목록을 열어준 뒤 다시 눌러주세요!", "#fde047");
        runningBatch = false;
        return;
      }
      let done = 0;
      for (const loc of LOCALES) {
        // Re-open dropdown if needed
        const currTrigger = findLanguageDropdownTrigger();
        let opt = findLanguageOptions().get(loc);
        if (!opt && currTrigger) {
          triggerClick(currTrigger);
          await sleep(250);
          opt = findLanguageOptions().get(loc);
        }
        if (!opt) {
          console.warn("[GhostPiP CWS] Option not found in dropdown for:", loc);
          continue;
        }
        triggerClick(opt);
        await sleep(280);
        const ta = findDescriptionTextarea();
        if (ta) {
          setTextareaValue(ta, DATA[loc].text);
          done++;
          sel.value = loc;
          setStatus(\`⏳ 자동 입력 중... (\${done}/\${LOCALES.length}) — \${DATA[loc].nameKo} (\${loc})\`, "#38bdf8");
        }
        await sleep(160);
      }
      setStatus(\`🎉 총 \${done}개 언어 상세 설명 자동 입력 완료! 우측 상단 [임시보관함에 저장]을 누르세요.\`, "#86efac");
    } finally {
      runningBatch = false;
    }
  };

  // Watch for manual language switching in CWS dropdown
  let lastDetectedLoc = null;
  setInterval(() => {
    if (runningBatch) return;
    const watchOn = panel.querySelector("#gp-cws-autofill-watch")?.checked;
    if (!watchOn) return;
    const trigger = findLanguageDropdownTrigger();
    const detected = matchLocaleFromElement(trigger);
    if (detected && detected !== lastDetectedLoc) {
      lastDetectedLoc = detected;
      sel.value = detected;
      const ta = findDescriptionTextarea();
      if (ta && ta.value.trim() !== DATA[detected].text.trim()) {
        setTextareaValue(ta, DATA[detected].text);
        setStatus(\`✨ 언어 감지 [\${DATA[detected].nameKo} (\${detected})] → 자동 입력됨\`, "#86efac");
      }
    }
  }, 400);

  console.log("[GhostPiP CWS Helper] Loaded 52 locales successfully.");
})();
`;

const autofillPath = path.join(OUT_DIR, "cws-autofill-52-locales.js");
fs.writeFileSync(autofillPath, autofillScript, "utf8");

// 4. Write Interactive HTML Copy & Auto-Fill Dashboard
const htmlContent = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>GhostPiP — Chrome 웹 스토어 52개국 상세 설명 도우미</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #0b1120;
      color: #f1f5f9;
      line-height: 1.5;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: linear-gradient(135deg, #0f172a, #1e293b);
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 8px; font-size: 22px; color: #38bdf8; }
    p { margin: 6px 0; color: #cbd5e1; font-size: 14px; }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 16px;
    }
    .btn-primary {
      background: #0284c7;
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-primary:hover { background: #0369a1; }
    .steps {
      margin-top: 14px;
      padding: 12px 16px;
      background: rgba(15, 23, 42, 0.75);
      border-radius: 10px;
      border: 1px solid #1e293b;
      font-size: 13px;
      color: #e2e8f0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 14px;
    }
    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card.done { border-color: #22c55e; }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .lang-title { font-weight: 700; font-size: 14px; color: #f8fafc; }
    .lang-code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: #1e293b;
      color: #38bdf8;
      padding: 2px 7px;
      border-radius: 6px;
    }
    .btn-copy {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-copy:hover { background: #334155; }
    textarea {
      width: 100%;
      height: 150px;
      background: #020617;
      color: #cbd5e1;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 10px;
      font-size: 12px;
      font-family: system-ui, -apple-system, sans-serif;
      resize: vertical;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>👻 GhostPiP — 크롬 웹 스토어 52개국 상세 설명 최신화 도구</h1>
      <p>웹 모드 삭제 + 다중 PiP · 위치/크기 기억 · 실시간 자막 · 리모컨 · 역 투명화 추가 + 길이 50% 단축 완료</p>
      <div class="hero-actions">
        <button class="btn-primary" id="copyAutofillBtn">🚀 F12 콘솔용 52개국 자동 입력 스크립트 복사</button>
      </div>
      <div class="steps">
        <strong>크롬 웹 스토어 대시보드에서 10초 만에 52개국 모두 채우는 방법:</strong><br/>
        1. 위 <b>[🚀 F12 콘솔용 52개국 자동 입력 스크립트 복사]</b> 버튼을 클릭합니다.<br/>
        2. 크롬 웹 스토어 <b>스토어 등록 정보(Store listing)</b> 페이지에서 <code>F12</code>를 눌러 개발자 도구 <b>Console(콘솔)</b> 탭을 엽니다.<br/>
        3. 콘솔에 붙여넣기(<code>Ctrl+V</code>) 후 <code>Enter</code>를 치면 우측 하단에 <b>👻 GhostPiP 52개국 자동 입력기</b> 패널이 나타납니다.<br/>
        4. 스토어 페이지 우측 상단의 <b>언어 선택 드롭다운</b>을 한 번 눌러 목록을 연 뒤, 패널의 <b>[⚡ 52개 언어 드롭다운 자동 순회 입력]</b>을 누르면 52개 언어가 자동으로 입력됩니다! (또는 드롭다운에서 언어를 바꿀 때마다 자동으로 채워집니다.)
      </div>
    </header>
    <div class="grid" id="grid"></div>
  </div>
  <script>
    const DATA = ${JSON.stringify(ALL)};
    const LOCALES = ${JSON.stringify(STORE_LOCALES)};
    const AUTOFILL_CODE = ${JSON.stringify(autofillScript)};

    document.getElementById("copyAutofillBtn").onclick = async (e) => {
      await navigator.clipboard.writeText(AUTOFILL_CODE);
      e.target.textContent = "✅ 자동 입력 스크립트 복사 완료! (웹스토어 탭 F12 콘솔에 붙여넣으세요)";
      setTimeout(() => {
        e.target.textContent = "🚀 F12 콘솔용 52개국 자동 입력 스크립트 복사";
      }, 4000);
    };

    const grid = document.getElementById("grid");
    for (const loc of LOCALES) {
      const item = DATA[loc];
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = \`
        <div class="card-head">
          <div>
            <span class="lang-code">\${loc}</span>
            <span class="lang-title">\${item.nameKo} (\${item.nameEn})</span>
          </div>
          <button class="btn-copy">복사</button>
        </div>
        <textarea readonly></textarea>
      \`;
      card.querySelector("textarea").value = item.text;
      const btn = card.querySelector(".btn-copy");
      btn.onclick = async () => {
        await navigator.clipboard.writeText(item.text);
        card.classList.add("done");
        btn.textContent = "✓ 복사됨";
      };
      grid.appendChild(card);
    }
  </script>
</body>
</html>
`;
const htmlPath = path.join(OUT_DIR, "store-descriptions-52.html");
fs.writeFileSync(htmlPath, htmlContent, "utf8");

console.log(`[store-descriptions] Generated 52 locales cleanly:
  - ${jsonPath}
  - ${mdPath}
  - ${autofillPath}
  - ${htmlPath}`);
