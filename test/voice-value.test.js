"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  encodeVoiceValue,
  decodeVoiceValue,
  voiceFingerprint,
  VOICE_VALUE_PREFIX,
} = require("../src/voice-value.js");

function assertErrorCode(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
      return true;
    },
  );
}

function toBase64Url(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

const SAMPLE = {
  backendId: "audio8",
  endpointId: "ep-audio8",
  bindingId: "binding-lin-audio8",
  revision: 1,
};

test("encode/decode 往返得到同一身份对象", () => {
  const encoded = encodeVoiceValue(SAMPLE);

  assert.ok(encoded.startsWith(VOICE_VALUE_PREFIX));
  assert.deepEqual(decodeVoiceValue(encoded), SAMPLE);
});

test("正文字符集严格为 base64url，不含 +、/ 与 = 填充", () => {
  const encoded = encodeVoiceValue(SAMPLE);
  const body = encoded.slice(VOICE_VALUE_PREFIX.length);

  assert.match(body, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(body, "base64url").toString("base64url"), body);
});

test("字段书写顺序固定，等价对象产出同一字符串", () => {
  const reordered = {
    revision: 1,
    bindingId: "binding-lin-audio8",
    endpointId: "ep-audio8",
    backendId: "audio8",
  };

  assert.equal(encodeVoiceValue(reordered), encodeVoiceValue(SAMPLE));
});

test("大整数 revision 也能精确往返", () => {
  const value = encodeVoiceValue({ ...SAMPLE, revision: 9007199254740991 });
  assert.equal(decodeVoiceValue(value).revision, 9007199254740991);
});

test("encode 拒绝非法参数与非法字段", () => {
  assertErrorCode(() => encodeVoiceValue(undefined), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => encodeVoiceValue(null), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => encodeVoiceValue([]), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => encodeVoiceValue("audio8"), "ERR_VOICE_VALUE_INPUT");

  assertErrorCode(() => encodeVoiceValue({ ...SAMPLE, backendId: "" }), "ERR_VOICE_VALUE_FIELD");
  assertErrorCode(() => encodeVoiceValue({ ...SAMPLE, endpointId: "   " }), "ERR_VOICE_VALUE_FIELD");
  assertErrorCode(() => encodeVoiceValue({ ...SAMPLE, bindingId: 7 }), "ERR_VOICE_VALUE_FIELD");
});

test("encode 只接受正整数 revision", () => {
  for (const revision of [
    0,
    -1,
    1.5,
    Number.NaN,
    "1",
    null,
    undefined,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1e21,
  ]) {
    assertErrorCode(
      () => encodeVoiceValue({ ...SAMPLE, revision }),
      "ERR_VOICE_VALUE_REVISION",
    );
  }
});

test("encode 接受最大安全整数 revision", () => {
  const encoded = encodeVoiceValue({ ...SAMPLE, revision: Number.MAX_SAFE_INTEGER });
  assert.equal(decodeVoiceValue(encoded).revision, Number.MAX_SAFE_INTEGER);
});

test("decode 拒绝非字符串、空值与错误前缀（含非法版本）", () => {
  assertErrorCode(() => decodeVoiceValue(undefined), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => decodeVoiceValue(null), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => decodeVoiceValue(42), "ERR_VOICE_VALUE_INPUT");
  assertErrorCode(() => decodeVoiceValue(""), "ERR_VOICE_VALUE_PREFIX");
  assertErrorCode(() => decodeVoiceValue("audio8:xyz"), "ERR_VOICE_VALUE_PREFIX");
  assertErrorCode(() => decodeVoiceValue("localtts:v2:AAAA"), "ERR_VOICE_VALUE_PREFIX");
  assertErrorCode(() => decodeVoiceValue("localtTS:v1:AAAA"), "ERR_VOICE_VALUE_PREFIX");
});

test("decode 拒绝非 base64url 正文", () => {
  assertErrorCode(() => decodeVoiceValue(`${VOICE_VALUE_PREFIX}A`), "ERR_VOICE_VALUE_ENCODING");
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(JSON.stringify(SAMPLE))}=`),
    "ERR_VOICE_VALUE_ENCODING",
  );
  assertErrorCode(() => decodeVoiceValue(`${VOICE_VALUE_PREFIX}ab+c`), "ERR_VOICE_VALUE_ENCODING");
  assertErrorCode(() => decodeVoiceValue(`${VOICE_VALUE_PREFIX}ab/c`), "ERR_VOICE_VALUE_ENCODING");
});

test("decode 拒绝非法 JSON 与非对象 JSON", () => {
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url("{not json")}`),
    "ERR_VOICE_VALUE_JSON",
  );
  for (const payload of ["null", "42", '"text"', "[1,2,3]"]) {
    assertErrorCode(
      () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(payload)}`),
      "ERR_VOICE_VALUE_JSON",
    );
  }
});

test("decode 拒绝字段缺失、多余与空值", () => {
  const missing = { backendId: "audio8", endpointId: "ep-audio8", bindingId: "b" };
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(JSON.stringify(missing))}`),
    "ERR_VOICE_VALUE_SHAPE",
  );

  const extra = { ...SAMPLE, nickname: "lin" };
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(JSON.stringify(extra))}`),
    "ERR_VOICE_VALUE_SHAPE",
  );

  const blank = { ...SAMPLE, bindingId: "  " };
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(JSON.stringify(blank))}`),
    "ERR_VOICE_VALUE_FIELD",
  );
});

test("decode 只接受正整数 revision，且绝不把输入当作代码执行", () => {
  for (const revision of [0, -2, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = JSON.stringify({ ...SAMPLE, revision });
    assertErrorCode(
      () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(payload)}`),
      "ERR_VOICE_VALUE_REVISION",
    );
  }

  // JSON 文本里的超幅整数字面量也必须按不安全整数拒绝。
  const unsafeLiteral =
    '{"backendId":"audio8","endpointId":"ep-audio8","bindingId":"b","revision":9007199254740993}';
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(unsafeLiteral)}`),
    "ERR_VOICE_VALUE_REVISION",
  );

  // 若实现错误地 eval/Function 了输入，这里会真的把进程标记为被污染。
  const hostile = "${process.exit(1)}";
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(hostile)}`),
    "ERR_VOICE_VALUE_JSON",
  );
});

test("decode 不产生原型污染副作用", () => {
  // 直接用 JSON 文本构造 __proto__ 自有键，避免对象字面量把它当成原型设置。
  const payload =
    '{"backendId":"audio8","endpointId":"ep-audio8","bindingId":"b","revision":1,"__proto__":{"polluted":true}}';
  assertErrorCode(
    () => decodeVoiceValue(`${VOICE_VALUE_PREFIX}${toBase64Url(payload)}`),
    "ERR_VOICE_VALUE_SHAPE",
  );
  assert.equal({}.polluted, undefined);
});

function expectedFingerprint(meta) {
  const ordered = {
    name: meta.name,
    reference_text: meta.reference_text,
    source_sha256: meta.source_sha256,
    model_fingerprint: meta.model_fingerprint,
    shape: meta.shape,
    dtype: meta.dtype,
    sample_rate: meta.sample_rate,
  };
  return crypto.createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

const VOICE_META = {
  name: "lin",
  reference_text: "这是参考原文。",
  shape: [1, 128],
  dtype: "float32",
  sample_rate: 32000,
  source_audio: "/Users/lynch5mo/Applications/Audio8_TTS/refs/lin.wav",
  source_sha256: "a".repeat(64),
  model_fingerprint: "fp-audio8-001",
};

test("voiceFingerprint 对同一元数据稳定，并与固定字段顺序一致", () => {
  const fingerprint = voiceFingerprint(VOICE_META);

  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, voiceFingerprint({ ...VOICE_META }));
  assert.equal(fingerprint, expectedFingerprint(VOICE_META));
});

test("voiceFingerprint 随任一身份字段变化而变化", () => {
  const base = voiceFingerprint(VOICE_META);

  for (const patch of [
    { name: "lin-2" },
    { reference_text: "换了参考原文。" },
    { source_sha256: "b".repeat(64) },
    { model_fingerprint: "fp-audio8-002" },
    { shape: [1, 256] },
    { dtype: "float16" },
    { sample_rate: 44100 },
  ]) {
    assert.notEqual(voiceFingerprint({ ...VOICE_META, ...patch }), base);
  }
});

test("voiceFingerprint 只取约定的七个字段，非身份字段不参与", () => {
  const base = voiceFingerprint(VOICE_META);

  assert.equal(voiceFingerprint({ ...VOICE_META, source_audio: "/elsewhere/other.wav" }), base);
  assert.equal(voiceFingerprint({ ...VOICE_META, extra: "ignored" }), base);
});

test("voiceFingerprint 拒绝缺失身份字段与非对象输入", () => {
  assertErrorCode(() => voiceFingerprint(undefined), "ERR_VOICE_FINGERPRINT_INPUT");
  assertErrorCode(() => voiceFingerprint([]), "ERR_VOICE_FINGERPRINT_INPUT");

  for (const key of [
    "name",
    "reference_text",
    "source_sha256",
    "model_fingerprint",
    "shape",
    "dtype",
    "sample_rate",
  ]) {
    const meta = { ...VOICE_META };
    delete meta[key];
    assertErrorCode(() => voiceFingerprint(meta), "ERR_VOICE_FINGERPRINT_INPUT");
  }
});
