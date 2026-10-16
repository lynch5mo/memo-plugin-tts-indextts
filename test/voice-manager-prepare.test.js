"use strict";

// 4A5 自有 namespace 新音色准备测试：真实 loopback register fixture + 隔离 namespace，人工字节与 fixture 授权。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../manager/store.js");
const fxAudio8 = require("./helpers/audio8-fixture.js");

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

function mktemp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memo-4a5-")));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// 与安装 registration.py 的 " ".join(text.strip().split()) 等价的空白规范化。
function normalizedText(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function syntheticAudio(seed = 1, size = 2048) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buffer[i] = (i * 31 + seed) % 251;
  }
  return buffer;
}

async function assertRejectsCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

function withHook(t, name, fn) {
  store.__testHooks.raceHook[name] = fn;
  t.after(() => {
    store.__testHooks.raceHook[name] = null;
  });
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

function attemptJournals(root) {
  return fs
    .readdirSync(path.join(root, "operations"))
    .filter((name) => name.startsWith("attempt-") && name.endsWith(".json"));
}

function journalTemps(root) {
  return fs
    .readdirSync(path.join(root, "operations"))
    .filter((name) => name.startsWith(".attempt-") && name.includes(".tmp-"));
}

function readAttempt(root) {
  const names = attemptJournals(root);
  assert.equal(names.length, 1, `期望恰好一份 attempt journal，实际 ${names.join(",")}`);
  return readJson(path.join(root, "operations", names[0]));
}

// 隔离 namespace，且在线 runtime.voicesRoot 与被登记端点的 voicesRoot 都等于本 namespace 的 voices/。
async function setupPrepareEnv(t, config = {}) {
  const root = mktemp();
  t.after(() => cleanup(root));
  const ns = await store.initialize(root);
  const voicesRoot = path.join(ns.root, "voices");

  const install = fxAudio8.makeInstallDir({ metaOverrides: config.metaOverrides || {} });
  const runtime = {
    backendId: "audio8",
    modelFingerprint: install.manifest.model_fingerprint,
    modelDir: install.modelDir,
    voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    instanceId: "prepare-instance-1",
    ...(config.runtimeOverrides || {}),
  };
  const voices = config.voices || [];
  // 共享同一个 register 配置对象，便于用例在 setup 之后注入 runtimeAfter 等时序。
  const registerConfig = config.register || {};
  if (registerConfig.voicesRoot === undefined) {
    registerConfig.voicesRoot = voicesRoot;
  }
  const audio8Server = await fxAudio8.startAudio8Server({
    health: config.health,
    voices,
    runtime: config.bare ? null : runtime,
    register: registerConfig,
  });

  const endpoint = {
    id: "ep-audio8-prepare",
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
  await store.updateCatalog(ns.root, (draft) => {
    draft.endpoints.push(endpoint);
  });

  t.after(async () => {
    await audio8Server.close();
    cleanup(install.installRoot);
  });

  return { root: ns.root, ns, install, runtime, audio8Server, endpoint, voicesRoot };
}

function baseOptions(env, overrides = {}) {
  return {
    endpointId: env.endpoint.id,
    label: "自有讲师",
    audio: syntheticAudio(),
    referenceText: "这是参考原文。",
    language: "zh",
    persistence: "temporary",
    authorizationConfirmed: true,
    ...overrides,
  };
}

test("prepareVoice 成功：恰好 1 次 register POST、multipart 正确、自有资料兼容 4A3、可 save", async (t) => {
  const env = await setupPrepareEnv(t);
  const audio = syntheticAudio(3);
  const committed = await store.prepareVoice(env.root, baseOptions(env, { audio }));

  assert.ok(Object.isFrozen(committed));
  const catalog = readJson(path.join(env.root, "catalog.json"));
  const profile = catalog.profiles[0];
  const binding = catalog.bindings[0];

  assert.equal(profile.persistence, "temporary");
  assert.equal(profile.label, "自有讲师");
  assert.equal(profile.owner, env.ns.namespaceId);
  assert.equal(profile.source.referenceText, "这是参考原文。");
  assert.equal(profile.source.language, "zh");
  assert.equal(profile.source.audioPath, path.join(env.root, "sources", profile.id, "reference.audio"));
  assert.equal(binding.status, "ready");
  assert.equal(binding.revision, 1);
  assert.deepEqual(binding.params, {});
  assert.match(binding.nativeVoiceFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(binding.endpointId, env.endpoint.id);

  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.equal(env.audio8Server.state.calls.tts, 0);
  const detail = env.audio8Server.state.registerDetails[0];
  assert.equal(detail.name, binding.nativeVoiceId);
  assert.equal(detail.text, "这是参考原文。");
  assert.equal(detail.overwrite, "false");
  assert.equal(detail.audioFilename, "reference.audio");
  assert.equal(detail.audioLength, audio.length);
  assert.equal(detail.audioSha256, sha256(audio));

  const sourceDir = path.join(env.root, "sources", profile.id);
  assert.deepEqual(fs.readdirSync(sourceDir).sort(), ["reference.audio", "source.json"]);
  assert.equal(sha256(fs.readFileSync(path.join(sourceDir, "reference.audio"))), sha256(audio));
  const source = readJson(path.join(sourceDir, "source.json"));
  const operation = readJson(path.join(env.root, "operations", `voice-${profile.id}.json`));
  assert.equal(source.kind, "memo-local-tts-source");
  assert.equal(source.audioSha256, sha256(audio));
  assert.equal(source.operationId, operation.operationId);
  assert.equal(operation.kind, "memo-local-tts-voice-operation");
  const attempt = readAttempt(env.root);
  assert.equal(attempt.kind, "memo-local-tts-prepare-attempt");
  assert.equal(attempt.stage, "published");
  assert.equal(attempt.profileId, profile.id);
  assert.equal(attempt.nativeVoiceId, binding.nativeVoiceId);

  await store.saveTemporary(env.root, profile.id);
  assert.equal(readJson(path.join(env.root, "catalog.json")).profiles[0].persistence, "saved");
});

test("referenceText 只差空白时按安装语义规范化后吻合仍通过", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
  const committed = await store.prepareVoice(
    env.root,
    baseOptions(env, { referenceText: "  这是   参考\t原文。  " }),
  );
  assert.equal(committed.bindings[0].status, "ready");
  assert.equal(env.audio8Server.state.calls.register, 1);
});

test("referenceText 含 CRLF/CR/LF/TAB 文本空白：规范化输入成功、meta 与规范化一致、源记录保留原文并可 save/end", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
  const rawText = "  第一段\t制表\r\n第二段\r换行 混排 \n 末段 ";
  const first = await store.prepareVoice(env.root, baseOptions(env, { referenceText: rawText }));
  assert.equal(first.bindings[0].status, "ready");
  assert.equal(env.audio8Server.state.calls.register, 1);

  // multipart：原始文本只作为正文字段原样承载，绝不进入任何 header 行。
  const detail = env.audio8Server.state.registerDetails[0];
  assert.equal(detail.text, rawText);
  assert.equal(detail.name, first.bindings[0].nativeVoiceId);

  // 磁盘音色 meta 与本次输入按安装语义规范化后一致。
  const meta = readJson(path.join(env.voicesRoot, first.bindings[0].nativeVoiceId, "meta.json"));
  assert.equal(meta.reference_text, normalizedText(rawText));
  assert.equal(meta.name, first.bindings[0].nativeVoiceId);
  assert.equal(meta.source_sha256, sha256(baseOptions(env).audio));

  // 源记录保留原始原文，不伪造为规范化文本。
  const catalog = readJson(path.join(env.root, "catalog.json"));
  assert.equal(catalog.profiles[0].source.referenceText, rawText);
  const source = readJson(path.join(env.root, "sources", catalog.profiles[0].id, "source.json"));
  assert.equal(source.referenceText, rawText);

  // 与 save/end 生命周期兼容。
  await store.saveTemporary(env.root, catalog.profiles[0].id);
  assert.equal(readJson(path.join(env.root, "catalog.json")).profiles[0].persistence, "saved");

  const second = await store.prepareVoice(
    env.root,
    baseOptions(env, { audio: syntheticAudio(5), referenceText: "第二段\r\n原文" }),
  );
  const secondBinding = second.bindings[second.bindings.length - 1];
  assert.equal(secondBinding.status, "ready");
  await store.endTemporary(env.root, secondBinding.profileId);
  const after = readJson(path.join(env.root, "catalog.json"));
  assert.equal(after.bindings.find((binding) => binding.id === secondBinding.id).status, "invalid");
});

test("注册后磁盘 meta.source_sha256 与本次上传字节不符时拒绝", async (t) => {
  const env = await setupPrepareEnv(t, {
    voices: [],
    register: { metaOverrides: { source_sha256: "b".repeat(64) } },
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_VERIFY_FAILED");
      assert.equal(error.registrationState, "registered");
      assert.equal(error.registrationRetrySafe, false);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  // 自有资料保留，不删除原录音。
  const profileDirs = fs.readdirSync(path.join(env.root, "sources"));
  assert.equal(profileDirs.length, 1);
  assert.ok(fs.existsSync(path.join(env.root, "sources", profileDirs[0], "reference.audio")));
});

test("注册后磁盘 meta.reference_text 与本次原文不符时拒绝", async (t) => {
  const env = await setupPrepareEnv(t, {
    voices: [],
    register: { metaOverrides: { reference_text: "完全不同的另一段原文。" } },
  });
  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_VERIFY_FAILED");
      assert.equal(error.registrationState, "registered");
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
});

test("注册后磁盘 meta.name 与本次 nativeVoiceId 不符时拒绝", async (t) => {
  const env = await setupPrepareEnv(t, {
    voices: [],
    register: { metaOverrides: { name: "someone-else-voice" } },
  });
  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_VERIFY_FAILED");
      assert.equal(error.registrationState, "registered");
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
});

test("POST 响应 voice 元数据与本次输入不一致时拒绝（不信 ok=true）", async (t) => {
  const env = await setupPrepareEnv(t, {
    voices: [],
    register: { responseMetaOverrides: { source_sha256: "c".repeat(64) } },
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));
  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_VERIFY_FAILED");
      assert.equal(error.registrationState, "registered");
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("在线 runtime.voicesRoot 与声明不一致时在准备层拒绝且 0 POST", async (t) => {
  const externalRoot = mktemp();
  t.after(() => cleanup(externalRoot));
  // endpoint 声明仍是本 namespace，但在线 runtime 报告外部目录。
  const env = await setupPrepareEnv(t, {
    voices: [],
    runtimeOverrides: { voicesRoot: externalRoot },
  });
  // 在线 runtime 的 voicesRoot 不匹配由只读 probe 的 voicesRoot 检查挡下（state=mismatch），
  // 现有准确分类是 ERR_STORE_PREPARE_UNVERIFIED；声明的 voicesRoot 门禁由另一用例覆盖。
  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.ok(
        error.code === "ERR_STORE_PREPARE_UNVERIFIED" ||
          error.code === "ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH",
        `期望在线 voicesRoot 不匹配被拒，实际 ${error.code}`,
      );
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(externalRoot), []);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
});

test("prepareVoice 支持 persistence=saved 直接生成已保存音色", async (t) => {
  const env = await setupPrepareEnv(t);
  await store.prepareVoice(env.root, baseOptions(env, { persistence: "saved" }));
  const catalog = readJson(path.join(env.root, "catalog.json"));
  assert.equal(catalog.profiles[0].persistence, "saved");
  assert.equal(catalog.bindings[0].status, "ready");
});

test("未授权、非法输入、任意路径读入都拒绝且 0 POST、不创建文件", async (t) => {
  const env = await setupPrepareEnv(t);
  const reject = async (overrides) => {
    await assertRejectsCode(() => store.prepareVoice(env.root, baseOptions(env, overrides)), "ERR_STORE_PREPARE_INPUT");
  };
  await reject({ authorizationConfirmed: false });
  await reject({ authorizationConfirmed: "yes" });
  await reject({ audio: Buffer.alloc(0) });
  await reject({ audio: "/Users/someone/secret.wav" });
  await reject({ audio: null });
  await reject({ label: "" });
  await reject({ label: "x".repeat(201) });
  await reject({ label: "带\n换行" });
  await reject({ referenceText: "" });
  await reject({ referenceText: "含\u0000空字符" });
  await reject({ referenceText: "含\u001f控制符" });
  await reject({ language: "not a language!" });
  await reject({ persistence: "external" });
  await reject({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1) });

  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "operations")), []);
});

test("GPT 端点拒绝且 0 POST", async (t) => {
  const env = await setupPrepareEnv(t);
  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.push({
      id: "ep-gpt",
      backendId: "gpt-sovits",
      baseUrl: env.endpoint.baseUrl,
      modelFingerprint: "fp-gpt",
      readiness: "ready",
    });
  });
  await assertRejectsCode(
    () => store.prepareVoice(env.root, baseOptions(env, { endpointId: "ep-gpt" })),
    "ERR_STORE_PREPARE_BACKEND_UNSUPPORTED",
  );
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("端点未登记或未 ready 时拒绝", async (t) => {
  const env = await setupPrepareEnv(t);
  await assertRejectsCode(
    () => store.prepareVoice(env.root, baseOptions(env, { endpointId: "ep-missing" })),
    "ERR_STORE_PREPARE_ENDPOINT_MISSING",
  );
  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.push({ ...env.endpoint, id: "ep-notready", readiness: "unverified" });
  });
  await assertRejectsCode(
    () => store.prepareVoice(env.root, baseOptions(env, { endpointId: "ep-notready" })),
    "ERR_STORE_PREPARE_ENDPOINT_NOT_READY",
  );
});

test("端点 voicesRoot 指向外部安装目录时拒绝且 0 POST、外部目录不变", async (t) => {
  const env = await setupPrepareEnv(t);
  const before = fs.readdirSync(env.install.voicesRoot).sort();
  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.find((entry) => entry.id === env.endpoint.id).voicesRoot = env.install.voicesRoot;
  });

  await assertRejectsCode(
    () => store.prepareVoice(env.root, baseOptions(env)),
    "ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH",
  );
  assert.equal(env.audio8Server.state.calls.register, 0);
  assert.deepEqual(fs.readdirSync(env.install.voicesRoot).sort(), before);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
});

test("同名不同调用得到不同随机身份，register name 不重复", async (t) => {
  const env = await setupPrepareEnv(t);
  await store.prepareVoice(env.root, baseOptions(env, { label: "同名讲师" }));
  await store.prepareVoice(env.root, baseOptions(env, { label: "同名讲师", audio: syntheticAudio(9) }));
  const catalog = readJson(path.join(env.root, "catalog.json"));
  assert.equal(catalog.profiles.length, 2);
  assert.equal(catalog.bindings.length, 2);
  assert.notEqual(catalog.profiles[0].id, catalog.profiles[1].id);
  assert.notEqual(catalog.bindings[0].nativeVoiceId, catalog.bindings[1].nativeVoiceId);
  assert.equal(catalog.profiles[0].label, catalog.profiles[1].label);
  assert.equal(env.audio8Server.state.calls.register, 2);
});

test("register 400 明确拒绝：failed、原目录不变、资料保留、恰好 1 POST", async (t) => {
  const env = await setupPrepareEnv(t, { register: { status: 400, body: { detail: "invalid audio" } } });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_REGISTER_FAILED");
      assert.equal(error.registrationState, "failed");
      assert.equal(error.registrationRetrySafe, false);
      assert.equal(error.commitState, "notCommitted");
      assert.equal(error.retrySafe, true);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.equal(readAttempt(env.root).stage, "failed");
  const profileDirs = fs.readdirSync(path.join(env.root, "sources"));
  assert.equal(profileDirs.length, 1);
  assert.ok(fs.existsSync(path.join(env.root, "sources", profileDirs[0], "reference.audio")));
});

test("register 409 也按明确拒绝处理", async (t) => {
  const env = await setupPrepareEnv(t, { register: { status: 409, body: { detail: "exists" } } });
  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_REGISTER_FAILED");
      assert.equal(error.registrationState, "failed");
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
});

test("register 503 保守记为 unknown：1 POST、资料保留、不重发", async (t) => {
  const env = await setupPrepareEnv(t, { register: { status: 503, body: { detail: "runtime busy" } } });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_REGISTER_UNKNOWN");
      assert.equal(error.registrationState, "unknown");
      assert.equal(error.registrationRetrySafe, false);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.equal(readAttempt(env.root).stage, "unknown");
});

test("register 超时按 unknown 处理：1 POST、资料保留、attempt 在场", async (t) => {
  const env = await setupPrepareEnv(t, {
    register: { hang: true },
    endpointOverrides: { registerTimeoutMs: 300 },
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_REGISTER_UNKNOWN");
      assert.equal(error.registrationState, "unknown");
      assert.equal(error.registrationRetrySafe, false);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.equal(readAttempt(env.root).stage, "unknown");
});

test("注册成功但在线 instanceId 漂移时拒绝：registered、1 POST、不发布", async (t) => {
  const registerConfig = {};
  const env = await setupPrepareEnv(t, { register: registerConfig, voices: [] });
  registerConfig.runtimeAfter = { ...env.runtime, instanceId: "prepare-instance-2" };
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.registrationState, "registered");
      assert.equal(error.registrationRetrySafe, false);
      assert.ok(
        error.code === "ERR_STORE_PREPARE_DRIFT" || error.code === "ERR_STORE_PREPARE_VERIFY_FAILED",
        `期望漂移或核验错误，实际 ${error.code}`,
      );
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("注册成功但目录提交 postcommit 失败：catalog committed、registrationState=registered", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
  let renamed = false;
  withHook(t, "beforeRename", () => {
    patchFs(t, "renameSync", (originalRename) => (from, to) => {
      originalRename(from, to);
      if (String(to).endsWith("catalog.json")) {
        renamed = true;
      }
    });
    patchFs(t, "readSync", (originalRead) => (...args) => {
      if (renamed) {
        throw ioError("EIO", "postcommit 读回失败");
      }
      return originalRead(...args);
    });
  });

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_POST_COMMIT");
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.equal(error.registrationState, "registered");
      assert.equal(error.registrationRetrySafe, false);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 1);
  const onDisk = readJson(path.join(env.root, "catalog.json"));
  assert.equal(onDisk.bindings[0].status, "ready");
});

test("注册成功但 journal published 末步失败：结构化错误且不静默成功、无残留 temp", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
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

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_JOURNAL_PUBLISHED");
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.equal(error.registrationState, "registered");
      assert.equal(error.registrationRetrySafe, false);
      assert.ok(error.cause, "必须保留 journal 写入的 cause");
      assert.ok(error.journalError, "必须暴露 journalError");
      return true;
    },
  );
  // ready 实际已落盘，不得被回退成未提交。
  const onDisk = readJson(path.join(env.root, "catalog.json"));
  assert.equal(onDisk.bindings[0].status, "ready");
  assert.ok(journalTemps(env.root).length === 0, "失败的 journal 临时文件必须清理");
  assert.equal(readAttempt(env.root).stage, "registered");
});

test("初始 pending journal 无法持久时 POST 前 fail closed，0 次注册", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
  patchFs(t, "renameSync", (originalRename) => (from, to) => {
    if (String(to).includes("attempt-")) {
      throw ioError("EPERM", "pending journal 写入失败");
    }
    return originalRename(from, to);
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assertRejectsCode(() => store.prepareVoice(env.root, baseOptions(env)), "ERR_STORE_PREPARE_JOURNAL");
  assert.equal(env.audio8Server.state.calls.register, 0, "没有操作记录就不允许先注册");
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.ok(journalTemps(env.root).length === 0, "pending 失败的临时文件必须清理");
});

test("published journal 落盘失败且 temp unlink 失败：保留本次 temp、结构化上报 unlink-failed", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
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
  // 只让本次 attempt temp 的 unlink 失败，避免影响 catalog/锁自己的清理路径。
  patchFs(t, "unlinkSync", (originalUnlink) => (target, ...rest) => {
    if (String(target).includes(".attempt-") && String(target).includes(".tmp-")) {
      throw ioError("EACCES", "unlink 被拒");
    }
    return originalUnlink(target, ...rest);
  });

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_JOURNAL_PUBLISHED");
      assert.equal(error.commitState, "committed");
      assert.equal(error.registrationState, "registered");
      assert.equal(error.retrySafe, false);
      assert.equal(error.registrationRetrySafe, false);
      assert.ok(error.cause, "必须保留 journal 写入的原始 cause");
      assert.ok(error.journalError, "必须暴露 journalError");
      assert.equal(error.cleanup.readyCommitted, true);
      assert.equal(error.cleanup.temp.status, "unlink-failed");
      assert.equal(error.cleanup.temp.removed, false);
      assert.equal(error.journalCleanup.status, "unlink-failed");
      return true;
    },
  );
  // 清理失败必须如实保留现场，不能硬编码声称无残留。
  assert.equal(journalTemps(env.root).length, 1, "unlink 失败必须保留本次 temp");
  assert.equal(readJson(path.join(env.root, "catalog.json")).bindings[0].status, "ready");
  assert.equal(env.audio8Server.state.calls.register, 1, "已发送的注册严禁重发");
});

test("published journal 落盘失败且 temp 身份被替换：不删未知文件、上报 identity-mismatch、保留现场字节", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
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
  // 模拟 temp 在失败瞬间被换成别的 inode：身份不再属于本次创建，绝不允许删除。
  patchFs(t, "lstatSync", (originalLstat) => (target, ...rest) => {
    const stats = originalLstat(target, ...rest);
    if (String(target).includes(".attempt-") && String(target).includes(".tmp-")) {
      return { dev: stats.dev + 1, ino: stats.ino + 1, isFile: () => stats.isFile() };
    }
    return stats;
  });

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_JOURNAL_PUBLISHED");
      assert.equal(error.commitState, "committed");
      assert.equal(error.registrationState, "registered");
      assert.equal(error.cleanup.temp.status, "identity-mismatch");
      assert.equal(error.cleanup.temp.removed, false);
      assert.equal(error.journalCleanup.status, "identity-mismatch");
      return true;
    },
  );
  const temps = journalTemps(env.root);
  assert.equal(temps.length, 1, "身份不符的 temp 必须保留");
  assert.equal(readJson(path.join(env.root, "operations", temps[0])).stage, "published");
  assert.equal(env.audio8Server.state.calls.register, 1, "已发送的注册严禁重发");
});

test("pending journal 写入失败：清理结果随上层错误上报、0 次注册、无残留", async (t) => {
  const env = await setupPrepareEnv(t, { voices: [] });
  patchFs(t, "writeSync", (originalWrite) => (fd, buffer, ...rest) => {
    const chunk = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
    if (chunk.includes("memo-local-tts-prepare-attempt")) {
      throw ioError("EIO", "pending journal 写入失败");
    }
    return originalWrite(fd, buffer, ...rest);
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assert.rejects(
    store.prepareVoice(env.root, baseOptions(env)),
    (error) => {
      assert.equal(error.code, "ERR_STORE_PREPARE_JOURNAL");
      assert.ok(error.cause, "必须保留原始 cause");
      assert.ok(error.journalError, "必须暴露 journalError");
      // updateCatalog 自带锁/目录 temp 的 cleanup；journal temp 结果走独立字段，互不覆盖。
      assert.ok(error.cleanup && typeof error.cleanup.ok === "boolean", "updateCatalog cleanup 仍在场");
      assert.equal(error.journalCleanup.status, "removed");
      assert.equal(error.journalCleanup.removed, true);
      return true;
    },
  );
  assert.equal(env.audio8Server.state.calls.register, 0, "没有操作记录就不允许先注册");
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.equal(journalTemps(env.root).length, 0, "写入失败必须清理本次 temp");
});

test("并发持锁时 prepareVoice 明确繁忙且 0 POST", async (t) => {
  const { spawn } = require("node:child_process");
  const env = await setupPrepareEnv(t, { voices: [] });
  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "const root = process.argv[1];",
    "store.__testHooks.raceHook.afterLockAcquire = () => { process.stdout.write('locked\\n'); };",
    "store.updateCatalog(root, () => { const until = Date.now() + 700; while (Date.now() < until) {} })",
    "  .then(() => process.stdout.write('done\\n'))",
    "  .catch((e) => process.stdout.write(`err:${e.code}\\n`));",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script, env.root], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("locked")) {
        resolve();
      }
    });
  });

  await assertRejectsCode(() => store.prepareVoice(env.root, baseOptions(env)), "ERR_STORE_BUSY");
  assert.equal(env.audio8Server.state.calls.register, 0);
  await new Promise((resolve) => child.on("close", resolve));
});
