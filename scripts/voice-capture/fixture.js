"use strict";
// 受限 fixture 制备：只用自有 WAV + 固定 argv 生成本地验证素材。
// 不下载、不调用外部 API、不做 ASR 或翻译；原文与译文由调用方给出并写入预期清单。
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CANONICAL_PCM = Object.freeze({ channels: 1, sampleRate: 16000, format: "s16le" });

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let read;
    do {
      read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read > 0) hash.update(buf.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// core 与 fixture 共用的 canonical PCM 提取 argv：前端永远不能提供其中任何一项。
function canonicalPcmArgv(ffmpegPath, mediaPath) {
  return [
    ffmpegPath,
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    mediaPath,
    "-vn",
    "-ac",
    String(CANONICAL_PCM.channels),
    "-ar",
    String(CANONICAL_PCM.sampleRate),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "-",
  ];
}

// 静态画面 MP4：单帧纯色加原音频，音频长度保持不变，不拼接、不凑 10 秒。
function buildMediaArgv(ffmpegPath, sourceWav, outMp4) {
  return [
    ffmpegPath,
    "-hide_banner",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x101418:s=640x360:r=10",
    "-i",
    sourceWav,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outMp4,
  ];
}

function readDurationSec(ffmpegPath, mediaPath) {
  const probe = spawnSync(ffmpegPath, ["-hide_banner", "-nostdin", "-i", mediaPath], {
    encoding: "utf8",
  });
  const text = String(probe.stderr || "");
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const DEFAULT_DECODE_TIMEOUT_MS = 20000;
const DEFAULT_DECODE_MAX_BYTES = 64 * 1024 * 1024;

// 有界解码：既限字节也限时间，超时或超限一律返回失败原因，绝不无限解码。
function canonicalPcmDigest(ffmpegPath, mediaPath, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_DECODE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_DECODE_MAX_BYTES;
  const argv = canonicalPcmArgv(ffmpegPath, mediaPath);
  const res = spawnSync(argv[0], argv.slice(1), { maxBuffer: maxBytes, timeout: timeoutMs });
  if (res.error && res.error.code === "ETIMEDOUT") {
    return { ok: false, reason: "decode-timeout", timeoutMs: timeoutMs };
  }
  if (res.error) {
    return { ok: false, reason: "decode-error", code: res.error.code || null };
  }
  if (res.status !== 0) {
    return { ok: false, reason: "decode-status", status: res.status };
  }
  if (!res.stdout || res.stdout.length === 0) {
    return { ok: false, reason: "decode-empty" };
  }
  if (res.stdout.length > maxBytes) {
    return { ok: false, reason: "decode-over-limit", maxBytes: maxBytes };
  }
  return { ok: true, sha256: crypto.createHash("sha256").update(res.stdout).digest("hex"), bytes: res.stdout.length };
}

function canonicalPcmSha256(ffmpegPath, mediaPath, options) {
  const digest = canonicalPcmDigest(ffmpegPath, mediaPath, options);
  return digest.ok ? digest.sha256 : null;
}

function buildExpected(options) {
  const durationMs = Math.round(options.durationSec * 1000);
  return {
    schemaVersion: 1,
    fixtureId: options.fixtureId,
    originalText: options.originalText,
    translationText: options.translationText,
    timeline: [
      {
        id: options.segmentId + ":0",
        startMs: 0,
        endMs: durationMs,
        text: options.originalText,
      },
    ],
    durationMs: durationMs,
    mediaSha256: options.mediaSha256 || null,
    pcmSha256: options.pcmSha256 || null,
    pcmCanonical: { channels: CANONICAL_PCM.channels, sampleRate: CANONICAL_PCM.sampleRate, format: CANONICAL_PCM.format },
    notes: options.notes || [],
  };
}

// 只生成计划，不落盘、不调用 ffmpeg，供单测与 CLI 复用。
function planFixture(options) {
  const outDir = path.resolve(options.outDir);
  const mediaPath = path.join(outDir, options.mediaName || "voice-capture-fixture.mp4");
  const expectedPath = path.join(outDir, options.expectedName || "voice-capture-expected.json");
  return {
    outDir: outDir,
    mediaPath: mediaPath,
    expectedPath: expectedPath,
    mediaArgv: buildMediaArgv(options.ffmpegPath, options.sourceWav, mediaPath),
  };
}

function buildFixture(options) {
  const plan = planFixture(options);
  fs.mkdirSync(plan.outDir, { recursive: true });
  const media = spawnSync(plan.mediaArgv[0], plan.mediaArgv.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (media.status !== 0) {
    const err = new Error("E_FIXTURE: ffmpeg media build failed");
    err.code = "E_FIXTURE";
    err.detail = { status: media.status, tail: String(media.stderr || "").slice(-400) };
    throw err;
  }
  const durationSec = readDurationSec(options.ffmpegPath, plan.mediaPath);
  const expected = buildExpected({
    fixtureId: options.fixtureId,
    segmentId: options.segmentId || "seg",
    originalText: options.originalText,
    translationText: options.translationText,
    durationSec: durationSec == null ? options.durationSec : durationSec,
    mediaSha256: sha256File(plan.mediaPath),
    pcmSha256: canonicalPcmSha256(options.ffmpegPath, plan.mediaPath),
    notes: options.notes,
  });
  fs.writeFileSync(plan.expectedPath, JSON.stringify(expected, null, 2) + "\n", "utf8");
  return { outDir: plan.outDir, mediaPath: plan.mediaPath, expectedPath: plan.expectedPath, expected: expected };
}

module.exports = {
  CANONICAL_PCM: CANONICAL_PCM,
  DEFAULT_DECODE_MAX_BYTES: DEFAULT_DECODE_MAX_BYTES,
  DEFAULT_DECODE_TIMEOUT_MS: DEFAULT_DECODE_TIMEOUT_MS,
  buildFixture: buildFixture,
  buildExpected: buildExpected,
  buildMediaArgv: buildMediaArgv,
  canonicalPcmDigest: canonicalPcmDigest,
  canonicalPcmArgv: canonicalPcmArgv,
  canonicalPcmSha256: canonicalPcmSha256,
  planFixture: planFixture,
  readDurationSec: readDurationSec,
  sha256File: sha256File,
};
