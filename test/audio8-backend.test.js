"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const audio8 = require("../src/backends/audio8.js");
const { voiceFingerprint } = require("../src/voice-value.js");
const wav = require("../src/wav.js");
const text = require("../src/text.js");
const fx = require("./helpers/audio8-fixture.js");

const SHORT_TEXT = "你好，这是一段短文本。";

function assertErrorCode(fn, code) {
  return assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

// 内部同步防护入口用 assert.throws，避免把同步抛出误当成未拒绝的 Promise。
function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

async function setup(options = {}) {
  const install = fx.makeInstallDir({
    manifestOverrides: options.manifestOverrides,
    metaOverrides: options.metaOverrides,
  });

  const runtime =
    options.runtime === null
      ? null
      : {
          backendId: "audio8",
          modelFingerprint: install.manifest.model_fingerprint,
          modelDir: install.modelDir,
          voicesRoot: install.voicesRoot,
          precision: install.manifest.default_precision,
          codecPrecision: install.manifest.default_codec_precision,
          instanceId: "instance-fixture",
          ...(options.runtimeOverrides || {}),
        };

  const server = await fx.startAudio8Server({
    health: options.health,
    voices: options.voices === undefined ? [install.meta] : options.voices,
    runtime,
    synthesize: options.synthesize,
    onRequest: options.onRequest,
  });

  const endpoint = {
    id: "ep-audio8",
    backendId: "audio8",
    baseUrl: server.baseUrl,
    modelFingerprint: install.manifest.model_fingerprint,
    readiness: "ready",
    runtimeManifestPath: install.manifestPath,
    voicesRoot: install.voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    ...(options.endpointOverrides || {}),
  };

  const binding = {
    id: "binding-audio8-1",
    profileId: "profile-1",
    backendId: "audio8",
    endpointId: "ep-audio8",
    nativeVoiceId: install.meta.name,
    modelFingerprint: install.manifest.model_fingerprint,
    revision: 1,
    status: "ready",
    params: {},
    nativeVoiceFingerprint: voiceFingerprint(install.meta),
    ...(options.bindingOverrides || {}),
  };

  const profile = {
    id: "profile-1",
    label: "讲师",
    persistence: "saved",
    source: { referenceText: install.meta.reference_text, language: "zh" },
    owner: "memo-local-tts",
  };

  const cleanup = async () => {
    await server.close();
    fs.rmSync(install.installRoot, { recursive: true, force: true });
  };

  return { install, endpoint, binding, profile, server, cleanup };
}

async function withEnv(t, options, run) {
  const env = await setup(options);
  t.after(env.cleanup);
  return run(env);
}

test("capabilities 声明 Audio8 能力并与底座共享口径", () => {
  assert.equal(audio8.id, "audio8");
  const caps = audio8.capabilities;

  assert.equal(caps.segmentCodePoints, 120);
  assert.equal(caps.maxInputCodePoints, text.MAX_INPUT_CODE_POINTS);
  assert.equal(caps.maxContainerBytes, wav.MAX_CONTAINER_BYTES);
  assert.equal(wav.MAX_CONTAINER_BYTES, 128 * 1024 * 1024);
  assert.equal(caps.maxResponseBytes, 16 * 1024 * 1024);
  assert.equal(caps.supportsSpeed, false);
  assert.equal(caps.supportsEmotion, false);
  assert.equal(caps.supportsLanguageHint, false);
  assert.equal(caps.filtersVoicesByReferenceLanguage, false);
  assert.deepEqual(
    Object.keys(caps.samplingParameters).sort(),
    ["max_new_tokens", "seed", "temperature", "top_k", "top_p"],
  );
  assert.equal(caps.endpoints.synthesize, "/api/tts");
  assert.equal(caps.endpoints.runtimeIdentity, "/api/memo/runtime");

  const meta = fx.makeVoiceMeta();
  assert.equal(audio8.voiceFingerprint(meta), voiceFingerprint(meta));
});

test("probe 在 manifest、在线身份、健康与声音一致时报 verified", async (t) => {
  await withEnv(t, {}, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });

    assert.equal(result.ready, true);
    assert.equal(result.state, "verified");
    assert.equal(result.identity.backendId, "audio8");
    assert.equal(result.identity.modelFingerprint, fx.AUDIO8_MODEL_FINGERPRINT);
    assert.equal(result.identity.voicesRoot, env.install.voicesRoot);
    assert.equal(result.identity.instanceId, "instance-fixture");
    assert.equal(result.health.precision, "int4");
    assert.equal(env.server.state.calls.runtime, 1);
  });
});

test("probe 在服务不可达时标 unreachable", async (t) => {
  const dead = await fx.startAudio8Server({});
  const deadUrl = dead.baseUrl;
  await dead.close();

  await withEnv(t, {}, async (env) => {
    const result = await audio8.probe({ endpoint: { ...env.endpoint, baseUrl: deadUrl } });
    assert.equal(result.ready, false);
    assert.equal(result.state, "unreachable");
  });
});

test("probe 在裸服务缺少身份接口时标 unverified", async (t) => {
  await withEnv(t, { runtime: null }, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(result.state, "unverified");
    assert.match(result.reason, /身份/);
  });
});

test("probe 在在线指纹与本地 manifest 不一致时拒绝", async (t) => {
  await withEnv(t, { runtimeOverrides: { modelFingerprint: "0".repeat(64) } }, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(result.state, "mismatch");
  });
});

test("probe 在在线 modelDir 真实路径不一致时拒绝", async (t) => {
  const otherDir = fx.makeTempDir();
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));

  await withEnv(t, { runtimeOverrides: { modelDir: otherDir } }, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(result.state, "mismatch");
  });
});

test("probe 在在线 voicesRoot 真实路径不一致时拒绝", async (t) => {
  const otherDir = fx.makeTempDir();
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));

  await withEnv(t, { runtimeOverrides: { voicesRoot: otherDir } }, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(result.state, "mismatch");
  });
});

test("probe 在精度不一致时拒绝", async (t) => {
  const health = { ...fx.DEFAULT_HEALTH, precision: "fp16" };
  await withEnv(t, { health }, async (env) => {
    const result = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(result.state, "mismatch");
  });
});

test("probe 在本地 manifest 缺失或非法时报 manifestInvalid", async (t) => {
  await withEnv(t, {}, async (env) => {
    fs.rmSync(env.install.manifestPath);
    const missing = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(missing.ready, false);
    assert.equal(missing.state, "manifestInvalid");

    fs.writeFileSync(env.install.manifestPath, "{ not json", "utf8");
    const broken = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(broken.state, "manifestInvalid");
  });
});

test("probe 对非 loopback endpoint 直接按策略拒绝", async (t) => {
  await withEnv(t, {}, async (env) => {
    const endpoint = { ...env.endpoint, baseUrl: "http://10.1.2.3:8001" };
    await assertErrorCode(() => audio8.probe({ endpoint }), "ERR_ENDPOINT_NOT_LOOPBACK");
  });
});

test("synthesize 单段只发 text 与 voice_name，返回可用 PCM16 WAV", async (t) => {
  await withEnv(t, {}, async (env) => {
    const { audio } = await audio8.synthesize({
      endpoint: env.endpoint,
      binding: env.binding,
      profile: env.profile,
      text: SHORT_TEXT,
    });

    assert.ok(Buffer.isBuffer(audio));
    const parsed = wav.parseWav(audio);
    assert.equal(parsed.sampleRate, fx.AUDIO8_SAMPLE_RATE);
    assert.equal(parsed.channels, 1);
    assert.equal(env.server.state.calls.tts, 1);
    assert.equal(env.server.state.calls.runtime, 1, "每次合成前必须重新探测身份");
    assert.deepEqual(Object.keys(env.server.state.ttsBodies[0]).sort(), ["text", "voice_name"]);
    assert.equal(env.server.state.ttsBodies[0].voice_name, env.binding.nativeVoiceId);
  });
});

test("synthesize 按 120 code point 分段，post 正文原样且完整覆盖", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  await withEnv(t, {}, async (env) => {
    const segments = text.splitText(longText, 120);
    const nonBlank = segments.filter((segment) => segment.trim() !== "");
    assert.ok(segments.length > 1);

    await audio8.synthesize({
      endpoint: env.endpoint,
      binding: env.binding,
      profile: env.profile,
      text: longText,
    });

    assert.equal(env.server.state.calls.tts, nonBlank.length);
    assert.deepEqual(
      env.server.state.ttsBodies.map((body) => body.text),
      nonBlank,
    );
    assert.equal(nonBlank.join(""), longText);
    for (const body of env.server.state.ttsBodies) {
      assert.ok(Array.from(body.text).length <= 120);
    }
  });
});

test("synthesize 跳过纯空白分段但覆盖全部非空白文字", async (t) => {
  const spacedText = `${"甲".repeat(130)}${" ".repeat(130)}${"乙".repeat(130)}`;
  await withEnv(t, {}, async (env) => {
    const segments = text.splitText(spacedText, 120);
    const nonBlank = segments.filter((segment) => segment.trim() !== "");
    assert.ok(segments.length > nonBlank.length, "夹具应产出纯空白分段");

    await audio8.synthesize({
      endpoint: env.endpoint,
      binding: env.binding,
      profile: env.profile,
      text: spacedText,
    });

    assert.equal(env.server.state.calls.tts, nonBlank.length);
    assert.deepEqual(
      env.server.state.ttsBodies.map((body) => body.text),
      nonBlank,
    );
    assert.equal(
      nonBlank.join("").replace(/\s/g, ""),
      spacedText.replace(/\s/g, ""),
      "所有非空白文字必须原样顺序覆盖",
    );
  });
});

test("synthesize 只放行白名单采样参数并原样传递", async (t) => {
  await withEnv(t, {}, async (env) => {
    await audio8.synthesize({
      endpoint: env.endpoint,
      binding: env.binding,
      profile: env.profile,
      text: SHORT_TEXT,
      parameters: { temperature: 0.5, top_p: 0.8, top_k: 64, seed: 7, max_new_tokens: 256 },
    });

    assert.deepEqual(env.server.state.ttsBodies[0], {
      text: SHORT_TEXT,
      voice_name: env.binding.nativeVoiceId,
      temperature: 0.5,
      top_p: 0.8,
      top_k: 64,
      seed: 7,
      max_new_tokens: 256,
    });
  });
});

test("synthesize 明确拒绝 Audio8 不支持的参数且不发请求", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const key of ["speed", "rate", "emotion", "language", "target_language", "languageHint"]) {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: SHORT_TEXT,
            parameters: { [key]: 1 },
          }),
        "ERR_AUDIO8_PARAM_UNSUPPORTED",
      );
    }
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 拒绝把身份字段放进 parameters 且不发请求", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const key of ["backendId", "endpointId", "bindingId", "revision", "nativeVoiceFingerprint"]) {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: SHORT_TEXT,
            parameters: { [key]: "x" },
          }),
        "ERR_AUDIO8_PARAM_IDENTITY",
      );
    }
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 校验参数类型与范围", async (t) => {
  await withEnv(t, {}, async (env) => {
    const invalid = [
      { temperature: "0.5" },
      { temperature: 0 },
      { temperature: 2.5 },
      { top_p: 0 },
      { top_p: 1.5 },
      { top_k: 0 },
      { top_k: 2.5 },
      { max_new_tokens: 8 },
      { max_new_tokens: 4096 },
      { seed: 1.5 },
    ];
    for (const parameters of invalid) {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: SHORT_TEXT,
            parameters,
          }),
        "ERR_AUDIO8_PARAM_INVALID",
      );
    }
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 在绑定音色不存在时拒绝", async (t) => {
  await withEnv(t, { voices: [] }, async (env) => {
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_MISSING",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 在同名音色被外部改写时拒绝", async (t) => {
  const rewritten = fx.makeVoiceMeta({ reference_text: "被外部改写后的参考原文。" });
  await withEnv(t, { voices: [rewritten] }, async (env) => {
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_FINGERPRINT",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 在音色被外部整体改写（在线与磁盘一致）时仍按绑定指纹拒绝", async (t) => {
  const original = fx.makeVoiceMeta();
  const rewritten = fx.makeVoiceMeta({ reference_text: "外部整体改写后的参考原文。" });
  await withEnv(
    t,
    { metaOverrides: { reference_text: rewritten.reference_text }, voices: [rewritten] },
    async (env) => {
      const binding = { ...env.binding, nativeVoiceFingerprint: voiceFingerprint(original) };
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding,
            profile: env.profile,
            text: SHORT_TEXT,
          }),
        "ERR_AUDIO8_VOICE_FINGERPRINT",
      );
      assert.equal(env.server.state.calls.tts, 0);
    },
  );
});

test("synthesize 在在线与磁盘声音元数据不一致时拒绝", async (t) => {
  const onlineMeta = fx.makeVoiceMeta({ reference_text: "在线版本参考原文。" });
  await withEnv(t, { voices: [onlineMeta] }, async (env) => {
    const binding = { ...env.binding, nativeVoiceFingerprint: voiceFingerprint(onlineMeta) };
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_FINGERPRINT",
    );
  });
});

test("synthesize 超时不重试未知完成状态的请求", async (t) => {
  await withEnv(
    t,
    {
      synthesize: () => ({ hang: true }),
      endpointOverrides: { synthesisTimeoutMs: 150 },
    },
    async (env) => {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: SHORT_TEXT,
          }),
        "ERR_TIMEOUT",
      );
      assert.equal(env.server.state.calls.tts, 1, "超时后不得自动重发");
    },
  );
});

test("synthesize 累计容器超限即停且不返回部分音频", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  const frames = 300;
  const pcmBytes = frames * 1 * 2;
  // 单段容器 44+pcmBytes；上限设为只允许一段多一点点，第二段即触发累计停止。
  const maxContainerBytes = 44 + pcmBytes + Math.floor(pcmBytes / 2);

  await withEnv(
    t,
    {
      synthesize: () => ({ status: 200, body: fx.makePcm16Wav({ frames }) }),
      endpointOverrides: { maxContainerBytes },
    },
    async (env) => {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: longText,
          }),
        "ERR_AUDIO8_CONTAINER_LIMIT",
      );
      assert.equal(env.server.state.calls.tts, 2, "超限后不得继续下一段 POST");
    },
  );
});

test("累计上限与 joinWav 容器口径一致（含边界值）", async (t) => {
  const twoSegmentText = "甲".repeat(150);
  const firstSegment = fx.makePcm16Wav({ frames: 100, seed: 1 });
  const secondSegment = fx.makePcm16Wav({ frames: 100, seed: 2 });
  const joined = wav.joinWav([firstSegment, secondSegment]);
  assert.equal(wav.parseWav(joined).pcm.length, 400);

  const synthesize = (body, index) => ({
    status: 200,
    body: index === 1 ? firstSegment : secondSegment,
  });

  await withEnv(
    t,
    { synthesize, endpointOverrides: { maxContainerBytes: joined.length } },
    async (env) => {
      const { audio } = await audio8.synthesize({
        endpoint: env.endpoint,
        binding: env.binding,
        profile: env.profile,
        text: twoSegmentText,
      });
      assert.deepEqual(audio, joined, "恰好等于上限时结果应与 joinWav 口径一致");
      assert.equal(env.server.state.calls.tts, 2);
    },
  );

  await withEnv(
    t,
    { synthesize, endpointOverrides: { maxContainerBytes: joined.length - 1 } },
    async (env) => {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: twoSegmentText,
          }),
        "ERR_AUDIO8_CONTAINER_LIMIT",
      );
      assert.equal(env.server.state.calls.tts, 2);
    },
  );
});

test("synthesize 在分段格式不一致时整体失败且不继续发送", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  await withEnv(
    t,
    {
      synthesize: (body, index) => ({
        status: 200,
        body: fx.makePcm16Wav({ sampleRate: index === 1 ? 44100 : 22050, seed: index }),
      }),
    },
    async (env) => {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: longText,
          }),
        "ERR_AUDIO8_SEGMENT",
      );
      assert.equal(env.server.state.calls.tts, 2);
    },
  );
});

test("synthesize 在服务返回错误状态时失败且不回显服务正文", async (t) => {
  await withEnv(
    t,
    { synthesize: () => ({ status: 500, body: Buffer.from('{"detail":"boom ETIMEDOUT"}', "utf8") }) },
    async (env) => {
      await assert.rejects(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: env.binding,
            profile: env.profile,
            text: SHORT_TEXT,
          }),
        (error) => {
          assert.equal(error.code, "ERR_AUDIO8_SYNTHESIS");
          assert.equal(error.statusCode, 500);
          assert.doesNotMatch(error.message, /boom|ETIMEDOUT/);
          return true;
        },
      );
    },
  );
});

test("synthesize 拒绝无效或静音 WAV 响应", async (t) => {
  const silent = fx.makePcm16Wav({ frames: 200 });
  silent.fill(0, 44);
  await withEnv(t, { synthesize: () => ({ status: 200, body: silent }) }, async (env) => {
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_WAV_SILENT",
    );
  });
});

test("synthesize 拒绝不属于本后端或本 endpoint 的绑定", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: { ...env.binding, endpointId: "ep-other" },
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_BINDING",
    );
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: { ...env.binding, backendId: "gpt-sovits" },
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_BINDING",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("listVoices 只把在线核验通过的绑定标为可用，且不按参考语言过滤", async (t) => {
  const englishMeta = fx.makeVoiceMeta({
    name: "professor_jiang_clean2",
    reference_text: "And the third prediction is that the United States would lose this war.",
  });
  await withEnv(t, { metaOverrides: { reference_text: englishMeta.reference_text } }, async (env) => {
    const catalog = {
      schemaVersion: 1,
      endpoints: [env.endpoint],
      profiles: [env.profile],
      bindings: [
        env.binding,
        { ...env.binding, id: "binding-other-endpoint", endpointId: "ep-gpt" },
        { ...env.binding, id: "binding-other-backend", backendId: "gpt-sovits" },
        {
          ...env.binding,
          id: "binding-ghost-voice",
          nativeVoiceId: "missing_voice",
          nativeVoiceFingerprint: "a".repeat(64),
        },
      ],
    };

    const listed = await audio8.listVoices({ endpoint: env.endpoint, catalog });
    assert.equal(listed.length, 2, "只返回本 endpoint 的 audio8 绑定");
    const usable = listed.filter((entry) => entry.usable);
    assert.equal(usable.length, 1);
    assert.equal(usable[0].status, "verified");
    assert.equal(usable[0].bindingId, env.binding.id);

    const ghost = listed.find((entry) => entry.bindingId === "binding-ghost-voice");
    assert.equal(ghost.status, "missing");
    assert.equal(ghost.usable, false);
  });
});

test("listVoices 区分缺失、指纹不符与 endpoint 未验证", async (t) => {
  const envMissing = await setup({ voices: [] });
  t.after(envMissing.cleanup);
  const catalogMissing = {
    schemaVersion: 1,
    endpoints: [envMissing.endpoint],
    profiles: [envMissing.profile],
    bindings: [envMissing.binding],
  };
  const missing = await audio8.listVoices({
    endpoint: envMissing.endpoint,
    catalog: catalogMissing,
  });
  assert.equal(missing[0].status, "missing");
  assert.equal(missing[0].usable, false);

  const envRewritten = await setup({
    voices: [fx.makeVoiceMeta({ reference_text: "被改写。" })],
  });
  t.after(envRewritten.cleanup);
  const rewritten = await audio8.listVoices({
    endpoint: envRewritten.endpoint,
    catalog: {
      schemaVersion: 1,
      endpoints: [envRewritten.endpoint],
      profiles: [envRewritten.profile],
      bindings: [envRewritten.binding],
    },
  });
  assert.equal(rewritten[0].status, "fingerprintMismatch");
  assert.equal(rewritten[0].usable, false);

  const envBare = await setup({ runtime: null });
  t.after(envBare.cleanup);
  const bare = await audio8.listVoices({
    endpoint: envBare.endpoint,
    catalog: {
      schemaVersion: 1,
      endpoints: [envBare.endpoint],
      profiles: [envBare.profile],
      bindings: [envBare.binding],
    },
  });
  assert.equal(bare[0].status, "unverified");
  assert.equal(bare[0].usable, false);
});

test("probe 与 synthesize 要求最小明确的 context 结构", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(() => audio8.probe({}), "ERR_AUDIO8_ENDPOINT");
    await assertErrorCode(
      () => audio8.probe({ endpoint: { id: "x" } }),
      "ERR_AUDIO8_ENDPOINT",
    );
    await assertErrorCode(
      () => audio8.listVoices({ endpoint: env.endpoint }),
      "ERR_AUDIO8_CONTEXT",
    );
  });
});

// ---------- fix1: endpoint 覆盖参数 ----------

test("endpoint 覆盖参数只有缺省才回默认，显式非法值一律拒绝", async (t) => {
  await withEnv(t, {}, async (env) => {
    const invalid = [
      Number.NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      1.5,
      "100",
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const field of ["probeTimeoutMs", "synthesisTimeoutMs", "maxContainerBytes"]) {
      for (const value of invalid) {
        await assertErrorCode(
          () => audio8.probe({ endpoint: { ...env.endpoint, [field]: value } }),
          "ERR_AUDIO8_ENDPOINT",
        );
      }
    }
  });
});

test("endpoint 覆盖参数不得超过底座安全上限，合法更小值允许", async (t) => {
  await withEnv(t, {}, async (env) => {
    const overLimit = [
      { probeTimeoutMs: 3001 },
      { synthesisTimeoutMs: 120001 },
      { maxContainerBytes: wav.MAX_CONTAINER_BYTES + 1 },
    ];
    for (const override of overLimit) {
      await assertErrorCode(
        () => audio8.probe({ endpoint: { ...env.endpoint, ...override } }),
        "ERR_AUDIO8_ENDPOINT",
      );
    }

    const atLimit = {
      probeTimeoutMs: 3000,
      synthesisTimeoutMs: 120000,
      maxContainerBytes: wav.MAX_CONTAINER_BYTES,
    };
    assert.equal((await audio8.probe({ endpoint: { ...env.endpoint, ...atLimit } })).ready, true);

    const smaller = { probeTimeoutMs: 500, synthesisTimeoutMs: 1000, maxContainerBytes: 1000 };
    assert.equal((await audio8.probe({ endpoint: { ...env.endpoint, ...smaller } })).ready, true);
  });
});

// ---------- fix2: manifest 与 meta 的有界读取和路径边界 ----------

test("manifest 超尺寸或链接逃逸时判为不可用", async (t) => {
  await withEnv(t, {}, async (env) => {
    fs.writeFileSync(env.install.manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const oversize = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(oversize.ready, false);
    assert.equal(oversize.state, "manifestInvalid");
  });

  const outside = fx.makeTempDir();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await withEnv(t, {}, async (env) => {
    const outsideManifest = path.join(outside, "runtime_manifest.json");
    fs.writeFileSync(outsideManifest, `${JSON.stringify(env.install.manifest)}\n`, "utf8");
    fs.rmSync(env.install.manifestPath);
    fs.symlinkSync(outsideManifest, env.install.manifestPath);

    const escaped = await audio8.probe({ endpoint: env.endpoint });
    assert.equal(escaped.ready, false);
    assert.equal(escaped.state, "manifestInvalid");
  });
});

test("声音目录或 meta 链接逃逸、meta 超尺寸时拒绝合成", async (t) => {
  await withEnv(t, {}, async (env) => {
    const metaPath = path.join(env.install.voicesRoot, env.binding.nativeVoiceId, "meta.json");
    fs.writeFileSync(metaPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_METADATA",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });

  const outside = fx.makeTempDir();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  await withEnv(t, {}, async (env) => {
    const meta = env.install.meta;
    const escapedVoiceDir = path.join(outside, meta.name);
    fs.mkdirSync(escapedVoiceDir, { recursive: true });
    fs.writeFileSync(
      path.join(escapedVoiceDir, "meta.json"),
      `${JSON.stringify(meta)}\n`,
      "utf8",
    );
    const link = path.join(env.install.voicesRoot, meta.name);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(escapedVoiceDir, link);

    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_METADATA",
    );
  });

  await withEnv(t, {}, async (env) => {
    const meta = env.install.meta;
    const outsideMeta = path.join(outside, `meta-outside-${Date.now()}.json`);
    fs.writeFileSync(outsideMeta, `${JSON.stringify(meta)}\n`, "utf8");
    const metaPath = path.join(env.install.voicesRoot, meta.name, "meta.json");
    fs.rmSync(metaPath);
    fs.symlinkSync(outsideMeta, metaPath);

    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_VOICE_METADATA",
    );
  });
});

test("有界读取入口拒绝超尺寸、读取期增长、替换与符号链接（确定性）", async (t) => {
  const dir = fx.makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks = audio8.__testHooks;
  assert.equal(hooks.MAX_JSON_BYTES, 1024 * 1024);

  const big = path.join(dir, "big.json");
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x20));
  const bigStats = fs.statSync(big);
  assertThrowsCode(
    () => {
      const fd = hooks.openVerifiedJsonFile(big, { dev: bigStats.dev, ino: bigStats.ino });
      fs.closeSync(fd);
    },
    "ERR_AUDIO8_JSON_TOO_LARGE",
  );

  const grow = path.join(dir, "grow.json");
  fs.writeFileSync(grow, "{}", "utf8");
  const growStats = fs.statSync(grow);
  const growFd = hooks.openVerifiedJsonFile(grow, { dev: growStats.dev, ino: growStats.ino });
  try {
    assertThrowsCode(
      () =>
        hooks.readBoundedJsonText(growFd, {
          beforeRead: () => fs.appendFileSync(grow, " ".repeat(1024 * 1024 + 1)),
        }),
      "ERR_AUDIO8_JSON_TOO_LARGE",
    );
  } finally {
    fs.closeSync(growFd);
  }

  const other = path.join(dir, "other.json");
  fs.writeFileSync(other, "{}", "utf8");
  const stale = fs.statSync(other);
  assertThrowsCode(() => {
    const fd = hooks.openVerifiedJsonFile(grow, stale);
    fs.closeSync(fd);
  }, "ERR_AUDIO8_JSON_BOUNDARY");

  if (fs.constants.O_NOFOLLOW !== undefined) {
    const link = path.join(dir, "link.json");
    fs.symlinkSync(other, link);
    assertThrowsCode(() => {
      const fd = hooks.openVerifiedJsonFile(link, fs.statSync(other));
      fs.closeSync(fd);
    }, "ERR_AUDIO8_JSON_BOUNDARY");
  }
});

// ---------- fix3: binding 就绪与指纹复核 ----------

test("listVoices 不得把非 ready binding 显示为可用", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const status of ["unverified", "invalid", "needsPreparation"]) {
      const listed = await audio8.listVoices({
        endpoint: env.endpoint,
        catalog: {
          schemaVersion: 1,
          endpoints: [env.endpoint],
          profiles: [env.profile],
          bindings: [{ ...env.binding, status }],
        },
      });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].usable, false, `status=${status} 不得可用`);
      assert.notEqual(listed[0].status, "verified");
    }
  });
});

test("listVoices 拒绝模型指纹与 endpoint 不一致的绑定", async (t) => {
  await withEnv(t, {}, async (env) => {
    const listed = await audio8.listVoices({
      endpoint: env.endpoint,
      catalog: {
        schemaVersion: 1,
        endpoints: [env.endpoint],
        profiles: [env.profile],
        bindings: [{ ...env.binding, modelFingerprint: "0".repeat(64) }],
      },
    });
    assert.equal(listed[0].usable, false);
    assert.notEqual(listed[0].status, "verified");
  });
});

test("synthesize 拒绝非 ready 或指纹不符的 binding 且不发合成请求", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const status of ["unverified", "invalid", "needsPreparation"]) {
      await assertErrorCode(
        () =>
          audio8.synthesize({
            endpoint: env.endpoint,
            binding: { ...env.binding, status },
            profile: env.profile,
            text: SHORT_TEXT,
          }),
        "ERR_AUDIO8_BINDING_NOT_READY",
      );
    }

    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: env.endpoint,
          binding: { ...env.binding, modelFingerprint: "0".repeat(64) },
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_BINDING_FINGERPRINT",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 拒绝目录声明未 ready 的 endpoint", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () =>
        audio8.synthesize({
          endpoint: { ...env.endpoint, readiness: "unverified" },
          binding: env.binding,
          profile: env.profile,
          text: SHORT_TEXT,
        }),
      "ERR_AUDIO8_ENDPOINT_NOT_READY",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

// ---------- fix4: 调用期快照 ----------

test("synthesize 在 await 与分段之间被外部改写仍保持原 endpoint/binding", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  let mutate = null;

  const env = await setup({
    synthesize: (body, index) => ({ status: 200, body: fx.makePcm16Wav({ seed: index }) }),
    onRequest: () => {
      if (mutate) {
        mutate();
      }
    },
  });
  t.after(env.cleanup);

  const originalVoiceId = env.binding.nativeVoiceId;
  const originalBaseUrl = env.endpoint.baseUrl;
  mutate = () => {
    env.binding.nativeVoiceId = "switched_voice";
    env.binding.nativeVoiceFingerprint = "a".repeat(64);
    env.binding.modelFingerprint = "0".repeat(64);
    env.binding.endpointId = "ep-other";
    env.binding.status = "invalid";
    env.endpoint.baseUrl = "http://127.0.0.1:1";
    env.endpoint.modelFingerprint = "0".repeat(64);
  };

  const { audio } = await audio8.synthesize({
    endpoint: env.endpoint,
    binding: env.binding,
    profile: env.profile,
    text: longText,
  });

  assert.ok(Buffer.isBuffer(audio));
  const expectedSegments = text
    .splitText(longText, 120)
    .filter((segment) => segment.trim() !== "").length;
  assert.equal(env.server.state.calls.tts, expectedSegments, "全部请求仍须打到原 endpoint");
  for (const body of env.server.state.ttsBodies) {
    assert.equal(body.voice_name, originalVoiceId, "不得切换到被改写后的音色");
  }
  assert.notEqual(originalBaseUrl, env.endpoint.baseUrl);
});

test("listVoices 在 await 期间被外部改写仍返回快照描述", async (t) => {
  let mutate = null;
  const env = await setup({
    onRequest: () => {
      if (mutate) {
        mutate();
      }
    },
  });
  t.after(env.cleanup);

  const catalog = {
    schemaVersion: 1,
    endpoints: [env.endpoint],
    profiles: [env.profile],
    bindings: [env.binding],
  };
  const originalVoiceId = env.binding.nativeVoiceId;
  const originalBindingId = env.binding.id;
  mutate = () => {
    catalog.bindings[0].nativeVoiceId = "switched_voice";
    catalog.bindings[0].id = "switched-binding";
    catalog.bindings[0].status = "invalid";
  };

  const listed = await audio8.listVoices({ endpoint: env.endpoint, catalog });

  assert.equal(listed.length, 1);
  assert.equal(listed[0].bindingId, originalBindingId);
  assert.equal(listed[0].nativeVoiceId, originalVoiceId);
  assert.equal(listed[0].usable, true);
});
