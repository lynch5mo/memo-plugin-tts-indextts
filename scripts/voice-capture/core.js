"use strict";
// fixture 专用本地核心（架构契约版）。
// 授权与比对分离：App 只能提交注册过的 mediaId 加文稿三元组，永远不能指定路径或 URL。
// 登记来自主控核准的 registry 文件，前端不能新增或修改；核心先匹配会话、三元组、mediaId，再碰文件系统。
// 路径一律 O_NOFOLLOW 打开，核对 dev/ino/size/mtime，再从同一 fd 有界复制到自有 0600 快照，只解码快照。
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const WALL_CLOCK_MS = 30 * 1000;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function json(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  }, headers || {}));
  res.end(body);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Probe-Token",
    "Access-Control-Max-Age": "0",
    Vary: "Origin",
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) { overflow = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) { reject(Object.assign(new Error("body too large"), { code: "E_CONTEXT" })); return; }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => reject(Object.assign(err, { code: "E_CONTEXT" })));
  });
}

function summarizePcm(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return { peak: peak, nonSilent: peak > 32 };
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createCore(options) {
  const port = options.port;
  const ffmpegPath = options.ffmpegPath;
  const expected = options.expected;
  const outDir = options.outDir;
  const allowOrigins = Array.isArray(options.allowOrigin) ? options.allowOrigin.slice() : [];
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const bodyLimit = options.bodyLimit || DEFAULT_BODY_LIMIT;
  const wallClockMs = options.wallClockMs || WALL_CLOCK_MS;
  const expectedHost = "127.0.0.1:" + port;
  const eventsPath = options.eventsPath || path.join(outDir, "core-events.jsonl");
  const snapshotDir = path.join(outDir, "snapshots");
  const registry = options.registry || { media: [], note: null };
  const coreSourceHash = options.coreSourceHash || null;
  const appArtifactHash = options.appArtifactHash || null;
  const fixtureManifestHash = options.fixtureManifestHash || null;
  const failOnLogError = options.failOnLogError !== false;
  const runNonce = options.runNonce || crypto.randomBytes(16).toString("hex");
  const sessions = new Map();
  const state = { reports: [], observedOrigins: [], extracts: [], runNonce: runNonce, logFailures: 0 };
  let runCounter = 0;
  let seq = 0;

  function now() { return new Date().toISOString(); }

  // 事件日志写失败必须阻止完成：记录失败计数，后续再过闸时直接判失败。
  function log(event) {
    seq += 1;
    const record = Object.assign({ seq: seq, at: now(), fixtureManifestHash: fixtureManifestHash, coreSourceHash: coreSourceHash }, event);
    try {
      fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
      fs.appendFileSync(eventsPath, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      state.logFailures += 1;
    }
  }

  function provenance() {
    const record = {
      schemaVersion: 2,
      nonce: runNonce,
      pid: process.pid,
      port: port,
      startedAt: now(),
      fixtureId: expected.fixtureId,
      fixtureManifestHash: fixtureManifestHash,
      coreSourceHash: coreSourceHash,
      appArtifactHash: appArtifactHash,
      registeredMediaIds: (registry.media || []).map((m) => m.mediaId),
      logFailures: state.logFailures,
    };
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "core-provenance.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch {
      state.logFailures += 1;
    }
    return record;
  }
  provenance();

  function originDecision(req) {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    if (origin === null) return { ok: false, code: "E_ORIGIN", reason: "missing-origin" };
    if (origin === "null") return { ok: false, code: "E_ORIGIN", reason: "null-origin" };
    if (allowOrigins.includes(origin)) return { ok: true, origin: origin };
    if (!state.observedOrigins.includes(origin)) {
      state.observedOrigins.push(origin);
      log({ type: "origin-observed", origin: origin });
    }
    return { ok: false, code: "E_ORIGIN", reason: "origin-not-allowed", observed: origin };
  }

  function issueSession(origin) {
    runCounter += 1;
    const token = crypto.randomBytes(24).toString("base64url");
    const sessionId = "sess-" + runCounter;
    const entry = {
      runId: "run-" + runCounter,
      sessionId: sessionId,
      origin: origin,
      expiresAt: Date.now() + ttlMs,
      note: registry.note || null,
    };
    sessions.set(token, entry);
    log({ type: "session-issued", runId: entry.runId, sessionId: sessionId, origin: origin });
    return { token: token, runId: entry.runId, ttlMs: ttlMs, nonce: runNonce, port: port, sessionId: sessionId };
  }

  function checkToken(req) {
    const raw = req.headers["x-probe-token"];
    const token = typeof raw === "string" ? raw : "";
    const entry = sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { sessions.delete(token); return null; }
    return entry;
  }

  function extractRange(segmentIds) {
    const byId = new Map((expected.timeline || []).map((s) => [s.id, s]));
    const picked = [];
    for (const id of segmentIds) {
      const seg = byId.get(id);
      if (!seg) return { ok: false, code: "E_CONTEXT", reason: "unknown-segment" };
      picked.push(seg);
    }
    if (picked.length === 0) return { ok: false, code: "E_CONTEXT", reason: "no-segments" };
    const startMs = Math.max(0, Math.min.apply(null, picked.map((s) => s.startMs)));
    const endMs = Math.max.apply(null, picked.map((s) => s.endMs));
    return { ok: true, startMs: startMs, endMs: Math.min(endMs, startMs + wallClockMs), segmentCount: picked.length };
  }

  function extractArgv(snapshotPath, range) {
    return [
      ffmpegPath, "-hide_banner", "-nostdin", "-y",
      "-ss", (range.startMs / 1000).toFixed(3),
      "-t", ((range.endMs - range.startMs) / 1000).toFixed(3),
      "-i", snapshotPath,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-",
    ];
  }

  function decodeSnapshotArgv(snapshotPath) {
    return [ffmpegPath, "-hide_banner", "-nostdin", "-y", "-i", snapshotPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "-"];
  }

  // 只解码自有快照，永不对原路径二次打开。
  function canonicalDigest(snapshotPath) {
    const argv = decodeSnapshotArgv(snapshotPath);
    const res = spawnSync(argv[0], argv.slice(1), { maxBuffer: MAX_OUTPUT_BYTES, timeout: wallClockMs });
    if (res.error && res.error.code === "ETIMEDOUT") return { ok: false, reason: "decode-timeout" };
    if (res.error) return { ok: false, reason: "decode-error" };
    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) return { ok: false, reason: "decode-status" };
    if (res.stdout.length > MAX_OUTPUT_BYTES) return { ok: false, reason: "decode-over-limit" };
    return { ok: true, sha256: sha256Buffer(res.stdout), bytes: res.stdout.length };
  }

  // 有界复制：仅从已校验的 fd 读取，写入自有 0600 快照。
  function copyFromFd(fd, dest, expectedSize) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.openSync(dest, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
    try {
      const buffer = Buffer.alloc(1 << 20);
      let total = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, total);
        if (read <= 0) break;
        total += read;
        if (total > MAX_MEDIA_BYTES) { throw Object.assign(new Error("too large"), { code: "E_MEDIA" }); }
        fs.writeSync(out, buffer, 0, read);
      }
      if (total !== expectedSize) throw Object.assign(new Error("size changed"), { code: "E_MEDIA" });
      return total;
    } finally {
      fs.closeSync(out);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = req.method + " " + url.pathname;
    const cors = (origin) => corsHeaders(origin);

    if (req.headers.host !== expectedHost) {
      log({ type: "host-rejected", host: req.headers.host || null, route: route });
      return json(res, 421, { ok: false, code: "E_ORIGIN", detail: "host" });
    }

    const decision = originDecision(req);
    if (req.method === "OPTIONS") {
      if (!decision.ok) return json(res, 403, { ok: false, code: "E_ORIGIN", detail: decision.reason });
      res.writeHead(204, cors(decision.origin));
      return res.end();
    }
    if (!decision.ok) {
      log({ type: "origin-rejected", route: route, reason: decision.reason });
      return json(res, 403, { ok: false, code: "E_ORIGIN", detail: decision.reason });
    }

    if (route === "GET /probe/session") {
      const issued = issueSession(decision.origin);
      return json(res, 200, { ok: true, runId: issued.runId, sessionId: issued.sessionId, ttlMs: issued.ttlMs, token: issued.token, nonce: issued.nonce, port: issued.port }, cors(decision.origin));
    }

    const session = checkToken(req);
    if (!session) {
      log({ type: "token-rejected", route: route });
      return json(res, 401, { ok: false, code: "E_CONTEXT", detail: "token" }, cors(decision.origin));
    }
    const sess = { runId: session.runId, sessionId: session.sessionId };

    if (route === "GET /probe/expected") {
      return json(res, 200, {
        fixtureId: expected.fixtureId,
        originalText: expected.originalText,
        translationText: expected.translationText,
        timeline: expected.timeline,
        durationMs: expected.durationMs,
        mediaId: (registry.media || []).length === 1 ? registry.media[0].mediaId : null,
      }, cors(decision.origin));
    }

    if (route === "POST /probe/report") {
      let body;
      try {
        body = JSON.parse(await readBody(req, bodyLimit));
      } catch (err) {
        return json(res, 400, { ok: false, code: err.code || "E_CONTEXT", detail: "body" }, cors(decision.origin));
      }
      const record = { at: now(), runId: sess.runId, sessionId: sess.sessionId, records: body.records || [] };
      state.reports.push(record);
      log({ type: "report", runId: sess.runId, sessionId: sess.sessionId, steps: record.records.map((r) => ({ step: r.step, ok: r.ok, code: r.code })) });
      return json(res, 200, { ok: true, runId: sess.runId, sessionId: sess.sessionId }, cors(decision.origin));
    }

    if (route === "POST /probe/extract") {
      let body;
      try {
        body = JSON.parse(await readBody(req, bodyLimit));
      } catch (err) {
        return json(res, 400, { ok: false, code: err.code || "E_CONTEXT", detail: "body" }, cors(decision.origin));
      }
      const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
      const triple = { noteId: body.noteId, workspaceId: body.workspaceId, folderId: body.folderId };
      const wantNote = session.note;
      if (wantNote) {
        const mismatch = ["noteId", "workspaceId", "folderId"].find((k) => wantNote[k] !== undefined && wantNote[k] !== triple[k]);
        if (mismatch) {
          log({ type: "extract-note-mismatch", runId: sess.runId, sessionId: sess.sessionId, field: mismatch });
          return json(res, 403, { ok: false, code: "E_CONTEXT", detail: "note-triple-mismatch", field: mismatch }, cors(decision.origin));
        }
      }
      const entry = (registry.media || []).find((m) => m.mediaId === mediaId);
      if (!entry) {
        log({ type: "extract-media-unregistered", runId: sess.runId, sessionId: sess.sessionId, mediaId: mediaId });
        return json(res, 403, { ok: false, code: "E_MEDIA", detail: "media-not-registered" }, cors(decision.origin));
      }
      const range = extractRange(Array.isArray(body.segmentIds) ? body.segmentIds : []);
      if (!range.ok) return json(res, 400, { ok: false, code: range.code, detail: range.reason }, cors(decision.origin));

      const canonicalPath = entry.canonicalPath;
      if (typeof canonicalPath !== "string" || !path.isAbsolute(canonicalPath) || canonicalPath.indexOf("://") >= 0 || canonicalPath.indexOf("\u0000") >= 0) {
        return json(res, 400, { ok: false, code: "E_MEDIA", detail: "registration-invalid" }, cors(decision.origin));
      }

      let fd;
      try {
        fd = fs.openSync(canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      } catch (err) {
        log({ type: "extract-open-failed", runId: sess.runId, sessionId: sess.sessionId, code: err.code || null });
        return json(res, 403, { ok: false, code: "E_MEDIA", detail: "open-refused" }, cors(decision.origin));
      }
      try {
        const before = fs.fstatSync(fd);
        if (!before.isFile()) return json(res, 400, { ok: false, code: "E_MEDIA", detail: "not-regular" }, cors(decision.origin));
        const identity = { dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs };
        const mismatch = Object.keys(identity).find((k) => identity[k] !== undefined && identity[k] !== before[k]);
        if (mismatch) {
          log({ type: "extract-identity-mismatch", runId: sess.runId, sessionId: sess.sessionId, field: mismatch });
          return json(res, 409, { ok: false, code: "E_MEDIA", detail: "identity-mismatch", field: mismatch }, cors(decision.origin));
        }
        if (before.size <= 0) return json(res, 400, { ok: false, code: "E_MEDIA", detail: "empty" }, cors(decision.origin));
        if (before.size > MAX_MEDIA_BYTES) return json(res, 413, { ok: false, code: "E_MEDIA", detail: "media-too-large" }, cors(decision.origin));

        const snapshotPath = path.join(snapshotDir, entry.mediaId + ".snapshot");
        let bytes;
        try {
          bytes = copyFromFd(fd, snapshotPath, before.size);
        } catch (err) {
          return json(res, 409, { ok: false, code: "E_MEDIA", detail: err.code === "E_MEDIA" ? "snapshot-size-changed" : "snapshot-failed" }, cors(decision.origin));
        }
        const after = fs.fstatSync(fd);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          log({ type: "extract-identity-changed", runId: sess.runId, sessionId: sess.sessionId });
          return json(res, 409, { ok: false, code: "E_MEDIA", detail: "identity-changed-after-copy" }, cors(decision.origin));
        }

        const snapshotBytes = fs.readFileSync(snapshotPath);
        const snapshotByteHash = sha256Buffer(snapshotBytes);
        let digest;
        if (entry.digestKind === "bytes") {
          digest = { ok: snapshotByteHash === entry.sha256, sha256: snapshotByteHash, reason: "byte-mismatch" };
          if (!digest.ok) {
            log({ type: "extract-bytes-mismatch", runId: sess.runId, sessionId: sess.sessionId });
            return json(res, 422, { ok: false, code: "E_MEDIA", detail: "media-pin-mismatch", digestKind: "bytes" }, cors(decision.origin));
          }
        } else {
          digest = canonicalDigest(snapshotPath);
          if (!digest.ok) {
            log({ type: "extract-decode-failed", runId: sess.runId, sessionId: sess.sessionId, reason: digest.reason });
            return json(res, 422, { ok: false, code: "E_MEDIA", detail: digest.reason }, cors(decision.origin));
          }
          if (!entry.sha256 || digest.sha256 !== entry.sha256) {
            log({ type: "extract-pcm-mismatch", runId: sess.runId, sessionId: sess.sessionId });
            return json(res, 422, { ok: false, code: "E_MEDIA", detail: "media-pin-mismatch", digestKind: "pcm" }, cors(decision.origin));
          }
        }

        const argv = extractArgv(snapshotPath, range);
        const cut = spawnSync(argv[0], argv.slice(1), { maxBuffer: MAX_OUTPUT_BYTES, timeout: wallClockMs });
        if (cut.error && cut.error.code === "ETIMEDOUT") {
          return json(res, 500, { ok: false, code: "E_MEDIA", detail: "extract-timeout" }, cors(decision.origin));
        }
        if (cut.status !== 0 || !cut.stdout || cut.stdout.length === 0) {
          return json(res, 500, { ok: false, code: "E_MEDIA", detail: "extract-failed" }, cors(decision.origin));
        }
        const stats = summarizePcm(cut.stdout.subarray(44));
        const result = {
          ok: true,
          mediaId: entry.mediaId,
          bytes: cut.stdout.length,
          durationSec: Number(((range.endMs - range.startMs) / 1000).toFixed(3)),
          sha256: sha256Buffer(cut.stdout),
          mediaByteSha256: snapshotByteHash,
          digestKind: entry.digestKind || "pcm",
          snapshotPath: snapshotPath,
          mediaSha256Match: true,
          nonSilent: stats.nonSilent,
          peak: stats.peak,
          segmentCount: range.segmentCount,
          runId: sess.runId,
          sessionId: sess.sessionId,
        };
        state.extracts.push(result);
        log({ type: "extract-ok", runId: sess.runId, sessionId: sess.sessionId, mediaId: entry.mediaId, bytes: result.bytes, sha256: result.sha256, mediaByteSha256: snapshotByteHash, nonSilent: result.nonSilent });
        return json(res, 200, result, cors(decision.origin));
      } finally {
        fs.closeSync(fd);
      }
    }

    return json(res, 404, { ok: false, code: "E_CONTEXT", detail: "route" }, cors(decision.origin));
  });

  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  return { server: server, state: state, eventsPath: eventsPath, expectedHost: expectedHost, provenance: provenance };
}

module.exports = {
  createCore: createCore,
  DEFAULT_BODY_LIMIT: DEFAULT_BODY_LIMIT,
  MAX_MEDIA_BYTES: MAX_MEDIA_BYTES,
  WALL_CLOCK_MS: WALL_CLOCK_MS,
};
