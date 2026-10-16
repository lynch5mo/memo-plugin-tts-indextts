const test = require("node:test");
const assert = require("node:assert/strict");

// 旧断言把 100ms 静音占位 WAV 当作成功，本轮改为真实入口契约：
// 未配置音色资料时必须是固定中文分类错误字符串，绝不是静音 Buffer。
test("仓库入口在未配置资料时返回固定中文分类错误，而不是静音占位", async () => {
  const entry = require("../index.js");
  const result = await new entry.default().textToSpeech({ text: "  " });

  assert.equal(Buffer.isBuffer(result), false, "不得再返回静音占位 WAV");
  assert.equal(typeof result, "string");
  assert.match(result, /^语音合成失败：/);
  assert.doesNotMatch(result, /[A-Za-z0-9]/, "错误串不得包含英文错误码或诊断内容");
});
