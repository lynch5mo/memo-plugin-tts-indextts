"use strict";

// 4A3 临时音色生命周期测试：全部在隔离 namespace + 人工合成录音字节，不碰真实录音、安装或 Memo。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../manager/store.js");
const { makeAudio8Endpoint, AUDIO8_VOICE_FINGERPRINT } = require("./helpers/catalog-fixture.js");

const ROOT_ENTRIES = ["catalog.json", "derived", "operations", "owner.json", "sources", "voices"];

function mktemp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memo-4a3-")));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256Bytes(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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

async function setupNamespace(t) {
  const root = mktemp();
  t.after(() => cleanup(root));
  const ns = await store.initialize(root);
  return { root, ns };
}

// 构造未来 prepare 会写下的最小不可变归属记录 + 合成音频字节（fixture 直接写文件，不新增生产入口）。
function materializeVoiceFiles(root, opts) {
  const profileId = opts.profileId;
  const dir = path.join(root, "sources", profileId);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = opts.fileName || "reference.wav";
  const audioPath = path.join(dir, fileName);
  const audioBytes = opts.audioBytes || Buffer.from("memo-synthetic-audio-bytes");
  fs.writeFileSync(audioPath, audioBytes);

  const relative = `sources/${profileId}/${fileName}`;
  const operationId = opts.operationId || crypto.randomUUID();
  const sourceRecord = {
    schemaVersion: 1,
    kind: "memo-local-tts-source",
    namespaceId: opts.namespaceId,
    profileId,
    operationId,
    audioRelativePath: opts.audioRelativePathOverride || relative,
    audioSha256: opts.audioSha256 || sha256Bytes(audioBytes),
    referenceText: opts.referenceText === undefined ? "参考原文。" : opts.referenceText,
    language: opts.language === undefined ? "zh" : opts.language,
  };
  const sourcePath = path.join(dir, "source.json");
  fs.writeFileSync(sourcePath, `${JSON.stringify(sourceRecord, null, 2)}\n`, "utf8");

  const operationRecord = {
    schemaVersion: 1,
    kind: "memo-local-tts-voice-operation",
    namespaceId: opts.namespaceId,
    profileId,
    operationId: opts.operationRecordOperationId || operationId,
    sourceRelativePath: `sources/${profileId}/source.json`,
  };
  const operationPath = path.join(root, "operations", `voice-${profileId}.json`);
  fs.writeFileSync(operationPath, `${JSON.stringify(operationRecord, null, 2)}\n`, "utf8");

  return { profileId, operationId, relative, audioPath, sourcePath, operationPath };
}

async function addVoice(root, ns, opts = {}) {
  const profileId = opts.profileId || crypto.randomUUID();
  const files = materializeVoiceFiles(root, {
    ...opts,
    profileId,
    namespaceId: opts.namespaceId || ns.namespaceId,
  });
  const bindingId = opts.bindingId || `binding-${profileId}`;
  const revision = opts.revision === undefined ? 1 : opts.revision;
  const status = opts.status || "ready";

  await store.updateCatalog(root, (draft) => {
    if (!draft.endpoints.some((entry) => entry.id === "ep-audio8")) {
      draft.endpoints.push(makeAudio8Endpoint());
    }
    draft.profiles.push({
      id: profileId,
      label: opts.label || "临时讲师",
      persistence: opts.persistence || "temporary",
      owner: opts.owner || ns.namespaceId,
      source: {
        audioPath: opts.audioPathOverride || files.audioPath,
        referenceText: opts.sourceReferenceText === undefined ? "参考原文。" : opts.sourceReferenceText,
        language: opts.sourceLanguage === undefined ? "zh" : opts.sourceLanguage,
      },
    });
    draft.bindings.push({
      id: bindingId,
      profileId,
      backendId: "audio8",
      endpointId: "ep-audio8",
      nativeVoiceId: opts.nativeVoiceId || "voice-1",
      modelFingerprint: "fp-audio8-001",
      revision,
      status,
      params: { speed: 1 },
      nativeVoiceFingerprint: AUDIO8_VOICE_FINGERPRINT,
    });
  });

  return { profileId, bindingId, ...files };
}

function snapshotBytes(root, voice) {
  return {
    owner: fs.readFileSync(path.join(root, "owner.json")),
    source: fs.readFileSync(voice.sourcePath),
    operation: fs.readFileSync(voice.operationPath),
    audio: fs.readFileSync(voice.audioPath),
  };
}

function assertBytesUnchanged(root, voice, before) {
  assert.deepEqual(fs.readFileSync(path.join(root, "owner.json")), before.owner);
  assert.deepEqual(fs.readFileSync(voice.sourcePath), before.source);
  assert.deepEqual(fs.readFileSync(voice.operationPath), before.operation);
  assert.deepEqual(fs.readFileSync(voice.audioPath), before.audio);
}

function catalogBytes(root) {
  return fs.readFileSync(path.join(root, "catalog.json"));
}

function findProfile(catalog, profileId) {
  return catalog.profiles.find((entry) => entry.id === profileId);
}

function bindingsOf(catalog, profileId) {
  return catalog.bindings.filter((entry) => entry.profileId === profileId);
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

test("saveTemporary 把 temporary 变 saved：保留 ID/revision/params 且所有原文件字节不变", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { params: { speed: 1 } });
  const before = snapshotBytes(root, voice);
  const beforeCatalog = catalogBytes(root);

  await store.saveTemporary(root, voice.profileId);

  const catalog = readJson(path.join(root, "catalog.json"));
  const profile = findProfile(catalog, voice.profileId);
  const binding = bindingsOf(catalog, voice.profileId)[0];
  assert.equal(profile.persistence, "saved");
  assert.equal(profile.id, voice.profileId);
  assert.equal(binding.id, voice.bindingId);
  assert.equal(binding.revision, 1);
  assert.equal(binding.status, "ready");
  assert.deepEqual(binding.params, { speed: 1 });
  assertBytesUnchanged(root, voice, before);
  assert.notDeepEqual(catalogBytes(root), beforeCatalog, "catalog 必须被提交更新");
});

test("saveTemporary 对已 saved 的合法完整记录幂等且不改 revision", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  await store.saveTemporary(root, voice.profileId);
  const afterFirst = catalogBytes(root);
  const before = snapshotBytes(root, voice);

  await store.saveTemporary(root, voice.profileId);

  assert.deepEqual(catalogBytes(root), afterFirst, "幂等保存不得改变目录字节");
  assertBytesUnchanged(root, voice, before);
});

test("endTemporary 只把目标 profile 的 binding 置 invalid 并 revision+1，profile 仍 temporary", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { revision: 4 });
  const before = snapshotBytes(root, voice);

  await store.endTemporary(root, voice.profileId);

  const catalog = readJson(path.join(root, "catalog.json"));
  const profile = findProfile(catalog, voice.profileId);
  const binding = bindingsOf(catalog, voice.profileId)[0];
  assert.equal(profile.persistence, "temporary");
  assert.equal(binding.status, "invalid");
  assert.equal(binding.revision, 5);
  assertBytesUnchanged(root, voice, before, "停用不得删改源录音与归属记录");
});

test("endTemporary 再次调用幂等：不重复涨 revision", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { revision: 4 });
  await store.endTemporary(root, voice.profileId);
  const afterFirst = catalogBytes(root);

  await store.endTemporary(root, voice.profileId);

  const catalog = readJson(path.join(root, "catalog.json"));
  assert.equal(bindingsOf(catalog, voice.profileId)[0].revision, 5);
  assert.deepEqual(catalogBytes(root), afterFirst, "重复停用不得改变目录字节");
});

test("同名不同 ID 互不影响", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const first = await addVoice(root, ns, { label: "同名讲师", revision: 2 });
  const second = await addVoice(root, ns, { label: "同名讲师", revision: 7 });

  await store.endTemporary(root, first.profileId);

  const catalog = readJson(path.join(root, "catalog.json"));
  assert.equal(bindingsOf(catalog, first.profileId)[0].status, "invalid");
  assert.equal(bindingsOf(catalog, first.profileId)[0].revision, 3);
  assert.equal(bindingsOf(catalog, second.profileId)[0].status, "ready");
  assert.equal(bindingsOf(catalog, second.profileId)[0].revision, 7);
  assert.equal(findProfile(catalog, second.profileId).persistence, "temporary");
});

test("saved 音色不可被 endTemporary 停用", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { revision: 3 });
  await store.saveTemporary(root, voice.profileId);
  const before = catalogBytes(root);

  await assertRejectsCode(
    () => store.endTemporary(root, voice.profileId),
    "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  );
  assert.deepEqual(catalogBytes(root), before, "拒绝不得改目录");
  const catalog = readJson(path.join(root, "catalog.json"));
  assert.equal(bindingsOf(catalog, voice.profileId)[0].status, "ready");
  assert.equal(bindingsOf(catalog, voice.profileId)[0].revision, 3);
});

test("external 音色不可 save 也不可 end", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { persistence: "external" });
  const before = catalogBytes(root);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  );
  await assertRejectsCode(
    () => store.endTemporary(root, voice.profileId),
    "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
  );
  assert.deepEqual(catalogBytes(root), before);
});

test("owner 与 namespace 不符时拒绝且原目录不变", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { owner: crypto.randomUUID() });
  const before = catalogBytes(root);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_LIFECYCLE_FORBIDDEN",
  );
  assert.deepEqual(catalogBytes(root), before);
});

test("缺少 source 记录时拒绝且原目录不变", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  fs.rmSync(voice.sourcePath);
  const before = catalogBytes(root);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_SOURCE_MISSING",
  );
  assert.deepEqual(catalogBytes(root), before);
});

test("缺少 operation 记录时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  fs.rmSync(voice.operationPath);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_OPERATION_MISSING",
  );
});

test("两份记录 operationId 不一致时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { operationRecordOperationId: crypto.randomUUID() });

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_OPERATION_INVALID",
  );
});

test("音频摘要与记录不一致时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  // 直接改写音频字节，摘要记录不再匹配。
  fs.writeFileSync(voice.audioPath, Buffer.from("tampered-audio-bytes"));

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_SOURCE_HASH_MISMATCH",
  );
});

test("audioRelativePath 越界（含 .. 或指向别的 profile）时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const escape = await addVoice(root, ns, { audioRelativePathOverride: "../../etc/passwd" });
  await assertRejectsCode(
    () => store.saveTemporary(root, escape.profileId),
    "ERR_STORE_SOURCE_INVALID",
  );

  const other = await addVoice(root, ns, {
    audioRelativePathOverride: "sources/00000000-0000-4000-8000-000000000000/file.wav",
  });
  await assertRejectsCode(
    () => store.saveTemporary(root, other.profileId),
    "ERR_STORE_SOURCE_INVALID",
  );
});

test("source.json 末段是符号链接时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  const decoy = path.join(root, "derived", "decoy-source.json");
  fs.copyFileSync(voice.sourcePath, decoy);
  fs.rmSync(voice.sourcePath);
  fs.symlinkSync(decoy, voice.sourcePath);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_SOURCE_INVALID",
  );
});

test("音频末段是符号链接时拒绝", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
  const decoy = path.join(root, "derived", "decoy-audio.wav");
  fs.copyFileSync(voice.audioPath, decoy);
  fs.rmSync(voice.audioPath);
  fs.symlinkSync(decoy, voice.audioPath);

  await assertRejectsCode(
    () => store.saveTemporary(root, voice.profileId),
    "ERR_STORE_SOURCE_INVALID",
  );
});

test("revision 达到安全整数上限时 endTemporary 拒绝且原目录不变", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, { revision: Number.MAX_SAFE_INTEGER });
  const before = catalogBytes(root);

  await assertRejectsCode(
    () => store.endTemporary(root, voice.profileId),
    "ERR_STORE_REVISION_OVERFLOW",
  );
  assert.deepEqual(catalogBytes(root), before);
});

test("postcommit 读回失败时原样透传 committed/retrySafe=false", async (t) => {
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});
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

  await assert.rejects(store.saveTemporary(root, voice.profileId), (error) => {
    assert.equal(error.code, "ERR_STORE_POST_COMMIT");
    assert.equal(error.commitState, "committed");
    assert.equal(error.retrySafe, false);
    assert.match(String(error.cause && (error.cause.code || error.cause.message)), /EIO/);
    return true;
  });
  assert.equal(renamed, true);
  // 用 readFileSync 绕开注入确认提交实际已落盘。
  const onDisk = readJson(path.join(root, "catalog.json"));
  assert.equal(findProfile(onDisk, voice.profileId).persistence, "saved");
});

test("持锁期间 saveTemporary/endTemporary 明确繁忙", async (t) => {
  const { spawn } = require("node:child_process");
  const { root, ns } = await setupNamespace(t);
  const voice = await addVoice(root, ns, {});

  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "const root = process.argv[1];",
    "store.__testHooks.raceHook.afterLockAcquire = () => { process.stdout.write('locked\\n'); };",
    "store.updateCatalog(root, (draft) => {",
    "  const until = Date.now() + 700;",
    "  while (Date.now() < until) {}",
    "  void draft;",
    "}).then(() => process.stdout.write('done\\n'))",
    "  .catch((e) => process.stdout.write(`err:${e.code}\\n`));",
  ].join("\n");

  const child = spawn(process.execPath, ["-e", script, root], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("locked")) {
        resolve();
      }
    });
  });

  await assertRejectsCode(() => store.saveTemporary(root, voice.profileId), "ERR_STORE_BUSY");
  await assertRejectsCode(() => store.endTemporary(root, voice.profileId), "ERR_STORE_BUSY");
  assert.equal(fs.existsSync(path.join(root, "operations", ".catalog.lock")), true);

  await new Promise((resolve) => child.on("close", resolve));
  const catalog = readJson(path.join(root, "catalog.json"));
  assert.equal(findProfile(catalog, voice.profileId).persistence, "temporary");
  assert.equal(bindingsOf(catalog, voice.profileId)[0].status, "ready");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});
