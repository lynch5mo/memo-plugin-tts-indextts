"use strict";

// 4B1 本地管理 HTTP API：真实 loopback 服务 + 自有临时 root，全部走 HTTP 断言。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const fx = require("./helpers/server-fixture.js");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function patchFs(t, name, impl) {
  const original = fs[name];
  fs[name] = impl(original);
  t.after(() => {
    fs[name] = original;
  });
}

function ioError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

test("GET /api/session 同源引导：no-store/nosniff、随机 CSRF、HttpOnly+SameSite=Strict cookie、无 CORS 头", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  assert.equal(session.response.status, 200);
  assert.equal(session.response.headers["cache-control"], "no-store");
  assert.equal(session.response.headers["x-content-type-options"], "nosniff");
  assert.match(session.csrfToken, /^[0-9a-f]{64}$/);
  assert.match(session.cookie, /^memo_tts_session=[0-9a-f]{64}$/);
  assert.match(session.rawCookie, /HttpOnly/i);
  assert.match(session.rawCookie, /SameSite=Strict/i);
  assert.match(session.rawCookie, /Path=\//i);
  for (const name of Object.keys(session.response.headers)) {
    assert.ok(!name.startsWith("access-control-"), `不得出现 CORS 头 ${name}`);
  }
  // 第二次引导复用同一会话，令牌不变化。
  const again = await fx.api(env.baseUrl, "/api/session", { headers: { cookie: session.cookie } });
  assert.equal(again.json.csrfToken, session.csrfToken);
});

test("Host 不是本实例 127.0.0.1:port 时拒绝，session 与 state 都不放行", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  const badHost = await fx.api(env.baseUrl, "/api/session", { headers: { host: "localhost:1234" } });
  assert.equal(badHost.status, 403);

  const badHostState = await fx.api(env.baseUrl, "/api/state", {
    headers: fx.authedHeaders(env.baseUrl, session, { host: "evil.example" }),
  });
  assert.equal(badHostState.status, 403);
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("无 session cookie 的 /api/state 与写请求都拒绝，0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t);
  const state = await fx.api(env.baseUrl, "/api/state");
  assert.equal(state.status, 403);

  const write = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: { origin: env.baseUrl, "x-memo-tts-csrf": "0".repeat(64) },
    payload: Buffer.from(JSON.stringify(fx.basePrepareBody(env)), "utf8"),
  });
  assert.equal(write.status, 403);
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("GET /api/state 返回摘要：端点公开状态与名称/ID，不含绝对路径、令牌或原始错误正文", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  const state = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });

  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.endpoints.length, 1);
  assert.equal(state.json.endpoints[0].id, env.endpoint.id);
  assert.equal(state.json.endpoints[0].backendId, "audio8");
  assert.equal(state.json.endpoints[0].readiness, "ready");
  assert.deepEqual(state.json.profiles, []);
  assert.deepEqual(state.json.bindings, []);
  assert.ok(!state.text.includes(env.root), "不得出现 root 绝对路径");
  assert.ok(!state.text.includes(env.install.installRoot), "不得出现安装绝对路径");
  assert.ok(!state.text.includes(session.csrfToken), "不得回显 CSRF 令牌");
  assert.ok(!state.text.includes(session.cookie), "不得回显 session cookie");
  assert.equal(state.headers["cache-control"], "no-store");
});

test("合法 session+CSRF+Origin 的 prepare 成功：恰好 1 次注册、自有资料落盘、state 反映 ready 绑定", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  const audio = fx.syntheticAudio(3);
  const body = fx.basePrepareBody(env, { audioBase64: audio.toString("base64") });

  const response = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(body), "utf8"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.equal(env.audio8Server.state.calls.tts, 0);
  assert.equal(env.audio8Server.state.registerDetails[0].audioSha256, sha256(audio));

  const state = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });
  assert.equal(state.json.profiles.length, 1);
  assert.equal(state.json.profiles[0].persistence, "temporary");
  assert.equal(state.json.profiles[0].label, "自有讲师");
  assert.equal(state.json.bindings.length, 1);
  assert.equal(state.json.bindings[0].status, "ready");
  assert.equal(state.json.bindings[0].endpointId, env.endpoint.id);
  assert.ok(!state.text.includes(env.root));

  const sourceDirs = fs.readdirSync(path.join(env.root, "sources"));
  assert.equal(sourceDirs.length, 1);
  assert.ok(fs.existsSync(path.join(env.root, "sources", sourceDirs[0], "reference.audio")));
});

test("缺 CSRF header、错 CSRF、Origin 缺失、跨站 Origin 的写请求全部 403 且 0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  const payload = Buffer.from(JSON.stringify(fx.basePrepareBody(env)), "utf8");

  const cases = [
    { name: "缺 CSRF", headers: { cookie: session.cookie, origin: env.baseUrl } },
    { name: "错 CSRF", headers: fx.authedHeaders(env.baseUrl, session, { "x-memo-tts-csrf": "f".repeat(64) }) },
    {
      name: "Origin 缺失",
      headers: { cookie: session.cookie, "x-memo-tts-csrf": session.csrfToken, origin: "" },
    },
    { name: "跨站 Origin", headers: fx.authedHeaders(env.baseUrl, session, { origin: "http://evil.example" }) },
    {
      name: "跨站 Sec-Fetch-Site",
      headers: fx.authedHeaders(env.baseUrl, session, { "sec-fetch-site": "cross-site" }),
    },
    { name: "X-Forwarded-For", headers: fx.authedHeaders(env.baseUrl, session, { "x-forwarded-for": "10.0.0.1" }) },
  ];

  for (const entry of cases) {
    const response = await fx.api(env.baseUrl, "/api/prepare", { method: "POST", headers: entry.headers, payload });
    assert.equal(response.status, 403, `${entry.name} 必须 403，实际 ${response.status}`);
    assert.ok(!Object.keys(response.headers).some((name) => name.startsWith("access-control-")));
  }
  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
});

test("OPTIONS 与副作用 GET 都被拒绝，不提供 CORS 预检，0 次注册且不改目录", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  const preflight = await fx.api(env.baseUrl, "/api/prepare", {
    method: "OPTIONS",
    headers: fx.authedHeaders(env.baseUrl, session, { "access-control-request-method": "POST" }),
  });
  assert.equal(preflight.status, 405);
  assert.ok(!Object.keys(preflight.headers).some((name) => name.startsWith("access-control-")));

  for (const route of ["/api/prepare", "/api/save", "/api/end", "/api/import"]) {
    const response = await fx.api(env.baseUrl, route, { headers: fx.authedHeaders(env.baseUrl, session) });
    assert.equal(response.status, 405, `GET ${route} 必须 405`);
  }
  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("未知路径 404、已知路径错误方法 405，且不泄漏文件系统信息", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  const missing = await fx.api(env.baseUrl, "/api/nope", { headers: fx.authedHeaders(env.baseUrl, session) });
  assert.equal(missing.status, 404);
  assert.ok(!missing.text.includes(env.root));

  const wrongMethod = await fx.api(env.baseUrl, "/api/state", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from("{}", "utf8"),
  });
  assert.equal(wrongMethod.status, 405);
});

test("未知字段（root/audioPath）被拒绝 400，绝不展开进 store，0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  for (const extra of [{ root: env.root }, { audioPath: "/tmp/evil.wav" }, { module: "node:fs" }]) {
    const body = fx.basePrepareBody(env, extra);
    const response = await fx.api(env.baseUrl, "/api/prepare", {
      method: "POST",
      headers: fx.authedHeaders(env.baseUrl, session),
      payload: Buffer.from(JSON.stringify(body), "utf8"),
    });
    assert.equal(response.status, 400, `未知字段 ${Object.keys(extra)[0]} 必须 400`);
    assert.ok(!response.text.includes("/tmp/evil.wav"));
  }
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("非法 base64 与非 canonical base64 拒绝 400，0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  for (const audioBase64 of ["not-base64!!!", "AAAA AAAA", "AAA", "====", ""]) {
    const body = fx.basePrepareBody(env, { audioBase64 });
    const response = await fx.api(env.baseUrl, "/api/prepare", {
      method: "POST",
      headers: fx.authedHeaders(env.baseUrl, session),
      payload: Buffer.from(JSON.stringify(body), "utf8"),
    });
    assert.equal(response.status, 400, `非法 base64 ${JSON.stringify(audioBase64)} 必须 400`);
  }
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("prepare 端点未在 catalog 登记时拒绝，带双状态字段且 0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t, { skipEndpoint: true });
  const session = await fx.bootstrapSession(env.baseUrl);
  const body = fx.basePrepareBody(env);

  const response = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(body), "utf8"),
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  // 未发出 POST 时 registrationState/registrationRetrySafe 未定，服务端不臆造。
  assert.equal(response.json.registrationState, null);
  assert.equal(response.json.commitState, "notCommitted");
  assert.equal(response.json.retrySafe, true);
  assert.equal(response.json.registrationRetrySafe, null);
  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.ok(!response.text.includes(env.root));
});

test("register 503：错误 JSON 保留 unknown/notCommitted/两种 retry，恰好 1 次注册不重试，无绝对路径", async (t) => {
  const env = await fx.setupServerEnv(t, { register: { status: 503, body: { detail: "runtime busy" } } });
  const session = await fx.bootstrapSession(env.baseUrl);
  const body = fx.basePrepareBody(env);

  const response = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(body), "utf8"),
  });
  assert.ok(response.status >= 500 && response.status < 600, `未知完成状态必须 5xx，实际 ${response.status}`);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.registrationState, "unknown");
  assert.equal(response.json.commitState, "notCommitted");
  // 目录未提交，目录级 retrySafe 为 true；registrationRetrySafe 才是禁止重发 POST 的那一位。
  assert.equal(response.json.retrySafe, true);
  assert.equal(response.json.registrationRetrySafe, false);
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.ok(!response.text.includes(env.root));
  assert.ok(!response.text.includes("runtime busy"));
});

test("published journal 失败：错误 JSON 报 committed+registered 且两种 retry false，不写成可重试", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  let operationRenames = 0;
  patchFs(t, "renameSync", (originalRename) => (from, to) => {
    if (String(to).includes("operations")) {
      operationRenames += 1;
      if (operationRenames === 3) {
        throw ioError("EPERM", "journal published 写入失败");
      }
    }
    return originalRename(from, to);
  });

  const response = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(fx.basePrepareBody(env)), "utf8"),
  });
  assert.ok(response.status >= 500, `服务侧失败必须 5xx，实际 ${response.status}`);
  assert.equal(response.json.commitState, "committed");
  assert.equal(response.json.registrationState, "registered");
  assert.equal(response.json.retrySafe, false);
  assert.equal(response.json.registrationRetrySafe, false);
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.ok(!response.text.includes(env.root));
  assert.ok(!response.text.includes("EPERM"));
  const onDisk = JSON.parse(fs.readFileSync(path.join(env.root, "catalog.json"), "utf8"));
  assert.equal(onDisk.bindings[0].status, "ready");
});

test("上传边界：Content-Length 声明超限、无 Content-Length 的分块流式超限、JSON 路由超限都 413 且不落盘", async (t) => {
  const env = await fx.setupServerEnv(t, {
    limits: { jsonBytes: 1024, prepareBodyBytes: 8192, prepareAudioBytes: 1024 },
  });
  const session = await fx.bootstrapSession(env.baseUrl);
  const origin = env.baseUrl;
  const commonHeaders = [
    `Host: 127.0.0.1:${env.port}`,
    `Cookie: ${session.cookie}`,
    `X-Memo-TTS-CSRF: ${session.csrfToken}`,
    `Origin: ${origin}`,
    "Content-Type: application/json",
  ].join("\r\n");

  // Content-Length 直接声明超限：不读取正文就拒绝。
  const declared = await fx.rawRequest(
    env.port,
    `POST /api/prepare HTTP/1.1\r\n${commonHeaders}\r\nContent-Length: 99999999\r\n\r\n`,
    { stopWhen: "413" },
  );
  assert.match(declared, / 413 /, "Content-Length 超限必须 413");

  // 无 Content-Length 的分块流式：累计超过上限即拒绝。
  const chunk = Buffer.alloc(2048, 0x61);
  let streamed = `POST /api/prepare HTTP/1.1\r\n${commonHeaders}\r\nTransfer-Encoding: chunked\r\n\r\n`;
  for (let i = 0; i < 8; i += 1) {
    streamed += `${chunk.length.toString(16)}\r\n${chunk.toString("utf8")}\r\n`;
  }
  streamed += "0\r\n\r\n";
  const streamedResponse = await fx.rawRequest(env.port, streamed, { stopWhen: "413" });
  assert.match(streamedResponse, / 413 /, "分块流式超限必须 413");

  // 其它 JSON 路由只允许 64KiB（本实例收窄到 1KiB）。
  const bigJson = await fx.api(env.baseUrl, "/api/save", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify({ profileId: "x".repeat(2048) }), "utf8"),
  });
  assert.equal(bigJson.status, 413);

  // 收窄后的解码音频上限同样生效。
  const bigAudio = fx.basePrepareBody(env, { audioBase64: fx.syntheticAudio(1, 4096).toString("base64") });
  const bigAudioResponse = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(bigAudio), "utf8"),
  });
  assert.equal(bigAudioResponse.status, 413);

  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
});

test("并发持锁时写请求返回 409 BUSY 且 0 次注册", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  const holding = env.store.updateCatalog(env.root, async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  try {
    const response = await fx.api(env.baseUrl, "/api/prepare", {
      method: "POST",
      headers: fx.authedHeaders(env.baseUrl, session),
      payload: Buffer.from(JSON.stringify(fx.basePrepareBody(env)), "utf8"),
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.ok, false);
    assert.equal(env.audio8Server.state.calls.register, 0);
  } finally {
    await holding;
  }
});

test("save 与 end 经 HTTP 生效：临时转 saved，end 后绑定 invalid", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);

  await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(fx.basePrepareBody(env, { persistence: "temporary" })), "utf8"),
  });
  let state = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });
  const profileId = state.json.profiles[0].id;

  const saved = await fx.api(env.baseUrl, "/api/save", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify({ profileId }), "utf8"),
  });
  assert.equal(saved.status, 200);
  state = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });
  assert.equal(state.json.profiles[0].persistence, "saved");

  // saved 不能停用：409 冲突，绑定保持 ready。
  const conflict = await fx.api(env.baseUrl, "/api/end", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify({ profileId }), "utf8"),
  });
  assert.ok(conflict.status === 409 || conflict.status === 400, `saved 停用必须冲突，实际 ${conflict.status}`);
  state = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });
  assert.equal(state.json.bindings[0].status, "ready");
});

test("close 只关闭自有句柄：本实例端口失效，Audio8 fixture 仍可用", async (t) => {
  const env = await fx.setupServerEnv(t);
  const session = await fx.bootstrapSession(env.baseUrl);
  const ok = await fx.api(env.baseUrl, "/api/state", { headers: fx.authedHeaders(env.baseUrl, session) });
  assert.equal(ok.status, 200);

  await env.server.close();
  await assert.rejects(fx.api(env.baseUrl, "/api/session"), (error) => {
    assert.ok(error && (error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "EPIPE"));
    return true;
  });
  const stillAlive = await fx.api(`${env.audio8Server.baseUrl}/`, "/api/health");
  assert.equal(stillAlive.status, 200);
  // 幂等：重复 close 不抛。
  await env.server.close();
});

test("body 限时：合法头不发 body 与慢滴流都在收窄阈值内被终止，0 次注册且无残留", async (t) => {
  const env = await fx.setupServerEnv(t, { timeouts: { bodyIdleMs: 250, bodyAbsoluteMs: 900 } });
  const session = await fx.bootstrapSession(env.baseUrl);
  const head = [
    "POST /api/prepare HTTP/1.1",
    `Host: 127.0.0.1:${env.port}`,
    `Cookie: ${session.cookie}`,
    `X-Memo-TTS-CSRF: ${session.csrfToken}`,
    `Origin: ${env.baseUrl}`,
    "Content-Type: application/json",
  ];

  // 合法头、声明 Content-Length 但从不发 body：空闲 deadline 触发。
  const idle = fx.openRawSocket(env.port);
  t.after(() => idle.close());
  idle.write(`${head.join("\r\n")}\r\nContent-Length: 100\r\n\r\n`);
  const idleResponse = await idle.waitFor("408", 3000);
  assert.match(idleResponse, / 408 /, "无 body 必须按空闲限时 408");

  // 慢滴流：每次 10 字节、间隔 120ms（不触发 250ms 空闲），由 900ms 绝对 deadline 终止。
  const drip = fx.openRawSocket(env.port);
  t.after(() => drip.close());
  drip.write(`${head.join("\r\n")}\r\nContent-Length: 20000\r\n\r\n`);
  const dripper = setInterval(() => drip.write("a".repeat(10)), 120);
  t.after(() => clearInterval(dripper));
  const dripResponse = await drip.waitFor("408", 4000);
  clearInterval(dripper);
  assert.match(dripResponse, / 408 /, "慢滴流必须按绝对限时 408");

  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "operations")), []);
});

test("已完成上传后的注册不被 body 定时器取消：极短 body 阈值下仍然成功且只注册一次", async (t) => {
  const env = await fx.setupServerEnv(t, { timeouts: { bodyIdleMs: 50, bodyAbsoluteMs: 4000 } });
  const session = await fx.bootstrapSession(env.baseUrl);

  const response = await fx.api(env.baseUrl, "/api/prepare", {
    method: "POST",
    headers: fx.authedHeaders(env.baseUrl, session),
    payload: Buffer.from(JSON.stringify(fx.basePrepareBody(env)), "utf8"),
  });
  assert.equal(response.status, 200);
  assert.equal(env.audio8Server.state.calls.register, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(env.root, "catalog.json"), "utf8"));
  assert.equal(onDisk.bindings[0].status, "ready");
});
