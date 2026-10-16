"use strict";

// GPT-SoVITS 适配器：按本机 api_v2.py 的 POST /tts 契约做原生字段映射。
// 本机服务不提供已加载模型组的身份接口，因此身份一律 fail-closed：
// 目录声明、/tts 可达、/docs 可连通都不作为在线模型组凭证，未获主控裁决前不放行可用音色。

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

const BACKEND_ID = "gpt-sovits";
const SYNTHESIZE_PATH = "/tts";
// 只触发 check_params 的必填校验（ref_audio_path 缺失 → 400），不进入推理。
const PROBE_QUERY = "?text_lang=en&prompt_lang=en";
const SEGMENT_CODE_POINTS = 120;
const WAV_CONTAINER_HEADER_BYTES = 44;
const MAX_REFERENCE_AUDIO_BYTES = 64 * 1024 * 1024;
const PROBE_MAX_BYTES = 1024 * 1024;

const MEDIA_TYPE = "wav";
const STREAMING_MODE = false;
const IDENTITY_EVIDENCE = "unavailable";

// 安装版 TTS_infer_pack/TTS.py：v1 为子集，v2 及之后（含 v2Pro/v3/v4）共用同一语言表。
const LANGUAGES = Object.freeze([
  "auto",
  "auto_yue",
  "en",
  "zh",
  "ja",
  "yue",
  "ko",
  "all_zh",
  "all_ja",
  "all_yue",
  "all_ko",
]);

// 安装版 text_segmentation_method.py 注册的切割方法。
const TEXT_SPLIT_METHODS = Object.freeze([
  "cut0",
  "cut1",
  "cut2",
  "cut3",
  "cut4",
  "cut5",
]);

// 本轮对外放行的原生采样参数白名单与范围（范围是本适配器声明的能力边界）。
const SAMPLING_PARAMETERS = Object.freeze({
  top_k: { kind: "integer", min: 1, max: 1024 },
  top_p: { kind: "number", min: 0, minExclusive: true, max: 1 },
  temperature: { kind: "number", min: 0, minExclusive: true, max: 2 },
  speed_factor: { kind: "number", min: 0.25, minExclusive: true, max: 4 },
  fragment_interval: { kind: "number", min: 0, max: 1 },
  repetition_penalty: { kind: "number", min: 1, max: 2 },
  seed: { kind: "integer", min: null, max: null },
  sample_steps: { kind: "integer", min: 1, max: 128 },
  text_split_method: { kind: "enum", values: TEXT_SPLIT_METHODS },
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

const FORBIDDEN_ENDPOINTS = Object.freeze([
  "/set_gpt_weights",
  "/set_sovits_weights",
  "/set_refer_audio",
  "/control",
]);

const capabilities = Object.freeze({
  backendId: BACKEND_ID,
  transport: "http-loopback",
  identityEvidence: IDENTITY_EVIDENCE,
  supportsSpeed: true,
  supportsEmotion: false,
  supportsLanguageHint: true,
  supportsStreaming: false,
  filtersVoicesByReferenceLanguage: false,
  requiresReferenceAudio: true,
  segmentCodePoints: SEGMENT_CODE_POINTS,
  maxInputCodePoints: MAX_INPUT_CODE_POINTS,
  maxContainerBytes: MAX_CONTAINER_BYTES,
  maxResponseBytes: DEFAULT_MAX_BYTES,
  maxReferenceAudioBytes: MAX_REFERENCE_AUDIO_BYTES,
  bitsPerSample: 16,
  maxChannels: 2,
  mediaType: MEDIA_TYPE,
  streamingMode: STREAMING_MODE,
  languages: LANGUAGES,
  textSplitMethods: TEXT_SPLIT_METHODS,
  samplingParameters: SAMPLING_PARAMETERS,
  unsupportedParameters: Object.freeze([
    "aux_ref_audio_paths",
    "batch_size",
    "batch_threshold",
    "split_bucket",
    "parallel_infer",
    "super_sampling",
    "overlap_length",
    "min_chunk_length",
    "streaming_mode",
    "media_type",
    "emotion",
  ]),
  endpoints: Object.freeze({ synthesize: SYNTHESIZE_PATH }),
  forbiddenEndpoints: FORBIDDEN_ENDPOINTS,
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
    throw createError("ERR_GPT_SOVITS_ENDPOINT", `endpoint 字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

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
      "ERR_GPT_SOVITS_ENDPOINT",
      `endpoint 字段 ${field} 必须是正安全整数，收到 ${String(value)}。`,
    );
  }
  if (value > OVERRIDE_LIMITS[field]) {
    throw createError(
      "ERR_GPT_SOVITS_ENDPOINT",
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

function resolveEndpoint(endpoint) {
  if (!isPlainObject(endpoint)) {
    throw createError("ERR_GPT_SOVITS_ENDPOINT", "context.endpoint 必须是 gpt-sovits endpoint 对象。");
  }
  return {
    id: requireNonEmptyString(endpoint.id, "id"),
    baseUrl: requireNonEmptyString(endpoint.baseUrl, "baseUrl"),
    modelFingerprint: requireNonEmptyString(endpoint.modelFingerprint, "modelFingerprint"),
    readiness: typeof endpoint.readiness === "string" ? endpoint.readiness : null,
    probeTimeoutMs: resolveOptionalOverride(endpoint, "probeTimeoutMs"),
    synthesisTimeoutMs: resolveOptionalOverride(endpoint, "synthesisTimeoutMs"),
    maxContainerBytes: resolveOptionalOverride(endpoint, "maxContainerBytes"),
  };
}

function requireLanguage(raw, field, code) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!LANGUAGES.includes(value)) {
    throw createError(
      code,
      `${field} 必须在已核对的语言表内（${LANGUAGES.join("/")}），收到 ${JSON.stringify(raw)}。`,
    );
  }
  return value;
}

// 参考资料：参考音频路径只作为数据发给本机服务，永不作为代码或命令执行。
function resolveReference(profile) {
  const code = "ERR_GPT_SOVITS_REFERENCE";
  if (!isPlainObject(profile) || !isPlainObject(profile.source)) {
    throw createError(code, "profile.source 缺失，GPT-SoVITS 需要参考音频、原文与语言。");
  }

  const { audioPath, referenceText, language } = profile.source;
  if (typeof audioPath !== "string" || audioPath.trim() === "" || !path.isAbsolute(audioPath)) {
    throw createError(code, `参考音频必须是绝对路径，收到 ${JSON.stringify(audioPath)}。`);
  }

  let stats;
  try {
    stats = fs.statSync(audioPath);
  } catch (error) {
    throw createError(code, `参考音频不存在或不可读：${audioPath}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw createError(code, `参考音频不是普通文件：${audioPath}`);
  }
  if (stats.size > MAX_REFERENCE_AUDIO_BYTES) {
    throw createError(
      code,
      `参考音频 ${stats.size} 字节超过上限 ${MAX_REFERENCE_AUDIO_BYTES} 字节。`,
    );
  }

  if (typeof referenceText !== "string" || referenceText.trim() === "") {
    throw createError(code, "参考原文缺失或为空白，不能用于提示对齐。");
  }

  return {
    audioPath,
    referenceText,
    language: requireLanguage(language, "参考语言（prompt_lang）", code),
  };
}

function isWithinSpec(value, spec) {
  if (spec.kind === "enum") {
    return spec.values.includes(value);
  }
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

// 参数只做白名单映射，不展开原对象，也不允许身份字段混入。
function normalizeParameters(parameters) {
  const input = parameters === undefined ? {} : parameters;
  if (!isPlainObject(input)) {
    throw createError("ERR_GPT_SOVITS_PARAM_INVALID", "parameters 必须是普通对象。");
  }

  const normalized = {
    text_lang: requireLanguage(input.text_lang, "text_lang", "ERR_GPT_SOVITS_PARAM_INVALID"),
  };

  for (const [key, value] of Object.entries(input)) {
    if (key === "text_lang") {
      continue;
    }
    if (IDENTITY_PARAMETER_KEYS.includes(key)) {
      throw createError(
        "ERR_GPT_SOVITS_PARAM_IDENTITY",
        `parameters 不得包含身份字段 ${key}，身份只能来自绑定。`,
      );
    }
    const spec = SAMPLING_PARAMETERS[key];
    if (!spec) {
      throw createError(
        "ERR_GPT_SOVITS_PARAM_UNSUPPORTED",
        `GPT-SoVITS 适配器不支持参数 ${key}，已拒绝发送。`,
      );
    }
    if (!isWithinSpec(value, spec)) {
      throw createError(
        "ERR_GPT_SOVITS_PARAM_INVALID",
        `参数 ${key} 取值 ${JSON.stringify(value)} 不符合类型或范围。`,
      );
    }
    normalized[key] = value;
  }

  return normalized;
}

function buildSynthesisPayload({ segment, reference, sampling }) {
  const payload = {
    text: segment,
    text_lang: sampling.text_lang,
    ref_audio_path: reference.audioPath,
    prompt_text: reference.referenceText,
    prompt_lang: reference.language,
    media_type: MEDIA_TYPE,
    streaming_mode: STREAMING_MODE,
  };
  for (const [key, value] of Object.entries(sampling)) {
    if (key === "text_lang") {
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

async function probe(context) {
  const endpoint = resolveEndpoint(snapshotValue(context && context.endpoint));
  const base = {
    backendId: BACKEND_ID,
    endpointId: endpoint.id,
    ready: false,
    state: "unverified",
    reason: "",
    identity: null,
    identityEvidence: IDENTITY_EVIDENCE,
    contract: null,
  };

  let response;
  try {
    response = await request({
      baseUrl: endpoint.baseUrl,
      path: SYNTHESIZE_PATH + PROBE_QUERY,
      method: "GET",
      timeoutMs: endpoint.probeTimeoutMs,
      maxBytes: PROBE_MAX_BYTES,
    });
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    return { ...base, state: "unreachable", reason: `GPT-SoVITS 服务不可达：${error.message}` };
  }

  const contract = {
    statusCode: response.statusCode,
    matchedValidationError:
      response.statusCode === 400 &&
      isPlainObject(response.json) &&
      typeof response.json.message === "string" &&
      response.json.message.includes("ref_audio_path"),
  };

  if (!contract.matchedValidationError) {
    return {
      ...base,
      state: "unreachable",
      reason: `/tts 契约探测未得到预期的必填校验响应（HTTP ${response.statusCode}）。`,
      contract,
    };
  }

  return {
    ...base,
    state: "unverified",
    reason:
      "本机 GPT-SoVITS 服务未提供可核验的已加载模型组身份接口；目录声明与 /tts、/docs 可达都不能证明在线模型组正确，故保持未验证且不放出可用音色。",
    contract,
  };
}

async function listVoices(context) {
  if (!isPlainObject(context)) {
    throw createError("ERR_GPT_SOVITS_CONTEXT", "listVoices 需要 { endpoint, catalog } 上下文。");
  }
  const endpoint = resolveEndpoint(snapshotValue(context.endpoint));
  const catalog = snapshotValue(context.catalog);
  if (!isPlainObject(catalog) || !Array.isArray(catalog.bindings)) {
    throw createError("ERR_GPT_SOVITS_CONTEXT", "listVoices 需要目录对象与 bindings 数组。");
  }

  const bindings = catalog.bindings.filter(
    (binding) =>
      isPlainObject(binding) &&
      binding.backendId === BACKEND_ID &&
      binding.endpointId === endpoint.id,
  );

  const describe = (binding, status) => ({
    bindingId: binding.id,
    nativeVoiceId: binding.nativeVoiceId,
    revision: binding.revision,
    voiceFingerprint: binding.nativeVoiceFingerprint,
    status,
    usable: false,
  });

  if (endpoint.readiness !== "ready") {
    return bindings.map((binding) => describe(binding, "notReady"));
  }

  const local = bindings.map((binding) => {
    if (binding.status !== "ready") {
      return describe(binding, "notReady");
    }
    if (binding.modelFingerprint !== endpoint.modelFingerprint) {
      return describe(binding, "invalid");
    }
    return null;
  });

  if (local.every((entry) => entry !== null)) {
    return local;
  }

  let probeResult;
  try {
    probeResult = await probe({ endpoint });
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    probeResult = { state: "unreachable" };
  }
  const fallbackStatus = probeResult.state === "unreachable" ? "unreachable" : "unverified";

  // 没有在线模型组身份证据：任何 GPT-SoVITS 声音都不可作为可用项。
  return local.map((entry, index) => entry || describe(bindings[index], fallbackStatus));
}

async function performSegmentedSynthesis({ endpoint, reference, sampling, segments }) {
  const parsedSegments = [];
  const segmentBuffers = [];
  let totalPcmBytes = 0;

  for (const segment of segments) {
    if (segment.trim() === "") {
      // 纯空白分段不发送合成请求，正文本身不被 trim。
      continue;
    }

    const response = await request({
      baseUrl: endpoint.baseUrl,
      path: SYNTHESIZE_PATH,
      method: "POST",
      json: buildSynthesisPayload({ segment, reference, sampling }),
      timeoutMs: endpoint.synthesisTimeoutMs,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    if (response.statusCode !== 200) {
      throw createError(
        "ERR_GPT_SOVITS_SYNTHESIS",
        `GPT-SoVITS 合成返回 HTTP ${response.statusCode}，未返回可用音频。`,
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
        "ERR_GPT_SOVITS_SEGMENT",
        "分段音频格式不一致或不是完整流式结果，按契约整体失败。",
        { segmentIndex: parsedSegments.length },
      );
    }

    const projected = WAV_CONTAINER_HEADER_BYTES + totalPcmBytes + segmentWav.pcm.length;
    if (projected > endpoint.maxContainerBytes) {
      throw createError(
        "ERR_GPT_SOVITS_CONTAINER_LIMIT",
        `累计音频容器将达到 ${projected} 字节，超过上限 ${endpoint.maxContainerBytes} 字节，已停止且不返回部分音频。`,
        { projectedBytes: projected },
      );
    }

    totalPcmBytes += segmentWav.pcm.length;
    parsedSegments.push(segmentWav);
    segmentBuffers.push(response.body);
  }

  if (segmentBuffers.length === 0) {
    throw createError("ERR_GPT_SOVITS_SEGMENT", "文本没有任何非空白内容，已拒绝合成。");
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

async function synthesize(options = {}) {
  // 在任何 await 之前固定快照：此后调用方改写 endpoint/binding/profile/parameters 都不生效。
  const endpoint = resolveEndpoint(snapshotValue(options.endpoint));
  const binding = snapshotValue(options.binding);
  const profile = snapshotValue(options.profile);
  const parametersSnapshot = snapshotValue(options.parameters);

  if (endpoint.readiness !== "ready") {
    throw createError(
      "ERR_GPT_SOVITS_ENDPOINT_NOT_READY",
      `endpoint ${endpoint.id} 的目录就绪度不是 ready，不能用于合成。`,
    );
  }

  if (!isPlainObject(binding)) {
    throw createError("ERR_GPT_SOVITS_BINDING", "binding 必须是普通对象。");
  }
  if (binding.backendId !== BACKEND_ID || binding.endpointId !== endpoint.id) {
    throw createError(
      "ERR_GPT_SOVITS_BINDING",
      `binding 不属于 ${BACKEND_ID}/${endpoint.id}，不能交给本适配器合成。`,
    );
  }
  if (typeof binding.nativeVoiceId !== "string" || binding.nativeVoiceId.trim() === "") {
    throw createError("ERR_GPT_SOVITS_BINDING", "binding.nativeVoiceId 必须是非空字符串。");
  }
  if (binding.status !== "ready") {
    throw createError(
      "ERR_GPT_SOVITS_BINDING_NOT_READY",
      `binding ${String(binding.id)} 状态为 ${String(binding.status)}，不能用于合成。`,
    );
  }
  if (binding.modelFingerprint !== endpoint.modelFingerprint) {
    throw createError(
      "ERR_GPT_SOVITS_BINDING_FINGERPRINT",
      `binding ${String(binding.id)} 的模型组声明与 endpoint 不一致，需重新准备音色。`,
    );
  }

  const reference = resolveReference(profile);
  const sampling = normalizeParameters(parametersSnapshot);
  const segments = splitText(options.text, SEGMENT_CODE_POINTS);

  const probeResult = await probe({ endpoint });
  if (!probeResult.ready) {
    throw createError(
      "ERR_GPT_SOVITS_NOT_VERIFIED",
      `GPT-SoVITS endpoint 未通过身份核验（${probeResult.state}）：${probeResult.reason}`,
    );
  }

  return performSegmentedSynthesis({ endpoint, reference, sampling, segments });
}

module.exports = {
  id: BACKEND_ID,
  capabilities,
  probe,
  listVoices,
  synthesize,
  SEGMENT_CODE_POINTS,
  SYNTHESIZE_PATH,
  MAX_REFERENCE_AUDIO_BYTES,
  // 仅供测试夹具直接驱动契约与分段传输（生产由 synthesize 的门禁控制可达性）。
  __testHooks: {
    buildSynthesisPayload,
    performSegmentedSynthesis,
    resolveEndpoint,
    resolveReference,
    normalizeParameters,
    LANGUAGES,
    TEXT_SPLIT_METHODS,
  },
};
