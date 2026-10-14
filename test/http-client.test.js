"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { request, DEFAULT_MAX_BYTES } = require("../src/http-client.js");
const { makeToneWav } = require("./helpers/wav-fixture.js");

const MIB = 1024 * 1024;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function assertRejectsCode(promise, code) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `期望以 ${code} 失败，但请求成功返回`);
  assert.equal(error.code, code);
  return error;
}

test("200 返回手工 PCM16 WAV 正文、响应头与 null 的 JSON 字段", async () => {
  const { wav } = makeToneWav({ sampleCount: 320, sampleRate: 32000 });
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "audio/wav" });
    res.end(wav);
  });

  try {
    const response = await request({
      baseUrl,
      path: "/api/tts",
      method: "POST",
      json: { text: "你好" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "audio/wav");
    assert.ok(Buffer.isBuffer(response.body));
    assert.deepEqual(response.body, wav);
    assert.equal(response.json, null);
  } finally {
    await stopServer(server);
  }
});

test("200 JSON 返回解析后的对象且保留原始正文", async () => {
  const payload = { ok: true, voices: [{ id: "a", label: "默认" }] };
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  });

  try {
    const response = await request({ baseUrl, path: "/api/voices" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json, payload);
    assert.equal(response.body.toString("utf8"), JSON.stringify(payload));
  } finally {
    await stopServer(server);
  }
});

test("省略 timeoutMs 时使用默认超时，快速响应仍然成功", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const response = await request({ baseUrl, path: "/api/health" });

    assert.equal(response.statusCode, 200);
  } finally {
    await stopServer(server);
  }
});

test("3xx 重定向直接失败且不跟随到目标服务器", async () => {
  let redirectedHits = 0;
  const target = await startServer((req, res) => {
    redirectedHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const source = await startServer((req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}/api/tts` });
    res.end();
  });

  try {
    const error = await assertRejectsCode(
      request({
        baseUrl: source.baseUrl,
        path: "/api/tts",
        method: "POST",
        json: { text: "你好" },
      }),
      "ERR_REDIRECT",
    );

    assert.equal(error.statusCode, 302);
    assert.equal(redirectedHits, 0);
  } finally {
    await stopServer(source.server);
    await stopServer(target.server);
  }
});

test("超时的 POST 只发送一次，不自动重试", async () => {
  let received = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    received += 1;
    req.resume();
  });

  try {
    const error = await assertRejectsCode(
      request({
        baseUrl,
        path: "/api/tts",
        method: "POST",
        json: { text: "超时用例" },
        timeoutMs: 150,
      }),
      "ERR_TIMEOUT",
    );

    assert.equal(error.timeoutMs, 150);
    assert.equal(received, 1);
  } finally {
    await stopServer(server);
  }
});

test("响应正文超过 16MiB 上限时失败", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(DEFAULT_MAX_BYTES + 4096, 7));
  });

  try {
    await assertRejectsCode(
      request({ baseUrl, path: "/api/tts", method: "POST", body: Buffer.from("x") }),
      "ERR_RESPONSE_TOO_LARGE",
    );
  } finally {
    await stopServer(server);
  }
});

test("声明 Content-Length 超过上限时立即失败而不读完正文", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(DEFAULT_MAX_BYTES + MIB),
    });
    res.write(Buffer.alloc(16, 1));
  });

  try {
    await assertRejectsCode(
      request({
        baseUrl,
        path: "/api/tts",
        method: "POST",
        body: Buffer.from("x"),
        timeoutMs: 2000,
      }),
      "ERR_RESPONSE_TOO_LARGE",
    );
  } finally {
    await stopServer(server);
  }
});

test("拒绝非 loopback endpoint 与协议相对路径", async () => {
  for (const baseUrl of [
    "http://10.1.2.3:8123",
    "http://example.com",
    "http://[2001:db8::1]:80",
  ]) {
    await assertRejectsCode(
      request({ baseUrl, path: "/api/health" }),
      "ERR_ENDPOINT_NOT_LOOPBACK",
    );
  }
  await assertRejectsCode(
    request({ baseUrl: "http://127.0.0.1:8123", path: "//example.com/api/health" }),
    "ERR_ENDPOINT_INVALID",
  );
});

test("拒绝带凭据的 URL 且不复述凭据", async () => {
  const error = await assertRejectsCode(
    request({ baseUrl: "http://user:secret@127.0.0.1:8123", path: "/api/health" }),
    "ERR_ENDPOINT_CREDENTIALS",
  );

  assert.ok(!String(error.message).includes("secret"), "错误信息不得回显凭据");
});

test("4xx/5xx 返回状态码给调用方判断，且不自动重试", async () => {
  let received = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    received += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model busy" }));
  });

  try {
    const response = await request({
      baseUrl,
      path: "/api/tts",
      method: "POST",
      json: { text: "忙" },
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json, { error: "model busy" });
    assert.equal(received, 1);
  } finally {
    await stopServer(server);
  }
});

test("不依赖全局 fetch，成功路径不调用它", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("request 不得依赖全局 fetch");
  };

  try {
    const response = await request({ baseUrl, path: "/api/health" });

    assert.equal(response.statusCode, 200);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
    await stopServer(server);
  }
});
