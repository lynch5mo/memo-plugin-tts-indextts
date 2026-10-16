"use strict";

// 只读音色目录：显式读取单个 catalog 文件，不做目录初始化，也不写入任何文件。
// 指纹/就绪度只反映目录声明，不宣称真实服务已经验证。

const fs = require("node:fs");
const path = require("node:path");

const { decodeVoiceValue } = require("./voice-value.js");

const SCHEMA_VERSION = 1;
const BACKENDS = ["audio8", "gpt-sovits"];
const READINESS_VALUES = ["ready", "unverified", "invalid", "needsPreparation"];
const PERSISTENCE_VALUES = ["saved", "temporary", "external"];
const READY = "ready";
const COLLECTIONS = ["endpoints", "profiles", "bindings"];

// 目录文件上限：1 MiB。超限时在整文件分配与读取之前就拒绝。
const MAX_CATALOG_BYTES = 1024 * 1024;
// 原生音色指纹固定为 64 位十六进制 SHA-256。
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
// 不得混入 params 的身份字段：声音选择值四段身份 + 原生音色指纹。
const IDENTITY_PARAM_KEYS = [
  "backendId",
  "endpointId",
  "bindingId",
  "revision",
  "nativeVoiceFingerprint",
];

function createError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) {
    Object.assign(error, extra);
  }
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

function assertPositiveInteger(value, field, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw createError(code, `${field} 必须是正安全整数，收到 ${JSON.stringify(value)}。`);
  }
}

function assertAbsolutePath(value, field, code) {
  if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value)) {
    throw createError(code, `${field} 必须是非空绝对路径，收到 ${JSON.stringify(value)}。`);
  }
}

function validateBaseUrl(baseUrl, id) {
  const code = "ERR_CATALOG_ENDPOINT";
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw createError(code, `endpoint ${id} 缺少 baseUrl。`);
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw createError(code, `endpoint ${id} 的 baseUrl 不是合法 URL。`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createError(code, `endpoint ${id} 只支持 http/https，收到 ${parsed.protocol}。`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw createError(code, `endpoint ${id} 的 baseUrl 携带凭据，按策略拒绝。`);
  }
}

function validateEndpoint(raw) {
  const code = "ERR_CATALOG_ENDPOINT";
  if (!isPlainObject(raw)) {
    throw createError(code, "endpoint 必须是普通对象。");
  }
  assertNonEmptyString(raw.id, "endpoint.id", code);
  if (!BACKENDS.includes(raw.backendId)) {
    throw createError(code, `endpoint ${raw.id} 的 backendId ${JSON.stringify(raw.backendId)} 不受支持。`);
  }
  validateBaseUrl(raw.baseUrl, raw.id);
  assertNonEmptyString(raw.modelFingerprint, `endpoint ${raw.id}.modelFingerprint`, code);
  if (!READINESS_VALUES.includes(raw.readiness)) {
    throw createError(
      code,
      `endpoint ${raw.id} 的 readiness ${JSON.stringify(raw.readiness)} 不在 ${READINESS_VALUES.join("/")} 内。`,
    );
  }
  if (raw.backendId === "audio8") {
    assertAbsolutePath(raw.runtimeManifestPath, `endpoint ${raw.id}.runtimeManifestPath`, code);
    assertAbsolutePath(raw.voicesRoot, `endpoint ${raw.id}.voicesRoot`, code);
    assertNonEmptyString(raw.precision, `endpoint ${raw.id}.precision`, code);
    assertNonEmptyString(raw.codecPrecision, `endpoint ${raw.id}.codecPrecision`, code);
  }

  return { ...raw };
}

function validateProfile(raw) {
  const code = "ERR_CATALOG_PROFILE";
  if (!isPlainObject(raw)) {
    throw createError(code, "profile 必须是普通对象。");
  }
  assertNonEmptyString(raw.id, "profile.id", code);
  assertNonEmptyString(raw.label, "profile.label", code);
  if (!PERSISTENCE_VALUES.includes(raw.persistence)) {
    throw createError(
      code,
      `profile ${raw.id} 的 persistence ${JSON.stringify(raw.persistence)} 不在 ${PERSISTENCE_VALUES.join("/")} 内。`,
    );
  }
  // owner 只表示记录归属（哪个管理流程写下这条资料），不代表对文件的删除授权。
  assertNonEmptyString(raw.owner, `profile ${raw.id}.owner`, code);

  // external 资料可以没有 source；有 source 时字段必须是数据，不据缺项宣称可迁移。
  const copy = { ...raw };
  if (raw.source !== undefined) {
    if (!isPlainObject(raw.source)) {
      throw createError(code, `profile ${raw.id}.source 必须是普通对象。`);
    }
    if (raw.source.audioPath !== undefined) {
      assertAbsolutePath(raw.source.audioPath, `profile ${raw.id}.source.audioPath`, code);
    }
    if (raw.source.referenceText !== undefined) {
      assertNonEmptyString(raw.source.referenceText, `profile ${raw.id}.source.referenceText`, code);
    }
    if (raw.source.language !== undefined) {
      assertNonEmptyString(raw.source.language, `profile ${raw.id}.source.language`, code);
    }
    copy.source = { ...raw.source };
  }

  return copy;
}

function validateBinding(raw) {
  const code = "ERR_CATALOG_BINDING";
  if (!isPlainObject(raw)) {
    throw createError(code, "binding 必须是普通对象。");
  }
  assertNonEmptyString(raw.id, "binding.id", code);
  assertNonEmptyString(raw.profileId, `binding ${raw.id}.profileId`, code);
  if (!BACKENDS.includes(raw.backendId)) {
    throw createError(code, `binding ${raw.id} 的 backendId ${JSON.stringify(raw.backendId)} 不受支持。`);
  }
  assertNonEmptyString(raw.endpointId, `binding ${raw.id}.endpointId`, code);
  assertNonEmptyString(raw.nativeVoiceId, `binding ${raw.id}.nativeVoiceId`, code);
  assertNonEmptyString(raw.modelFingerprint, `binding ${raw.id}.modelFingerprint`, code);
  assertPositiveInteger(raw.revision, `binding ${raw.id}.revision`, code);
  if (!READINESS_VALUES.includes(raw.status)) {
    throw createError(
      code,
      `binding ${raw.id} 的 status ${JSON.stringify(raw.status)} 不在 ${READINESS_VALUES.join("/")} 内。`,
    );
  }
  if (!isPlainObject(raw.params)) {
    throw createError(code, `binding ${raw.id}.params 必须是普通对象。`);
  }
  for (const key of IDENTITY_PARAM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw.params, key)) {
      throw createError(code, `binding ${raw.id} 的 params 不得包含身份字段 ${key}。`);
    }
  }

  const fingerprint = raw.nativeVoiceFingerprint;
  const hasFingerprint = fingerprint !== undefined && fingerprint !== null;
  if (
    hasFingerprint &&
    (typeof fingerprint !== "string" || !SHA256_HEX_PATTERN.test(fingerprint))
  ) {
    throw createError(
      code,
      `binding ${raw.id}.nativeVoiceFingerprint 必须是 64 位十六进制 SHA-256，收到 ${JSON.stringify(fingerprint)}。`,
    );
  }
  // ready 的 Audio8 绑定必须已经记下原生音色身份；非 ready 允许暂缺，但一旦提供就必须合法。
  if (raw.backendId === "audio8" && raw.status === READY && !hasFingerprint) {
    throw createError(
      code,
      `binding ${raw.id} 是 ready 的 Audio8 绑定，必须提供有效的 nativeVoiceFingerprint。`,
    );
  }

  return { ...raw, params: { ...raw.params } };
}

function indexById(items, kind) {
  const index = new Map();
  for (const item of items) {
    if (index.has(item.id)) {
      throw createError("ERR_CATALOG_DUPLICATE", `目录中出现重复的 ${kind} id ${item.id}。`);
    }
    index.set(item.id, item);
  }
  return index;
}

function validateCatalog(raw) {
  if (!isPlainObject(raw)) {
    throw createError("ERR_CATALOG_SCHEMA", "目录根必须是普通对象。");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw createError(
      "ERR_CATALOG_SCHEMA",
      `schemaVersion 必须等于 ${SCHEMA_VERSION}，收到 ${JSON.stringify(raw.schemaVersion)}。`,
    );
  }
  for (const key of COLLECTIONS) {
    if (!Array.isArray(raw[key])) {
      throw createError("ERR_CATALOG_SCHEMA", `目录字段 ${key} 必须是数组。`);
    }
  }

  const endpoints = raw.endpoints.map(validateEndpoint);
  const profiles = raw.profiles.map(validateProfile);
  const bindings = raw.bindings.map(validateBinding);

  const endpointById = indexById(endpoints, "endpoint");
  const profileById = indexById(profiles, "profile");
  indexById(bindings, "binding");

  for (const binding of bindings) {
    const endpoint = endpointById.get(binding.endpointId);
    if (!endpoint) {
      throw createError(
        "ERR_CATALOG_REFERENCE",
        `binding ${binding.id} 引用了不存在的 endpoint ${binding.endpointId}。`,
      );
    }
    if (!profileById.has(binding.profileId)) {
      throw createError(
        "ERR_CATALOG_REFERENCE",
        `binding ${binding.id} 引用了不存在的 profile ${binding.profileId}。`,
      );
    }
    if (binding.backendId !== endpoint.backendId) {
      throw createError(
        "ERR_CATALOG_CONFLICT",
        `binding ${binding.id} 的后端 ${binding.backendId} 与 endpoint ${endpoint.id} 的 ${endpoint.backendId} 不一致。`,
      );
    }
    if (binding.modelFingerprint !== endpoint.modelFingerprint) {
      throw createError(
        "ERR_CATALOG_CONFLICT",
        `binding ${binding.id} 的模型指纹与 endpoint ${endpoint.id} 不一致，需重新准备并提升 revision。`,
      );
    }
  }

  return deepFreeze({ schemaVersion: SCHEMA_VERSION, endpoints, profiles, bindings });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

// 以文件描述符打开已核验的真实文件：最终组件禁用符号链接（平台支持 O_NOFOLLOW 时），
// 再用 fstat 比对 dev/ino，避免“核验后按路径重新读取”被替换成别的文件。
// 说明：Node 标准库没有 openat/renameat，父目录级别的换名竞态无法完全封堵；
// 这里缩小窗口并保证读的是已核验 inode，不宣称绝对消除 TOCTOU。
function openCatalogFile(realFile, expectedIdentity) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

  let fd;
  try {
    fd = fs.openSync(realFile, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && error.code === "ELOOP") {
      throw createError(
        "ERR_CATALOG_BOUNDARY",
        `目录文件 ${realFile} 在核验后被替换为符号链接，按策略拒绝。`,
        { cause: error },
      );
    }
    throw createError("ERR_CATALOG_READ", `无法打开目录文件 ${realFile}。`, { cause: error });
  }

  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_CATALOG_READ", `目录路径 ${realFile} 不是普通文件。`);
    }
    if (
      expectedIdentity &&
      (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino)
    ) {
      throw createError(
        "ERR_CATALOG_READ",
        "目录文件在核验后被替换为另一个文件（inode 变化），按策略拒绝。",
      );
    }
    if (opened.size > MAX_CATALOG_BYTES) {
      throw createError(
        "ERR_CATALOG_TOO_LARGE",
        `目录文件 ${opened.size} 字节超过上限 ${MAX_CATALOG_BYTES} 字节。`,
      );
    }
    return fd;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    throw error;
  }
}

// 有界读取：预分配上限 +1 字节并按位置读取，绝不按文件声明大小一次性分配。
// 读取期间文件增长导致总量超过上限时同样拒绝。
function readCatalogText(fd, hooks) {
  const cap = MAX_CATALOG_BYTES + 1;
  if (hooks && typeof hooks.beforeRead === "function") {
    hooks.beforeRead();
  }

  const buffer = Buffer.allocUnsafe(cap);
  let offset = 0;
  while (offset < cap) {
    const bytesRead = fs.readSync(fd, buffer, offset, cap - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  if (offset > MAX_CATALOG_BYTES) {
    throw createError(
      "ERR_CATALOG_TOO_LARGE",
      `目录文件超过上限 ${MAX_CATALOG_BYTES} 字节，已在读取过程中停止。`,
    );
  }

  return buffer.toString("utf8", 0, offset);
}

function readCatalog(catalogPath) {
  if (typeof catalogPath !== "string" || catalogPath.trim() === "") {
    throw createError("ERR_CATALOG_INPUT", "catalogPath 必须是非空字符串路径。");
  }

  // 本版约定 catalogPath 就是 catalog.json 文件路径，不是目录，也不自动初始化。
  const lexical = path.resolve(catalogPath);

  let stats;
  try {
    stats = fs.statSync(lexical);
  } catch (error) {
    throw createError("ERR_CATALOG_READ", `无法读取目录文件 ${lexical}。`, { cause: error });
  }
  if (!stats.isFile()) {
    throw createError(
      "ERR_CATALOG_READ",
      `目录路径 ${lexical} 不是普通文件（本版要求 catalog.json 文件路径）。`,
    );
  }
  if (stats.size > MAX_CATALOG_BYTES) {
    throw createError(
      "ERR_CATALOG_TOO_LARGE",
      `目录文件 ${stats.size} 字节超过上限 ${MAX_CATALOG_BYTES} 字节。`,
    );
  }

  // 边界：真实文件必须仍位于其声明目录之内；同目录内文件链接允许，跨目录链接拒绝。
  let realFile;
  let realDir;
  try {
    realFile = fs.realpathSync(lexical);
    realDir = fs.realpathSync(path.dirname(lexical));
  } catch (error) {
    throw createError("ERR_CATALOG_READ", `无法解析目录文件真实路径 ${lexical}。`, { cause: error });
  }
  if (path.dirname(realFile) !== realDir) {
    throw createError(
      "ERR_CATALOG_BOUNDARY",
      "目录文件经符号链接离开了所在目录，按策略拒绝读取。",
    );
  }

  const fd = openCatalogFile(realFile, { dev: stats.dev, ino: stats.ino });
  let content;
  try {
    content = readCatalogText(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖既有错误。
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw createError("ERR_CATALOG_JSON", "目录文件不是合法 JSON。");
  }

  return validateCatalog(parsed);
}

function findById(items, id) {
  return items.find((item) => isPlainObject(item) && item.id === id);
}

function resolveBinding(catalog, model, voiceValue) {
  if (!BACKENDS.includes(model)) {
    throw createError(
      "ERR_BINDING_MODEL",
      `model 必须是 ${BACKENDS.join(" 或 ")}，收到 ${JSON.stringify(model)}。`,
    );
  }
  if (!isPlainObject(catalog)) {
    throw createError("ERR_CATALOG_SCHEMA", "目录必须是普通对象。");
  }
  for (const key of COLLECTIONS) {
    if (!Array.isArray(catalog[key])) {
      throw createError("ERR_CATALOG_SCHEMA", `目录字段 ${key} 必须是数组。`);
    }
  }

  const decoded = decodeVoiceValue(voiceValue);
  if (decoded.backendId !== model) {
    throw createError(
      "ERR_BINDING_BACKEND_MISMATCH",
      `声音值绑定到 ${decoded.backendId}，与请求的 ${model} 不一致，必须重新选择音色。`,
    );
  }

  const binding = findById(catalog.bindings, decoded.bindingId);
  if (!binding) {
    throw createError("ERR_BINDING_MISSING", `目录中不存在 binding ${decoded.bindingId}。`);
  }
  if (binding.backendId !== model) {
    throw createError(
      "ERR_BINDING_BACKEND_MISMATCH",
      `binding ${binding.id} 属于 ${binding.backendId}，与请求的 ${model} 不一致。`,
    );
  }
  if (binding.revision !== decoded.revision) {
    throw createError(
      "ERR_BINDING_REVISION",
      `声音值 revision ${decoded.revision} 与 binding ${binding.id} 的 ${binding.revision} 不一致，绑定已过期。`,
    );
  }
  if (binding.endpointId !== decoded.endpointId) {
    throw createError(
      "ERR_BINDING_ENDPOINT_MISMATCH",
      `声音值 endpointId ${decoded.endpointId} 与 binding ${binding.id} 的 ${binding.endpointId} 不一致。`,
    );
  }

  const endpoint = findById(catalog.endpoints, binding.endpointId);
  if (!endpoint) {
    throw createError("ERR_BINDING_ENDPOINT_MISSING", `binding ${binding.id} 引用的 endpoint 不存在。`);
  }
  if (endpoint.backendId !== model) {
    throw createError(
      "ERR_BINDING_BACKEND_MISMATCH",
      `endpoint ${endpoint.id} 属于 ${endpoint.backendId}，与请求的 ${model} 不一致。`,
    );
  }
  if (binding.modelFingerprint !== endpoint.modelFingerprint) {
    throw createError(
      "ERR_BINDING_FINGERPRINT",
      `binding ${binding.id} 与 endpoint ${endpoint.id} 的模型指纹不一致，需重新准备音色。`,
    );
  }
  if (binding.status !== READY) {
    throw createError(
      "ERR_BINDING_NOT_READY",
      `binding ${binding.id} 状态为 ${binding.status}，尚不可用于合成。`,
    );
  }
  if (endpoint.readiness !== READY) {
    throw createError(
      "ERR_ENDPOINT_NOT_READY",
      `endpoint ${endpoint.id} 就绪度为 ${endpoint.readiness}，尚不可用于合成。`,
    );
  }

  const profile = findById(catalog.profiles, binding.profileId);
  if (!profile) {
    throw createError("ERR_BINDING_PROFILE_MISSING", `binding ${binding.id} 引用的 profile 不存在。`);
  }

  // 固定快照：深拷贝后冻结，调用后目录对象再变化也不影响已解析的绑定。
  return deepFreeze({
    endpoint: cloneValue(endpoint),
    profile: cloneValue(profile),
    binding: cloneValue(binding),
  });
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      // 用自有数据属性写入：键名为 __proto__ 时也不会触发原型设置器，递归同名键同样安全。
      Object.defineProperty(copy, key, {
        value: cloneValue(item),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

// 管理数据层复用的纯校验入口：先做安全深拷贝（保留自有 __proto__ 数据键、不改原型、
// 不 JSON 序列化吞值），再交给既有 validateCatalog 校验并深冻结。这样输入及所有嵌套
// metadata/params/source 保持原引用与可写状态，输出与输入不共享嵌套引用。
function validateCatalogData(raw) {
  return validateCatalog(cloneValue(raw));
}

module.exports = {
  readCatalog,
  // 主控授权的最小上游扩展：把既有的纯 schema 校验函数公开给管理数据层复用，
  // 避免调用方复制目录规则或为拿内容而按路径重读文件；对入参是严格纯净的。
  validateCatalogData,
  resolveBinding,
  SCHEMA_VERSION,
  BACKENDS,
  READINESS_VALUES,
  PERSISTENCE_VALUES,
  MAX_CATALOG_BYTES,
  // 仅供测试夹具直接驱动内部防护（大小上限、inode 比对、O_NOFOLLOW、读取期增长）。
  // 生产调用一律走 readCatalog，不额外导出为公开 API。
  __testHooks: { openCatalogFile, readCatalogText },
};
