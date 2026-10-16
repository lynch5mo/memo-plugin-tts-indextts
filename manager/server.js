"use strict";

// 4B1 本地管理 HTTP API：只监听 127.0.0.1，root 由可信本机启动方固定。
// 会话 + CSRF + 精确同源校验；只接受固定字段白名单；不读任意文件、不执行模块/命令、不控制模型服务。
// 一次请求只调用一次 store，HTTP 层不重试、不因客户端断连自动回滚。

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.js");

const BIND_ADDRESS = "127.0.0.1";
const SESSION_COOKIE_NAME = "memo_tts_session";
const CSRF_HEADER_NAME = "x-memo-tts-csrf";
const DEFAULT_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_PREPARE_BODY_BYTES = 70 * 1024 * 1024;
const DEFAULT_PREPARE_AUDIO_BYTES = 50 * 1024 * 1024;
const DEFAULT_HEADERS_TIMEOUT_MS = 15 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_BODY_ABSOLUTE_TIMEOUT_MS = 120 * 1000;
const UI_ROOT = path.join(__dirname, "ui");
// 固定静态映射：只按路径查表，绝不把 URL 拼进文件路径。
const UI_ASSETS = Object.freeze({
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
});
const CSP_VALUE = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'none'",
].join("; ");
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// 固定分类令牌：仅字母/数字/连字符且有长度上界，杜绝路径、正文或任意字符串透传（含 notCommitted 等驼峰）。
const STATE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const CLEANUP_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const ROUTES = Object.freeze({
  "/api/session": { get: "session" },
  "/api/state": { get: "state" },
  "/api/import": { post: "import" },
  "/api/prepare": { post: "prepare" },
  "/api/save": { post: "save" },
  "/api/end": { post: "end" },
});

const FORWARDED_HEADERS = Object.freeze([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
]);

const PREPARE_FIELDS = Object.freeze([
  "endpointId",
  "label",
  "audioBase64",
  "referenceText",
  "language",
  "persistence",
  "authorizationConfirmed",
]);
const IMPORT_FIELDS = Object.freeze(["endpointId", "nativeVoiceId", "label"]);
const LIFECYCLE_FIELDS = Object.freeze(["profileId"]);

// 固定中文分类文案：只按错误码映射，绝不回显 store 原始 message/cause（可能含绝对路径）。
const FIXED_MESSAGES = Object.freeze({
  ERR_SERVER_INPUT: "请求格式非法。",
  ERR_SERVER_FIELDS: "请求包含不支持的字段。",
  ERR_SERVER_BASE64: "上传音频必须是规范的 base64 且非空。",
  ERR_SERVER_TOO_LARGE: "请求体超过本接口上限。",
  ERR_SERVER_HOST: "Host 不是本实例地址，拒绝。",
  ERR_SERVER_FORWARDED: "检测到转发头，拒绝。",
  ERR_SERVER_SESSION: "缺少有效会话，拒绝。",
  ERR_SERVER_CSRF: "CSRF 校验失败，拒绝。",
  ERR_SERVER_ORIGIN: "同源校验失败，拒绝。",
  ERR_SERVER_ABORTED: "客户端提前断开，本次请求未确认完成。",
  ERR_SERVER_BODY_TIMEOUT: "请求体在限时内未完整送达，已按超时终止。",
  ERR_STORE_PREPARE_INPUT: "准备参数不符合要求。",
  ERR_STORE_IMPORT_INPUT: "导入参数不符合要求。",
  ERR_STORE_PREPARE_ENDPOINT_MISSING: "端点未在当前目录登记。",
  ERR_STORE_IMPORT_ENDPOINT_MISSING: "端点未在当前目录登记。",
  ERR_STORE_PREPARE_ENDPOINT_NOT_READY: "端点目录声明未就绪。",
  ERR_STORE_PREPARE_BACKEND_UNSUPPORTED: "该后端不支持准备新音色。",
  ERR_STORE_IMPORT_BACKEND_UNSUPPORTED: "该后端不支持导入。",
  ERR_STORE_BUSY: "目录正被另一个事务修改，请稍后重试。",
  ERR_STORE_CONCURRENT: "目录正被并发修改，请稍后重试。",
  ERR_STORE_CATALOG_CONFLICT: "目录在事务期间被改写，已拒绝覆盖。",
  ERR_STORE_LIFECYCLE_NOT_TEMPORARY: "该音色当前状态不允许此操作。",
  ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH: "在线声音目录与自有目录不一致，拒绝。",
  ERR_STORE_PREPARE_REGISTER_FAILED: "注册被服务明确拒绝，原目录不变。",
  ERR_STORE_PREPARE_REGISTER_UNKNOWN: "注册请求未确认完成，保守记为未知，不自动重发。",
  ERR_STORE_PREPARE_VERIFY_FAILED: "注册后核验未通过，不发布 ready。",
  ERR_STORE_PREPARE_DRIFT: "在线身份或模型指纹漂移，拒绝发布。",
  ERR_STORE_PREPARE_JOURNAL: "操作记录无法持久写入，已在注册前失败关闭。",
  ERR_STORE_PREPARE_JOURNAL_PUBLISHED: "目录已提交但操作记录末步失败，需人工核对，禁止自动重发。",
  ERR_STORE_IMPORT_UNVERIFIED: "导入核验未通过，不发布 ready。",
  ERR_STORE_IMPORT_DRIFT: "导入期间在线身份漂移，拒绝发布。",
});

const BAD_REQUEST_CODES = new Set([
  "ERR_SERVER_INPUT",
  "ERR_SERVER_FIELDS",
  "ERR_SERVER_BASE64",
  "ERR_STORE_PREPARE_INPUT",
  "ERR_STORE_IMPORT_INPUT",
  "ERR_STORE_PREPARE_ENDPOINT_MISSING",
  "ERR_STORE_IMPORT_ENDPOINT_MISSING",
]);

const CONFLICT_CODES = new Set([
  "ERR_STORE_BUSY",
  "ERR_STORE_CONCURRENT",
  "ERR_STORE_CATALOG_CONFLICT",
  "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  "ERR_STORE_PREPARE_ENDPOINT_NOT_READY",
  "ERR_STORE_PREPARE_BACKEND_UNSUPPORTED",
  "ERR_STORE_IMPORT_BACKEND_UNSUPPORTED",
  "ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH",
  "ERR_STORE_IMPORT_CONFLICT",
  "ERR_STORE_IMPORT_FINGERPRINT_CHANGED",
]);

const UPSTREAM_CODES = new Set([
  "ERR_STORE_PREPARE_REGISTER_FAILED",
  "ERR_STORE_PREPARE_REGISTER_UNKNOWN",
  "ERR_STORE_PREPARE_VERIFY_FAILED",
  "ERR_STORE_PREPARE_DRIFT",
  "ERR_STORE_IMPORT_UNVERIFIED",
  "ERR_STORE_IMPORT_DRIFT",
]);

function createError(code, message, extra) {
  const error = new Error(message || code);
  error.code = code;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
}

function statusForCode(code) {
  if (BAD_REQUEST_CODES.has(code)) {
    return 400;
  }
  if (code === "ERR_SERVER_TOO_LARGE") {
    return 413;
  }
  if (code === "ERR_SERVER_BODY_TIMEOUT") {
    return 408;
  }
  if (
    code === "ERR_SERVER_HOST" ||
    code === "ERR_SERVER_FORWARDED" ||
    code === "ERR_SERVER_SESSION" ||
    code === "ERR_SERVER_CSRF" ||
    code === "ERR_SERVER_ORIGIN"
  ) {
    return 403;
  }
  if (CONFLICT_CODES.has(code)) {
    return 409;
  }
  if (UPSTREAM_CODES.has(code)) {
    return 502;
  }
  return 500;
}

function asStateToken(value) {
  return typeof value === "string" && STATE_TOKEN_PATTERN.test(value) ? value : null;
}

function asBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function projectCleanup(cleanup) {
  if (!cleanup || typeof cleanup !== "object") {
    return null;
  }
  const out = {};
  if (typeof cleanup.ok === "boolean") {
    out.ok = cleanup.ok;
  }
  if (cleanup.temp && typeof cleanup.temp === "object") {
    out.temp = {
      status: asStateToken(cleanup.temp.status) || "unknown",
      ok: asBoolean(cleanup.temp.ok),
    };
  }
  if (cleanup.lock && typeof cleanup.lock === "object") {
    out.lock = { status: asStateToken(cleanup.lock.status) || "unknown" };
  }
  // journal 清理结果（writeAttemptJournal 的单独结构）。
  if (typeof cleanup.status === "string") {
    out.status = CLEANUP_TOKEN_PATTERN.test(cleanup.status) ? cleanup.status : "unknown";
  }
  if (typeof cleanup.removed === "boolean") {
    out.removed = cleanup.removed;
  }
  if (typeof cleanup.rolledBack === "boolean") {
    out.rolledBack = cleanup.rolledBack;
  }
  if (typeof cleanup.readyCommitted === "boolean") {
    out.readyCommitted = cleanup.readyCommitted;
  }
  return out;
}

// 固定字段错误 JSON：双状态 + 精简清理，绝不序列化 Error/cause/绝对路径/令牌。
function toErrorPayload(error) {
  const code = typeof error.code === "string" ? error.code : "ERR_SERVER_UNKNOWN";
  return {
    ok: false,
    error: code,
    message: FIXED_MESSAGES[code] || "服务处理失败，请查看本机日志与目录状态。",
    registrationState: asStateToken(error.registrationState),
    commitState: asStateToken(error.commitState),
    retrySafe: asBoolean(error.retrySafe),
    registrationRetrySafe: asBoolean(error.registrationRetrySafe),
    cleanup: projectCleanup(error.cleanup),
    journalCleanup: projectCleanup(error.journalCleanup),
  };
}

function projectState(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    endpoints: catalog.endpoints.map((endpoint) => ({
      id: endpoint.id,
      backendId: endpoint.backendId,
      readiness: endpoint.readiness,
    })),
    profiles: catalog.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      persistence: profile.persistence,
    })),
    bindings: catalog.bindings.map((binding) => ({
      id: binding.id,
      profileId: binding.profileId,
      backendId: binding.backendId,
      endpointId: binding.endpointId,
      nativeVoiceId: binding.nativeVoiceId,
      status: binding.status,
      revision: binding.revision,
    })),
  };
}

function socketHostHeader(port) {
  return `${BIND_ADDRESS}:${port}`;
}

function instanceOrigin(port) {
  return `http://${socketHostHeader(port)}`;
}

function parseSessionId(header) {
  if (typeof header !== "string") {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name === SESSION_COOKIE_NAME) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function sessionCookie(id) {
  return `${SESSION_COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/`;
}

function timingSafeEqualText(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function assertOnlyKeys(object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw createError("ERR_SERVER_FIELDS", "请求包含不支持的字段。");
    }
  }
}

function requirePlainBody(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createError("ERR_SERVER_INPUT", "请求体必须是 JSON 对象。");
  }
  return parsed;
}

function decodeAudioBase64(value, maxAudioBytes) {
  if (typeof value !== "string" || value.length === 0) {
    throw createError("ERR_SERVER_BASE64", "上传音频必须是规范的 base64 且非空。");
  }
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw createError("ERR_SERVER_BASE64", "上传音频必须是规范的 base64 且非空。");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== value) {
    throw createError("ERR_SERVER_BASE64", "上传音频必须是规范的 base64 且非空。");
  }
  if (buffer.length > maxAudioBytes) {
    throw createError("ERR_SERVER_TOO_LARGE", "解码后的音频超过上限。");
  }
  return buffer;
}

function resolveLimit(value, fallback) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    return fallback;
  }
  return value;
}

// 有界读取：大小上限之外再加空闲与绝对 deadline。所有 timer/listener 在 resolve/reject 前清理，
// 且一旦 body 收完立即清 timer，后续 store 注册/合成不会被 body 计时取消。
function readBoundedBody(request, limit, deadlines) {
  return new Promise((resolve, reject) => {
    const declared = request.headers["content-length"];
    if (declared !== undefined) {
      if (!/^\d+$/.test(String(declared).trim())) {
        reject(createError("ERR_SERVER_INPUT", "Content-Length 非法。"));
        return;
      }
      if (Number(declared) > limit) {
        reject(createError("ERR_SERVER_TOO_LARGE", "请求体超过本接口上限。"));
        return;
      }
    }

    let total = 0;
    let settled = false;
    let idleTimer = null;
    let absoluteTimer = null;
    const chunks = [];
    const clearTimers = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (absoluteTimer !== null) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    };
    const expire = () => {
      fail(createError("ERR_SERVER_BODY_TIMEOUT", "请求体在限时内未完整送达。"));
      request.pause();
    };
    const armIdle = () => {
      if (settled) {
        return;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(expire, deadlines.idleMs);
    };

    absoluteTimer = setTimeout(expire, deadlines.absoluteMs);
    armIdle();

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      armIdle();
      total += chunk.length;
      if (total > limit) {
        fail(createError("ERR_SERVER_TOO_LARGE", "请求体超过本接口上限。"));
        request.pause();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => fail(createError("ERR_SERVER_ABORTED", "客户端提前断开。")));
    request.on("error", (error) => fail(createError("ERR_SERVER_ABORTED", "请求流错误。", { cause: error })));
  });
}

/**
 * 启动本地管理 API。root 由可信本机调用方固定；只做 validateNamespace，不隐式初始化。
 * 返回 { server, url, port, root, close }，close 只关闭本服务自己的句柄。
 */
async function createManagerServer(options = {}) {
  const root = options.root;
  if (typeof root !== "string" || root.trim() === "") {
    throw createError("ERR_SERVER_ROOT", "root 必须是启动方提供的非空路径字符串。");
  }
  const port = options.port === undefined ? 0 : options.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw createError("ERR_SERVER_PORT", "port 必须是 0 到 65535 的整数。");
  }
  const limits = options.limits || {};
  const bodyLimits = {
    json: resolveLimit(limits.jsonBytes, DEFAULT_JSON_BODY_BYTES),
    prepare: resolveLimit(limits.prepareBodyBytes, DEFAULT_PREPARE_BODY_BYTES),
    audio: resolveLimit(limits.prepareAudioBytes, DEFAULT_PREPARE_AUDIO_BYTES),
  };
  // 限时同样只允许收窄：测试用短阈值可重复验证，生产保留加固后的默认值。
  const requestedTimeouts = options.timeouts || {};
  const timeouts = {
    headersMs: resolveLimit(requestedTimeouts.headersMs, DEFAULT_HEADERS_TIMEOUT_MS),
    requestMs: resolveLimit(requestedTimeouts.requestMs, DEFAULT_REQUEST_TIMEOUT_MS),
    keepAliveMs: resolveLimit(requestedTimeouts.keepAliveMs, DEFAULT_KEEP_ALIVE_TIMEOUT_MS),
    bodyIdleMs: resolveLimit(requestedTimeouts.bodyIdleMs, DEFAULT_BODY_IDLE_TIMEOUT_MS),
    bodyAbsoluteMs: resolveLimit(requestedTimeouts.bodyAbsoluteMs, DEFAULT_BODY_ABSOLUTE_TIMEOUT_MS),
  };

  // 静态资源在启动时按固定映射读入内存，运行期不再拼路径。
  const assets = new Map();
  for (const [route, asset] of Object.entries(UI_ASSETS)) {
    let body;
    try {
      body = fs.readFileSync(path.join(UI_ROOT, asset.file));
    } catch (error) {
      throw createError("ERR_SERVER_UI_MISSING", `缺少界面资源 ${asset.file}。`, { cause: error });
    }
    assets.set(route, { type: asset.type, body });
  }

  // 启动只核验，不创建；未初始化目录直接失败。
  const ns = await store.validateNamespace(root);
  const realRoot = ns.root;
  const sessions = new Map();
  const state = { port: null };

  const sendJson = (response, status, payload, extraHeaders = {}) => {
    const text = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": text.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": CSP_VALUE,
      ...extraHeaders,
    });
    response.end(text);
  };

  const sendError = (response, error) => {
    const status = statusForCode(error.code);
    const extra = status === 413 || status === 408 ? { connection: "close" } : {};
    sendJson(response, status, toErrorPayload(error), extra);
  };

  const sendAsset = (response, asset) => {
    response.writeHead(200, {
      "content-type": asset.type,
      "content-length": asset.body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": CSP_VALUE,
    });
    response.end(asset.body);
  };

  const getSession = (request, response) => {
    const present = parseSessionId(request.headers.cookie);
    let session = present ? sessions.get(present) : null;
    if (!session) {
      const id = crypto.randomBytes(32).toString("hex");
      session = { id, csrf: crypto.randomBytes(32).toString("hex"), createdAt: Date.now() };
      sessions.set(id, session);
      response.setHeader("set-cookie", sessionCookie(id));
    }
    return session;
  };

  const requireSession = (request) => {
    const present = parseSessionId(request.headers.cookie);
    const session = present ? sessions.get(present) : null;
    if (!session || !TOKEN_PATTERN.test(present)) {
      throw createError("ERR_SERVER_SESSION", "缺少有效会话，拒绝。");
    }
    return session;
  };

  const requireSameOriginWrite = (request, session) => {
    const origin = request.headers.origin;
    if (origin !== instanceOrigin(state.port)) {
      throw createError("ERR_SERVER_ORIGIN", "同源校验失败，拒绝。");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      throw createError("ERR_SERVER_ORIGIN", "同源校验失败，拒绝。");
    }
    const token = request.headers[CSRF_HEADER_NAME];
    if (!timingSafeEqualText(typeof token === "string" ? token : "", session.csrf)) {
      throw createError("ERR_SERVER_CSRF", "CSRF 校验失败，拒绝。");
    }
  };

  // 逐路由固定字段映射：绝不把请求对象直接展开成 store 选项。
  const handleRoute = async (action, request, bodyText) => {
    if (action === "state") {
      return { status: 200, payload: { ok: true, ...projectState(await store.readManagedCatalog(realRoot)) } };
    }

    let parsed = null;
    if (bodyText.length > 0) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw createError("ERR_SERVER_INPUT", "请求体不是合法 JSON。");
      }
    }
    const body = requirePlainBody(parsed);

    if (action === "import") {
      assertOnlyKeys(body, IMPORT_FIELDS);
      await store.importExternal(realRoot, {
        endpointId: body.endpointId,
        nativeVoiceId: body.nativeVoiceId,
        label: body.label,
      });
    } else if (action === "prepare") {
      assertOnlyKeys(body, PREPARE_FIELDS);
      const audio = decodeAudioBase64(body.audioBase64, bodyLimits.audio);
      await store.prepareVoice(realRoot, {
        endpointId: body.endpointId,
        label: body.label,
        audio,
        referenceText: body.referenceText,
        language: body.language,
        persistence: body.persistence,
        authorizationConfirmed: body.authorizationConfirmed,
      });
    } else if (action === "save") {
      assertOnlyKeys(body, LIFECYCLE_FIELDS);
      await store.saveTemporary(realRoot, body.profileId);
    } else if (action === "end") {
      assertOnlyKeys(body, LIFECYCLE_FIELDS);
      await store.endTemporary(realRoot, body.profileId);
    } else {
      throw createError("ERR_SERVER_INPUT", "未知操作。");
    }

    return { status: 200, payload: { ok: true, ...projectState(await store.readManagedCatalog(realRoot)) } };
  };

  const handler = (request, response) => {
    response.on("error", () => {
      // 客户端断开导致的写失败不改变已完成的服务端状态。
    });

    const run = async () => {
      if (request.headers.host !== socketHostHeader(state.port)) {
        throw createError("ERR_SERVER_HOST", "Host 不是本实例地址，拒绝。");
      }
      if (FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined)) {
        throw createError("ERR_SERVER_FORWARDED", "检测到转发头，拒绝。");
      }
      // 跨站来源一律拒绝，静态资源也不例外（浏览器同源导航不带 Origin，但可带 Sec-Fetch-Site）。
      if (request.headers["sec-fetch-site"] === "cross-site") {
        throw createError("ERR_SERVER_ORIGIN", "同源校验失败，拒绝。");
      }

      const pathname = new URL(request.url, instanceOrigin(state.port)).pathname;
      const asset = assets.get(pathname);
      if (asset) {
        if (String(request.method).toUpperCase() !== "GET") {
          throw createError("ERR_SERVER_METHOD", "方法不被允许。");
        }
        sendAsset(response, asset);
        return;
      }
      const route = ROUTES[pathname];
      if (!route) {
        throw createError("ERR_SERVER_NOT_FOUND", "未知路径。");
      }
      const action = route[String(request.method).toLowerCase()];
      if (!action) {
        throw createError("ERR_SERVER_METHOD", "方法不被允许。");
      }

      if (action === "session") {
        const session = getSession(request, response);
        sendJson(response, 200, { ok: true, csrfToken: session.csrf });
        return;
      }

      const session = requireSession(request);
      if (request.method === "POST") {
        requireSameOriginWrite(request, session);
      }

      const limit = action === "prepare" ? bodyLimits.prepare : bodyLimits.json;
      const bodyBuffer = await readBoundedBody(request, limit, {
        idleMs: timeouts.bodyIdleMs,
        absoluteMs: timeouts.bodyAbsoluteMs,
      });
      const result = await handleRoute(action, request, bodyBuffer.toString("utf8"));
      sendJson(response, result.status, result.payload);
    };

    run().catch((error) => {
      if (response.headersSent || response.destroyed) {
        return;
      }
      try {
        if (error.code === "ERR_SERVER_NOT_FOUND") {
          sendJson(response, 404, toErrorPayload(error));
          return;
        }
        if (error.code === "ERR_SERVER_METHOD") {
          sendJson(response, 405, toErrorPayload(error), { allow: "GET, POST" });
          return;
        }
        sendError(response, error);
      } catch {
        // 响应阶段失败不再抛出，避免影响其它连接。
      }
    });
  };

  const server = http.createServer(handler);
  server.headersTimeout = timeouts.headersMs;
  server.requestTimeout = timeouts.requestMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, BIND_ADDRESS);
  });

  state.port = server.address().port;
  let closed = false;

  return {
    server,
    port: state.port,
    root: realRoot,
    url: instanceOrigin(state.port),
    close() {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      sessions.clear();
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };
}

module.exports = {
  createManagerServer,
  BIND_ADDRESS,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  DEFAULT_JSON_BODY_BYTES,
  DEFAULT_PREPARE_BODY_BYTES,
  DEFAULT_PREPARE_AUDIO_BYTES,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_BODY_ABSOLUTE_TIMEOUT_MS,
  UI_ASSETS,
  CSP_VALUE,
};
