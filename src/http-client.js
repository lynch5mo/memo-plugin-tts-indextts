"use strict";

// 本地模型 HTTP 客户端：只用显式 loopback endpoint，不跟随重定向，不自动重试，响应大小有界。

const http = require("node:http");
const https = require("node:https");

const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function createError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
}

function normalizeHostname(rawHostname) {
  return String(rawHostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = hostname.split(".");
  if (octets.length === 4 && octets[0] === "127") {
    return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  }
  return false;
}

function resolveTarget(baseUrl, path) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw createError("ERR_ENDPOINT_INVALID", "endpoint 缺少 baseUrl。");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw createError("ERR_ENDPOINT_INVALID", "endpoint baseUrl 不是合法 URL。");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw createError(
      "ERR_ENDPOINT_CREDENTIALS",
      "endpoint URL 携带凭据，已拒绝；凭据只能通过环境变量或凭据管理工具提供。",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createError("ERR_ENDPOINT_INVALID", "endpoint 只支持 http 或 https 协议。");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!isLoopbackHostname(hostname)) {
    throw createError(
      "ERR_ENDPOINT_NOT_LOOPBACK",
      `endpoint 主机 ${hostname || "(空)"} 不是 loopback，按策略拒绝。`,
    );
  }

  const requestPath = path === undefined ? "/" : path;
  if (
    typeof requestPath !== "string" ||
    !requestPath.startsWith("/") ||
    requestPath.startsWith("//") ||
    /[\r\n]/.test(requestPath)
  ) {
    throw createError(
      "ERR_ENDPOINT_INVALID",
      "请求路径必须是站内绝对路径（以 / 开头且不以 // 开头，不含换行）。",
    );
  }

  return { parsed, hostname, path: requestPath };
}

function normalizeMethod(rawMethod) {
  const method = rawMethod === undefined ? "GET" : rawMethod;
  if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method)) {
    throw createError("ERR_REQUEST", "HTTP method 必须是字母组成的字符串。");
  }
  return method.toUpperCase();
}

function normalizeHeaders(rawHeaders) {
  if (rawHeaders === undefined) {
    return {};
  }
  if (rawHeaders === null || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    throw createError("ERR_REQUEST", "headers 必须是普通对象。");
  }
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (/[\r\n]/.test(String(key)) || /[\r\n]/.test(String(value))) {
      throw createError("ERR_REQUEST", "headers 不允许包含换行字符。");
    }
    headers[String(key).toLowerCase()] = String(value);
  }
  return headers;
}

function buildPayload(json, body, headers) {
  if (json !== undefined && body !== undefined) {
    throw createError("ERR_REQUEST", "json 与 body 不能同时提供。");
  }
  if (json !== undefined) {
    if (headers["content-type"] === undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    return Buffer.from(JSON.stringify(json), "utf8");
  }
  if (body === undefined) {
    return null;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  throw createError("ERR_REQUEST", "body 只接受 Buffer 或字符串。");
}

function parseJsonBody(headers, body) {
  const contentType = String(headers["content-type"] || "");
  if (!/json/i.test(contentType)) {
    return null;
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function request(options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let clientRequest = null;

    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      settle(value);
    };
    const fail = (error) => finish(reject, error);
    const succeed = (value) => finish(resolve, value);

    let target;
    let method;
    let headers;
    let payload;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_SYNTHESIS_TIMEOUT_MS : options.timeoutMs;
    const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;

    try {
      target = resolveTarget(options.baseUrl, options.path);
      method = normalizeMethod(options.method);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw createError("ERR_REQUEST", "timeoutMs 必须是正整数毫秒。");
      }
      if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw createError("ERR_REQUEST", "maxBytes 必须是正整数。");
      }
      headers = normalizeHeaders(options.headers);
      payload = buildPayload(options.json, options.body, headers);
      if (payload) {
        headers["content-length"] = String(payload.length);
      } else if (method === "POST" || method === "PUT" || method === "PATCH") {
        headers["content-length"] = "0";
      }
    } catch (error) {
      fail(error);
      return;
    }

    const onResponse = (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400) {
        response.resume();
        fail(
          createError(
            "ERR_REDIRECT",
            `endpoint 返回 ${statusCode} 重定向，按策略不跟随，也不自动重试。`,
            { statusCode, location: response.headers.location },
          ),
        );
        return;
      }

      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        fail(
          createError(
            "ERR_RESPONSE_TOO_LARGE",
            `响应声明 ${declaredLength} 字节，超过单次上限 ${maxBytes} 字节。`,
            { maxBytes, declaredLength },
          ),
        );
        return;
      }

      const chunks = [];
      let received = 0;

      response.on("data", (chunk) => {
        if (settled) {
          return;
        }
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy();
          fail(
            createError(
              "ERR_RESPONSE_TOO_LARGE",
              `响应正文超过单次上限 ${maxBytes} 字节，已停止读取。`,
              { maxBytes },
            ),
          );
          return;
        }
        chunks.push(chunk);
      });

      response.on("error", (error) => {
        fail(
          createError("ERR_RESPONSE", `读取响应失败：${error && error.message ? error.message : "未知错误"}`, {
            cause: error,
          }),
        );
      });

      response.on("end", () => {
        if (settled) {
          return;
        }
        const body = Buffer.concat(chunks, received);
        succeed({
          statusCode,
          headers: response.headers,
          body,
          json: parseJsonBody(response.headers, body),
        });
      });
    };

    clientRequest = (target.parsed.protocol === "https:" ? https : http).request(
      {
        protocol: target.parsed.protocol,
        hostname: target.hostname,
        port: target.parsed.port || (target.parsed.protocol === "https:" ? 443 : 80),
        path: target.path,
        method,
        headers,
        agent: false,
      },
      onResponse,
    );

    clientRequest.on("error", (error) => {
      if (settled) {
        return;
      }
      if (error && error.code === "ERR_TIMEOUT") {
        fail(error);
        return;
      }
      fail(
        createError("ERR_REQUEST", `请求失败：${error && error.message ? error.message : "未知错误"}`, {
          cause: error,
        }),
      );
    });

    timer = setTimeout(() => {
      const error = createError(
        "ERR_TIMEOUT",
        `请求超时（${timeoutMs}ms）：客户端停止等待，模型侧推理可能仍在继续，不做自动重试。`,
        { timeoutMs },
      );
      clientRequest.destroy(error);
      fail(error);
    }, timeoutMs);

    if (payload) {
      clientRequest.write(payload);
    }
    clientRequest.end();
  });
}

module.exports = {
  request,
  DEFAULT_SYNTHESIS_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
};
