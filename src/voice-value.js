"use strict";

// 音色身份编码：声音选择值只承载 backendId/endpointId/bindingId/revision 四段身份，
// 全程作为数据解析，绝不作为代码或模块路径执行。

const crypto = require("node:crypto");

const VOICE_VALUE_PREFIX = "localtts:v1:";
const VOICE_FIELDS = ["backendId", "endpointId", "bindingId", "revision"];
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

// Audio8 原生音色身份摘要固定取这七个字段，顺序即指纹输入顺序。
const VOICE_FINGERPRINT_FIELDS = [
  "name",
  "reference_text",
  "source_sha256",
  "model_fingerprint",
  "shape",
  "dtype",
  "sample_rate",
];

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value, field, code) {
  if (typeof value !== "string" || value.trim() === "") {
    throw createError(code, `${field} 必须是非空字符串，收到 ${JSON.stringify(value)}。`);
  }
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw createError(
      "ERR_VOICE_VALUE_REVISION",
      `revision 必须是正安全整数，收到 ${JSON.stringify(revision)}。`,
    );
  }
}

function encodeVoiceValue(identity) {
  if (!isPlainObject(identity)) {
    throw createError("ERR_VOICE_VALUE_INPUT", "音色身份必须是普通对象。");
  }

  const { backendId, endpointId, bindingId, revision } = identity;
  assertNonEmptyString(backendId, "backendId", "ERR_VOICE_VALUE_FIELD");
  assertNonEmptyString(endpointId, "endpointId", "ERR_VOICE_VALUE_FIELD");
  assertNonEmptyString(bindingId, "bindingId", "ERR_VOICE_VALUE_FIELD");
  assertRevision(revision);

  // 固定字段顺序，保证等价对象产出同一字符串，便于缓存命中判定。
  const payload = JSON.stringify({ backendId, endpointId, bindingId, revision });
  return VOICE_VALUE_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

function decodeBase64Url(body) {
  if (body === "" || !BASE64URL_PATTERN.test(body) || body.length % 4 === 1) {
    throw createError("ERR_VOICE_VALUE_ENCODING", "音色身份正文不是合法的 base64url。");
  }
  const bytes = Buffer.from(body, "base64url");
  // 回写比对可拒绝非规范编码（例如多余填充或非零填充位）。
  if (bytes.toString("base64url") !== body) {
    throw createError("ERR_VOICE_VALUE_ENCODING", "音色身份正文不是规范 base64url 编码。");
  }
  return bytes;
}

function decodeVoiceValue(value) {
  if (typeof value !== "string") {
    throw createError("ERR_VOICE_VALUE_INPUT", "音色身份必须是字符串。");
  }
  if (!value.startsWith(VOICE_VALUE_PREFIX)) {
    throw createError(
      "ERR_VOICE_VALUE_PREFIX",
      `音色身份缺少前缀 ${VOICE_VALUE_PREFIX}（含版本号），按策略拒绝。`,
    );
  }

  const bytes = decodeBase64Url(value.slice(VOICE_VALUE_PREFIX.length));

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw createError("ERR_VOICE_VALUE_JSON", "音色身份正文不是合法 JSON。");
  }
  if (!isPlainObject(parsed)) {
    throw createError("ERR_VOICE_VALUE_JSON", "音色身份正文必须是 JSON 对象。");
  }

  const keys = Object.keys(parsed);
  const hasExactly = keys.length === VOICE_FIELDS.length;
  const hasAll = VOICE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(parsed, field));
  if (!hasExactly || !hasAll) {
    throw createError(
      "ERR_VOICE_VALUE_SHAPE",
      `音色身份字段必须恰好是 ${VOICE_FIELDS.join("/")}，不得缺失或多余。`,
    );
  }

  const { backendId, endpointId, bindingId, revision } = parsed;
  assertNonEmptyString(backendId, "backendId", "ERR_VOICE_VALUE_FIELD");
  assertNonEmptyString(endpointId, "endpointId", "ERR_VOICE_VALUE_FIELD");
  assertNonEmptyString(bindingId, "bindingId", "ERR_VOICE_VALUE_FIELD");
  assertRevision(revision);

  return { backendId, endpointId, bindingId, revision };
}

function voiceFingerprint(meta) {
  if (!isPlainObject(meta)) {
    throw createError("ERR_VOICE_FINGERPRINT_INPUT", "音色元数据必须是普通对象。");
  }

  const ordered = {};
  for (const field of VOICE_FINGERPRINT_FIELDS) {
    const value = meta[field];
    if (value === undefined || value === null) {
      throw createError(
        "ERR_VOICE_FINGERPRINT_INPUT",
        `音色元数据缺少身份字段 ${field}，无法计算指纹。`,
      );
    }
    ordered[field] = value;
  }

  return crypto.createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

module.exports = {
  encodeVoiceValue,
  decodeVoiceValue,
  voiceFingerprint,
  VOICE_VALUE_PREFIX,
  VOICE_FINGERPRINT_FIELDS,
};
