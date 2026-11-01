import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "_stage");

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const PUBLISH_DIR = path.join(STAGE, "publish");
fs.mkdirSync(PUBLISH_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, "engine/bin/Release/net8.0-windows/win-x64/native"), { recursive: true });

console.log("[1/3] Publishing GhostPiP.Engine.exe (Release win-x64 Native AOT)...");
execFileSync(
  "dotnet",
  [
    "publish",
    path.join(ROOT, "engine/GhostPiP.Engine.csproj"),
    "-c",
    "Release",
    "-r",
    "win-x64",
    "-o",
    PUBLISH_DIR,
    "--nologo",
  ],
  { stdio: "inherit" },
);

function waitFileReady(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return fs.readFileSync(filePath);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

const exePath = path.join(PUBLISH_DIR, "GhostPiP.Engine.exe");
waitFileReady(exePath);

const defaultPublishDir = path.join(ROOT, "engine/bin/Release/net8.0-windows/win-x64/publish");
fs.mkdirSync(defaultPublishDir, { recursive: true });
try {
  execFileSync("taskkill", ["/F", "/IM", "GhostPiP.Engine.exe"], { stdio: "ignore" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
} catch {}
fs.copyFileSync(exePath, path.join(defaultPublishDir, "GhostPiP.Engine.exe"));

function walkFiles(dir, baseDir = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, baseDir, out);
    } else if (ent.isFile()) {
      const rel = path.relative(baseDir, full).split(path.sep).join("/");
      out.push({ full, rel });
    }
  }
  return out;
}

function createZipFromDir(sourceDir, zipPath) {
  const files = walkFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const nameBuf = Buffer.from(rel, "utf8");
    const raw = waitFileReady(full);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = zlib.crc32(raw) >>> 0;

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4); // version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, data);

    // Central directory header (46 bytes + filename)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);

    centralParts.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...localParts, centralBuf, eocd]));
}

console.log("[2/3] Creating zip archives...");

// 1. Chrome Extension zip (ready for Chrome Web Store or unpacked loading)
const extZip = path.join(DIST, "GhostPiP-Extension.zip");
createZipFromDir(path.join(ROOT, "extension"), extZip);

// 2. Engine standalone zip
const engineStage = path.join(STAGE, "engine-only");
fs.mkdirSync(engineStage, { recursive: true });
fs.copyFileSync(exePath, path.join(engineStage, "GhostPiP.Engine.exe"));
for (const f of ["install.ps1", "install.bat", "uninstall.ps1", "uninstall.bat"]) {
  fs.copyFileSync(path.join(ROOT, "engine/installer", f), path.join(engineStage, f));
}
const engineZip = path.join(DIST, "GhostPiP-Engine-win-x64.zip");
createZipFromDir(engineStage, engineZip);

// 3. Full combined release zip (extension + engine + README)
const fullStage = path.join(STAGE, "full");
fs.mkdirSync(path.join(fullStage, "extension"), { recursive: true });
fs.mkdirSync(path.join(fullStage, "engine"), { recursive: true });
fs.cpSync(path.join(ROOT, "extension"), path.join(fullStage, "extension"), { recursive: true });
fs.cpSync(engineStage, path.join(fullStage, "engine"), { recursive: true });
fs.writeFileSync(
  path.join(fullStage, "README.txt"),
  [
    "====================================================",
    " GhostPiP - 투명 / 클릭 통과 / 스마트 자동 회피 PiP",
    "====================================================",
    "",
    "[1] 크롬 확장 프로그램 설치 방법",
    "  1. 크롬 주소창에 chrome://extensions 입력 후 이동",
    "  2. 우측 상단 '개발자 모드' 켜기",
    "  3. 좌측 상단 '압축해제된 확장 프로그램을 로드합니다' 클릭",
    "  4. 압축을 푼 폴더 내의 'extension' 폴더 선택",
    "",
    "[2] 외부 엔진 (PC 게임 위 전체 모드 투명화·클릭 통과·자동 회피) 설치 방법",
    "  1. 원하는 고정 위치에 이 폴더의 압축을 풀어둡니다.",
    "  2. 'engine' 폴더 안의 'install.bat'을 더블클릭하여 실행합니다.",
    "  3. 제거 시에는 'uninstall.bat'을 실행하면 됩니다.",
    "",
  ].join("\r\n"),
  "utf8",
);
const fullZip = path.join(DIST, "GhostPiP-Full-Package.zip");
createZipFromDir(fullStage, fullZip);

fs.rmSync(STAGE, { recursive: true, force: true });

console.log("[3/3] Done! Generated archives in dist/:");
for (const z of [extZip, engineZip, fullZip]) {
  const kb = (fs.statSync(z).size / 1024).toFixed(1);
  console.log(`  - ${path.basename(z)} (${kb} KB)`);
}
