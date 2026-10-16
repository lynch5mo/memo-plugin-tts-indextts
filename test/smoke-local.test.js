"use strict";

// 5A 端到端验收工具测试：全部走隔离 fixture（本地假服务 / 假 Node 子进程），不动真实模型与 Memo。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const smoke = require("../scripts/smoke-local.js");
const audio8Fixture = require("./helpers/audio8-fixture.js");
const { encodeVoiceValue, voiceFingerprint } = require("../src/voice-value.js");

const REPO_ROOT = path.join(__dirname, "..");
const SMOKE_CLI = path.join(REPO_ROOT, "scripts", "smoke-local.js");
const NATIVE_VOICE_ID = "prof-jiang-smoke";

function mktemp(prefix = "memo-5a-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function cleanup(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("等待条件超时"));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function waitUntil(predicate, timeoutMs = 6000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() - started > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isReachable(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const request = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: "GET", agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

// 隔离假 Node 子进程：真的在指定端口从 0 起一个最小 Audio8 兼容 HTTP 服务。
function childAudio8Script() {
  return [
    'const http = require("node:http");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const cfg = JSON.parse(process.argv[1]);",
    "const delayMs = Number(process.argv[2] || 0);",
    'const meta = JSON.parse(fs.readFileSync(path.join(cfg.voicesRoot, cfg.nativeVoiceId, "meta.json"), "utf8"));',
    "function wavBuffer() {",
    "  const frames = 600, sampleRate = 44100, dataSize = frames * 2;",
    "  const b = Buffer.alloc(44 + dataSize);",
    '  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8, "ascii");',
    '  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);',
    "  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);",
    '  b.write("data", 36, "ascii"); b.writeUInt32LE(dataSize, 40);',
    "  for (let i = 0; i < frames; i += 1) b.writeInt16LE(Math.round(18000 * Math.sin((i + 1) / 9)), 44 + i * 2);",
    "  return b;",
    "}",
    'const json = (res, payload, status = 200) => { const t = Buffer.from(JSON.stringify(payload), "utf8"); res.writeHead(status, { "content-type": "application/json", "content-length": t.length }); res.end(t); };',
    "const server = http.createServer((req, res) => {",
    '  if (req.method === "GET" && req.url === "/api/health") return json(res, { ok: true, precision: cfg.precision, codec_precision: cfg.codecPrecision, providers: { slow: ["CPUExecutionProvider"], fast: ["CPUExecutionProvider"], decoder: ["CPUExecutionProvider"] } });',
    '  if (req.method === "GET" && req.url === "/api/memo/runtime") return json(res, { backendId: "audio8", modelFingerprint: cfg.modelFingerprint, modelDir: cfg.modelDir, voicesRoot: cfg.voicesRoot, precision: cfg.precision, codecPrecision: cfg.codecPrecision, instanceId: "child-instance-1" });',
    '  if (req.method === "GET" && req.url === "/api/voices") return json(res, { voices: [meta] });',
    '  if (req.method === "POST" && req.url === "/api/tts") { req.resume(); req.on("end", () => { const body = wavBuffer(); res.writeHead(200, { "content-type": "audio/wav", "content-length": body.length }); res.end(body); }); return; }',
    '  return json(res, { detail: "not found" }, 404);',
    "});",
    'setTimeout(() => server.listen(cfg.port, "127.0.0.1"), delayMs);',
  ].join("\n");
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// 隔离 fixture：真实 loopback Audio8 假服务 + 自有临时 catalog（只读），不启动任何真实模型。
async function setupFixture(t, config = {}) {
  const catalogRoot = mktemp("memo-5a-catalog-");
  const outputParent = mktemp("memo-5a-out-");
  t.after(() => cleanup(catalogRoot));
  t.after(() => cleanup(outputParent));

  const install = audio8Fixture.makeInstallDir();
  t.after(() => cleanup(install.installRoot));
  const meta = audio8Fixture.makeVoiceMeta({ name: NATIVE_VOICE_ID, source_sha256: "a".repeat(64) });
  audio8Fixture.writeVoiceMeta(install.voicesRoot, meta);

  const referenceFile = path.join(catalogRoot, "reference.wav");
  fs.writeFileSync(referenceFile, audio8Fixture.makePcm16Wav({ seed: 7 }));

  // config.port 指定时不启动进程内假服务：用于验证工具自己启动并持有子进程的路径。
  const deferredPort = Number.isInteger(config.port) ? config.port : null;
  let server = null;
  if (deferredPort === null) {
    server = await audio8Fixture.startAudio8Server({
      runtime: {
        backendId: "audio8",
        modelFingerprint: install.manifest.model_fingerprint,
        modelDir: install.modelDir,
        voicesRoot: install.voicesRoot,
        precision: install.manifest.default_precision,
        codecPrecision: install.manifest.default_codec_precision,
        instanceId: "smoke-instance-1",
      },
      voices: [meta],
      synthesize: config.synthesize,
    });
    t.after(async () => {
      await server.close();
    });
  }

  const endpoint = {
    id: "ep-audio8-smoke",
    backendId: "audio8",
    baseUrl: server ? server.baseUrl : `http://127.0.0.1:${deferredPort}`,
    modelFingerprint: install.manifest.model_fingerprint,
    readiness: "ready",
    runtimeManifestPath: install.manifestPath,
    voicesRoot: install.voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
  };
  const catalog = {
    schemaVersion: 1,
    endpoints: [config.endpointOverride ? { ...endpoint, ...config.endpointOverride } : endpoint],
    profiles: [
      {
        id: "profile-smoke",
        label: "验收讲师",
        persistence: "saved",
        owner: "memo-local-tts",
        source: { audioPath: referenceFile, referenceText: "参考原文", language: "zh" },
      },
    ],
    bindings: [
      {
        id: "binding-smoke",
        profileId: "profile-smoke",
        backendId: "audio8",
        endpointId: "ep-audio8-smoke",
        nativeVoiceId: NATIVE_VOICE_ID,
        modelFingerprint: install.manifest.model_fingerprint,
        revision: 1,
        status: "ready",
        params: {},
        nativeVoiceFingerprint: voiceFingerprint(meta),
      },
    ],
  };
  const catalogPath = path.join(catalogRoot, "catalog.json");
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const voiceValue = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8-smoke",
    bindingId: "binding-smoke",
    revision: 1,
  });

  return {
    catalogRoot,
    outputParent,
    catalogPath,
    catalog,
    voiceValue,
    install,
    server,
    endpoint,
    port: deferredPort,
  };
}

function runFixtureSmoke(env, extra = {}) {
  return smoke.runSmoke({
    catalog: env.catalogPath,
    voice: env.voiceValue,
    output: extra.output || path.join(env.outputParent, "run-1"),
    fixtureOnly: true,
    ...extra,
  });
}

test("帮助为中文且列出固定参数；缺参数与未知参数被拒绝", () => {
  const help = smoke.helpText();
  assert.match(help, /用法/);
  assert.match(help, /--catalog/);
  assert.match(help, /--voice/);
  assert.match(help, /--output/);
  assert.match(help, /--fixture-only/);
  assert.ok(!/=====/.test(help));
  assert.throws(() => smoke.parseArgs(["--catalog", "/tmp/catalog.json"]));
  assert.throws(() => smoke.parseArgs(["--voice", "localtts:v1:x", "--output", "/tmp/o"]));
  assert.throws(() => smoke.parseArgs(["--catalog", "/a", "--voice", "b", "--output", "/o", "--nope"]));
  assert.throws(() => smoke.parseArgs(["--catalog", "/a", "--voice", "b", "--output", "/o", "--start-arg", "x"]));
});

test("非法声音值、非法 catalog、输出已存在或为符号链接都被拒绝且不写外部路径", async (t) => {
  const env = await setupFixture(t);
  const catalogBefore = fs.readFileSync(env.catalogPath);
  const voicesBefore = fs.readdirSync(env.install.voicesRoot).sort();

  const badVoice = await runFixtureSmoke(env, {
    voice: "localtts:v1:not-base64!!",
    output: path.join(env.outputParent, "bad-voice"),
  });
  assert.equal(badVoice.exitCode, smoke.EXIT_FAILED);
  assert.equal(badVoice.report.failureCode, "ERR_VOICE_VALUE_ENCODING");
  assert.equal(env.server.state.calls.tts, 0);

  const badCatalog = await runFixtureSmoke(env, {
    catalog: path.join(env.catalogRoot, "missing.json"),
    output: path.join(env.outputParent, "bad-catalog"),
  });
  assert.equal(badCatalog.exitCode, smoke.EXIT_FAILED);
  assert.ok(String(badCatalog.report.failureCode).startsWith("ERR_CATALOG"));

  const existing = path.join(env.outputParent, "already-there");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep.txt"), "keep", "utf8");
  await assert.rejects(
    () => runFixtureSmoke(env, { output: existing }),
    (error) => {
      assert.equal(error.code, "ERR_SMOKE_OUTPUT_EXISTS");
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "keep");

  const linkTarget = path.join(env.outputParent, "link-target");
  fs.mkdirSync(linkTarget);
  const linkPath = path.join(env.outputParent, "link-output");
  fs.symlinkSync(linkTarget, linkPath);
  await assert.rejects(
    () => runFixtureSmoke(env, { output: linkPath }),
    (error) => {
      assert.equal(error.code, "ERR_SMOKE_OUTPUT_EXISTS");
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(linkTarget), []);

  assert.deepEqual(fs.readFileSync(env.catalogPath), catalogBefore);
  assert.deepEqual(fs.readdirSync(env.install.voicesRoot).sort(), voicesBefore);
  assert.equal(env.server.state.calls.register, 0);
});

test("fixture 成功路径：三组文本经插件入口得到非静音 WAV，源文本与报告字段完整且默认未人工验证", async (t) => {
  const env = await setupFixture(t);
  const voicesBefore = fs.readdirSync(env.install.voicesRoot).sort();
  const result = await runFixtureSmoke(env);
  const report = result.report;
  const outputDir = path.join(env.outputParent, "run-1");

  assert.equal(result.exitCode, smoke.EXIT_OK);
  assert.equal(report.status, "passed");
  assert.equal(report.phases.p0, "passed");
  assert.equal(report.phases.p1, "notVerified");
  assert.equal(report.phases.p2, "notVerified");
  assert.equal(report.phases.p3, "notVerified");
  assert.equal(report.fixtureOnly, true);
  assert.equal(report.verification.listenVerified, false);
  assert.equal(report.verification.contentEndingVerified, false);
  assert.equal(report.verification.speakerSimilarityVerified, false);
  assert.equal(report.resources.peakRssBytes, null);
  assert.equal(report.safety.retries, 0);
  assert.equal(report.safety.partialSuccess, false);
  assert.equal(report.safety.externalServiceStopped, false);
  assert.equal(report.identity.backendId, "audio8");
  assert.equal(report.identity.bindingId, "binding-smoke");
  assert.match(report.plugin.indexSha256, /^[0-9a-f]{64}$/);
  assert.match(report.plugin.buildInputsSha256, /^[0-9a-f]{64}$/);

  assert.equal(report.cases.length, 3);
  for (const item of report.cases) {
    assert.equal(item.result, "ok");
    assert.ok(item.audioBytes > 44);
    assert.match(item.audioSha256, /^[0-9a-f]{64}$/);
    assert.match(item.sourceSha256, /^[0-9a-f]{64}$/);
    assert.ok(item.format.sampleRate > 0);
    assert.equal(item.format.channels, 1);
    assert.equal(item.format.bitsPerSample, 16);
    assert.ok(item.durationSeconds > 0);
    assert.ok(item.peakSample > 0, "必须是非静音音频");
    assert.ok(item.nonZeroSamples > 0);
    assert.ok(item.elapsedMs >= 0);
    assert.ok(fs.existsSync(item.audioFile));
    assert.ok(fs.existsSync(item.sourceFile));
  }

  const longCase = report.cases.find((item) => item.id === "long-tail");
  const savedLong = fs.readFileSync(longCase.sourceFile, "utf8");
  assert.equal(savedLong, smoke.SMOKE_CASES.find((item) => item.id === "long-tail").text);
  assert.ok(savedLong.endsWith("【末尾标记：如果听到这句话，说明长文本已经读到结尾】"));

  assert.ok(fs.existsSync(path.join(outputDir, "report.json")));
  assert.ok(fs.existsSync(path.join(outputDir, "report.md")));
  assert.equal(readJson(path.join(outputDir, "report.json")).cases.length, 3);
  assert.ok(voicesBefore.includes(NATIVE_VOICE_ID));
  assert.deepEqual(fs.readdirSync(env.install.voicesRoot).sort(), voicesBefore, "安装 voicesRoot 必须原样不变");
  assert.equal(env.server.state.calls.register, 0);
});

test("通过真实 CLI 进程执行 fixture：退出码 0、stdout 有中文结论、报告落盘", async (t) => {
  const env = await setupFixture(t);
  const outputDir = path.join(env.outputParent, "cli-run");
  const child = spawn(
    process.execPath,
    [SMOKE_CLI, "--catalog", env.catalogPath, "--voice", env.voiceValue, "--output", outputDir, "--fixture-only"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, smoke.EXIT_OK, `stderr=${stderr}`);
  assert.match(stdout, /通过/);
  const report = readJson(path.join(outputDir, "report.json"));
  assert.equal(report.status, "passed");
  assert.equal(report.cases.length, 3);
});

test("中间用例失败：不重试、不把部分结果标成功、失败用例带固定分类", async (t) => {
  const env = await setupFixture(t, {
    synthesize: (parsed, callIndex) =>
      callIndex === 1
        ? { status: 200, body: audio8Fixture.makePcm16Wav({ seed: callIndex }) }
        : { status: 500, body: Buffer.from("backend exploded", "utf8") },
  });
  const result = await runFixtureSmoke(env);
  const report = result.report;

  assert.equal(result.exitCode, smoke.EXIT_FAILED);
  assert.equal(report.status, "failed");
  assert.equal(report.phases.p0, "failed");
  assert.equal(report.failureCode, "ERR_SMOKE_CASE_FAILED");
  assert.equal(report.safety.retries, 0);
  assert.equal(report.safety.partialSuccess, false);
  assert.equal(report.cases.length, 2);
  assert.equal(report.cases[0].result, "ok");
  assert.equal(report.cases[1].result, "failed");
  assert.equal(report.cases[1].retrySafe, false);
  assert.equal(report.cases[1].audioFile, null);
  assert.equal(env.server.state.calls.tts, 2);
  const reportText = fs.readFileSync(path.join(env.outputParent, "run-1", "report.json"), "utf8");
  assert.ok(!reportText.includes("backend exploded"), "后端正文不得进入报告");
  assert.equal(report.verification.listenVerified, false);
});

test("GPT 声音值 fail-closed：明确未验证、退出非 0、不连接也不合成", async (t) => {
  const env = await setupFixture(t);
  const gptCatalogPath = path.join(env.catalogRoot, "catalog-gpt.json");
  const gptCatalog = {
    schemaVersion: 1,
    endpoints: [
      {
        id: "ep-gpt-smoke",
        backendId: "gpt-sovits",
        baseUrl: env.server.baseUrl,
        modelFingerprint: "fp-gpt-smoke",
        readiness: "ready",
      },
    ],
    profiles: [
      {
        id: "profile-gpt",
        label: "GPT 讲师",
        persistence: "saved",
        owner: "memo-local-tts",
        source: {
          audioPath: path.join(env.catalogRoot, "reference.wav"),
          referenceText: "参考原文",
          language: "zh",
        },
      },
    ],
    bindings: [
      {
        id: "binding-gpt",
        profileId: "profile-gpt",
        backendId: "gpt-sovits",
        endpointId: "ep-gpt-smoke",
        nativeVoiceId: NATIVE_VOICE_ID,
        modelFingerprint: "fp-gpt-smoke",
        revision: 1,
        status: "ready",
        params: {},
      },
    ],
  };
  fs.writeFileSync(gptCatalogPath, `${JSON.stringify(gptCatalog, null, 2)}\n`, "utf8");
  const gptVoice = encodeVoiceValue({
    backendId: "gpt-sovits",
    endpointId: "ep-gpt-smoke",
    bindingId: "binding-gpt",
    revision: 1,
  });

  const result = await runFixtureSmoke(env, { catalog: gptCatalogPath, voice: gptVoice });
  assert.equal(result.exitCode, smoke.EXIT_UNVERIFIED);
  assert.equal(result.report.failureCode, "ERR_SMOKE_BACKEND_UNVERIFIED");
  assert.equal(result.report.phases.p1, "notVerified");
  assert.equal(result.report.status, "failed");
  assert.equal(env.server.state.calls.tts, 0);
  assert.equal(env.server.state.calls.health, 0);
});

test("服务不可达时清晰失败且不自动启动任何进程", async (t) => {
  const port = await freePort();
  const env = await setupFixture(t, { endpointOverride: { baseUrl: `http://127.0.0.1:${port}` } });
  const result = await runFixtureSmoke(env);

  assert.equal(result.exitCode, smoke.EXIT_FAILED);
  assert.equal(result.report.failureCode, "ERR_SMOKE_SERVICE_UNREACHABLE");
  assert.equal(result.report.safety.ownedProcess, null);
  assert.equal(result.report.connectivity.mode, "externalExisting");
  assert.equal(result.report.cases.length, 0);
  assert.ok(fs.existsSync(path.join(env.outputParent, "run-1", "report.json")));
});

test("显式 startCommand 且端口空闲：先启动本次持有的假子进程，就绪后三用例成功，结束后子进程被回收", async (t) => {
  const port = await freePort();
  const env = await setupFixture(t, { port });
  assert.equal(env.server, null);
  const runtimeInfo = {
    port,
    voicesRoot: env.install.voicesRoot,
    nativeVoiceId: NATIVE_VOICE_ID,
    modelFingerprint: env.install.manifest.model_fingerprint,
    modelDir: env.install.modelDir,
    precision: env.install.manifest.default_precision,
    codecPrecision: env.install.manifest.default_codec_precision,
  };

  const result = await runFixtureSmoke(env, {
    startCommand: process.execPath,
    startArgs: ["-e", childAudio8Script(), JSON.stringify(runtimeInfo), "300"],
    startWaitMs: 8000,
  });

  assert.equal(result.exitCode, smoke.EXIT_OK, String(result.report.failureCode));
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.cases.length, 3);
  assert.equal(result.report.connectivity.mode, "startedByTool");
  assert.equal(result.report.safety.ownedProcess.started, true);
  assert.equal(result.report.safety.ownedProcess.spawnShell, false);
  assert.equal(result.report.safety.ownedProcess.stopRequested, true);
  assert.equal(result.report.safety.ownedProcess.reason, "started-by-tool");
  assert.ok(result.report.safety.ownedProcess.pid > 0);
  assert.equal(result.report.safety.externalServiceStopped, false);
  for (const item of result.report.cases) {
    assert.equal(item.result, "ok");
    assert.ok(item.peakSample > 0);
  }
  // 结束后本次持有的子进程必须被回收：端口不再有人监听。
  const closed = await waitUntil(async () => !(await isReachable(port)), 6000);
  assert.equal(closed, true, "本次启动的子进程必须已被终止");
});

test("startCommand 指向不存在的可执行文件：结构化失败、可观测、无未捕获异常", async (t) => {
  const port = await freePort();
  const env = await setupFixture(t, { port });
  const result = await runFixtureSmoke(env, {
    startCommand: "/nonexistent/memo-5a-missing-binary",
    startWaitMs: 3000,
  });

  assert.equal(result.exitCode, smoke.EXIT_FAILED);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.failureCode, "ERR_SMOKE_PROCESS_START");
  assert.equal(result.report.safety.ownedProcess.started, true);
  assert.equal(result.report.safety.ownedProcess.spawnError.code, "ENOENT");
  assert.equal(result.report.cases.length, 0);
});

test("startCommand 起了不就绪的进程：有界超时退出、清理本次子进程、不重试", async (t) => {
  const port = await freePort();
  const env = await setupFixture(t, { port });
  const startedAt = Date.now();
  const result = await runFixtureSmoke(env, {
    startCommand: process.execPath,
    startArgs: ["-e", "setInterval(() => {}, 1000);"],
    startWaitMs: 1200,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.exitCode, smoke.EXIT_FAILED);
  assert.equal(result.report.failureCode, "ERR_SMOKE_START_TIMEOUT");
  assert.ok(elapsed < 9000, `必须是有界退出，实际 ${elapsed}ms`);
  assert.equal(result.report.safety.ownedProcess.stopRequested, true);
  assert.ok(
    result.report.safety.ownedProcess.exitCode !== null || result.report.safety.ownedProcess.signal !== null,
    "本次子进程必须已被回收",
  );
  assert.equal(result.report.safety.externalServiceStopped, false);
  assert.equal(result.report.cases.length, 0);
});

test("端口已有外部服务且显式给 startCommand：只连接不新起进程，外部服务不被停止", async (t) => {
  const env = await setupFixture(t);
  const result = await runFixtureSmoke(env, {
    startCommand: process.execPath,
    startArgs: ["-e", "setInterval(() => {}, 1000);"],
  });

  assert.equal(result.exitCode, smoke.EXIT_OK, String(result.report.failureCode));
  assert.equal(result.report.connectivity.mode, "externalExisting");
  assert.equal(result.report.safety.ownedProcess.started, false);
  assert.equal(result.report.safety.ownedProcess.reason, "port-already-listening");
  assert.equal(result.report.safety.externalServiceStopped, false);
  const health = await httpGetJson(`${env.server.baseUrl}/api/health`);
  assert.equal(health.status, 200, "外部既有服务必须仍然存活");
  assert.ok(env.server.state.calls.tts >= 3);
});

test("runWithOwnedProcess：spawn 错误、立即退出、忽略 SIGTERM 时升级 SIGKILL，均有界完成", async (t) => {
  const missing = smoke.runWithOwnedProcess({ file: "/nonexistent/memo-5a-binary" });
  const missingState = await missing.done;
  assert.equal(missingState.error.code, "ENOENT");
  assert.equal(missingState.pid, undefined);

  const quick = smoke.runWithOwnedProcess({ file: process.execPath, args: ["-e", "process.exit(3);"] });
  const quickState = await quick.done;
  assert.equal(quickState.exitCode, 3);
  assert.equal(quickState.error, null);

  const stubborn = smoke.runWithOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('handler-ready\\n'); setInterval(() => {}, 1000);",
    ],
  });
  t.after(() => stubborn.stop());
  // 必须等子进程真正装好 SIGTERM 处理器再发信号，否则会命中默认终止行为（测试竞态，不是产品行为）。
  await waitFor(() => stubborn.state.stdout.includes("handler-ready"));
  stubborn.stop();
  const stubbornState = await stubborn.done;
  assert.equal(stubbornState.stopRequested, true);
  assert.equal(stubbornState.forcedKill, true);
  assert.equal(stubbornState.signal, "SIGKILL");
});

test("CLI 收到 SIGTERM：只清理本次持有的子进程", async (t) => {
  const endpointPort = await freePort();
  const childPort = await freePort();
  const env = await setupFixture(t, { port: endpointPort });
  const childScript =
    "require('node:net').createServer().listen(Number(process.argv[1]), '127.0.0.1');setInterval(() => {}, 1000);";
  const cli = spawn(
    process.execPath,
    [
      SMOKE_CLI,
      "--catalog",
      env.catalogPath,
      "--voice",
      env.voiceValue,
      "--output",
      path.join(env.outputParent, "sig-run"),
      "--fixture-only",
      "--start-command",
      process.execPath,
      "--start-arg",
      "-e",
      "--start-arg",
      childScript,
      "--start-arg",
      String(childPort),
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (cli.exitCode === null) {
      cli.kill("SIGKILL");
    }
  });

  const childUp = await waitUntil(async () => isReachable(childPort), 6000);
  assert.equal(childUp, true, "本次子进程必须已启动");
  cli.kill("SIGTERM");
  const code = await new Promise((resolve) => cli.on("exit", resolve));
  assert.equal(code, 143);
  const childGone = await waitUntil(async () => !(await isReachable(childPort)), 6000);
  assert.equal(childGone, true, "收到 SIGTERM 后必须清理本次持有的子进程");
});

test("runWithOwnedProcess：argv 原样传入（shell=false）、只停止自己持有的子进程、外部进程不受影响", async (t) => {
  const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)));setInterval(() => {}, 1000);";
  const owned = smoke.runWithOwnedProcess({
    file: process.execPath,
    args: ["-e", script, "a b", "c; touch /tmp/should-not-exist-5a", "$(whoami)"],
  });
  t.after(() => owned.stop());
  await waitFor(() => owned.state.stdout.length > 0);
  assert.deepEqual(JSON.parse(owned.state.stdout), ["a b", "c; touch /tmp/should-not-exist-5a", "$(whoami)"]);
  assert.equal(owned.state.truncated, false);

  const external = spawn(process.execPath, ["-e", script, "external"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => external.kill("SIGKILL"));
  await waitFor(() => external.pid !== undefined);

  owned.stop();
  const state = await owned.done;
  assert.equal(state.stopRequested, true);
  assert.ok(state.exitCode !== null || state.signal !== null);
  assert.equal(external.exitCode, null, "外部服务绝不能被本工具停止");
  assert.equal(external.killed, false);
  assert.ok(!fs.existsSync("/tmp/should-not-exist-5a"));
});
