const test = require("node:test");
const assert = require("node:assert/strict");

test("发布入口导出 default 与 getEditorOptions，未配置时返回固定中文错误", async () => {
  const plugin = require("../index.js");

  assert.equal(typeof plugin.default, "function");
  assert.equal(typeof plugin.getEditorOptions, "function");
  assert.deepEqual(Object.keys(plugin).sort(), ["default", "getEditorOptions"]);

  const result = await new plugin.default().textToSpeech({ text: "你好" });
  assert.equal(typeof result, "string");
  assert.match(result, /^语音合成失败：/);

  const options = await plugin.getEditorOptions({ fieldKey: "model", config: {}, query: {} });
  assert.deepEqual(
    options.map((entry) => entry.value),
    ["audio8", "gpt-sovits"],
  );
});
