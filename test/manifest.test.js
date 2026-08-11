const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");

test("declares an independent Memo TTS provider", () => {
  assert.equal(manifest.manifestVersion, "1");
  assert.equal(manifest.pluginId, "memo-plugin-tts-gptsovits");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.type, "tts");
  assert.deepEqual(manifest.platforms, ["darwin"]);
  assert.deepEqual(manifest.arch, ["arm64"]);
  assert.equal(manifest.provider.value, "GPT-SoVITS TTS");
});
