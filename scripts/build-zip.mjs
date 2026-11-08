import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const PUBLISH_DIR = path.join(ROOT, "engine/bin/Release/net10.0-windows/win-x64/publish");
const STAGE_DIR = path.join(ROOT, "engine/bin/Release/net10.0-windows/win-x64/stage");
const EXE_NAME = "GhostPiP.Engine.exe";
const INSTALLER_FILES = ["install.ps1", "install.bat", "uninstall.ps1", "uninstall.bat"];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

execFileSync(process.execPath, [path.join(ROOT, "scripts/check-locales.mjs")], { stdio: "inherit" });

const QUARANTINE_HINT =
  `${EXE_NAME}을(를) 읽을 수 없습니다. 백신(Avast 등)이 서명되지 않은 새 빌드를 오탐으로 격리했을 가능성이 큽니다.\n` +
  "  - 백신 격리함에서 복원하고 engine 폴더를 예외로 추가한 뒤 다시 실행하거나\n" +
  "  - GHOSTPIP_SIGN_THUMBPRINT / GHOSTPIP_SIGN_PFX 를 설정해 코드 서명된 빌드를 만드세요 (README 참고).";

function readWithRetry(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.readFileSync(file);
    } catch (err) {
      if (Date.now() >= deadline) throw new Error(`${QUARANTINE_HINT}\n  (${err.code ?? err.message}: ${file})`);
      sleep(150);
    }
  }
}

function findSigntool() {
  const kits = "C:/Program Files (x86)/Windows Kits/10/bin";
  if (!fs.existsSync(kits)) return null;
  const versions = fs.readdirSync(kits).filter((d) => /^\d+\./.test(d)).sort().reverse();
  for (const v of versions) {
    const p = path.join(kits, v, "x64", "signtool.exe");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function signIfConfigured(file) {
  const thumb = process.env.GHOSTPIP_SIGN_THUMBPRINT;
  const pfx = process.env.GHOSTPIP_SIGN_PFX;
  if (!thumb && !pfx) {
    console.log("  (코드 서명 생략: GHOSTPIP_SIGN_THUMBPRINT 또는 GHOSTPIP_SIGN_PFX 미설정)");
    return false;
  }
  const signtool = findSigntool();
  if (!signtool) throw new Error("signtool.exe를 찾지 못했습니다. Windows SDK를 설치하세요.");
  const ts = process.env.GHOSTPIP_SIGN_TIMESTAMP_URL || "http://timestamp.digicert.com";
  const certArgs = thumb
    ? ["/sha1", thumb]
    : ["/f", pfx, ...(process.env.GHOSTPIP_SIGN_PFX_PASSWORD ? ["/p", process.env.GHOSTPIP_SIGN_PFX_PASSWORD] : [])];
  execFileSync(signtool, ["sign", "/fd", "sha256", "/tr", ts, "/td", "sha256", ...certArgs, file], { stdio: "inherit" });
  execFileSync(signtool, ["verify", "/pa", file], { stdio: "inherit" });
  return true;
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    // Chrome rejects packages with top-level "_" entries other than _locales (e.g. the
    // _metadata folder Chrome writes into unpacked extensions).
    if (ent.name.startsWith("_") && ent.name !== "_locales") continue;
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.push({ rel, data: readWithRetry(full) });
  }
  return out;
}

function writeZip(zipPath, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { rel, data: raw } of entries) {
    const name = Buffer.from(rel, "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = zlib.crc32(raw) >>> 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, name, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...local, cd, eocd]));
}

const prefixed = (prefix, entries) => entries.map((e) => ({ rel: `${prefix}/${e.rel}`, data: e.data }));

fs.mkdirSync(DIST, { recursive: true });
for (const ent of fs.readdirSync(DIST)) {
  if (ent.endsWith(".zip")) fs.rmSync(path.join(DIST, ent), { force: true });
}

console.log("[1/4] GhostPiP.Engine.exe 빌드 (Release win-x64 Native AOT)...");
const killEngine = () => {
  try {
    execFileSync("taskkill", ["/F", "/IM", EXE_NAME], { stdio: "ignore" });
    sleep(300);
  } catch {}
};
fs.mkdirSync(path.join(ROOT, "engine/bin/Release/net10.0-windows/win-x64/native"), { recursive: true });
const NO_BUILD = process.argv.includes("--no-build");
let exe;
if (NO_BUILD) {
  console.log("  --no-build: 기존 빌드를 패키징합니다.");
  exe = readWithRetry(path.join(PUBLISH_DIR, EXE_NAME));
} else {
  // Build into a staging dir: the registered host path (PUBLISH_DIR) can be re-locked at any moment
  // because a running browser respawns the engine on demand.
  execFileSync(
    "dotnet",
    ["publish", path.join(ROOT, "engine/GhostPiP.Engine.csproj"), "-c", "Release", "-r", "win-x64", "-o", STAGE_DIR, "--nologo"],
    { stdio: "inherit" },
  );
  const stagedExe = path.join(STAGE_DIR, EXE_NAME);

  console.log("[2/4] 코드 서명...");
  readWithRetry(stagedExe);
  signIfConfigured(stagedExe);
  exe = readWithRetry(stagedExe);

  const exePath = path.join(PUBLISH_DIR, EXE_NAME);
  fs.mkdirSync(PUBLISH_DIR, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    killEngine();
    try {
      fs.writeFileSync(exePath, exe);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
    }
  }
}

console.log("[3/4] 패키지 구성...");
const extFiles = walk(path.join(ROOT, "extension"));
const manifest = JSON.parse(extFiles.find((f) => f.rel === "manifest.json").data.toString("utf8"));
const { key: _key, ...storeManifest } = manifest;
const storeExtFiles = extFiles.map((f) =>
  f.rel === "manifest.json" ? { rel: f.rel, data: Buffer.from(JSON.stringify(storeManifest, null, 2) + "\n") } : f,
);
const engineFiles = [
  { rel: EXE_NAME, data: exe },
  ...INSTALLER_FILES.map((f) => ({ rel: f, data: readWithRetry(path.join(ROOT, "engine/installer", f)) })),
];
const readme = Buffer.from(
  [
    "GhostPiP " + manifest.version,
    "",
    "[1] 크롬 확장 프로그램",
    "  1. chrome://extensions 를 열고 오른쪽 위 '개발자 모드'를 켭니다.",
    "  2. '압축해제된 확장 프로그램을 로드합니다'를 눌러 이 폴더의 extension 폴더를 고릅니다.",
    "",
    "[2] GhostPiP Engine (전체 모드: 게임·다른 프로그램 위 투명/클릭 통과/자동 회피)",
    "  1. engine 폴더의 install.bat 을 더블클릭합니다.",
    "     엔진은 %LOCALAPPDATA%\\Programs\\GhostPiP 에 복사되므로 설치 후 이 폴더는 지워도 됩니다.",
    "  2. 제거: engine\\uninstall.bat 실행",
    "",
    "[백신 경고가 뜰 때]",
    "  코드 서명이 없는 새 실행 파일이라 일부 백신(Avast 'Win64:Evo-gen' 등)이 오탐할 수 있습니다.",
    "  격리함에서 복원하고 %LOCALAPPDATA%\\Programs\\GhostPiP 를 예외로 추가한 뒤 install.bat 을 다시 실행하세요.",
    "",
  ].join("\r\n"),
  "utf8",
);

console.log("[4/4] zip 생성...");
const outputs = {
  "GhostPiP-Extension-store.zip": storeExtFiles,
  "GhostPiP-Engine-win-x64.zip": engineFiles,
  "GhostPiP-Full-Package.zip": [
    ...prefixed("extension", extFiles),
    ...prefixed("engine", engineFiles),
    { rel: "README.txt", data: readme },
  ],
};
for (const [name, entries] of Object.entries(outputs)) {
  const zip = path.join(DIST, name);
  writeZip(zip, entries);
  console.log(`  - ${name} (${(fs.statSync(zip).size / 1024).toFixed(1)} KB)`);
}
