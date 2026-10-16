const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");
const options = require("../options.json");

test("保留 provider 身份并升级到 2.0.0 / Memo 1.8.8 起", () => {
  assert.equal(manifest.manifestVersion, "1");
  assert.equal(manifest.pluginId, "memo-plugin-tts-gptsovits");
  assert.equal(manifest.version, "2.0.0");
  assert.equal(manifest.type, "tts");
  assert.deepEqual(manifest.platforms, ["darwin"]);
  assert.deepEqual(manifest.arch, ["arm64"]);
  assert.equal(manifest.provider.value, "GPT-SoVITS TTS");
  assert.equal(manifest.provider.label, "GPT-SoVITS TTS");
  assert.match(manifest.description, /1\.8\.8/);
});

test("宿主 importType 使用 module 分支，发布入口另由单文件 CommonJS 提供", () => {
  assert.equal(manifest.importType, "module");
});

test("配置项为 model / voiceName / catalogPath，不再有旧 language 与 speed", () => {
  const byKey = Object.fromEntries(manifest.configuration.map((entry) => [entry.key, entry]));
  assert.deepEqual(Object.keys(byKey).sort(), ["catalogPath", "model", "voiceName"]);
  assert.equal(byKey.model.type, "select");
  assert.equal(byKey.voiceName.type, "select");
  assert.equal(byKey.catalogPath.type, "text");

  assert.deepEqual(manifest.defaultsConfiguration, {
    model: "audio8",
    voiceName: "",
    catalogPath: "",
  });

  for (const field of ["configurationExposed", "ttsInput", "configurationStorage"]) {
    assert.deepEqual(manifest[field], ["model", "voiceName", "catalogPath"]);
  }
  assert.deepEqual(manifest.configurationRequired, ["voiceName", "catalogPath"]);
  assert.equal(manifest.storageKey, "gptsovits");

  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /"language"/);
  assert.doesNotMatch(serialized, /"speed"/);
  assert.doesNotMatch(serialized, /@plugins-components\/Language/);
  assert.deepEqual(options, {}, "旧语言选项表已移除");
});

test("动态字段声明 model/voiceName 的角色与作用域", () => {
  const fields = manifest.memoTtsEditor.fields;
  assert.equal(fields.model.role, "model");
  assert.equal(fields.voiceName.role, "voice");
  assert.equal(fields.catalogPath.scope, "global");
});
