"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const plugin = require("../src/plugin.js");
const { decodeVoiceValue } = require("../src/voice-value.js");
const fxAudio8 = require("./helpers/audio8-fixture.js");
const { setupPluginEnv } = require("./helpers/plugin-fixture.js");

async function withEnv(t, options, run) {
  const env = await setupPluginEnv(options);
  t.after(env.cleanup);
  return run(env);
}

function assertOnlyValueLabel(entries) {
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["label", "value"]);
    assert.equal(typeof entry.value, "string");
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0);
  }
}

test("model 字段返回两个引擎并附带真实核验状态说明", async (t) => {
  await withEnv(t, {}, async (env) => {
    const options = await plugin.getEditorOptions({
      fieldKey: "model",
      config: { catalogPath: env.catalogPath },
      query: {},
    });

    assert.deepEqual(
      options.map((entry) => entry.value),
      ["audio8", "gpt-sovits"],
    );
    assertOnlyValueLabel(options);
    assert.match(options[0].label, /已核验|在线/, "Audio8 应显示在线身份核验结果");
    assert.match(options[1].label, /未验证/, "GPT-SoVITS 应显示未验证");
    assert.equal(env.gptServer.state.calls.tts, 0, "菜单不得发起合成 POST");
    assert.equal(env.gptServer.state.calls.forbidden, 0);
  });
});

test("model 字段在缺 catalog 时仍返回两个引擎并说明未配置", async (t) => {
  await withEnv(t, {}, async () => {
    const options = await plugin.getEditorOptions({ fieldKey: "model", config: {}, query: {} });

    assert.deepEqual(
      options.map((entry) => entry.value),
      ["audio8", "gpt-sovits"],
    );
    assertOnlyValueLabel(options);
    for (const entry of options) {
      assert.match(entry.label, /未配置/);
    }
  });
});

test("voiceName 只返回可用绑定，value 为版本化身份且仅含 value/label", async (t) => {
  await withEnv(t, {}, async (env) => {
    const options = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath, model: "audio8" },
      query: {},
    });

    assert.equal(options.length, 1);
    assertOnlyValueLabel(options);
    assert.deepEqual(decodeVoiceValue(options[0].value), {
      backendId: "audio8",
      endpointId: "ep-audio8",
      bindingId: "binding-audio8-1",
      revision: 1,
    });
    assert.match(options[0].label, /讲师林/);
    assert.equal(env.audio8Server.state.calls.tts, 0, "菜单不得发起合成 POST");
  });
});

test("voiceName 只认 config.model：query 不得提供或覆盖模型，GPT 恒为空", async (t) => {
  await withEnv(t, {}, async (env) => {
    // 冲突负例 A：config 选 GPT，query 说 Audio8，必须仍按 GPT（未验证 → 空）。
    const conflict = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath, model: "gpt-sovits" },
      query: { model: "audio8" },
    });
    assert.deepEqual(conflict, [], "query.model 不得覆盖 config.model");
    assert.equal(env.gptServer.state.calls.tts, 0);
    assert.equal(env.audio8Server.state.calls.tts, 0);

    // 冲突负例 B：config 选 Audio8，query 说 GPT，仍只返回 Audio8 音色。
    const configWins = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath, model: "audio8" },
      query: { model: "gpt-sovits" },
    });
    assert.equal(configWins.length, 1);
    assert.equal(decodeVoiceValue(configWins[0].value).backendId, "audio8");

    // query 不得单独提供模型：query 说 GPT，缺 config.model 时只能回默认 Audio8。
    const injected = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath },
      query: { model: "gpt-sovits" },
    });
    assert.equal(injected.length, 1);
    assert.equal(decodeVoiceValue(injected[0].value).backendId, "audio8", "query 不得注入模型");
  });
});

test("catalogPath 只认 config：query.catalogPath 不得覆盖或补配置", async (t) => {
  await withEnv(t, {}, async (env) => {
    const missing = path.join(env.dir, "missing-catalog.json");

    // config 指向不存在的目录时，即便 query 给了有效目录也必须返回空（query 不得补配置）。
    const injected = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: missing, model: "audio8" },
      query: { catalogPath: env.catalogPath },
    });
    assert.deepEqual(injected, [], "query.catalogPath 不得作为配置来源");

    // config 有效而 query 无效时仍按 config 返回。
    const configWins = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath, model: "audio8" },
      query: { catalogPath: missing },
    });
    assert.equal(configWins.length, 1);
  });
});

test("voiceName 不按参考语言排除 Audio8 音色", async (t) => {
  await withEnv(
    t,
    {
      metaOverrides: {
        reference_text: "And the third prediction is that the United States would lose this war.",
      },
    },
    async (env) => {
      const options = await plugin.getEditorOptions({
        fieldKey: "voiceName",
        config: { catalogPath: env.catalogPath, model: "audio8" },
        query: {},
      });
      assert.equal(options.length, 1, "跨语言音色不得被参考语言过滤");
    },
  );
});

test("Audio8 在线身份未通过时 voiceName 为空", async (t) => {
  await withEnv(t, { runtime: null }, async (env) => {
    const options = await plugin.getEditorOptions({
      fieldKey: "voiceName",
      config: { catalogPath: env.catalogPath, model: "audio8" },
      query: {},
    });
    assert.deepEqual(options, []);
  });
});

test("未知 fieldKey 返回空数组", async (t) => {
  await withEnv(t, {}, async (env) => {
    const options = await plugin.getEditorOptions({
      fieldKey: "unknownField",
      config: { catalogPath: env.catalogPath },
      query: {},
    });
    assert.deepEqual(options, []);
  });
});

test("model 菜单按后端聚合全部端点：非 ready 不探测、首端点失效仍展示次端点", async (t) => {
  const extra = await fxAudio8.startAudio8Server({ runtime: null });
  t.after(() => extra.close());

  await withEnv(
    t,
    {
      mutateCatalog: (catalog) => {
        catalog.endpoints.push({
          ...catalog.endpoints[0],
          id: "ep-audio8-invalid",
          baseUrl: extra.baseUrl,
          readiness: "invalid",
        });
        return catalog;
      },
    },
    async (env) => {
      const options = await plugin.getEditorOptions({
        fieldKey: "model",
        config: { catalogPath: env.catalogPath },
        query: {},
      });
      const audio8 = options.find((entry) => entry.value === "audio8");

      assert.match(audio8.label, /部分端点已核验/, "应说明只有部分端点可用");
      assert.match(audio8.label, /尚未实机试音/);
      assert.doesNotMatch(audio8.label, /全部端点.*已核验|均可用/);
      assert.equal(
        extra.state.calls.health + extra.state.calls.runtime,
        0,
        "目录非 ready 的端点不得被探测",
      );
      assert.equal(env.audio8Server.state.calls.health > 0, true, "合格端点应被探测");
    },
  );
});

test("model 菜单：全部端点目录未就绪时不标已核验且不探测", async (t) => {
  const extra = await fxAudio8.startAudio8Server({ runtime: null });
  t.after(() => extra.close());

  await withEnv(
    t,
    {
      mutateCatalog: (catalog, install) => {
        catalog.endpoints[0].readiness = "unverified";
        catalog.endpoints.push({
          ...catalog.endpoints[0],
          id: "ep-audio8-invalid",
          baseUrl: extra.baseUrl,
          readiness: "needsPreparation",
        });
        return catalog;
      },
    },
    async (env) => {
      const options = await plugin.getEditorOptions({
        fieldKey: "model",
        config: { catalogPath: env.catalogPath },
        query: {},
      });
      const audio8 = options.find((entry) => entry.value === "audio8");

      assert.match(audio8.label, /未就绪/);
      assert.doesNotMatch(audio8.label, /已核验/);
      assert.equal(extra.state.calls.health + extra.state.calls.runtime, 0);
      assert.equal(env.audio8Server.state.calls.health, 0, "非 ready 端点不得被探测");
    },
  );
});

test("model 菜单：无端点时标未配置端点，不再显示已核验", async (t) => {
  await withEnv(
    t,
    {
      mutateCatalog: (catalog) => {
        catalog.endpoints = catalog.endpoints.filter((item) => item.backendId !== "gpt-sovits");
        catalog.bindings = catalog.bindings.filter((item) => item.backendId !== "gpt-sovits");
        return catalog;
      },
    },
    async (env) => {
      const options = await plugin.getEditorOptions({
        fieldKey: "model",
        config: { catalogPath: env.catalogPath },
        query: {},
      });
      const gpt = options.find((entry) => entry.value === "gpt-sovits");

      assert.match(gpt.label, /未配置端点/);
      assert.doesNotMatch(gpt.label, /已核验/);
      assert.equal(env.gptServer.state.calls.probe, 0, "无端点时不得探测");
    },
  );
});

test("getEditorOptions 在首个 await 前固定 config 快照", async (t) => {
  let mutate = null;
  await withEnv(
    t,
    {
      onRequest: (state, method, url) => {
        if (method === "GET" && url === "/api/memo/runtime" && mutate) {
          mutate();
        }
      },
    },
    async (env) => {
      const config = { catalogPath: env.catalogPath, model: "audio8" };
      mutate = () => {
        config.catalogPath = path.join(env.dir, "missing-catalog.json");
        config.model = "gpt-sovits";
      };

      const options = await plugin.getEditorOptions({ fieldKey: "voiceName", config, query: {} });

      assert.equal(options.length, 1, "菜单必须使用固定快照完成本次调用");
      assert.equal(
        decodeVoiceValue(options[0].value).backendId,
        "audio8",
        "模型与目录都不得被改写混用",
      );
      assert.equal(env.gptServer.state.calls.probe, 0, "不得因改写而转向 GPT 端点");
    },
  );
});
