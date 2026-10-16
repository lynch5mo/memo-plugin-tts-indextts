"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const buildRuntime = require("../scripts/build-runtime.js");
const wav = require("../src/wav.js");
const { encodeVoiceValue, decodeVoiceValue } = require("../src/voice-value.js");
const { setupPluginEnv } = require("./helpers/plugin-fixture.js");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-runtime.js");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runBuild(outputDir) {
  execFileSync(process.execPath, [BUILD_SCRIPT, "--output", path.join(outputDir, "index.js")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("同一输入两次构建 byte-identical，且与仓库 index.js 一致", () => {
  const first = mktemp("memo-build-a-");
  const second = mktemp("memo-build-b-");
  try {
    runBuild(first);
    runBuild(second);
    const shaFirst = sha256(path.join(first, "index.js"));
    const shaSecond = sha256(path.join(second, "index.js"));

    assert.equal(shaFirst, shaSecond, "同输入必须 byte-identical");
    assert.equal(
      shaFirst,
      sha256(path.join(REPO_ROOT, "index.js")),
      "仓库 index.js 必须与构建输出一致（需先跑 npm run build）",
    );
    assert.deepEqual(fs.readdirSync(first).sort(), ["index.js"], "构建只写目标文件");
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("构建产物自包含：无相对 require、无内部测试缝、导出面固定", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "index.js"), "utf8");

  assert.doesNotMatch(source, /require\s*\(\s*["']\./, "不得含相对 require");
  assert.doesNotMatch(source, /__testHooks/, "不得把内部测试缝打进发布包");
  assert.match(source, /module\.exports = __require\("src\/plugin\.js"\)/);
  for (const id of buildRuntime.MODULE_ORDER) {
    assert.ok(source.includes(JSON.stringify(id)), `${id} 必须内联进单文件`);
  }
});

test("构建器拒绝白名单外的相对依赖", () => {
  assert.throws(
    () => buildRuntime.rewriteRequires('require("./evil.js");', "src/plugin.js"),
    /outside the whitelist/,
  );
});

test("解包到项目外隔离目录后，发布入口经真实 HTTP fixture 可合成", async (t) => {
  const env = await setupPluginEnv({});
  t.after(env.cleanup);

  const isolated = mktemp("memo-publish-");
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  fs.copyFileSync(path.join(REPO_ROOT, "index.js"), path.join(isolated, "index.js"));

  const entry = require(path.join(isolated, "index.js"));
  const voiceName = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-audio8-1",
    revision: 1,
  });
  const tts = new entry.default({ model: "audio8", catalogPath: env.catalogPath, voiceName });

  const audio = await tts.textToSpeech({ text: "你好，这是一段短文本。" });
  assert.ok(Buffer.isBuffer(audio), `期望 Buffer，实际 ${typeof audio}`);
  assert.ok(wav.parseWav(audio).pcm.length > 0);
  assert.equal(env.audio8Server.state.calls.tts, 1);

  const menu = await entry.getEditorOptions({
    fieldKey: "voiceName",
    config: { catalogPath: env.catalogPath, model: "audio8" },
    query: {},
  });
  assert.equal(menu.length, 1);
  assert.deepEqual(Object.keys(menu[0]).sort(), ["label", "value"]);
  assert.equal(decodeVoiceValue(menu[0].value).bindingId, "binding-audio8-1");
});

test("发布入口负例：GPT 未验证零合成 POST，未配置资料返回固定中文错误", async (t) => {
  const env = await setupPluginEnv({});
  t.after(env.cleanup);

  const isolated = mktemp("memo-publish-neg-");
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  fs.copyFileSync(path.join(REPO_ROOT, "index.js"), path.join(isolated, "index.js"));

  const entry = require(path.join(isolated, "index.js"));

  const gpt = new entry.default({
    model: "gpt-sovits",
    catalogPath: env.catalogPath,
    voiceName: encodeVoiceValue({
      backendId: "gpt-sovits",
      endpointId: "ep-gpt",
      bindingId: "binding-gpt-1",
      revision: 4,
    }),
  });
  const gptResult = await gpt.textToSpeech({ text: "你好" });
  assert.equal(typeof gptResult, "string");
  assert.match(gptResult, /^语音合成失败：/);
  assert.doesNotMatch(gptResult, /[A-Za-z0-9]/, "错误串不得包含英文错误码或诊断内容");
  assert.equal(env.gptServer.state.calls.tts, 0);

  const missing = new entry.default({
    model: "audio8",
    catalogPath: path.join(isolated, "missing-catalog.json"),
    voiceName: encodeVoiceValue({
      backendId: "audio8",
      endpointId: "ep-audio8",
      bindingId: "binding-audio8-1",
      revision: 1,
    }),
  });
  const missingResult = await missing.textToSpeech({ text: "你好" });
  assert.match(missingResult, /^语音合成失败：/);
});
