"use strict";

// 4B1 本地管理 HTTP API 隔离夹具：自有临时 root + 真实 loopback Audio8 注册服务 + 极简 HTTP 客户端。
// 只写临时目录，不碰真实安装/资料/默认 root；测试输出不打印真实令牌。

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const store = require("../../manager/store.js");
const audio8Fixture = require("./audio8-fixture.js");
const { createManagerServer } = require("../../manager/server.js");

function mktemp(prefix = "memo-4b1-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function syntheticAudio(seed = 1, size = 2048) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buffer[i] = (i * 31 + seed) % 251;
  }
  return buffer;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 极简 HTTP 客户端：显式控制 cookie/CSRF/Origin/Host/Content-Length，便于安全负例。
function api(baseUrl, requestPath, options = {}) {
  const target = new URL(requestPath, baseUrl);
  const headers = { ...(options.headers || {}) };
  const payload = options.payload === undefined ? null : options.payload;
  if (options.chunked !== true && options.declaredLength === undefined && payload !== null) {
    headers["content-length"] = String(payload.length);
  }
  if (options.declaredLength !== undefined) {
    headers["content-length"] = String(options.declaredLength);
  }
  if (payload !== null && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || "GET",
        headers,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    request.on("error", reject);
    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}

// 裸 socket 请求：用于伪造 Content-Length 与分块流式超限等 HTTP 层边界。
function rawRequest(port, requestText, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, options.timeoutMs || 3000);
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (options.stopWhen && received.includes(options.stopWhen)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (received.length > 0) {
        resolve(received);
      } else {
        reject(error);
      }
    });
  });
}

async function bootstrapSession(baseUrl) {
  const response = await api(baseUrl, "/api/session");
  const setCookie = response.headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = rawCookie ? String(rawCookie).split(";")[0] : null;
  return {
    response,
    cookie,
    csrfToken: response.json && response.json.csrfToken ? response.json.csrfToken : null,
    rawCookie,
  };
}

// 裸 socket 控制器：用于慢发/滴流/无 body 的限时负例，避免等待默认长超时。
function openRawSocket(port) {
  const socket = net.connect(port, "127.0.0.1");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("utf8");
  });
  socket.on("error", () => {
    // 连接被服务端关闭属于预期路径。
  });
  return {
    write: (text) => socket.write(text),
    received: () => received,
    waitFor(pattern, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          if (received.includes(pattern)) {
            resolve(received);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`等待 ${pattern} 超时，已收到 ${received.length} 字节`));
            return;
          }
          setTimeout(check, 20);
        };
        check();
      });
    },
    close: () => socket.destroy(),
  };
}

// 默认授权头：cookie + CSRF + 精确同源 Origin；测试可逐项覆盖做负例。
function authedHeaders(baseUrl, session, extra = {}) {
  return {
    cookie: session.cookie,
    "x-memo-tts-csrf": session.csrfToken,
    origin: baseUrl,
    ...extra,
  };
}

async function setupServerEnv(t, config = {}) {
  const root = mktemp();
  t.after(() => cleanup(root));
  const ns = await store.initialize(root);
  const voicesRoot = path.join(ns.root, "voices");

  const install = audio8Fixture.makeInstallDir({ metaOverrides: config.metaOverrides || {} });
  t.after(() => cleanup(install.installRoot));

  const runtime = {
    backendId: "audio8",
    modelFingerprint: install.manifest.model_fingerprint,
    modelDir: install.modelDir,
    voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    instanceId: "server-instance-1",
    ...(config.runtimeOverrides || {}),
  };
  const voices = config.voices || [];
  const registerConfig = config.register || {};
  if (registerConfig.voicesRoot === undefined) {
    registerConfig.voicesRoot = voicesRoot;
  }
  const audio8Server = await audio8Fixture.startAudio8Server({
    health: config.health,
    voices,
    runtime: config.bare ? null : runtime,
    register: registerConfig,
  });
  t.after(async () => {
    await audio8Server.close();
  });

  const endpoint = {
    id: "ep-audio8-server",
    backendId: "audio8",
    baseUrl: audio8Server.baseUrl,
    modelFingerprint: install.manifest.model_fingerprint,
    readiness: "ready",
    runtimeManifestPath: install.manifestPath,
    voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    ...(config.endpointOverrides || {}),
  };
  if (config.skipEndpoint !== true) {
    await store.updateCatalog(ns.root, (draft) => {
      draft.endpoints.push(endpoint);
    });
  }

  const server = await createManagerServer({
    root: ns.root,
    port: 0,
    limits: config.limits,
    timeouts: config.timeouts,
  });
  t.after(async () => {
    await server.close();
  });

  return {
    root: ns.root,
    ns,
    install,
    runtime,
    audio8Server,
    endpoint,
    voicesRoot,
    server,
    baseUrl: server.url,
    port: server.port,
    store,
  };
}

function basePrepareBody(env, overrides = {}) {
  return {
    endpointId: env.endpoint.id,
    label: "自有讲师",
    audioBase64: syntheticAudio().toString("base64"),
    referenceText: "这是参考原文。",
    language: "zh",
    persistence: "temporary",
    authorizationConfirmed: true,
    ...overrides,
  };
}

module.exports = {
  mktemp,
  cleanup,
  syntheticAudio,
  api,
  rawRequest,
  openRawSocket,
  bootstrapSession,
  authedHeaders,
  setupServerEnv,
  basePrepareBody,
};
