"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gpt = require("../src/backends/gpt-sovits.js");
const wav = require("../src/wav.js");
const text = require("../src/text.js");
const fx = require("./helpers/gpt-sovits-fixture.js");

function assertErrorCode(fn, code) {
  return assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

async function setup(options = {}) {
  const dir = fx.makeTempDir();
  const audioPath = fx.writeReferenceAudio(dir, options.referenceAudio || {});

  const server = await fx.startGptSovitsServer({
    synthesize: options.synthesize,
    validationError: options.validationError,
    validationStatus: options.validationStatus,
    onRequest: options.onRequest,
  });

  const endpoint = {
    id: "ep-gpt",
    backendId: "gpt-sovits",
    baseUrl: server.baseUrl,
    modelFingerprint: "gpt-model-group-v2",
    readiness: "ready",
    ...(options.endpointOverrides || {}),
  };

  const binding = {
    id: "binding-gpt-1",
    profileId: "profile-gpt-1",
    backendId: "gpt-sovits",
    endpointId: "ep-gpt",
    nativeVoiceId: "reference.wav",
    modelFingerprint: "gpt-model-group-v2",
    revision: 1,
    status: "ready",
    params: {},
    ...(options.bindingOverrides || {}),
  };

  const profile = {
    id: "profile-gpt-1",
    label: "讲师",
    persistence: "saved",
    source: { audioPath, referenceText: "这是参考原文。", language: "zh" },
    owner: "memo-local-tts",
    ...(options.profileOverrides || {}),
  };

  const parameters = { text_lang: "zh", ...(options.parameters || {}) };

  const cleanup = async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, audioPath, endpoint, binding, profile, parameters, server, cleanup };
}

async function withEnv(t, options, run) {
  const env = await setup(options);
  t.after(env.cleanup);
  return run(env);
}

function synthArgs(env, extra = {}) {
  return {
    endpoint: env.endpoint,
    binding: env.binding,
    profile: env.profile,
    text: "你好，这是一段短文本。",
    parameters: env.parameters,
    ...extra,
  };
}

test("capabilities 声明原生契约、强制字段与 fail-closed 身份状态", () => {
  assert.equal(gpt.id, "gpt-sovits");
  const caps = gpt.capabilities;

  assert.equal(caps.segmentCodePoints, 120);
  assert.equal(caps.maxInputCodePoints, text.MAX_INPUT_CODE_POINTS);
  assert.equal(caps.maxContainerBytes, wav.MAX_CONTAINER_BYTES);
  assert.equal(caps.maxResponseBytes, 16 * 1024 * 1024);
  assert.equal(caps.mediaType, "wav");
  assert.equal(caps.streamingMode, false);
  assert.equal(caps.identityEvidence, "unavailable");
  assert.equal(caps.supportsStreaming, false);
  assert.equal(caps.filtersVoicesByReferenceLanguage, false);
  assert.ok(caps.languages.includes("zh") && caps.languages.includes("auto"));
  assert.deepEqual(caps.textSplitMethods, ["cut0", "cut1", "cut2", "cut3", "cut4", "cut5"]);
  assert.deepEqual(
    Object.keys(caps.samplingParameters).sort(),
    [
      "fragment_interval",
      "repetition_penalty",
      "sample_steps",
      "seed",
      "speed_factor",
      "temperature",
      "text_split_method",
      "top_k",
      "top_p",
    ],
  );
  assert.equal(caps.endpoints.synthesize, "/tts");
  assert.deepEqual([...caps.forbiddenEndpoints].sort(), [
    "/control",
    "/set_gpt_weights",
    "/set_refer_audio",
    "/set_sovits_weights",
  ]);
});

test("probe 在服务可达且契约匹配时仍保持 unverified（无在线模型组身份）", async (t) => {
  await withEnv(t, {}, async (env) => {
    const result = await gpt.probe({ endpoint: env.endpoint });

    assert.equal(result.ready, false);
    assert.equal(result.state, "unverified");
    assert.equal(result.identity, null);
    assert.equal(result.identityEvidence, "unavailable");
    assert.equal(result.contract.matchedValidationError, true);
    assert.match(result.reason, /模型组/);
  });
});

test("probe 不把 /docs 可连通或 200 当作身份证据", async (t) => {
  await withEnv(t, {}, async (env) => {
    const result = await gpt.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.equal(env.server.state.calls.probe, 1);
    assert.equal(env.server.state.calls.docs, 0, "不得依赖 /docs");
  });

  await withEnv(t, { validationStatus: 200 }, async (env) => {
    const result = await gpt.probe({ endpoint: env.endpoint });
    assert.equal(result.ready, false);
    assert.notEqual(result.state, "verified");
  });
});

test("probe 在服务不可达时标 unreachable", async (t) => {
  const dead = await fx.startGptSovitsServer({});
  const deadUrl = dead.baseUrl;
  await dead.close();

  await withEnv(t, {}, async (env) => {
    const result = await gpt.probe({ endpoint: { ...env.endpoint, baseUrl: deadUrl } });
    assert.equal(result.ready, false);
    assert.equal(result.state, "unreachable");
  });
});

test("probe 对非 loopback endpoint 直接按策略拒绝", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () => gpt.probe({ endpoint: { ...env.endpoint, baseUrl: "http://10.9.9.9:9880" } }),
      "ERR_ENDPOINT_NOT_LOOPBACK",
    );
  });
});

test("endpoint 覆盖参数缺省才回默认，非法或超上限一律拒绝", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const value of [Number.NaN, Infinity, 0, -1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ["probeTimeoutMs", "synthesisTimeoutMs", "maxContainerBytes"]) {
        await assertErrorCode(
          () => gpt.probe({ endpoint: { ...env.endpoint, [field]: value } }),
          "ERR_GPT_SOVITS_ENDPOINT",
        );
      }
    }
    for (const override of [
      { probeTimeoutMs: 3001 },
      { synthesisTimeoutMs: 120001 },
      { maxContainerBytes: wav.MAX_CONTAINER_BYTES + 1 },
    ]) {
      await assertErrorCode(
        () => gpt.probe({ endpoint: { ...env.endpoint, ...override } }),
        "ERR_GPT_SOVITS_ENDPOINT",
      );
    }
    assert.equal(
      (await gpt.probe({ endpoint: { ...env.endpoint, probeTimeoutMs: 1000 } })).state,
      "unverified",
    );
  });
});

test("listVoices 的 GPT 声音一律 fail-closed 不可用", async (t) => {
  await withEnv(t, {}, async (env) => {
    const catalog = {
      schemaVersion: 1,
      endpoints: [env.endpoint],
      profiles: [env.profile],
      bindings: [
        env.binding,
        { ...env.binding, id: "binding-other-endpoint", endpointId: "ep-other" },
        { ...env.binding, id: "binding-other-backend", backendId: "audio8" },
      ],
    };

    const listed = await gpt.listVoices({ endpoint: env.endpoint, catalog });
    assert.equal(listed.length, 1, "只返回本 endpoint 的 gpt-sovits 绑定");
    assert.equal(listed[0].usable, false);
    assert.equal(listed[0].status, "unverified");
    assert.equal(listed[0].bindingId, env.binding.id);
  });
});

test("listVoices 区分非 ready 与指纹不符的绑定", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const status of ["unverified", "invalid", "needsPreparation"]) {
      const listed = await gpt.listVoices({
        endpoint: env.endpoint,
        catalog: {
          schemaVersion: 1,
          endpoints: [env.endpoint],
          profiles: [env.profile],
          bindings: [{ ...env.binding, status }],
        },
      });
      assert.equal(listed[0].usable, false);
      assert.equal(listed[0].status, "notReady");
    }

    const mismatch = await gpt.listVoices({
      endpoint: env.endpoint,
      catalog: {
        schemaVersion: 1,
        endpoints: [env.endpoint],
        profiles: [env.profile],
        bindings: [{ ...env.binding, modelFingerprint: "other-model-group" }],
      },
    });
    assert.equal(mismatch[0].usable, false);
    assert.equal(mismatch[0].status, "invalid");
  });
});

test("buildSynthesisPayload 只含原生白名单字段", async (t) => {
  await withEnv(t, {}, async (env) => {
    const hooks = gpt.__testHooks;
    const reference = hooks.resolveReference(env.profile);
    const sampling = hooks.normalizeParameters({
      text_lang: "zh",
      top_k: 15,
      temperature: 1,
      speed_factor: 1.2,
      text_split_method: "cut5",
    });

    const payload = hooks.buildSynthesisPayload({
      segment: "分段正文",
      reference,
      sampling,
    });

    assert.deepEqual(payload, {
      text: "分段正文",
      text_lang: "zh",
      ref_audio_path: env.audioPath,
      prompt_text: "这是参考原文。",
      prompt_lang: "zh",
      media_type: "wav",
      streaming_mode: false,
      top_k: 15,
      temperature: 1,
      speed_factor: 1.2,
      text_split_method: "cut5",
    });
    for (const key of ["backendId", "endpointId", "bindingId", "revision", "nativeVoiceFingerprint"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(payload, key), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "aux_ref_audio_paths"), false);
  });
});

test("synthesize 在未验证 endpoint 上 fail-closed 且不发合成请求", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(() => gpt.synthesize(synthArgs(env)), "ERR_GPT_SOVITS_NOT_VERIFIED");
    assert.equal(env.server.state.calls.tts, 0);
    assert.equal(env.server.state.calls.forbidden, 0, "不得调用权重切换等写路由");
  });
});

test("synthesize 拒绝目录声明未 ready 的 endpoint", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () => gpt.synthesize(synthArgs(env, { endpoint: { ...env.endpoint, readiness: "unverified" } })),
      "ERR_GPT_SOVITS_ENDPOINT_NOT_READY",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 拒绝非 ready 或指纹不符的 binding", async (t) => {
  await withEnv(t, {}, async (env) => {
    for (const status of ["unverified", "invalid", "needsPreparation"]) {
      await assertErrorCode(
        () => gpt.synthesize(synthArgs(env, { binding: { ...env.binding, status } })),
        "ERR_GPT_SOVITS_BINDING_NOT_READY",
      );
    }
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, { binding: { ...env.binding, modelFingerprint: "other-model-group" } }),
        ),
      "ERR_GPT_SOVITS_BINDING_FINGERPRINT",
    );
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 校验参考资料：缺失原文、缺失音频、相对路径、超尺寸", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            profile: { ...env.profile, source: { ...env.profile.source, referenceText: "  " } },
          }),
        ),
      "ERR_GPT_SOVITS_REFERENCE",
    );
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            profile: {
              ...env.profile,
              source: { ...env.profile.source, audioPath: path.join(env.dir, "missing.wav") },
            },
          }),
        ),
      "ERR_GPT_SOVITS_REFERENCE",
    );
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            profile: { ...env.profile, source: { ...env.profile.source, audioPath: "relative.wav" } },
          }),
        ),
      "ERR_GPT_SOVITS_REFERENCE",
    );
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            profile: {
              ...env.profile,
              source: { ...env.profile.source, language: "klingon" },
            },
          }),
        ),
      "ERR_GPT_SOVITS_REFERENCE",
    );
  });

  await withEnv(t, {}, async (env) => {
    const big = path.join(env.dir, "big.wav");
    fs.writeFileSync(big, Buffer.alloc(64, 0));
    fs.truncateSync(big, 64 * 1024 * 1024 + 1);
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            profile: { ...env.profile, source: { ...env.profile.source, audioPath: big } },
          }),
        ),
      "ERR_GPT_SOVITS_REFERENCE",
    );
    assert.equal(fs.statSync(big).size, 64 * 1024 * 1024 + 1);
  });
});

test("synthesize 拒绝未声明或非法的语言与不支持参数", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(
      () => gpt.synthesize(synthArgs(env, { parameters: { text_lang: "klingon" } })),
      "ERR_GPT_SOVITS_PARAM_INVALID",
    );
    await assertErrorCode(
      () =>
        gpt.synthesize(
          synthArgs(env, {
            parameters: {
              text_lang: "zh",
              aux_ref_audio_paths: ["/tmp/x.wav"],
              streaming_mode: true,
              media_type: "raw",
              batch_size: 4,
            },
          }),
        ),
      "ERR_GPT_SOVITS_PARAM_UNSUPPORTED",
    );
    await assertErrorCode(
      () => gpt.synthesize(synthArgs(env, { parameters: { text_lang: "zh", bindingId: "x" } })),
      "ERR_GPT_SOVITS_PARAM_IDENTITY",
    );
    for (const parameters of [
      { text_lang: "zh", temperature: Number.NaN },
      { text_lang: "zh", top_p: Infinity },
      { text_lang: "zh", top_k: 0 },
      { text_lang: "zh", speed_factor: 0 },
      { text_lang: "zh", text_split_method: "cut9" },
    ]) {
      await assertErrorCode(
        () => gpt.synthesize(synthArgs(env, { parameters })),
        "ERR_GPT_SOVITS_PARAM_INVALID",
      );
    }
    assert.equal(env.server.state.calls.tts, 0);
  });
});

test("synthesize 在任何 await 前固定快照，await 期间改写不影响判定", async (t) => {
  let mutate = null;
  await withEnv(
    t,
    {
      onRequest: () => {
        if (mutate) {
          mutate();
        }
      },
    },
    async (env) => {
      mutate = () => {
        env.profile.source.audioPath = path.join(env.dir, "gone.wav");
        env.profile.source.referenceText = "";
        env.binding.status = "invalid";
        env.binding.modelFingerprint = "other-model-group";
      };

      // 快照在首个 await 之前完成，因此仍以原资料通过校验并停在 fail-closed 身份门。
      await assertErrorCode(() => gpt.synthesize(synthArgs(env)), "ERR_GPT_SOVITS_NOT_VERIFIED");
    },
  );
});

test("分段传输：每段一次原生 POST 且合并结果与 joinWav 一致", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  await withEnv(t, {}, async (env) => {
    const hooks = gpt.__testHooks;
    const endpoint = hooks.resolveEndpoint(env.endpoint);
    const reference = hooks.resolveReference(env.profile);
    const sampling = hooks.normalizeParameters({ text_lang: "zh", speed_factor: 1 });
    const segments = text.splitText(longText, 120);
    const nonBlank = segments.filter((segment) => segment.trim() !== "");

    const result = await hooks.performSegmentedSynthesis({ endpoint, reference, sampling, segments });

    assert.equal(env.server.state.calls.tts, nonBlank.length);
    assert.deepEqual(
      env.server.state.ttsBodies.map((body) => body.text),
      nonBlank,
    );
    for (const body of env.server.state.ttsBodies) {
      assert.equal(body.media_type, "wav");
      assert.equal(body.streaming_mode, false);
      assert.equal(body.ref_audio_path, env.audioPath);
      assert.equal(body.prompt_lang, "zh");
      assert.equal(body.text_lang, "zh");
    }
    assert.equal(Object.prototype.hasOwnProperty.call(result, "audio"), true);
    assert.ok(wav.parseWav(result.audio).pcm.length > 0);
    assert.equal(env.server.state.calls.forbidden, 0);
  });
});

test("分段传输：纯空白不分段发送，累计超限即停，格式不一致整体失败", async (t) => {
  const spacedText = `${"甲".repeat(130)}${" ".repeat(130)}${"乙".repeat(130)}`;
  await withEnv(t, {}, async (env) => {
    const hooks = gpt.__testHooks;
    const endpoint = hooks.resolveEndpoint(env.endpoint);
    const reference = hooks.resolveReference(env.profile);
    const sampling = hooks.normalizeParameters({ text_lang: "zh" });
    const segments = text.splitText(spacedText, 120);
    const nonBlank = segments.filter((segment) => segment.trim() !== "");
    assert.ok(segments.length > nonBlank.length, "夹具应产出纯空白分段");

    await hooks.performSegmentedSynthesis({ endpoint, reference, sampling, segments });
    assert.equal(env.server.state.calls.tts, nonBlank.length);
    assert.equal(
      nonBlank.join("").replace(/\s/g, ""),
      spacedText.replace(/\s/g, ""),
      "所有非空白文字必须原样覆盖",
    );
  });

  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  const frames = 300;
  const pcmBytes = frames * 2;
  await withEnv(
    t,
    {
      synthesize: () => ({ status: 200, body: fx.makePcm16Wav({ frames }) }),
      endpointOverrides: { maxContainerBytes: 44 + pcmBytes + Math.floor(pcmBytes / 2) },
    },
    async (env) => {
      const hooks = gpt.__testHooks;
      await assertErrorCode(
        () =>
          hooks.performSegmentedSynthesis({
            endpoint: hooks.resolveEndpoint(env.endpoint),
            reference: hooks.resolveReference(env.profile),
            sampling: hooks.normalizeParameters({ text_lang: "zh" }),
            segments: text.splitText(longText, 120),
          }),
        "ERR_GPT_SOVITS_CONTAINER_LIMIT",
      );
      assert.equal(env.server.state.calls.tts, 2, "超限后不得继续下一段");
    },
  );

  await withEnv(
    t,
    {
      synthesize: (body, index) => ({
        status: 200,
        body: fx.makePcm16Wav({ sampleRate: index === 1 ? 32000 : 22050, seed: index }),
      }),
    },
    async (env) => {
      const hooks = gpt.__testHooks;
      await assertErrorCode(
        () =>
          hooks.performSegmentedSynthesis({
            endpoint: hooks.resolveEndpoint(env.endpoint),
            reference: hooks.resolveReference(env.profile),
            sampling: hooks.normalizeParameters({ text_lang: "zh" }),
            segments: text.splitText(longText, 120),
          }),
        "ERR_GPT_SOVITS_SEGMENT",
      );
      assert.equal(env.server.state.calls.tts, 2);
    },
  );
});

test("分段传输：错误状态、静音 WAV 与超时都不重试", async (t) => {
  const hooks = () => gpt.__testHooks;

  await withEnv(
    t,
    { synthesize: () => ({ status: 400, body: Buffer.from("tts failed ETIMEDOUT") }) },
    async (env) => {
      await assert.rejects(
        () =>
          hooks().performSegmentedSynthesis({
            endpoint: hooks().resolveEndpoint(env.endpoint),
            reference: hooks().resolveReference(env.profile),
            sampling: hooks().normalizeParameters({ text_lang: "zh" }),
            segments: ["短句。"],
          }),
        (error) => {
          assert.equal(error.code, "ERR_GPT_SOVITS_SYNTHESIS");
          assert.equal(error.statusCode, 400);
          assert.doesNotMatch(error.message, /tts failed|ETIMEDOUT/);
          return true;
        },
      );
      assert.equal(env.server.state.calls.tts, 1);
    },
  );

  const silent = fx.makePcm16Wav({ frames: 200 });
  silent.fill(0, 44);
  await withEnv(t, { synthesize: () => ({ status: 200, body: silent }) }, async (env) => {
    await assertErrorCode(
      () =>
        hooks().performSegmentedSynthesis({
          endpoint: hooks().resolveEndpoint(env.endpoint),
          reference: hooks().resolveReference(env.profile),
          sampling: hooks().normalizeParameters({ text_lang: "zh" }),
          segments: ["短句。"],
        }),
      "ERR_WAV_SILENT",
    );
  });

  await withEnv(
    t,
    { synthesize: () => ({ hang: true }), endpointOverrides: { synthesisTimeoutMs: 150 } },
    async (env) => {
      await assertErrorCode(
        () =>
          hooks().performSegmentedSynthesis({
            endpoint: hooks().resolveEndpoint(env.endpoint),
            reference: hooks().resolveReference(env.profile),
            sampling: hooks().normalizeParameters({ text_lang: "zh" }),
            segments: ["短句。"],
          }),
        "ERR_TIMEOUT",
      );
      assert.equal(env.server.state.calls.tts, 1, "超时后不得自动重发");
    },
  );
});

test("分段传输全过程不触碰权重切换与注册路由", async (t) => {
  await withEnv(t, {}, async (env) => {
    const hooks = gpt.__testHooks;
    await hooks.performSegmentedSynthesis({
      endpoint: hooks.resolveEndpoint(env.endpoint),
      reference: hooks.resolveReference(env.profile),
      sampling: hooks.normalizeParameters({ text_lang: "zh" }),
      segments: ["第一段。", "第二段。"],
    });

    const touched = env.server.state.requests.map((request) => request.path);
    assert.deepEqual([...new Set(touched)], ["/tts"]);
    assert.equal(env.server.state.calls.forbidden, 0);
  });
});

test("synthesize 与 probe 要求最小明确 context 结构", async (t) => {
  await withEnv(t, {}, async (env) => {
    await assertErrorCode(() => gpt.probe({}), "ERR_GPT_SOVITS_ENDPOINT");
    await assertErrorCode(() => gpt.listVoices({ endpoint: env.endpoint }), "ERR_GPT_SOVITS_CONTEXT");
  });
});
