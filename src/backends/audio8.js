"use strict";

// Audio8 适配器：只消费本机 loopback HTTP，身份以同进程 /api/memo/runtime 为准，
// 不支持语速/情感/目标语言，采样参数按安装契约白名单映射，参数对象不做泛化展开。

const fs = require("node:fs");
const path = require("node:path");

const {
  request,
  DEFAULT_SYNTHESIS_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
} = require("../http-client.js");
const { parseWav, joinWav, MAX_CONTAINER_BYTES } = require("../wav.js");
const { splitText, MAX_INPUT_CODE_POINTS } = require("../text.js");
const { voiceFingerprint } = require("../voice-value.js");

const BACKEND_ID = "audio8";
const SEGMENT_CODE_POINTS = 120;
const IDENTITY_PATH = "/api/memo/runtime";
const HEALTH_PATH = "/api/health";
const VOICES_PATH = "/api/voices";
const SYNTHESIZE_PATH = "/api/tts";
const PROBE_MAX_BYTES = 1024 * 1024;

// 与 wav.js 的规范化 WAV 容器头部同口径（44 字节头 + PCM 数据）。
const WAV_CONTAINER_HEADER_BYTES = 44;

// manifest 与每份声音 meta.json 的读取上限：有界 fd 读取，不按声明大小一次性分配。
const MAX_JSON_BYTES = 1024 * 1024;

// 安装契约 TtsRequest 允许的字段；Audio8 没有 speed/rate/emotion/目标 language。
const SAMPLING_PARAMETERS = Object.freeze({
  max_new_tokens: { kind: "integer", min: 16, max: 2048 },
  temperature: { kind: "number", min: 0, minExclusive: true, max: 2 },
  top_p: { kind: "number", min: 0, minExclusive: true, max: 1 },
  top_k: { kind: "integer", min: 1, max: 4096 },
  seed: { kind: "integer", min: null, max: null },
});

const IDENTITY_PARAMETER_KEYS = Object.freeze([
  "backendId",
  "endpointId",
  "bindingId",
  "revision",
  "nativeVoiceFingerprint",
  "nativeVoiceId",
  "profileId",
  "modelFingerprint",
]);

const capabilities = Object.freeze({
  backendId: BACKEND_ID,
  transport: "http-loopback",
  supportsSpeed: false,
  supportsEmotion: false,
  supportsLanguageHint: false,
  supportsStreaming: false,
  filtersVoicesByReferenceLanguage: false,
  segmentCodePoints: SEGMENT_CODE_POINTS,
  maxInputCodePoints: MAX_INPUT_CODE_POINTS,
  maxContainerBytes: MAX_CONTAINER_BYTES,
  maxResponseBytes: DEFAULT_MAX_BYTES,
  bitsPerSample: 16,
  maxChannels: 2,
  samplingParameters: SAMPLING_PARAMETERS,
  unsupportedParameters: Object.freeze([
    "speed",
    "rate",
    "emotion",
    "language",
    "target_language",
    "languageHint",
  ]),
  endpoints: Object.freeze({
    health: HEALTH_PATH,
    voices: VOICES_PATH,
    synthesize: SYNTHESIZE_PATH,
    runtimeIdentity: IDENTITY_PATH,
  }),
});

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

function isPolicyError(error) {
  return Boolean(error) && typeof error.code === "string" && error.code.startsWith("ERR_ENDPOINT");
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw createError("ERR_AUDIO8_ENDPOINT", `endpoint 字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireNonEmptyString(value, field);
  if (!path.isAbsolute(value)) {
    throw createError("ERR_AUDIO8_ENDPOINT", `endpoint 字段 ${field} 必须是绝对路径。`);
  }
  return value;
}

// 可选覆盖只允许收紧，不得超过底座安全口径；显式非法值一律拒绝，不悄悄回退默认。
const OVERRIDE_LIMITS = Object.freeze({
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  synthesisTimeoutMs: DEFAULT_SYNTHESIS_TIMEOUT_MS,
  maxContainerBytes: MAX_CONTAINER_BYTES,
});

function resolveOptionalOverride(endpoint, field) {
  const value = endpoint[field];
  if (value === undefined) {
    return OVERRIDE_LIMITS[field];
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createError(
      "ERR_AUDIO8_ENDPOINT",
      `endpoint 字段 ${field} 必须是正安全整数，收到 ${String(value)}。`,
    );
  }
  if (value > OVERRIDE_LIMITS[field]) {
    throw createError(
      "ERR_AUDIO8_ENDPOINT",
      `endpoint 字段 ${field} 不得超过安全上限 ${OVERRIDE_LIMITS[field]}，收到 ${value}。`,
    );
  }
  return value;
}

// 深拷贝并写为自有数据属性：__proto__ 之类的键名不会改写原型，也不修改调用方对象。
function snapshotValue(value) {
  if (Array.isArray(value)) {
    return value.map(snapshotValue);
  }
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: snapshotValue(item),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

// 最小明确的 context：probe 用 { endpoint }，listVoices 用 { endpoint, catalog }。
function resolveEndpoint(endpoint) {
  if (!isPlainObject(endpoint)) {
    throw createError("ERR_AUDIO8_ENDPOINT", "context.endpoint 必须是 audio8 endpoint 对象。");
  }
  return {
    id: requireNonEmptyString(endpoint.id, "id"),
    baseUrl: requireNonEmptyString(endpoint.baseUrl, "baseUrl"),
    modelFingerprint: requireNonEmptyString(endpoint.modelFingerprint, "modelFingerprint"),
    runtimeManifestPath: requireAbsolutePath(endpoint.runtimeManifestPath, "runtimeManifestPath"),
    voicesRoot: requireAbsolutePath(endpoint.voicesRoot, "voicesRoot"),
    precision: requireNonEmptyString(endpoint.precision, "precision"),
    codecPrecision: requireNonEmptyString(endpoint.codecPrecision, "codecPrecision"),
    readiness: typeof endpoint.readiness === "string" ? endpoint.readiness : null,
    probeTimeoutMs: resolveOptionalOverride(endpoint, "probeTimeoutMs"),
    synthesisTimeoutMs: resolveOptionalOverride(endpoint, "synthesisTimeoutMs"),
    maxContainerBytes: resolveOptionalOverride(endpoint, "maxContainerBytes"),
  };
}

// 以 fd 打开已核验的真实文件：最终组件禁用符号链接，dev/ino 比对拦截核验后被替换，
// 并在读取前拒绝超尺寸。父目录中间组件竞态无法用 Node 标准库完全封堵，此处不作豁免声明。
function openVerifiedJsonFile(realPath, expectedIdentity) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

  let fd;
  try {
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && error.code === "ELOOP") {
      throw createError(
        "ERR_AUDIO8_JSON_BOUNDARY",
        `JSON 文件 ${realPath} 的最末组件是符号链接，按策略拒绝。`,
        { cause: error },
      );
    }
    throw createError("ERR_AUDIO8_JSON_READ", `无法打开 JSON 文件 ${realPath}。`, { cause: error });
  }

  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_AUDIO8_JSON_BOUNDARY", `JSON 路径 ${realPath} 不是普通文件。`);
    }
    if (
      expectedIdentity &&
      (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino)
    ) {
      throw createError(
        "ERR_AUDIO8_JSON_BOUNDARY",
        "JSON 文件在核验后被替换为另一个文件（inode 变化），按策略拒绝。",
      );
    }
    if (opened.size > MAX_JSON_BYTES) {
      throw createError(
        "ERR_AUDIO8_JSON_TOO_LARGE",
        `JSON 文件 ${opened.size} 字节超过上限 ${MAX_JSON_BYTES} 字节。`,
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

function readBoundedJsonText(fd, hooks) {
  const cap = MAX_JSON_BYTES + 1;
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

  if (offset > MAX_JSON_BYTES) {
    throw createError(
      "ERR_AUDIO8_JSON_TOO_LARGE",
      `JSON 文件超过上限 ${MAX_JSON_BYTES} 字节，已在读取过程中停止。`,
    );
  }

  return buffer.toString("utf8", 0, offset);
}

// 读取一个必须留在 allowedRealParent 之内的 JSON 文件（真实路径归属校验）。
function readBoundedJson(lexicalPath, allowedRealParent) {
  const lexical = path.resolve(lexicalPath);

  let stats;
  try {
    stats = fs.statSync(lexical);
  } catch (error) {
    throw createError("ERR_AUDIO8_JSON_READ", `JSON 文件不可读：${lexical}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw createError("ERR_AUDIO8_JSON_BOUNDARY", `JSON 路径 ${lexical} 不是普通文件。`);
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw createError(
      "ERR_AUDIO8_JSON_TOO_LARGE",
      `JSON 文件 ${stats.size} 字节超过上限 ${MAX_JSON_BYTES} 字节。`,
    );
  }

  let realFile;
  try {
    realFile = fs.realpathSync(lexical);
  } catch (error) {
    throw createError("ERR_AUDIO8_JSON_READ", `无法解析真实路径：${lexical}`, { cause: error });
  }
  if (path.dirname(realFile) !== allowedRealParent) {
    throw createError(
      "ERR_AUDIO8_JSON_BOUNDARY",
      `JSON 文件经链接离开了声明目录（${allowedRealParent}），按策略拒绝。`,
    );
  }

  const fd = openVerifiedJsonFile(realFile, { dev: stats.dev, ino: stats.ino });
  try {
    return readBoundedJsonText(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖既有错误。
    }
  }
}

function readLocalManifest(endpoint) {
  let declaredParent;
  try {
    declaredParent = fs.realpathSync(path.dirname(path.resolve(endpoint.runtimeManifestPath)));
  } catch {
    return { ok: false, reason: "本地 manifest 父目录不可解析" };
  }

  let content;
  try {
    content = readBoundedJson(endpoint.runtimeManifestPath, declaredParent);
  } catch (error) {
    return { ok: false, reason: `本地 manifest 不可用：${error.message}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return { ok: false, reason: "本地 manifest 不是合法 JSON" };
  }
  if (
    !isPlainObject(manifest) ||
    typeof manifest.model_fingerprint !== "string" ||
    manifest.model_fingerprint.trim() === ""
  ) {
    return { ok: false, reason: "本地 manifest 缺少 model_fingerprint" };
  }
  return { ok: true, manifest };
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function isSafeVoiceName(name) {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && path.basename(name) === name;
}

// 音色目录与 meta 的真实路径必须落在已在线核对的 voicesRoot 之内，且各自的最末组件不得逃逸。
function readVoiceMeta(voicesRoot, nativeVoiceId) {
  if (!isSafeVoiceName(nativeVoiceId)) {
    throw createError("ERR_AUDIO8_VOICE_METADATA", `音色名 ${String(nativeVoiceId)} 必须是单个路径组件。`);
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(voicesRoot);
  } catch (error) {
    throw createError("ERR_AUDIO8_VOICE_METADATA", "voicesRoot 不可解析。", { cause: error });
  }

  let realVoiceDir;
  try {
    realVoiceDir = fs.realpathSync(path.join(realRoot, nativeVoiceId));
  } catch (error) {
    throw createError(
      "ERR_AUDIO8_VOICE_METADATA",
      `音色目录不可解析：${nativeVoiceId}`,
      { cause: error },
    );
  }
  if (path.dirname(realVoiceDir) !== realRoot || path.basename(realVoiceDir) !== nativeVoiceId) {
    throw createError(
      "ERR_AUDIO8_VOICE_METADATA",
      `音色目录 ${nativeVoiceId} 经链接逃出了 voicesRoot，按策略拒绝。`,
    );
  }

  let raw;
  try {
    raw = readBoundedJson(path.join(realVoiceDir, "meta.json"), realVoiceDir);
  } catch (error) {
    throw createError(
      "ERR_AUDIO8_VOICE_METADATA",
      `音色 ${nativeVoiceId} 的 meta.json 不可用：${error.message}`,
      { cause: error },
    );
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw createError("ERR_AUDIO8_VOICE_METADATA", `音色 ${nativeVoiceId} 的 meta.json 不是合法 JSON。`);
  }
  if (!isPlainObject(meta)) {
    throw createError("ERR_AUDIO8_VOICE_METADATA", `音色 ${nativeVoiceId} 的 meta.json 必须是 JSON 对象。`);
  }
  return meta;
}

async function fetchJson(pathname, endpoint, timeoutMs) {
  const response = await request({
    baseUrl: endpoint.baseUrl,
    path: pathname,
    method: "GET",
    timeoutMs,
    maxBytes: PROBE_MAX_BYTES,
  });
  return { statusCode: response.statusCode, json: response.json };
}

async function probe(context) {
  // 固定快照：probe 内部有多次 await，不能被调用方在期间改写 endpoint 影响后续请求。
  const endpoint = resolveEndpoint(snapshotValue(context && context.endpoint));
  const base = {
    backendId: BACKEND_ID,
    endpointId: endpoint.id,
    ready: false,
    state: "unverified",
    reason: "",
    localManifest: null,
    health: null,
    identity: null,
    checks: [],
  };

  const local = readLocalManifest(endpoint);
  if (!local.ok) {
    return { ...base, state: "manifestInvalid", reason: local.reason };
  }
  const manifest = local.manifest;

  let healthResponse;
  let identityResponse;
  try {
    healthResponse = await fetchJson(HEALTH_PATH, endpoint, endpoint.probeTimeoutMs);
    identityResponse = await fetchJson(IDENTITY_PATH, endpoint, endpoint.probeTimeoutMs);
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    return { ...base, state: "unreachable", reason: `Audio8 服务不可达：${error.message}` };
  }

  const health = isPlainObject(healthResponse.json) ? healthResponse.json : null;
  if (healthResponse.statusCode !== 200 || !health || health.ok !== true) {
    return {
      ...base,
      state: "unverified",
      reason: `Audio8 未就绪：/api/health 返回 HTTP ${healthResponse.statusCode}。`,
      health,
    };
  }

  const identity =
    identityResponse.statusCode === 200 && isPlainObject(identityResponse.json)
      ? identityResponse.json
      : null;
  if (!identity) {
    return {
      ...base,
      health,
      state: "unverified",
      reason: `裸服务缺少身份接口 ${IDENTITY_PATH}（HTTP ${identityResponse.statusCode}），不得放行。`,
    };
  }

  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  record("backendId", identity.backendId === BACKEND_ID, `identity.backendId=${identity.backendId}`);
  record(
    "modelFingerprint",
    identity.modelFingerprint === endpoint.modelFingerprint &&
      manifest.model_fingerprint === endpoint.modelFingerprint,
    "在线/本地 manifest/endpoint 三处模型指纹必须一致",
  );
  record(
    "modelDir",
    sameRealPath(String(identity.modelDir || ""), path.dirname(endpoint.runtimeManifestPath)),
    "在线 modelDir 必须等于本地 manifest 所在目录",
  );
  record(
    "voicesRoot",
    sameRealPath(String(identity.voicesRoot || ""), endpoint.voicesRoot),
    "在线 voicesRoot 必须等于 endpoint 声明的真实目录",
  );
  record(
    "precision",
    identity.precision === endpoint.precision &&
      health.precision === identity.precision &&
      Array.isArray(manifest.available_precisions) &&
      manifest.available_precisions.includes(identity.precision),
    `identity.precision=${identity.precision} health.precision=${health.precision}`,
  );
  record(
    "codecPrecision",
    identity.codecPrecision === endpoint.codecPrecision &&
      health.codec_precision === identity.codecPrecision &&
      Array.isArray(manifest.available_codec_precisions) &&
      manifest.available_codec_precisions.includes(identity.codecPrecision),
    `identity.codecPrecision=${identity.codecPrecision} health.codec_precision=${health.codec_precision}`,
  );
  record(
    "instanceId",
    typeof identity.instanceId === "string" && identity.instanceId !== "",
    "同进程身份实例 id 必须存在",
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return {
      ...base,
      health,
      identity,
      checks,
      state: "mismatch",
      reason: `在线身份与本机声明不一致：${failed.map((check) => check.name).join("、")}。`,
    };
  }

  return {
    ...base,
    ready: true,
    state: "verified",
    reason: "在线身份、路径、精度、模型指纹与本地 manifest 一致。",
    localManifest: manifest,
    health,
    identity,
    checks,
  };
}

// 采样参数只做白名单映射，不展开原始对象，也不允许身份字段混入。
function normalizeParameters(parameters) {
  if (parameters === undefined) {
    return {};
  }
  if (!isPlainObject(parameters)) {
    throw createError("ERR_AUDIO8_PARAM_INVALID", "parameters 必须是普通对象。");
  }

  const normalized = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (IDENTITY_PARAMETER_KEYS.includes(key)) {
      throw createError(
        "ERR_AUDIO8_PARAM_IDENTITY",
        `parameters 不得包含身份字段 ${key}，身份只能来自绑定。`,
      );
    }
    const spec = SAMPLING_PARAMETERS[key];
    if (!spec) {
      throw createError(
        "ERR_AUDIO8_PARAM_UNSUPPORTED",
        `Audio8 不支持参数 ${key}（不支持语速/情感/目标语言等字段），已拒绝发送。`,
      );
    }
    if (!isWithinSpec(value, spec)) {
      throw createError(
        "ERR_AUDIO8_PARAM_INVALID",
        `参数 ${key} 取值 ${JSON.stringify(value)} 不符合安装契约的类型或范围。`,
      );
    }
    normalized[key] = value;
  }
  return normalized;
}

function isWithinSpec(value, spec) {
  if (spec.kind === "integer") {
    if (!Number.isSafeInteger(value)) {
      return false;
    }
  } else if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  if (spec.min !== null) {
    if (spec.minExclusive ? value <= spec.min : value < spec.min) {
      return false;
    }
  }
  if (spec.max !== null && value > spec.max) {
    return false;
  }
  return true;
}

async function fetchVoices(endpoint) {
  const response = await fetchJson(VOICES_PATH, endpoint, endpoint.probeTimeoutMs);
  if (response.statusCode !== 200 || !isPlainObject(response.json) || !Array.isArray(response.json.voices)) {
    return [];
  }
  return response.json.voices.filter(isPlainObject);
}

// 在线声音元数据必须与绑定指纹、模型指纹以及磁盘上的 meta.json 三方一致。
function verifyVoice(endpoint, binding, onlineMeta, identity) {
  if (!onlineMeta) {
    throw createError("ERR_AUDIO8_VOICE_MISSING", `Audio8 在线声音列表不存在 ${binding.nativeVoiceId}。`);
  }
  if (String(onlineMeta.model_fingerprint || "") !== identity.modelFingerprint) {
    throw createError(
      "ERR_AUDIO8_VOICE_FINGERPRINT",
      `在线声音 ${binding.nativeVoiceId} 的模型指纹与当前在线模型不一致。`,
    );
  }
  const fingerprint = voiceFingerprint(onlineMeta);
  if (fingerprint !== binding.nativeVoiceFingerprint) {
    throw createError(
      "ERR_AUDIO8_VOICE_FINGERPRINT",
      `在线声音 ${binding.nativeVoiceId} 的元数据指纹与绑定不一致，需重新准备音色。`,
    );
  }
  const diskMeta = readVoiceMeta(endpoint.voicesRoot, binding.nativeVoiceId);
  if (voiceFingerprint(diskMeta) !== fingerprint) {
    throw createError(
      "ERR_AUDIO8_VOICE_FINGERPRINT",
      `声音 ${binding.nativeVoiceId} 的磁盘元数据与在线元数据不一致，需重新确认。`,
    );
  }
}

async function synthesize(options = {}) {
  // 在任何 await 之前固定快照：此后调用方改写 endpoint/binding/parameters 都换不掉声音与配置。
  const endpointSnapshot = snapshotValue(options.endpoint);
  const binding = snapshotValue(options.binding);
  const parametersSnapshot = snapshotValue(options.parameters);
  const endpoint = resolveEndpoint(endpointSnapshot);

  if (endpoint.readiness !== "ready") {
    throw createError(
      "ERR_AUDIO8_ENDPOINT_NOT_READY",
      `endpoint ${endpoint.id} 的目录就绪度不是 ready，不能用于合成。`,
    );
  }

  if (!isPlainObject(binding)) {
    throw createError("ERR_AUDIO8_BINDING", "binding 必须是普通对象。");
  }
  if (binding.backendId !== BACKEND_ID || binding.endpointId !== endpoint.id) {
    throw createError(
      "ERR_AUDIO8_BINDING",
      `binding 不属于 ${BACKEND_ID}/${endpoint.id}，不能交给本适配器合成。`,
    );
  }
  if (!isSafeVoiceName(binding.nativeVoiceId)) {
    throw createError("ERR_AUDIO8_BINDING", "binding.nativeVoiceId 必须是单个路径组件。");
  }
  if (typeof binding.nativeVoiceFingerprint !== "string" || binding.nativeVoiceFingerprint === "") {
    throw createError("ERR_AUDIO8_BINDING", "binding 缺少 nativeVoiceFingerprint。");
  }
  if (binding.status !== "ready") {
    throw createError(
      "ERR_AUDIO8_BINDING_NOT_READY",
      `binding ${String(binding.id)} 状态为 ${String(binding.status)}，不能用于合成。`,
    );
  }
  if (binding.modelFingerprint !== endpoint.modelFingerprint) {
    throw createError(
      "ERR_AUDIO8_BINDING_FINGERPRINT",
      `binding ${String(binding.id)} 的模型指纹与 endpoint 声明不一致，需重新准备音色。`,
    );
  }

  const sampling = normalizeParameters(parametersSnapshot);
  const segments = splitText(options.text, SEGMENT_CODE_POINTS);

  const probeResult = await probe({ endpoint });
  if (!probeResult.ready) {
    throw createError(
      "ERR_AUDIO8_NOT_VERIFIED",
      `Audio8 endpoint 未通过在线核验（${probeResult.state}）：${probeResult.reason}`,
    );
  }

  const onlineMeta = (await fetchVoices(endpoint)).find(
    (voice) => voice.name === binding.nativeVoiceId,
  );
  verifyVoice(endpoint, binding, onlineMeta, probeResult.identity);

  const parsedSegments = [];
  const segmentBuffers = [];
  let totalPcmBytes = 0;

  for (const segment of segments) {
    if (segment.trim() === "") {
      // 纯空白分段不发送合成请求，但正文不含被 trim 掉的非空白内容。
      continue;
    }

    const body = { text: segment, voice_name: binding.nativeVoiceId };
    for (const [key, value] of Object.entries(sampling)) {
      body[key] = value;
    }

    const response = await request({
      baseUrl: endpoint.baseUrl,
      path: SYNTHESIZE_PATH,
      method: "POST",
      json: body,
      timeoutMs: endpoint.synthesisTimeoutMs,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    if (response.statusCode !== 200) {
      throw createError(
        "ERR_AUDIO8_SYNTHESIS",
        `Audio8 合成返回 HTTP ${response.statusCode}，未返回可用音频。`,
        { statusCode: response.statusCode },
      );
    }

    const segmentWav = parseWav(response.body);
    const first = parsedSegments[0];
    if (
      first &&
      (segmentWav.sampleRate !== first.sampleRate ||
        segmentWav.channels !== first.channels ||
        segmentWav.bitsPerSample !== first.bitsPerSample)
    ) {
      throw createError(
        "ERR_AUDIO8_SEGMENT",
        "分段音频格式不一致，按契约整体失败，不返回部分音频。",
        { segmentIndex: parsedSegments.length },
      );
    }

    const projected = WAV_CONTAINER_HEADER_BYTES + totalPcmBytes + segmentWav.pcm.length;
    if (projected > endpoint.maxContainerBytes) {
      throw createError(
        "ERR_AUDIO8_CONTAINER_LIMIT",
        `累计音频容器将达到 ${projected} 字节，超过上限 ${endpoint.maxContainerBytes} 字节，已停止且不返回部分音频。`,
        { projectedBytes: projected },
      );
    }

    totalPcmBytes += segmentWav.pcm.length;
    parsedSegments.push(segmentWav);
    segmentBuffers.push(response.body);
  }

  if (segmentBuffers.length === 0) {
    throw createError("ERR_AUDIO8_SEGMENT", "文本没有任何非空白内容，已拒绝合成。");
  }

  return {
    audio: joinWav(segmentBuffers),
    format: {
      sampleRate: parsedSegments[0].sampleRate,
      channels: parsedSegments[0].channels,
      bitsPerSample: parsedSegments[0].bitsPerSample,
    },
  };
}

async function listVoices(context) {
  if (!isPlainObject(context)) {
    throw createError("ERR_AUDIO8_CONTEXT", "listVoices 需要 { endpoint, catalog } 上下文。");
  }
  // 同样在首个 await 之前固定快照，await 期间外部改写目录不影响返回结果。
  const endpoint = resolveEndpoint(snapshotValue(context.endpoint));
  const catalog = snapshotValue(context.catalog);
  if (!isPlainObject(catalog) || !Array.isArray(catalog.bindings)) {
    throw createError("ERR_AUDIO8_CONTEXT", "listVoices 需要目录对象与 bindings 数组。");
  }

  const bindings = catalog.bindings.filter(
    (binding) =>
      isPlainObject(binding) &&
      binding.backendId === BACKEND_ID &&
      binding.endpointId === endpoint.id,
  );

  const describe = (binding, status, usable) => ({
    bindingId: binding.id,
    nativeVoiceId: binding.nativeVoiceId,
    revision: binding.revision,
    voiceFingerprint: binding.nativeVoiceFingerprint,
    status,
    usable,
  });

  // 目录声明未 ready 的 endpoint 不得返回任何可用音色。
  if (endpoint.readiness !== "ready") {
    return bindings.map((binding) => describe(binding, "notReady", false));
  }

  let probeResult;
  try {
    probeResult = await probe({ endpoint });
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    probeResult = { ready: false, state: "unreachable" };
  }
  if (!probeResult.ready) {
    return bindings.map((binding) => describe(binding, "unverified", false));
  }

  let online;
  try {
    online = await fetchVoices(endpoint);
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    return bindings.map((binding) => describe(binding, "unverified", false));
  }

  return bindings.map((binding) => {
    if (binding.status !== "ready") {
      return describe(binding, "notReady", false);
    }
    if (
      binding.modelFingerprint !== endpoint.modelFingerprint ||
      binding.modelFingerprint !== probeResult.identity.modelFingerprint
    ) {
      return describe(binding, "invalid", false);
    }
    const meta = online.find((voice) => voice.name === binding.nativeVoiceId);
    if (!meta) {
      return describe(binding, "missing", false);
    }
    const fingerprint = voiceFingerprint(meta);
    if (fingerprint !== binding.nativeVoiceFingerprint) {
      return describe(binding, "fingerprintMismatch", false);
    }
    let diskMeta;
    try {
      diskMeta = readVoiceMeta(endpoint.voicesRoot, binding.nativeVoiceId);
    } catch {
      return describe(binding, "invalid", false);
    }
    if (voiceFingerprint(diskMeta) !== fingerprint) {
      return describe(binding, "fingerprintMismatch", false);
    }
    return describe(binding, "verified", true);
  });
}

module.exports = {
  id: BACKEND_ID,
  capabilities,
  probe,
  listVoices,
  synthesize,
  voiceFingerprint,
  SEGMENT_CODE_POINTS,
  IDENTITY_PATH,
  MAX_JSON_BYTES,
  // 仅供测试夹具直接驱动内部防护（尺寸上限、inode 比对、O_NOFOLLOW、读取期增长）。
  __testHooks: { openVerifiedJsonFile, readBoundedJsonText, MAX_JSON_BYTES },
};
