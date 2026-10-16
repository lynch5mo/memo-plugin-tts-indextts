"use strict";

// 4A4 只读导入已有 Audio8 音色测试：真实 loopback HTTP fixture + 隔离磁盘 meta 与 namespace。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../manager/store.js");
const fxAudio8 = require("./helpers/audio8-fixture.js");

const ROOT_ENTRIES = ["catalog.json", "derived", "operations", "owner.json", "sources", "voices"];

function mktemp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memo-4a4-")));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hashTree(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current, name);
      const stats = fs.lstatSync(target);
      if (stats.isDirectory()) {
        walk(target);
      } else {
        entries.push([path.relative(dir, target), crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")]);
      }
    }
  };
  walk(dir);
  return entries;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

// 构造隔离的 namespace + 真实 Audio8 HTTP fixture，并把端点登记进 managed catalog。
async function setupImportEnv(t, config = {}) {
  const install = fxAudio8.makeInstallDir({ metaOverrides: config.metaOverrides || {} });
  const runtime = {
    backendId: "audio8",
    modelFingerprint: install.manifest.model_fingerprint,
    modelDir: install.modelDir,
    voicesRoot: install.voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    instanceId: "import-instance-1",
    ...(config.runtimeOverrides || {}),
  };
  const audio8Server = await fxAudio8.startAudio8Server({
    health: config.health,
    voices: config.voices === undefined ? [install.meta] : config.voices,
    runtime: config.bare ? null : runtime,
    onRequest: config.onRequest,
  });

  const root = mktemp();
  t.after(() => cleanup(root));
  const ns = await store.initialize(root);

  const endpoint = {
    id: "ep-audio8-import",
    backendId: "audio8",
    baseUrl: audio8Server.baseUrl,
    modelFingerprint: install.manifest.model_fingerprint,
    readiness: "ready",
    runtimeManifestPath: install.manifestPath,
    voicesRoot: install.voicesRoot,
    precision: install.manifest.default_precision,
    codecPrecision: install.manifest.default_codec_precision,
    ...(config.endpointOverrides || {}),
  };
  await store.updateCatalog(root, (draft) => {
    draft.endpoints.push(endpoint);
  });

  t.after(async () => {
    await audio8Server.close();
    cleanup(install.installRoot);
  });

  return { root, ns, install, runtime, audio8Server, endpoint };
}

function onlyGets(server) {
  return server.state.requests.every((entry) => entry.method === "GET");
}

function findImportBinding(catalog, endpointId, nativeVoiceId) {
  return catalog.bindings.find(
    (entry) => entry.endpointId === endpointId && entry.nativeVoiceId === nativeVoiceId,
  );
}

test("importExternal 成功：只发 GET、profile 无 source、binding ready/revision1/params 空，外部目录字节不变", async (t) => {
  const env = await setupImportEnv(t);
  const beforeTree = hashTree(env.install.installRoot);

  const committed = await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });

  assert.ok(Object.isFrozen(committed));
  const catalog = readJson(path.join(env.root, "catalog.json"));
  const profile = catalog.profiles[0];
  const binding = catalog.bindings[0];
  assert.equal(profile.persistence, "external");
  assert.equal(profile.label, "外部讲师");
  assert.equal(profile.owner, env.ns.namespaceId);
  assert.equal(profile.source, undefined, "external profile 不得臆造原录音 source");
  assert.equal(binding.status, "ready");
  assert.equal(binding.revision, 1);
  assert.deepEqual(binding.params, {});
  assert.equal(binding.endpointId, env.endpoint.id);
  assert.equal(binding.modelFingerprint, env.endpoint.modelFingerprint);
  assert.match(binding.nativeVoiceFingerprint, /^[0-9a-f]{64}$/);

  // 只读：全部 GET，且没有合成 POST。
  assert.equal(onlyGets(env.audio8Server), true, "导入只允许 GET");
  assert.equal(env.audio8Server.state.calls.tts, 0, "导入不得发起合成");

  // 外部安装目录全文件 hash 与内容不变。
  assert.deepEqual(hashTree(env.install.installRoot), beforeTree, "外部音色目录不得被改动");

  // 不写自有音色/原始录音记录。
  assert.deepEqual(fs.readdirSync(path.join(env.root, "sources")), []);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "voices")), []);
  assert.deepEqual(fs.readdirSync(path.join(env.root, "operations")), []);
  assert.deepEqual(fs.readdirSync(env.root).sort(), ROOT_ENTRIES);
});

test("重复导入相同端点+声音+指纹幂等，复用原 ID 且不改 revision 与字节", async (t) => {
  const env = await setupImportEnv(t);
  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });
  const first = readJson(path.join(env.root, "catalog.json"));
  const firstBytes = fs.readFileSync(path.join(env.root, "catalog.json"));
  const beforeTree = hashTree(env.install.installRoot);

  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "改过的名字也不得覆盖",
  });

  const second = readJson(path.join(env.root, "catalog.json"));
  assert.equal(second.profiles.length, 1, "幂等不得新增 profile");
  assert.equal(second.bindings.length, 1, "幂等不得新增 binding");
  assert.equal(second.profiles[0].id, first.profiles[0].id);
  assert.equal(second.bindings[0].id, first.bindings[0].id);
  assert.equal(second.bindings[0].revision, first.bindings[0].revision);
  assert.equal(second.profiles[0].label, first.profiles[0].label, "不得无提示覆盖既有 label");
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), firstBytes);
  assert.deepEqual(hashTree(env.install.installRoot), beforeTree);
});

test("指纹已变时拒绝并提示需重新确认，不覆盖原绑定", async (t) => {
  const env = await setupImportEnv(t);
  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  // reference_text 是指纹字段：同时改在线元数据对象与磁盘 meta，令在线与磁盘仍一致但指纹已变。
  env.install.meta.reference_text = "换了一段参考原文。";
  fxAudio8.writeVoiceMeta(env.install.voicesRoot, env.install.meta);

  await assertRejectsCode(
    () =>
      store.importExternal(env.root, {
        endpointId: env.endpoint.id,
        nativeVoiceId: env.install.meta.name,
        label: "外部讲师",
      }),
    "ERR_STORE_IMPORT_FINGERPRINT_CHANGED",
  );
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("同名不同端点生成各自独立的外部 profile", async (t) => {
  const env = await setupImportEnv(t);
  const secondEndpoint = { ...env.endpoint, id: "ep-audio8-import-2" };
  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.push(secondEndpoint);
  });

  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });
  await store.importExternal(env.root, {
    endpointId: secondEndpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });

  const catalog = readJson(path.join(env.root, "catalog.json"));
  assert.equal(catalog.bindings.length, 2);
  assert.notEqual(catalog.bindings[0].id, catalog.bindings[1].id);
  const ids = new Set(catalog.bindings.map((entry) => entry.endpointId));
  assert.deepEqual([...ids].sort(), [env.endpoint.id, secondEndpoint.id].sort());
});

test("GPT 端点拒绝导入 ready，且不发起任何 POST", async (t) => {
  const env = await setupImportEnv(t);
  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.push({
      id: "ep-gpt",
      backendId: "gpt-sovits",
      baseUrl: env.audio8Server.baseUrl,
      modelFingerprint: "fp-gpt",
      readiness: "ready",
    });
  });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assertRejectsCode(
    () => store.importExternal(env.root, { endpointId: "ep-gpt", nativeVoiceId: "lin", label: "GPT" }),
    "ERR_STORE_IMPORT_BACKEND_UNSUPPORTED",
  );
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
  assert.equal(env.audio8Server.state.calls.tts, 0);
});

test("端点未登记或未 ready 时拒绝", async (t) => {
  const env = await setupImportEnv(t);
  await assertRejectsCode(
    () => store.importExternal(env.root, { endpointId: "ep-missing", nativeVoiceId: "v", label: "x" }),
    "ERR_STORE_IMPORT_ENDPOINT_MISSING",
  );

  await store.updateCatalog(env.root, (draft) => {
    draft.endpoints.push({ ...env.endpoint, id: "ep-notready", readiness: "unverified" });
  });
  await assertRejectsCode(
    () =>
      store.importExternal(env.root, {
        endpointId: "ep-notready",
        nativeVoiceId: env.install.meta.name,
        label: "x",
      }),
    "ERR_STORE_IMPORT_ENDPOINT_NOT_READY",
  );
});

test("裸服务缺身份接口时拒绝且目录不变", async (t) => {
  const env = await setupImportEnv(t, { bare: true });
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assertRejectsCode(
    () =>
      store.importExternal(env.root, {
        endpointId: env.endpoint.id,
        nativeVoiceId: env.install.meta.name,
        label: "外部讲师",
      }),
    "ERR_STORE_IMPORT_UNVERIFIED",
  );
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("在线声音不存在或磁盘与在线元数据不一致时拒绝", async (t) => {
  const missing = await setupImportEnv(t, { voices: [] });
  await assertRejectsCode(
    () =>
      store.importExternal(missing.root, {
        endpointId: missing.endpoint.id,
        nativeVoiceId: missing.install.meta.name,
        label: "外部讲师",
      }),
    "ERR_STORE_IMPORT_UNVERIFIED",
  );

  const drift = await setupImportEnv(t);
  const tampered = { ...drift.install.meta, reference_text: "磁盘被改成另一段原文。" };
  fxAudio8.writeVoiceMeta(drift.install.voicesRoot, tampered);
  await assertRejectsCode(
    () =>
      store.importExternal(drift.root, {
        endpointId: drift.endpoint.id,
        nativeVoiceId: drift.install.meta.name,
        label: "外部讲师",
      }),
    "ERR_STORE_IMPORT_UNVERIFIED",
  );
});

test("不合法 label 与 voiceId 被拒绝", async (t) => {
  const env = await setupImportEnv(t);
  await assertRejectsCode(
    () => store.importExternal(env.root, { endpointId: env.endpoint.id, nativeVoiceId: "../evil", label: "x" }),
    "ERR_STORE_IMPORT_INPUT",
  );
  await assertRejectsCode(
    () => store.importExternal(env.root, { endpointId: env.endpoint.id, nativeVoiceId: env.install.meta.name, label: "" }),
    "ERR_STORE_IMPORT_INPUT",
  );
});

test("meta 的 source_audio 旧文件名不得被写成 audioPath", async (t) => {
  const env = await setupImportEnv(t, {
    metaOverrides: { source_audio: "old-recording-name.wav" },
  });

  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });

  const catalog = readJson(path.join(env.root, "catalog.json"));
  const profile = catalog.profiles[0];
  assert.equal(profile.source, undefined);
  assert.equal(
    JSON.stringify(profile).includes("old-recording-name.wav"),
    false,
    "不得把 source_audio 文件名变成 audioPath 或迁移声明",
  );
});

test("在线 instanceId 漂移时拒绝且不写目录", async (t) => {
  let runtimeRef = null;
  const env = await setupImportEnv(t, {
    onRequest: (state, method, url) => {
      if (url === "/api/voices" && state.calls.voices === 0 && runtimeRef) {
        runtimeRef.instanceId = "import-instance-2";
      }
    },
  });
  runtimeRef = env.runtime;
  const before = fs.readFileSync(path.join(env.root, "catalog.json"));

  await assertRejectsCode(
    () =>
      store.importExternal(env.root, {
        endpointId: env.endpoint.id,
        nativeVoiceId: env.install.meta.name,
        label: "外部讲师",
      }),
    "ERR_STORE_IMPORT_DRIFT",
  );
  assert.deepEqual(fs.readFileSync(path.join(env.root, "catalog.json")), before);
});

test("网络 await 期间另一个 manager 更新明确繁忙，不拿旧目录覆盖", async (t) => {
  let busyObserved = null;
  let env;
  env = await setupImportEnv(t, {
    onRequest: () => {
      if (busyObserved !== null) {
        return;
      }
      store.updateCatalog(env.root, () => {}).then(
        () => {
          busyObserved = "ok";
        },
        (error) => {
          busyObserved = error.code;
        },
      );
    },
  });

  await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(busyObserved, "ERR_STORE_BUSY");
  const catalog = readJson(path.join(env.root, "catalog.json"));
  assert.equal(catalog.profiles.length, 1);
  assert.equal(catalog.profiles[0].persistence, "external");
});

test("external 音色不可 save，也不可 end", async (t) => {
  const env = await setupImportEnv(t);
  const committed = await store.importExternal(env.root, {
    endpointId: env.endpoint.id,
    nativeVoiceId: env.install.meta.name,
    label: "外部讲师",
  });
  const profileId = committed.profiles[0].id;

  await assertRejectsCode(
    () => store.saveTemporary(env.root, profileId),
    "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  );
  await assertRejectsCode(
    () => store.endTemporary(env.root, profileId),
    "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  );
});

test("postcommit 读回失败时原样透传 committed/retrySafe=false", async (t) => {
  const env = await setupImportEnv(t);
  let renamed = false;

  withHook(t, "beforeRename", () => {
    patchFs(t, "renameSync", (originalRename) => (from, to) => {
      originalRename(from, to);
      renamed = true;
    });
    patchFs(t, "readSync", (originalRead) => (...args) => {
      if (renamed) {
        throw ioError("EIO", "postcommit 读回失败");
      }
      return originalRead(...args);
    });
  });

  await assert.rejects(
    store.importExternal(env.root, {
      endpointId: env.endpoint.id,
      nativeVoiceId: env.install.meta.name,
      label: "外部讲师",
    }),
    (error) => {
      assert.equal(error.code, "ERR_STORE_POST_COMMIT");
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.match(String(error.cause && (error.cause.code || error.cause.message)), /EIO/);
      return true;
    },
  );
  assert.equal(renamed, true);
  // 用 readFileSync 绕开注入，确认 external profile 提交实际已落盘。
  const onDisk = readJson(path.join(env.root, "catalog.json"));
  assert.equal(onDisk.profiles.length, 1);
  assert.equal(onDisk.profiles[0].persistence, "external");
});
