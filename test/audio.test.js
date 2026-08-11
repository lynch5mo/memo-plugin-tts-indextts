const test = require("node:test");
const assert = require("node:assert/strict");

test("empty text returns a 100ms mono PCM WAV Buffer", async () => {
  const TTS = require("../index.js").default;
  const result = await new TTS().textToSpeech({ text: "  " });
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(result.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(result.readUInt32LE(24), 32000);
  assert.equal(result.readUInt16LE(22), 1);
  assert.equal(result.readUInt16LE(34), 16);
  assert.equal(result.length, 44 + 3200 * 2);
});
