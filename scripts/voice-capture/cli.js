"use strict";
// 统一 CLI：fixture / pack / core / judge 四个子命令。所有工具日志写绝对路径。
//   node scripts/voice-capture/cli.js fixture --source-wav <wav> --out <dir> [--ffmpeg <bin>]
//   node scripts/voice-capture/cli.js pack --out <dir>
//   node scripts/voice-capture/cli.js core --expected <json> --out <dir> [--port 18027] [--allow-origin <o>]... [--note-id <id>]...
//   node scripts/voice-capture/cli.js judge --evidence <dir> [--human-confirmed]
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const flags = {};
  const list = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.slice(0, 2) !== "--") throw new Error("unexpected arg: " + token);
    const key = token.slice(2);
    const next = argv[i + 1];
    let value = true;
    if (next !== undefined && next.slice(0, 2) !== "--") {
      value = next;
      i += 1;
    }
    if (value === true) {
      if (flags[key] === undefined && list[key] === undefined) flags[key] = true;
      else list[key] = (list[key] || []).concat(true);
    } else if (flags[key] !== undefined) {
      list[key] = [flags[key], value];
      delete flags[key];
    } else if (Array.isArray(list[key])) {
      list[key].push(value);
    } else {
      flags[key] = value;
    }
  }
  return { flags: flags, list: list };
}

function cmdFixture(args) {
  const fixture = require("./fixture.js");
  const f = args.flags;
  const out = path.resolve(f.out || ".");
  const result = fixture.buildFixture({
    ffmpegPath: f.ffmpeg || "/opt/homebrew/bin/ffmpeg",
    sourceWav: f["source-wav"],
    outDir: out,
    fixtureId: f["fixture-id"] || "voice-capture-fixture",
    segmentId: f["segment-id"] || "seg",
    durationSec: Number(f["duration-sec"] || 8.312744),
    originalText: f["original-text"] || "Memo 5B 独立验收：这是新建的测试文本，用于验证真实语音和缓存。",
    translationText: f["translation-text"] || "Memo 5B independent acceptance: this is a newly created test text used to verify real speech and caching.",
  });
  process.stdout.write(JSON.stringify({
    mediaPath: result.mediaPath,
    expectedPath: result.expectedPath,
    mediaSha256: result.expected.mediaSha256,
    pcmSha256: result.expected.pcmSha256,
    durationMs: result.expected.durationMs,
  }, null, 2) + "\n");
}

function cmdPack(args) {
  const packApp = require("./pack-app.js").packApp;
  const repoRoot = path.resolve(__dirname, "..", "..");
  const out = path.resolve(args.flags.out || path.join(repoRoot, "dist", "voice-feasibility"));
  const result = packApp({ sourceDir: path.join(repoRoot, "apps", "voice-feasibility"), outDir: out });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function cmdCore(args) {
  const createCore = require("./core.js").createCore;
  const crypto = require("node:crypto");
  const f = args.flags;
  const expectedPath = path.resolve(f.expected);
  const expectedRaw = fs.readFileSync(expectedPath);
  const expected = JSON.parse(expectedRaw.toString("utf8"));
  const out = path.resolve(f.out || path.dirname(expectedPath));
  const port = Number(f.port || 18027);
  const registryPath = f.registry ? path.resolve(f.registry) : null;
  const registry = registryPath && fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : { media: [], note: null };
  const coreSourcePath = path.join(__dirname, "core.js");
  const appArtifact = f["app-artifact"] ? path.resolve(f["app-artifact"]) : null;
  const core = createCore({
    port: port,
    ffmpegPath: f.ffmpeg || "/opt/homebrew/bin/ffmpeg",
    expected: expected,
    outDir: out,
    allowOrigin: args.list["allow-origin"] || [],
    registry: registry,
    fixtureManifestHash: crypto.createHash("sha256").update(expectedRaw).digest("hex"),
    coreSourceHash: crypto.createHash("sha256").update(fs.readFileSync(coreSourcePath)).digest("hex"),
    appArtifactHash: appArtifact && fs.existsSync(appArtifact) ? crypto.createHash("sha256").update(fs.readFileSync(appArtifact)).digest("hex") : null,
    eventsPath: path.join(out, "core-events.jsonl"),
  });
  core.server.listen(port, "127.0.0.1", () => {
    process.stdout.write("voice-capture-core listening on http://" + core.expectedHost + "\n");
  });
}

// 受控登记命令：只由人手在核实原生见证后运行，前端无法调用，也不扩大登记范围。
function cmdRegisterMedia(args) {
  const f = args.flags;
  const mediaPath = path.resolve(f.path);
  const stat = fs.statSync(mediaPath);
  const real = fs.realpathSync(mediaPath);
  if (real !== mediaPath) {
    process.stderr.write("refused: path is not canonical (symlink or alias): " + mediaPath + " -> " + real + "\n");
    process.exitCode = 3;
    return;
  }
  const crypto = require("node:crypto");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(mediaPath)).digest("hex");
  const entry = {
    mediaId: f["media-id"],
    canonicalPath: mediaPath,
    digestKind: f["digest-kind"] || "bytes",
    sha256: sha256,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    parentFixtureId: f.parent || null,
    nativeWitnessIndex: f.witness || null,
  };
  const outPath = path.resolve(f.out);
  fs.writeFileSync(outPath, JSON.stringify({ schemaVersion: 1, media: [entry] }, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(entry, null, 2) + "\nwrote " + outPath + "\n");
}

function cmdJudge(args) {
  const evaluateGates = require("./judge.js").evaluateGates;
  const dir = path.resolve(args.flags.evidence || ".");
  const reportPath = path.join(dir, "page-report.json");
  const eventsPath = path.join(dir, "core-events.jsonl");
  const provenancePath = path.join(dir, "core-provenance.json");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { records: [] };
  const provenance = fs.existsSync(provenancePath) ? JSON.parse(fs.readFileSync(provenancePath, "utf8")) : null;
  const events = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(function (line) { return JSON.parse(line); })
    : [];
  const extracts = events.filter(function (e) { return e.type === "extract-ok"; }).map(function (e) {
    return { mediaSha256Match: true, nonSilent: e.nonSilent, runId: e.runId || null, sessionId: e.sessionId || null };
  });
  const origins = events.filter(function (e) { return e.type === "origin-observed"; }).map(function (e) { return e.origin; });
  const result = evaluateGates({
    report: report,
    extracts: extracts,
    observedOrigins: origins,
    provenance: provenance,
    allowOrigin: args.list["allow-origin"] ? args.list["allow-origin"][0] : null,
    challengeCode: args.flags.challenge || (provenance && provenance.challengeCode) || null,
    nativeWitness: fs.existsSync(path.join(dir, "native-witness.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "native-witness.json"), "utf8")) : null,
    ownerListening: fs.existsSync(path.join(dir, "owner-listening.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "owner-listening.json"), "utf8")) : null,
  });
  const outPath = path.join(dir, "verification.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("wrote " + outPath + "\n");
}

const COMMANDS = {
  fixture: cmdFixture,
  pack: cmdPack,
  core: cmdCore,
  judge: cmdJudge,
  "register-media": cmdRegisterMedia,
};

function main(argv) {
  const command = argv[0];
  const runner = COMMANDS[command];
  if (!runner) {
    process.stderr.write("usage: cli.js <fixture|pack|core|judge|register-media> [--flags]\n");
    return 2;
  }
  runner(parseArgs(argv.slice(1)));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(String((err && err.message) || err) + "\n");
    process.exitCode = 1;
  }
}

module.exports = { parseArgs: parseArgs, main: main };
