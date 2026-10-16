"use strict";

// 3A 入口夹具：把真实 Audio8 / GPT-SoVITS HTTP fixture 与真实 catalog.json 组合起来，
// 让 src/plugin.js 走完整链路（读目录 → 适配器 → loopback HTTP），不使用 mock 适配器。

const fs = require("node:fs");
const path = require("node:path");

const fxAudio8 = require("./audio8-fixture.js");
const fxGpt = require("./gpt-sovits-fixture.js");
const fxCatalog = require("./catalog-fixture.js");
const { voiceFingerprint } = require("../../src/voice-value.js");

// 已核对的宿主分类正则：命中就会自动再调用一次。
const HOST_RETRY_PATTERN = /429|RateLimit|timeout|ETIMEDOUT|ECONNRESET/i;

const GPT_MODEL_GROUP = "gpt-model-group-v2";

function writeDummyAudio(dir, name) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, fxAudio8.makePcm16Wav({ frames: 256 }));
  return target;
}

async function setupPluginEnv(options = {}) {
  const install = fxAudio8.makeInstallDir({ metaOverrides: options.metaOverrides });
  const audio8Server = await fxAudio8.startAudio8Server({
    health: options.health,
    voices: options.voices === undefined ? [install.meta] : options.voices,
    runtime:
      options.runtime === null
        ? null
        : {
            backendId: "audio8",
            modelFingerprint: install.manifest.model_fingerprint,
            modelDir: install.modelDir,
            voicesRoot: install.voicesRoot,
            precision: install.manifest.default_precision,
            codecPrecision: install.manifest.default_codec_precision,
            instanceId: "plugin-fixture-instance",
            ...(options.runtimeOverrides || {}),
          },
    synthesize: options.synthesize,
    onRequest: options.onRequest,
  });
  const gptServer = await fxGpt.startGptSovitsServer();

  const dir = fxCatalog.makeTempDir();
  const audio8Reference = writeDummyAudio(dir, "audio8-reference.wav");
  const gptReference = fxGpt.writeReferenceAudio(dir, { name: "gpt-reference.wav" });

  const catalog = {
    schemaVersion: 1,
    endpoints: [
      {
        id: "ep-audio8",
        backendId: "audio8",
        baseUrl: audio8Server.baseUrl,
        modelFingerprint: install.manifest.model_fingerprint,
        readiness: "ready",
        runtimeManifestPath: install.manifestPath,
        voicesRoot: install.voicesRoot,
        precision: install.manifest.default_precision,
        codecPrecision: install.manifest.default_codec_precision,
        ...(options.audio8EndpointExtra || {}),
      },
      {
        id: "ep-gpt",
        backendId: "gpt-sovits",
        baseUrl: gptServer.baseUrl,
        modelFingerprint: GPT_MODEL_GROUP,
        readiness: "ready",
      },
    ],
    profiles: [
      {
        id: "profile-audio8",
        label: "讲师林",
        persistence: "saved",
        source: { audioPath: audio8Reference, referenceText: "这是参考原文。", language: "zh" },
        owner: "memo-local-tts",
      },
      {
        id: "profile-gpt",
        label: "GPT讲师",
        persistence: "saved",
        source: { audioPath: gptReference, referenceText: "GPT 参考原文。", language: "zh" },
        owner: "memo-local-tts",
      },
    ],
    bindings: [
      {
        id: "binding-audio8-1",
        profileId: "profile-audio8",
        backendId: "audio8",
        endpointId: "ep-audio8",
        nativeVoiceId: install.meta.name,
        modelFingerprint: install.manifest.model_fingerprint,
        revision: 1,
        status: "ready",
        params: {},
        nativeVoiceFingerprint: voiceFingerprint(install.meta),
      },
      {
        id: "binding-gpt-1",
        profileId: "profile-gpt",
        backendId: "gpt-sovits",
        endpointId: "ep-gpt",
        nativeVoiceId: "gpt-reference.wav",
        modelFingerprint: GPT_MODEL_GROUP,
        revision: 4,
        status: "ready",
        params: {},
      },
    ],
  };

  const configuredCatalog =
    typeof options.mutateCatalog === "function"
      ? options.mutateCatalog(catalog, install)
      : options.catalog || catalog;
  const catalogPath = fxCatalog.writeCatalogFile(dir, configuredCatalog);

  const cleanup = async () => {
    await audio8Server.close();
    await gptServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(install.installRoot, { recursive: true, force: true });
  };

  return {
    install,
    dir,
    catalog: configuredCatalog,
    catalogPath,
    audio8Server,
    gptServer,
    audio8Endpoint: configuredCatalog.endpoints[0],
    gptEndpoint: configuredCatalog.endpoints.find((item) => item.backendId === "gpt-sovits"),
    audio8Binding: configuredCatalog.bindings[0],
    gptBinding: configuredCatalog.bindings.find((item) => item.backendId === "gpt-sovits"),
    cleanup,
  };
}

// 模拟已核对的宿主重试逻辑：失败字符串命中分类正则才会再调用一次。
async function simulateHostCall(invoke) {
  let calls = 0;
  let result = await invoke();
  calls += 1;
  if (typeof result === "string" && HOST_RETRY_PATTERN.test(result)) {
    result = await invoke();
    calls += 1;
  }
  return { calls, result };
}

module.exports = {
  HOST_RETRY_PATTERN,
  GPT_MODEL_GROUP,
  setupPluginEnv,
  simulateHostCall,
};
