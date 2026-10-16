"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createCore, MAX_MEDIA_BYTES } = require("../scripts/voice-capture/core.js");

const HOST = "127.0.0.1";
const ORIGIN = "aim://app-deadbeef";
const OTHER_ORIGIN = "https://evil.example";
const NOTE = { noteId: "note-1", workspaceId: "ws-1", folderId: "folder-1" };
const REAL_FFMPEG = "/opt/homebrew/bin/ffmpeg";

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: port, method: options.method || "GET", path: options.path, headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let portCursor = 22000 + Math.floor(Math.random() * 500);
function nextPort() { portCursor += 1; return portCursor; }

function makeMedia(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const stat = fs.statSync(file);
  return {
    entry: {
      mediaId: "media-" + name, canonicalPath: file, digestKind: "bytes",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
      parentFixtureId: "fixture-1", nativeWitnessIndex: "witness-1",
    },
  };
}

function startCore(t, options) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-core-test-"));
  const port = nextPort();
  const core = createCore({
    port: port,
    ffmpegPath: options.ffmpegPath || "/usr/bin/false",
    expected: options.expected || {
      fixtureId: "f1", originalText: "原始", translationText: "translated",
      timeline: [{ id: "seg:0", startMs: 0, endMs: 1000, text: "原始" }], durationMs: 1000,
    },
    outDir: outDir,
    allowOrigin: options.allowOrigin || [ORIGIN],
    registry: options.registry || { media: [], note: NOTE },
    fixtureManifestHash: "manifest-hash",
    coreSourceHash: "core-hash",
    wallClockMs: options.wallClockMs,
    decodeTimeoutMs: options.decodeTimeoutMs,
  });
  return new Promise((resolve) => {
    core.server.listen(port, HOST, () => {
      t.after(() => { core.server.close(); fs.rmSync(outDir, { recursive: true, force: true }); });
      resolve({ core: core, port: port, outDir: outDir });
    });
  });
}

function headers(port, extra) {
  return Object.assign({ Host: HOST + ":" + port, Origin: ORIGIN }, extra || {});
}

async function openSession(port) {
  const res = await request(port, { path: "/probe/session", headers: headers(port) });
  return res.body;
}

test("core rejects no Origin and null Origin", async (t) => {
  const ctx = await startCore(t, {});
  const noOrigin = await request(ctx.port, { path: "/probe/session", headers: { Host: HOST + ":" + ctx.port } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.code, "E_ORIGIN");
  const nullOrigin = await request(ctx.port, { path: "/probe/session", headers: { Host: HOST + ":" + ctx.port, Origin: "null" } });
  assert.equal(nullOrigin.status, 403);
});

test("core records unknown Origin without granting CORS", async (t) => {
  const ctx = await startCore(t, {});
  const res = await request(ctx.port, { path: "/probe/session", headers: { Host: HOST + ":" + ctx.port, Origin: OTHER_ORIGIN } });
  assert.equal(res.status, 403);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.ok(ctx.core.state.observedOrigins.includes(OTHER_ORIGIN));
});

test("core rejects a mismatched Host header", async (t) => {
  const ctx = await startCore(t, {});
  const res = await request(ctx.port, { path: "/probe/session", headers: { Host: "evil.example", Origin: ORIGIN } });
  assert.equal(res.status, 421);
});

test("core requires the token and never logs it", async (t) => {
  const ctx = await startCore(t, {});
  const missing = await request(ctx.port, { path: "/probe/expected", headers: headers(ctx.port) });
  assert.equal(missing.status, 401);
  const session = await openSession(ctx.port);
  assert.ok(session.token.length > 20);
  const log = fs.readFileSync(path.join(ctx.outDir, "core-events.jsonl"), "utf8");
  assert.ok(log.includes("session-issued"));
  assert.ok(!log.includes(session.token), "token must never be logged");
});

test("core binds the session to the run and reports the nonce", async (t) => {
  const ctx = await startCore(t, {});
  const session = await openSession(ctx.port);
  assert.match(session.runId, /^run-\d+$/);
  assert.match(session.sessionId, /^sess-\d+$/);
  assert.equal(session.nonce, ctx.core.state.runNonce);
  const report = JSON.parse(fs.readFileSync(path.join(ctx.outDir, "core-provenance.json"), "utf8"));
  assert.equal(report.nonce, session.nonce);
  assert.equal(report.logFailures, 0);
});

test("core refuses extract for an unregistered mediaId without touching the filesystem", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { entry } = makeMedia(dir, "a.bin", Buffer.from("hello"));
  const ctx = await startCore(t, { registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: "not-registered", segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "E_MEDIA");
  assert.equal(res.body.detail, "media-not-registered");
  const log = fs.readFileSync(path.join(ctx.outDir, "core-events.jsonl"), "utf8");
  assert.ok(log.includes("extract-media-unregistered"));
});

test("core refuses a document triple that does not match the registered note", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { entry } = makeMedia(dir, "a.bin", Buffer.from("hello"));
  const ctx = await startCore(t, { registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify({ mediaId: entry.mediaId, noteId: "other-note", workspaceId: NOTE.workspaceId, folderId: NOTE.folderId, segmentIds: ["seg:0"] }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.detail, "note-triple-mismatch");
});

test("core refuses a symlinked registration path via O_NOFOLLOW", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "real.bin");
  fs.writeFileSync(real, Buffer.from("hello"));
  const link = path.join(dir, "link.bin");
  fs.symlinkSync(real, link);
  const stat = fs.statSync(real);
  const entry = {
    mediaId: "symlink", canonicalPath: link, digestKind: "bytes",
    sha256: crypto.createHash("sha256").update(Buffer.from("hello")).digest("hex"),
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
  };
  const ctx = await startCore(t, { registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: "symlink", segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.detail, "open-refused");
});

test("core refuses when the registered identity no longer matches", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { entry } = makeMedia(dir, "a.bin", Buffer.from("hello"));
  const stale = Object.assign({}, entry, { size: entry.size + 99 });
  const ctx = await startCore(t, { registry: { media: [stale], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: entry.mediaId, segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.detail, "identity-mismatch");
});

test("core refuses a media file above the size cap before reading it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sparse = path.join(dir, "big.bin");
  fs.writeFileSync(sparse, Buffer.alloc(1));
  fs.truncateSync(sparse, MAX_MEDIA_BYTES + 1);
  const stat = fs.statSync(sparse);
  const entry = { mediaId: "big", canonicalPath: sparse, digestKind: "bytes", sha256: "0".repeat(64), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  const ctx = await startCore(t, { registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: "big", segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.detail, "media-too-large");
});

test("core refuses a request with no segments", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { entry } = makeMedia(dir, "a.bin", Buffer.from("hello"));
  const ctx = await startCore(t, { registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: entry.mediaId, segmentIds: [] }, NOTE)),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.detail, "no-segments");
});

test("core stops a decode that exceeds the wall clock", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { entry } = makeMedia(dir, "a.bin", Buffer.from("hello"));
  const slow = path.join(dir, "slow-ffmpeg");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
  fs.chmodSync(slow, 0o755);
  const pcmEntry = Object.assign({}, entry, { digestKind: "pcm" });
  const ctx = await startCore(t, { registry: { media: [pcmEntry], note: NOTE }, ffmpegPath: slow, wallClockMs: 300 });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: pcmEntry.mediaId, segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.detail, "decode-timeout");
});

test("core enforces the body size limit and stops answering after close", async (t) => {
  const ctx = await startCore(t, {});
  const session = await openSession(ctx.port);
  const big = await request(ctx.port, {
    method: "POST", path: "/probe/report",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify({ pad: "x".repeat(80 * 1024) }),
  });
  assert.equal(big.status, 400);
  assert.equal(big.body.code, "E_CONTEXT");
});

test("core extracts from a registered bytes-pinned snapshot only", async (t) => {
  if (!fs.existsSync(REAL_FFMPEG)) { t.skip("ffmpeg not available"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, "tone.wav");
  const { spawnSync } = require("node:child_process");
  const gen = spawnSync(REAL_FFMPEG, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "-ar", "16000", wav]);
  assert.equal(gen.status, 0);
  const bytes = fs.readFileSync(wav);
  const stat = fs.statSync(wav);
  const entry = { mediaId: "tone", canonicalPath: wav, digestKind: "bytes", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  const ctx = await startCore(t, { ffmpegPath: REAL_FFMPEG, registry: { media: [entry], note: NOTE } });
  const session = await openSession(ctx.port);
  const res = await request(ctx.port, {
    method: "POST", path: "/probe/extract",
    headers: headers(ctx.port, { "X-Probe-Token": session.token, "Content-Type": "application/json" }),
    body: JSON.stringify(Object.assign({ mediaId: "tone", segmentIds: ["seg:0"] }, NOTE)),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mediaSha256Match, true);
  assert.equal(res.body.runId, session.runId);
  assert.equal(res.body.sessionId, session.sessionId);
  assert.ok(res.body.snapshotPath.startsWith(ctx.outDir));
  assert.ok(res.body.nonSilent === true);
  const mode = fs.statSync(res.body.snapshotPath).mode & 0o777;
  assert.equal(mode, 0o600);
});
