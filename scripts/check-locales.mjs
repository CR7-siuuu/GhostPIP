// Verifies every locale against the English master and every i18n key the code uses.
// Usage: node scripts/check-locales.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const EXT = path.join(ROOT, "extension");
const LOCALES = path.join(EXT, "_locales");

export const STORE_LOCALES = [
  "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "es_419", "et", "fa", "fi", "fil", "fr",
  "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nl", "no", "pl",
  "pt_BR", "pt_PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "vi", "zh_CN", "zh_TW",
];

const errors = [];
const read = (loc) => JSON.parse(fs.readFileSync(path.join(LOCALES, loc, "messages.json"), "utf8"));
const tags = (s) => (s.match(/<\/?[a-z]+(?:\s[^>]*)?>/g) ?? []).sort().join("");
const tokens = (s) => (s.match(/\$[A-Z_]+\$/g) ?? []).sort().join(",");

const master = read("en");
const keys = Object.keys(master);

for (const loc of STORE_LOCALES) {
  const file = path.join(LOCALES, loc, "messages.json");
  if (!fs.existsSync(file)) {
    errors.push(`${loc}: missing messages.json`);
    continue;
  }
  let msgs;
  try {
    msgs = read(loc);
  } catch (e) {
    errors.push(`${loc}: invalid JSON (${e.message})`);
    continue;
  }
  for (const key of keys) {
    const m = msgs[key]?.message;
    if (typeof m !== "string" || !m.trim()) {
      errors.push(`${loc}.${key}: missing`);
      continue;
    }
    const en = master[key];
    if (tags(m) !== tags(en.message)) errors.push(`${loc}.${key}: HTML tags differ from en`);
    if (tokens(m) !== tokens(en.message)) errors.push(`${loc}.${key}: placeholders differ from en`);
    const enPh = Object.keys(en.placeholders ?? {}).sort().join(",");
    const ph = Object.keys(msgs[key].placeholders ?? {}).sort().join(",");
    if (enPh !== ph) errors.push(`${loc}.${key}: placeholders object differs from en`);
  }
  for (const key of Object.keys(msgs)) if (!(key in master)) errors.push(`${loc}.${key}: not in en`);
  if ([...msgs.extDescription.message].length > 132) errors.push(`${loc}.extDescription: over 132 characters`);
  if (msgs.extName.message !== "GhostPiP") errors.push(`${loc}.extName: must stay "GhostPiP"`);
}

for (const dir of fs.readdirSync(LOCALES)) {
  if (!STORE_LOCALES.includes(dir)) errors.push(`${dir}: not a Chrome Web Store locale`);
}

const used = new Set();
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== "_locales") walk(p);
    } else if (/\.(js|html|json)$/.test(ent.name)) {
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
      for (const m of src.matchAll(/data-i18n(?:-html|-title|-aria-label)?="(\w+)"/g)) used.add(m[1]);
      for (const m of src.matchAll(/\bt\("(\w+)"/g)) used.add(m[1]);
      for (const m of src.matchAll(/getMessage\("(\w+)"/g)) used.add(m[1]);
    }
  }
};
walk(EXT);
for (const key of used) if (!key.startsWith("@@") && !(key in master)) errors.push(`code uses unknown key "${key}"`);
for (const key of keys) if (!used.has(key)) errors.push(`en.${key}: never used in code`);

if (errors.length) {
  console.error(`[locales] ${errors.length} problem(s):\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`[locales] OK: ${STORE_LOCALES.length} locales × ${keys.length} keys, ${used.size} keys used in code`);
