"use strict";

// Audio8 契约夹具：按实际安装结构构造 manifest、声音元数据、PCM16 WAV 与本地 HTTP 服务。
// 只服务 test/audio8-backend.test.js；不读取真实安装目录，也不写产品目录。

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const AUDIO8_MODEL_FINGERPRINT =
  "62dcff0adf6c2535b3260467a7c1d482b556da57266c96a444518b76e140d2c3";
const AUDIO8_SAMPLE_RATE = 44100;

function makeTempDir(prefix = "memo-audio8-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 对应 model/runtime_manifest.json 中与本适配器相关的字段。
function makeManifest(overrides = {}) {
  return {
    model_family: "audio8_tts",
    num_codebooks: 10,
    sample_rate: AUDIO8_SAMPLE_RATE,
    model_fingerprint: AUDIO8_MODEL_FINGERPRINT,
    default_precision: "int4",
    available_precisions: ["int4"],
    default_codec_precision: "fp16",
    available_codec_precisions: ["fp16"],
    ...overrides,
  };
}

// 对应 voices/<name>/meta.json 的实际字段。
function makeVoiceMeta(overrides = {}) {
  return {
    name: "professor_jiang_clean2",
    reference_text: "这是参考原文。",
    shape: [10, 210],
    dtype: "uint16",
    sample_rate: AUDIO8_SAMPLE_RATE,
    source_audio: "reference_segment.wav",
    source_sample_rate: AUDIO8_SAMPLE_RATE,
    source_sha256: "b".repeat(64),
    model_fingerprint: AUDIO8_MODEL_FINGERPRINT,
    created_at: "2026-09-01T12:02:45.709265+00:00",
    source_kind: "web_registration",
    ...overrides,
  };
}

// 生成带时间变化的 PCM16 WAV（parseWav 会拒绝恒定波形，所以样本必须随帧变化）。
function makePcm16Wav({ sampleRate = AUDIO8_SAMPLE_RATE, channels = 1, frames = 600, seed = 1 } = {}) {
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.round(18000 * Math.sin((frame + seed) / 9));
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

const DEFAULT_HEALTH = Object.freeze({
  ok: true,
  precision: "int4",
  codec_precision: "fp16",
  providers: {
    slow: ["CPUExecutionProvider"],
    fast: ["CPUExecutionProvider"],
    decoder: ["CPUExecutionProvider"],
  },
});

// 搭建隔离安装目录：model/runtime_manifest.json + voices/<name>/meta.json。
function makeInstallDir({ manifestOverrides = {}, metaOverrides = {} } = {}) {
  const installRoot = makeTempDir();
  const modelDir = path.join(installRoot, "model");
  const voicesRoot = path.join(installRoot, "voices");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(voicesRoot, { recursive: true });

  const manifest = makeManifest(manifestOverrides);
  const manifestPath = path.join(modelDir, "runtime_manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const meta = makeVoiceMeta(metaOverrides);
  writeVoiceMeta(voicesRoot, meta);

  return { installRoot, modelDir, voicesRoot, manifestPath, manifest, meta };
}

function writeVoiceMeta(voicesRoot, meta) {
  const dir = path.join(voicesRoot, String(meta.name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

// 与安装 registration.py 的 " ".join(text.strip().split()) 等价的空白规范化。
function normalizeWhitespace(text) {
  return String(text === undefined || text === null ? "" : text)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

// 解析 multipart/form-data：只用于测试夹具，逐段切分并保留字段名与内容。
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) {
    return null;
  }
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const segments = [];
  let start = 0;
  for (;;) {
    const index = body.indexOf(boundary, start);
    if (index === -1) {
      break;
    }
    segments.push(body.slice(start, index));
    start = index + boundary.length;
  }
  const parts = [];
  for (const raw of segments) {
    if (raw.length === 0) {
      continue;
    }
    const trimmed = raw.slice(raw.indexOf("\r\n") + 2);
    if (trimmed.slice(0, 2).toString("utf8") === "--") {
      continue;
    }
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }
    const headerText = trimmed.slice(0, headerEnd).toString("utf8");
    let content = trimmed.slice(headerEnd + 4);
    if (content.slice(content.length - 2).toString("utf8") === "\r\n") {
      content = content.slice(0, content.length - 2);
    }
    const nameMatch = /name="([^"]*)"/.exec(headerText);
    const fileMatch = /filename="([^"]*)"/.exec(headerText);
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: fileMatch ? fileMatch[1] : null,
      content,
    });
  }
  return parts;
}

function summarizeRegisterFields(fields) {
  const read = (fieldName) => (fields || []).find((entry) => entry.name === fieldName) || null;
  const audio = read("audio");
  const text = read("text");
  const name = read("name");
  const overwrite = read("overwrite");
  return {
    audioFilename: audio ? audio.filename : null,
    audioLength: audio ? audio.content.length : 0,
    audioSha256: audio ? crypto.createHash("sha256").update(audio.content).digest("hex") : null,
    text: text ? text.content.toString("utf8") : null,
    name: name ? name.content.toString("utf8") : null,
    overwrite: overwrite ? overwrite.content.toString("utf8") : null,
  };
}

// 本地真实 HTTP 服务：按安装契约实现 /api/health、/api/voices、/api/memo/runtime、POST /api/tts。
// runtime 传 null 表示裸服务缺少身份接口；synthesize 可返回 {status, body, delayMs, hang}。
function startAudio8Server(config = {}) {
  const state = {
    requests: [],
    calls: { health: 0, voices: 0, runtime: 0, tts: 0, register: 0 },
    ttsBodies: [],
    registerDetails: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, path: req.url, body });

      // 同步门闩：让用例在适配器 await 期间改写调用方对象。
      if (typeof config.onRequest === "function") {
        config.onRequest(state, req.method, req.url);
      }

      const sendJson = (payload, status = 200) => {
        const text = Buffer.from(JSON.stringify(payload), "utf8");
        res.writeHead(status, { "content-type": "application/json", "content-length": text.length });
        res.end(text);
      };
      const sendAudio = (payload, status = 200, contentType = "audio/wav") => {
        res.writeHead(status, { "content-type": contentType, "content-length": payload.length });
        res.end(payload);
      };

      if (req.method === "GET" && req.url === "/api/health") {
        state.calls.health += 1;
        if (config.health === null) {
          return sendJson({ detail: "Not Found" }, 404);
        }
        return sendJson(config.health || DEFAULT_HEALTH);
      }

      if (req.method === "GET" && req.url === "/api/voices") {
        state.calls.voices += 1;
        if (config.voices === null) {
          return sendJson({ detail: "Not Found" }, 404);
        }
        const voices = config.voices === undefined ? [makeVoiceMeta()] : config.voices;
        return sendJson({ voices });
      }

      if (req.method === "GET" && req.url === "/api/memo/runtime") {
        state.calls.runtime += 1;
        if (config.runtime === null) {
          return sendJson({ detail: "Not Found" }, 404);
        }
        return sendJson(config.runtime);
      }

      if (req.method === "POST" && req.url === "/api/tts") {
        state.calls.tts += 1;
        let parsed = null;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          parsed = null;
        }
        state.ttsBodies.push(parsed);

        const plan =
          typeof config.synthesize === "function"
            ? config.synthesize(parsed, state.calls.tts)
            : { status: 200, body: makePcm16Wav({ seed: state.calls.tts }) };

        if (plan && plan.hang) {
          return undefined;
        }
        const status = plan && plan.status !== undefined ? plan.status : 200;
        const payload = plan && plan.body ? plan.body : Buffer.from("error", "utf8");
        const emit = () => {
          if (status === 200) {
            return sendAudio(payload, status);
          }
          return sendAudio(payload, status, "application/json");
        };
        if (plan && plan.delayMs) {
          setTimeout(emit, plan.delayMs);
          return undefined;
        }
        return emit();
      }

      // 真实安装契约：POST /api/voices/register 为 multipart(audio/text/name/overwrite)，
      // 成功写自有 voicesRoot 下的 meta 并重建 runtime，返回 {ok:true,voice:meta}。
      if (req.method === "POST" && req.url === "/api/voices/register") {
        state.calls.register += 1;
        const reg = config.register || {};
        const fields = parseMultipart(body, req.headers["content-type"] || "");
        state.registerDetails.push(summarizeRegisterFields(fields));

        if (reg.hang) {
          return undefined;
        }
        if (reg.status && reg.status >= 400) {
          return sendJson(reg.body || { detail: "register rejected" }, reg.status);
        }

        const find = (fieldName) => (fields || []).find((entry) => entry.name === fieldName) || null;
        const audioPart = find("audio");
        const textPart = find("text");
        const namePart = find("name");
        const voiceName = namePart ? namePart.content.toString("utf8") : "";
        const rawText = textPart ? textPart.content.toString("utf8") : "";
        // 默认按安装 registration.py 的真实语义生成 meta：name=请求名，reference_text 空白规范化，
        // source_sha256=上传字节摘要。reg.metaOverrides / reg.responseVoice 供负例注入不一致。
        const meta = makeVoiceMeta({
          name: voiceName,
          reference_text: normalizeWhitespace(rawText),
          source_sha256: audioPart
            ? crypto.createHash("sha256").update(audioPart.content).digest("hex")
            : "0".repeat(64),
          source_audio: audioPart && audioPart.filename ? path.basename(audioPart.filename) : "reference_audio",
          ...(reg.metaOverrides || {}),
        });

        if (reg.voicesRoot) {
          // 实际服务按请求 name 建目录（target = voices_root / voice_name），此处如实复刻。
          const voiceDir = path.join(reg.voicesRoot, voiceName);
          fs.mkdirSync(voiceDir, { recursive: true });
          fs.writeFileSync(path.join(voiceDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        }
        if (Array.isArray(config.voices)) {
          config.voices.push(meta);
        }
        if (reg.runtimeAfter) {
          config.runtime = reg.runtimeAfter;
        }
        state.lastRegisterAudioBytes = audioPart ? audioPart.content.length : 0;
        const responseVoice = reg.responseMetaOverrides
          ? { ...meta, ...reg.responseMetaOverrides }
          : meta;
        return sendJson({ ok: true, voice: responseVoice });
      }

      return sendJson({ detail: "unexpected path" }, 404);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        state,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = {
  AUDIO8_MODEL_FINGERPRINT,
  AUDIO8_SAMPLE_RATE,
  DEFAULT_HEALTH,
  makeTempDir,
  makeManifest,
  makeVoiceMeta,
  makePcm16Wav,
  makeInstallDir,
  writeVoiceMeta,
  startAudio8Server,
};
