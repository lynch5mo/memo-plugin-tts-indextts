"use strict";

// Memo 源码入口：default TTS 与 getEditorOptions。
// 只消费已验收的目录、身份与适配器；对宿主只返回有效 Buffer 或固定中文分类错误，
// 不回显原错误码、服务正文、URL 或诊断内容（避免误触宿主按英文错误分类的自动重试）。

const os = require("node:os");
const path = require("node:path");

const { readCatalog, resolveBinding } = require("./catalog.js");
const { encodeVoiceValue } = require("./voice-value.js");
const { getBackend, listBackends } = require("./backends/index.js");

const DEFAULT_CATALOG_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "memo-local-tts",
  "catalog.json",
);
const DEFAULT_MODEL = "audio8";
const CONFIG_FIELDS = Object.freeze(["model", "voiceName", "catalogPath", "text"]);

// 固定中文分类错误：全部为纯中文，绝不包含英文错误码、URL 或可诊断片段。
const CATEGORY = Object.freeze({
  NOT_CONFIGURED: "语音合成失败：尚未配置本地音色资料或目录，请先在选择界面中配置音色。",
  MODEL: "语音合成失败：选择的语音引擎不受支持。",
  NO_VOICE: "语音合成失败：未选择音色或所选音色已失效，请重新选择。",
  NOT_VERIFIED: "语音合成失败：所选引擎或音色尚未通过在线核验，暂不可用。",
  REFERENCE: "语音合成失败：音色参考资料不完整，请重新准备音色。",
  TEXT: "语音合成失败：待合成文本为空或超出长度限制。",
  SERVICE: "语音合成失败：本地语音服务未启动、未就绪或拒绝了请求。",
  BUSY: "语音合成失败：本地语音服务当前繁忙，请稍后再试。",
  TIMEOUT: "语音合成失败：请求等待超出时限，未自动重发。",
  AUDIO: "语音合成失败：后端返回的音频无效或格式不支持。",
  PARAMETERS: "语音合成失败：音色参数不受支持或超出允许范围。",
  UNKNOWN: "语音合成失败：发生未分类错误。",
});

const BACKEND_LABELS = Object.freeze({
  audio8: "Audio8 本地模型",
  "gpt-sovits": "GPT-SoVITS",
});

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 深拷贝并写为自有数据属性：不修改调用方对象，也不受调用方后续改写影响。
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

// 只合并已知字段：默认值、构造配置与当前 options（当前优先），其余字段一律不展开。
function mergeConfig(constructorConfig, callOptions) {
  const config = isPlainObject(constructorConfig) ? constructorConfig : {};
  const options = isPlainObject(callOptions) ? callOptions : {};

  const merged = {};
  for (const field of CONFIG_FIELDS) {
    if (config[field] !== undefined) {
      merged[field] = config[field];
    }
    if (options[field] !== undefined) {
      merged[field] = options[field];
    }
  }
  if (merged.model === undefined) {
    merged.model = DEFAULT_MODEL;
  }
  if (merged.catalogPath === undefined) {
    merged.catalogPath = DEFAULT_CATALOG_PATH;
  }
  if (merged.text === undefined) {
    merged.text = "";
  }
  return merged;
}

function categoryOf(error) {
  const code = error && typeof error.code === "string" ? error.code : "";

  if (code.startsWith("ERR_TEXT_")) {
    return "TEXT";
  }
  if (code === "ERR_PLUGIN_NO_VOICE") {
    return "NO_VOICE";
  }
  if (code === "ERR_PLUGIN_MODEL") {
    return "MODEL";
  }
  if (code === "ERR_PLUGIN_AUDIO") {
    return "AUDIO";
  }
  if (
    code === "ERR_PLUGIN_NOT_CONFIGURED" ||
    code === "ERR_CATALOG_INPUT" ||
    code === "ERR_CATALOG_READ" ||
    code === "ERR_CATALOG_JSON"
  ) {
    return "NOT_CONFIGURED";
  }
  if (code === "ERR_BACKEND_UNKNOWN" || code === "ERR_BINDING_MODEL") {
    return "MODEL";
  }
  if (code.startsWith("ERR_VOICE_VALUE_")) {
    return "NO_VOICE";
  }
  if (
    code === "ERR_BINDING_NOT_READY" ||
    code === "ERR_ENDPOINT_NOT_READY" ||
    code === "ERR_BINDING_FINGERPRINT" ||
    code === "ERR_CATALOG_CONFLICT"
  ) {
    return "NOT_VERIFIED";
  }
  if (code.endsWith("_NOT_VERIFIED")) {
    return "NOT_VERIFIED";
  }
  if (code.startsWith("ERR_BINDING_")) {
    return "NO_VOICE";
  }
  if (code.endsWith("_REFERENCE")) {
    return "REFERENCE";
  }
  if (code.startsWith("ERR_TIMEOUT")) {
    return "TIMEOUT";
  }
  if (code.endsWith("_SYNTHESIS")) {
    return error && error.statusCode === 429 ? "BUSY" : "SERVICE";
  }
  if (code.startsWith("ERR_WAV_")) {
    return "AUDIO";
  }
  if (
    code.endsWith("_PARAM_UNSUPPORTED") ||
    code.endsWith("_PARAM_INVALID") ||
    code.endsWith("_PARAM_IDENTITY")
  ) {
    return "PARAMETERS";
  }
  if (code.endsWith("_SEGMENT") || code.endsWith("_CONTAINER_LIMIT")) {
    return "AUDIO";
  }
  if (code.startsWith("ERR_ENDPOINT") || code.startsWith("ERR_REQUEST") || code.startsWith("ERR_RESPONSE")) {
    return "SERVICE";
  }
  if (code.endsWith("_ENDPOINT") || code.endsWith("_CONTEXT") || code.endsWith("_BINDING")) {
    return "NOT_CONFIGURED";
  }
  return "UNKNOWN";
}

class TTS {
  constructor(config) {
    this.config = isPlainObject(config) ? config : {};
  }

  async textToSpeech(options) {
    // 合并后立即快照：此后调用方改写传入对象不影响本次请求。
    const merged = snapshotValue(mergeConfig(this.config, options));

    try {
      if (!listBackends().includes(merged.model)) {
        throw createError("ERR_PLUGIN_MODEL", "该语音引擎不受支持。");
      }
      if (typeof merged.catalogPath !== "string" || merged.catalogPath.trim() === "") {
        throw createError("ERR_PLUGIN_NOT_CONFIGURED", "缺少本地音色资料目录。");
      }
      if (typeof merged.voiceName !== "string" || merged.voiceName === "") {
        throw createError("ERR_PLUGIN_NO_VOICE", "缺少音色选择。");
      }
      const text = typeof merged.text === "string" ? merged.text : "";
      if (text.trim() === "") {
        throw createError("ERR_TEXT_EMPTY", "待合成文本为空。");
      }

      // 目录只读一次，之后一律使用固定绑定快照。
      const catalog = readCatalog(merged.catalogPath);
      const resolved = resolveBinding(catalog, merged.model, merged.voiceName);
      const backend = getBackend(merged.model);
      const profile = catalog.profiles.find((item) => item.id === resolved.binding.profileId) || null;
      // 参数只来自已验证的绑定，绝不从 options 展开任何字段（旧 speed/language 一律忽略）。
      const parameters = isPlainObject(resolved.binding.params) ? resolved.binding.params : {};

      const result = await backend.synthesize({
        endpoint: resolved.endpoint,
        binding: resolved.binding,
        profile,
        text,
        parameters,
      });
      if (!result || !Buffer.isBuffer(result.audio) || result.audio.length === 0) {
        throw createError("ERR_PLUGIN_AUDIO", "后端未返回有效音频。");
      }
      return result.audio;
    } catch (error) {
      return CATEGORY[categoryOf(error)] || CATEGORY.UNKNOWN;
    }
  }
}

async function modelOptions(config) {
  const catalogPath =
    typeof config.catalogPath === "string" && config.catalogPath.trim() !== ""
      ? config.catalogPath
      : null;

  let catalog = null;
  if (catalogPath) {
    try {
      catalog = readCatalog(catalogPath);
    } catch {
      catalog = null;
    }
  }

  const entries = [];
  for (const id of listBackends()) {
    const label = BACKEND_LABELS[id] || id;
    if (!catalog) {
      entries.push({ value: id, label: `${label}（未配置本地音色资料）` });
      continue;
    }

    // 按后端聚合全部端点，不能只看第一个端点就判定整个引擎可用或不可用。
    const endpoints = catalog.endpoints.filter((item) => item.backendId === id);
    if (endpoints.length === 0) {
      entries.push({ value: id, label: `${label}（未配置端点）` });
      continue;
    }

    // 目录 readiness 先于任何探测：非 ready 的端点不得显示已核验，也不做无意义探测。
    const readyEndpoints = endpoints.filter((item) => item.readiness === "ready");
    if (readyEndpoints.length === 0) {
      entries.push({ value: id, label: `${label}（全部端点目录未就绪，暂不可用）` });
      continue;
    }

    let verifiedCount = 0;
    let reachable = false;
    for (const endpoint of readyEndpoints) {
      let state = "unreachable";
      try {
        state = (await getBackend(id).probe({ endpoint })).state;
      } catch {
        state = "unreachable";
      }
      if (state === "verified") {
        verifiedCount += 1;
      }
      if (state !== "unreachable") {
        reachable = true;
      }
    }

    let statusText;
    if (verifiedCount === 0) {
      statusText = reachable
        ? "全部端点未通过在线核验（未验证），暂不可用"
        : "端点服务未启动或不可达";
    } else if (verifiedCount === endpoints.length) {
      statusText = "在线身份已核验，尚未实机试音";
    } else {
      statusText = `部分端点已核验可用（${verifiedCount}/${endpoints.length}），尚未实机试音`;
    }
    entries.push({ value: id, label: `${label}（${statusText}）` });
  }
  return entries;
}

async function voiceOptions(config) {
  // 模型与目录只认 config（查询语义未证实，query 不得提供或覆盖配置）。
  const model = config.model || DEFAULT_MODEL;
  if (!listBackends().includes(model)) {
    return [];
  }
  const catalogPath =
    typeof config.catalogPath === "string" && config.catalogPath.trim() !== ""
      ? config.catalogPath
      : DEFAULT_CATALOG_PATH;

  let catalog;
  try {
    catalog = readCatalog(catalogPath);
  } catch {
    return [];
  }

  const backend = getBackend(model);
  const options = [];
  const seen = new Set();

  for (const endpoint of catalog.endpoints.filter((item) => item.backendId === model)) {
    let listed;
    try {
      listed = await backend.listVoices({ endpoint, catalog });
    } catch {
      continue;
    }

    for (const descriptor of listed) {
      if (!descriptor || descriptor.usable !== true) {
        continue;
      }
      const value = encodeVoiceValue({
        backendId: model,
        endpointId: endpoint.id,
        bindingId: descriptor.bindingId,
        revision: descriptor.revision,
      });
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);

      const binding = catalog.bindings.find((item) => item.id === descriptor.bindingId) || null;
      const profile = binding
        ? catalog.profiles.find((item) => item.id === binding.profileId) || null
        : null;
      options.push({
        value,
        label: profile ? `${profile.label}（已核验）` : String(descriptor.nativeVoiceId),
      });
    }
  }

  return options;
}

async function getEditorOptions(request) {
  const input = isPlainObject(request) ? request : {};
  // 首个 await 前固定快照，避免菜单期间调用方改写对象导致模型与目录混用。
  const config = snapshotValue(isPlainObject(input.config) ? input.config : {});

  if (input.fieldKey === "model") {
    return modelOptions(config);
  }
  if (input.fieldKey === "voiceName") {
    return voiceOptions(config);
  }
  return [];
}

module.exports = { default: TTS, getEditorOptions };
