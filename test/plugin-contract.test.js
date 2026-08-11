const test = require("node:test");
const assert = require("node:assert/strict");

test("exposes a constructor and a Buffer-producing textToSpeech", async () => {
  const plugin = require("../index.js");
  assert.equal(typeof plugin.default, "function");
  const result = await new plugin.default().textToSpeech({ text: "" });
  assert.ok(Buffer.isBuffer(result));
});
