const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");
const options = require("../options.json");

test("declares an independent Memo TTS provider", () => {
  assert.equal(manifest.manifestVersion, "1");
  assert.equal(manifest.pluginId, "memo-plugin-tts-gptsovits");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.type, "tts");
  assert.deepEqual(manifest.platforms, ["darwin"]);
  assert.deepEqual(manifest.arch, ["arm64"]);
  assert.equal(manifest.provider.value, "GPT-SoVITS TTS");
});

test("declares the CommonJS entry and Phase 0 configuration contract", () => {
  assert.equal(manifest.importType, "commonjs");

  const byKey = Object.fromEntries(
    manifest.configuration.map((entry) => [entry.key, entry]),
  );

  assert.equal(byKey.language.type, "@plugins-components/Language");
  assert.equal(byKey.speed.type, "slider");
  assert.deepEqual(byKey.speed.range, { min: 0, max: 100, step: 1 });

  assert.deepEqual(manifest.defaultsConfiguration, {
    language: "ZH_CN",
    speed: 10,
  });

  for (const field of [
    "configurationExposed",
    "ttsInput",
    "configurationStorage",
  ]) {
    assert.deepEqual(manifest[field], ["language", "speed"]);
  }
  assert.deepEqual(manifest.configurationRequired, []);
  assert.equal(manifest.storageKey, "gptsovits");

  const languageValues = options.languages.map((language) => language.value);
  assert.ok(languageValues.includes(manifest.defaultsConfiguration.language));
  assert.ok(languageValues.includes("EN_US"));
  assert.ok(languageValues.includes("JA_JP"));
});
