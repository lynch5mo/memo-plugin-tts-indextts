"use strict";
// 独立 App 打包器：把 apps/voice-feasibility 打成可原生导入的 .memox，输出固定清单与 sha256。
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_ID = "memo-plugin-app-voice-feasibility";
const EXPECTED_TYPE = "app";
const RUNTIME_FILES = Object.freeze(["manifest.json", "index.js", "index.html"]);
const FIXED_MTIME = "202601010000";

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyManifest(sourceDir) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const problems = [];
  if (manifest.pluginId !== APP_ID) problems.push("pluginId must be " + APP_ID);
  if (manifest.type !== EXPECTED_TYPE) problems.push("type must be " + EXPECTED_TYPE);
  if (manifest.importType !== "module") problems.push("importType must be module");
  if (manifest.minVersion !== "1.8.8") problems.push("minVersion must be 1.8.8");
  if (!Array.isArray(manifest.apis)) problems.push("apis must be an array");
  return { manifest: manifest, problems: problems };
}

function packApp(options) {
  const sourceDir = path.resolve(options.sourceDir);
  const outDir = path.resolve(options.outDir);
  const { manifest, problems } = verifyManifest(sourceDir);
  if (problems.length > 0) {
    const err = new Error("E_FIXTURE: manifest invalid: " + problems.join("; "));
    err.code = "E_FIXTURE";
    err.detail = { problems: problems };
    throw err;
  }
  for (const name of RUNTIME_FILES) {
    const file = path.join(sourceDir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) {
      const err = new Error("E_FIXTURE: runtime file invalid: " + name);
      err.code = "E_FIXTURE";
      throw err;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = APP_ID + "-" + manifest.version + ".memox";
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "voice-app-pack-"));
  try {
    for (const name of RUNTIME_FILES) {
      const dest = path.join(stage, name);
      fs.copyFileSync(path.join(sourceDir, name), dest);
      fs.chmodSync(dest, 0o644);
    }
    const touch = spawnSync("/usr/bin/touch", ["-t", FIXED_MTIME].concat(RUNTIME_FILES), { cwd: stage });
    if (touch.status !== 0) throw new Error("E_FIXTURE: touch failed");
    const zip = spawnSync("zip", ["-X", "-q", artifact].concat(RUNTIME_FILES), { cwd: stage });
    if (zip.status !== 0) throw new Error("E_FIXTURE: zip failed");
    const listed = spawnSync("unzip", ["-Z1", artifact], { cwd: stage, encoding: "utf8" });
    const entries = String(listed.stdout || "").trim().split("\n").filter(Boolean);
    if (entries.join(",") !== RUNTIME_FILES.join(",")) {
      throw new Error("E_FIXTURE: zip entry list mismatch: " + entries.join(","));
    }
    const built = path.join(stage, artifact);
    const digest = sha256File(built);
    const finalArtifact = path.join(outDir, artifact);
    fs.copyFileSync(built, finalArtifact);
    fs.writeFileSync(finalArtifact + ".sha256", digest + "  " + artifact + "\n", "utf8");
    return {
      artifact: finalArtifact,
      sha256: digest,
      entries: entries,
      pluginId: manifest.pluginId,
      version: manifest.version,
      sourceDir: sourceDir,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { APP_ID: APP_ID, RUNTIME_FILES: RUNTIME_FILES, packApp: packApp, verifyManifest: verifyManifest };
