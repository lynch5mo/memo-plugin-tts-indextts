"use strict";

// Task 2A 只读目录测试夹具：构造结构与引用都自洽的目录数据与临时目录。
// 夹具不写入产品目录，只服务 test/catalog.test.js 的隔离读取场景。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AUDIO8_MANIFEST =
  "/Users/lynch5mo/Applications/Audio8_TTS/onnx_runtime/model/runtime_manifest.json";
const AUDIO8_VOICES_ROOT = "/Users/lynch5mo/Applications/Audio8_TTS/onnx_runtime/voices";

// 64 位十六进制 SHA-256 形状的占位指纹，用于 ready 的 Audio8 绑定。
const AUDIO8_VOICE_FINGERPRINT = "3f".repeat(32);

// 合法的嵌套 __proto__ 自有数据键（第三方目录可能出现），用于验证读取与快照不篡改原型、不丢数据。
function nestedProtoMetadata() {
  return JSON.parse('{"__proto__":{"kept":"yes"}}');
}

function makeAudio8Endpoint(overrides = {}) {
  return {
    id: "ep-audio8",
    backendId: "audio8",
    baseUrl: "http://127.0.0.1:8799",
    modelFingerprint: "fp-audio8-001",
    readiness: "ready",
    runtimeManifestPath: AUDIO8_MANIFEST,
    voicesRoot: AUDIO8_VOICES_ROOT,
    precision: "fp32",
    codecPrecision: "fp32",
    ...overrides,
  };
}

function makeGptSovitsEndpoint(overrides = {}) {
  return {
    id: "ep-gptsovits",
    backendId: "gpt-sovits",
    baseUrl: "http://127.0.0.1:9880",
    modelFingerprint: "fp-gptsovits-001",
    readiness: "ready",
    ...overrides,
  };
}

function makeSavedProfile(overrides = {}) {
  return {
    id: "profile-lin",
    label: "讲师林",
    persistence: "saved",
    source: {
      audioPath: "/Users/lynch5mo/Applications/Audio8_TTS/refs/lin.wav",
      referenceText: "这是参考原文。",
      language: "zh",
    },
    owner: "memo-local-tts",
    ...overrides,
  };
}

function makeAudio8Binding(overrides = {}) {
  return {
    id: "binding-lin-audio8",
    profileId: "profile-lin",
    backendId: "audio8",
    endpointId: "ep-audio8",
    nativeVoiceId: "lin",
    modelFingerprint: "fp-audio8-001",
    revision: 1,
    status: "ready",
    params: {},
    nativeVoiceFingerprint: AUDIO8_VOICE_FINGERPRINT,
    ...overrides,
  };
}

function makeGptSovitsBinding(overrides = {}) {
  return {
    id: "binding-lin-gptsovits",
    profileId: "profile-lin",
    backendId: "gpt-sovits",
    endpointId: "ep-gptsovits",
    nativeVoiceId: "lin",
    modelFingerprint: "fp-gptsovits-001",
    revision: 3,
    status: "ready",
    params: { speed_factor: 1 },
    ...overrides,
  };
}

function makeCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoints: [makeAudio8Endpoint(), makeGptSovitsEndpoint()],
    profiles: [makeSavedProfile()],
    bindings: [makeAudio8Binding(), makeGptSovitsBinding()],
    ...overrides,
  };
}

function makeTempDir(prefix = "memo-catalog-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCatalogFile(dir, catalog, name = "catalog.json") {
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(catalog, null, 2), "utf8");
  return target;
}

module.exports = {
  AUDIO8_MANIFEST,
  AUDIO8_VOICES_ROOT,
  AUDIO8_VOICE_FINGERPRINT,
  nestedProtoMetadata,
  makeAudio8Endpoint,
  makeGptSovitsEndpoint,
  makeSavedProfile,
  makeAudio8Binding,
  makeGptSovitsBinding,
  makeCatalog,
  makeTempDir,
  writeCatalogFile,
};
