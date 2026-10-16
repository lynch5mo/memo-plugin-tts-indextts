"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const plugin = require("../src/plugin.js");
const { decodeVoiceValue, encodeVoiceValue } = require("../src/voice-value.js");
const wav = require("../src/wav.js");
const { setupPluginEnv, simulateHostCall } = require("./helpers/plugin-fixture.js");

const SHORT_TEXT = "你好，这是一段短文本。";

function assertSafeChineseError(message) {
  assert.equal(typeof message, "string");
  assert.match(message, /^语音合成失败：/);
  assert.doesNotMatch(message, /[A-Za-z0-9]/, "错误字符串不得包含 ASCII 码、码值或诊断内容");
  assert.doesNotMatch(message, /:\/\//);
  assert.doesNotMatch(message, /429|RateLimit|timeout|ETIMEDOUT|ECONNRESET/i);
}

async function withEnv(t, options, run) {
  const env = await setupPluginEnv(options);
  t.after(env.cleanup);
  return run(env);
}

function voiceValueFor(env, binding = env.audio8Binding) {
  return encodeVoiceValue({
    backendId: binding.backendId,
    endpointId: binding.endpointId,
    bindingId: binding.id,
    revision: binding.revision,
  });
}

test("源码入口导出 default 与 getEditorOptions", () => {
  assert.equal(typeof plugin.default, "function");
  assert.equal(typeof plugin.getEditorOptions, "function");
});

test("Audio8 经源码入口返回有效非静音 Buffer，且只发白名单字段", async (t) => {
  await withEnv(t, {}, async (env) => {
    const tts = new plugin.default({
      model: "audio8",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
    });

    const result = await tts.textToSpeech({ text: SHORT_TEXT });

    assert.ok(Buffer.isBuffer(result), `期望 Buffer，实际 ${typeof result}`);
    const parsed = wav.parseWav(result);
    assert.ok(parsed.pcm.length > 0);
    assert.equal(env.audio8Server.state.calls.tts, 1);

    const body = env.audio8Server.state.ttsBodies[0];
    assert.deepEqual(Object.keys(body).sort(), ["text", "voice_name"]);
    assert.equal(body.text, SHORT_TEXT);
    assert.equal(body.voice_name, env.audio8Binding.nativeVoiceId);
    assert.equal(env.gptServer.state.calls.tts, 0);
  });
});

test("当前 options 覆盖构造配置选择后端", async (t) => {
  await withEnv(t, {}, async (env) => {
    const tts = new plugin.default({
      model: "gpt-sovits",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
    });

    const result = await tts.textToSpeech({ text: SHORT_TEXT, model: "audio8" });

    assert.ok(Buffer.isBuffer(result), "当前 options.model 应覆盖构造配置");
    assert.equal(env.audio8Server.state.calls.tts, 1);
    assert.equal(env.gptServer.state.calls.tts, 0);
  });
});

test("调用期目录被改写也不换绑定：catalog 只读一次", async (t) => {
  const longText = "这是一段需要分段合成的长文本。".repeat(20);
  let rewrite = null;

  await withEnv(
    t,
    {
      onRequest: (state, method, url) => {
        if (method === "POST" && url === "/api/tts" && rewrite) {
          rewrite();
        }
      },
    },
    async (env) => {
      const rewritten = JSON.parse(JSON.stringify(env.catalog));
      rewritten.bindings[0].nativeVoiceId = "switched_voice";
      rewritten.bindings[0].revision = 9;
      rewrite = () => fs.writeFileSync(env.catalogPath, JSON.stringify(rewritten), "utf8");

      const tts = new plugin.default({
        model: "audio8",
        catalogPath: env.catalogPath,
        voiceName: voiceValueFor(env),
      });

      const result = await tts.textToSpeech({ text: longText });

      assert.ok(Buffer.isBuffer(result));
      assert.ok(env.audio8Server.state.calls.tts > 1, "长文本应产生多段请求");
      for (const body of env.audio8Server.state.ttsBodies) {
        assert.equal(body.voice_name, env.audio8Binding.nativeVoiceId, "不得切换到改写后的音色");
      }
      assert.equal(decodeVoiceValue(voiceValueFor(env)).revision, 1);
    },
  );
});

test("旧 speed 与 language 等字段不会进入 Audio8 请求", async (t) => {
  await withEnv(t, {}, async (env) => {
    const tts = new plugin.default({
      model: "audio8",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
      speed: 20,
      language: "ZH_CN",
    });

    const result = await tts.textToSpeech({
      text: SHORT_TEXT,
      speed: 20,
      language: "ZH_CN",
      rate: 1.5,
      emotion: "happy",
      temperature: 0.9,
    });

    assert.ok(Buffer.isBuffer(result));
    const body = env.audio8Server.state.ttsBodies[0];
    for (const key of ["speed", "language", "rate", "emotion", "temperature"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, `${key} 不得进入请求`);
    }
  });
});

test("GPT-SoVITS 恒未验证：0 次合成 POST，返回固定中文错误", async (t) => {
  await withEnv(t, {}, async (env) => {
    const tts = new plugin.default({
      model: "gpt-sovits",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env, env.gptBinding),
    });

    const result = await tts.textToSpeech({ text: SHORT_TEXT });

    assertSafeChineseError(result);
    assert.equal(env.gptServer.state.calls.tts, 0);
    assert.equal(env.gptServer.state.calls.forbidden, 0);
  });
});

test("服务未验证、声音缺失、空文本、未配置目录、未知模型都返回固定中文错误", async (t) => {
  await withEnv(t, {}, async (env) => {
    const empty = new plugin.default({
      model: "audio8",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
    });
    assertSafeChineseError(await empty.textToSpeech({ text: "" }));
    assert.equal(env.audio8Server.state.calls.tts, 0);

    const missingVoice = new plugin.default({
      model: "audio8",
      catalogPath: env.catalogPath,
      voiceName: encodeVoiceValue({
        backendId: "audio8",
        endpointId: "ep-audio8",
        bindingId: "binding-ghost",
        revision: 1,
      }),
    });
    assertSafeChineseError(await missingVoice.textToSpeech({ text: SHORT_TEXT }));

    const noSelection = new plugin.default({ model: "audio8", catalogPath: env.catalogPath });
    assertSafeChineseError(await noSelection.textToSpeech({ text: SHORT_TEXT }));

    const noCatalog = new plugin.default({
      model: "audio8",
      catalogPath: path.join(env.dir, "missing-catalog.json"),
      voiceName: voiceValueFor(env),
    });
    assertSafeChineseError(await noCatalog.textToSpeech({ text: SHORT_TEXT }));

    const unknownModel = new plugin.default({
      model: "other-backend",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
    });
    assertSafeChineseError(await unknownModel.textToSpeech({ text: SHORT_TEXT }));
  });
});

test("Audio8 在线身份未通过（裸服务缺身份接口）时返回固定中文错误", async (t) => {
  await withEnv(t, { runtime: null }, async (env) => {
    const tts = new plugin.default({
      model: "audio8",
      catalogPath: env.catalogPath,
      voiceName: voiceValueFor(env),
    });

    const result = await tts.textToSpeech({ text: SHORT_TEXT });

    assertSafeChineseError(result);
    assert.equal(env.audio8Server.state.calls.tts, 0);
  });
});

test("超时不会触发宿主二次调用，且 HTTP 只发一次", async (t) => {
  await withEnv(
    t,
    {
      synthesize: () => ({ hang: true }),
      audio8EndpointExtra: { synthesisTimeoutMs: 150 },
    },
    async (env) => {
      const tts = new plugin.default({
        model: "audio8",
        catalogPath: env.catalogPath,
        voiceName: voiceValueFor(env),
      });

      const { calls, result } = await simulateHostCall(() => tts.textToSpeech({ text: SHORT_TEXT }));

      assertSafeChineseError(result);
      assert.equal(calls, 1, "宿主不得因超时分类而重调");
      assert.equal(env.audio8Server.state.calls.tts, 1, "HTTP 不得重发");
    },
  );
});

test("后端返回 429 等重试关键词时仍只返回安全中文说明", async (t) => {
  await withEnv(
    t,
    {
      synthesize: () => ({
        status: 429,
        body: Buffer.from("RateLimit timeout ETIMEDOUT ECONNRESET 429 http://127.0.0.1:1/secret"),
      }),
    },
    async (env) => {
      const tts = new plugin.default({
        model: "audio8",
        catalogPath: env.catalogPath,
        voiceName: voiceValueFor(env),
      });

      const { calls, result } = await simulateHostCall(() => tts.textToSpeech({ text: SHORT_TEXT }));

      assertSafeChineseError(result);
      assert.equal(calls, 1, "宿主不得因原样错误再次调用");
      assert.equal(env.audio8Server.state.calls.tts, 1);
    },
  );
});
