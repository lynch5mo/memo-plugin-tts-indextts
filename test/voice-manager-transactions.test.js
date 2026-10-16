"use strict";

// 4A2 目录事务测试：只在隔离 namespace 内操作，不触碰真实录音、安装或用户默认根。
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../manager/store.js");
const { readCatalog, MAX_CATALOG_BYTES } = require("../src/catalog.js");
const {
  makeAudio8Endpoint,
  makeSavedProfile,
  makeAudio8Binding,
} = require("./helpers/catalog-fixture.js");

const LOCK_NAME = ".catalog.lock";
const ROOT_ENTRIES = ["catalog.json", "derived", "operations", "owner.json", "sources", "voices"];

function mktemp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memo-4a2-")));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readFileText(file) {
  return fs.readFileSync(file, "utf8");
}

function ownerBytes(root) {
  return fs.readFileSync(path.join(root, "owner.json"));
}

function lockTarget(root) {
  return path.join(root, "operations", LOCK_NAME);
}

function listTempFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(".catalog.tmp-"));
}

function fullCatalog() {
  return {
    endpoints: [makeAudio8Endpoint()],
    profiles: [makeSavedProfile()],
    bindings: [makeAudio8Binding()],
  };
}

function applyFullCatalog(draft) {
  const next = fullCatalog();
  draft.endpoints = next.endpoints;
  draft.profiles = next.profiles;
  draft.bindings = next.bindings;
}

function withHook(t, name, fn) {
  store.__testHooks.raceHook[name] = fn;
  t.after(() => {
    store.__testHooks.raceHook[name] = null;
  });
}

// 临时替换 fs 上的一个方法，测试结束必定还原；只用于确定性故障注入。
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

async function assertRejectsCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

async function assertRejectsWith(fn, code, check) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    check(error);
    return true;
  });
}

test("readManagedCatalog 返回冻结快照且不创建或删除任何文件", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const before = fs.readdirSync(root).sort();
  const snapshot = await store.readManagedCatalog(root);
  const after = fs.readdirSync(root).sort();

  assert.deepEqual(Object.keys(snapshot).sort(), ["bindings", "endpoints", "profiles", "schemaVersion"]);
  assert.ok(Object.isFrozen(snapshot), "快照必须冻结");
  assert.equal(snapshot.endpoints.length, 0);
  assert.deepEqual(after, before, "只读快照不得增删文件");
  assert.equal(fs.existsSync(lockTarget(root)), false, "只读不得创建锁");
});

test("updateCatalog 合法更新可被 src readCatalog 消费，owner 与目录集合不变（fix 事务）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const ownerBefore = ownerBytes(root);
  const committed = await store.updateCatalog(root, (draft) => {
    applyFullCatalog(draft);
  });

  assert.ok(Object.isFrozen(committed), "提交返回的快照必须冻结");
  assert.equal(committed.profiles[0].label, "讲师林");

  // 插件侧 readCatalog 直接消费落盘文件。
  const viaCatalog = readCatalog(path.join(root, "catalog.json"));
  assert.equal(viaCatalog.profiles[0].label, "讲师林");
  assert.equal(viaCatalog.bindings[0].id, "binding-lin-audio8");
  assert.equal(viaCatalog.endpoints[0].backendId, "audio8");

  assert.deepEqual(ownerBytes(root), ownerBefore, "owner.json 不得变化");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, "提交后无残留临时或锁文件");
  assert.equal(fs.existsSync(lockTarget(root)), false, "锁必须释放");
});

test("updateCatalog 草稿与返回快照无共享可写引用", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  let captured;
  const committed = await store.updateCatalog(root, (draft) => {
    applyFullCatalog(draft);
    captured = draft;
  });

  captured.profiles[0].label = "被改写的草稿";
  captured.bindings[0].params.mutated = true;
  const reread = await store.readManagedCatalog(root);
  assert.equal(committed.profiles[0].label, "讲师林", "提交快照不得随草稿变化");
  assert.equal(reread.profiles[0].label, "讲师林", "落盘内容不得随草稿变化");
  assert.equal(reread.bindings[0].params.mutated, undefined);
});

test("mutator 抛错原 catalog 字节不变且清理本次临时文件", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);
  const ownerBefore = ownerBytes(root);

  await assert.rejects(
    store.updateCatalog(root, () => {
      throw new Error("业务 mutator 失败");
    }),
    /业务 mutator 失败/,
  );

  assert.equal(readFileText(catalogPath), original, "失败必须保持原字节");
  assert.deepEqual(ownerBytes(root), ownerBefore);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, "失败不得留下临时或锁文件");
});

test("mutator 产出非法 schema 时拒绝且原字节不变", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  await assertRejectsCode(
    () =>
      store.updateCatalog(root, (draft) => {
        draft.schemaVersion = 2;
      }),
    "ERR_STORE_CATALOG_INVALID",
  );
  assert.equal(readFileText(catalogPath), original);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("更新后序列化超过 1MiB 时拒绝且原字节不变", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  await assertRejectsCode(
    () =>
      store.updateCatalog(root, (draft) => {
        applyFullCatalog(draft);
        draft.profiles[0].label = "x".repeat(MAX_CATALOG_BYTES + 1024);
      }),
    "ERR_STORE_CATALOG_TOO_LARGE",
  );
  assert.equal(readFileText(catalogPath), original);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("锁已存在时读写都明确繁忙且不偷锁", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const lock = lockTarget(root);
  const lockBody = JSON.stringify({ kind: "foreign-lock", note: "pre-existing" });
  fs.writeFileSync(lock, lockBody, "utf8");

  await assertRejectsCode(() => store.readManagedCatalog(root), "ERR_STORE_BUSY");
  await assertRejectsCode(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_BUSY",
  );

  assert.equal(readFileText(lock), lockBody, "不得移除或改写既有锁");
  assert.equal(readFileText(path.join(root, "catalog.json")).includes("讲师林"), false);
});

test("锁位置是符号链接时明确繁忙且不删除该链接", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  const outside = mktemp();
  t.after(() => cleanup(outside));
  await store.initialize(root);

  const decoy = path.join(outside, "decoy.json");
  fs.writeFileSync(decoy, "{}", "utf8");
  const lock = lockTarget(root);
  fs.symlinkSync(decoy, lock);

  await assertRejectsCode(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_BUSY",
  );
  assert.ok(fs.lstatSync(lock).isSymbolicLink(), "既有链接锁不得被删除");
  assert.equal(fs.existsSync(decoy), true);
});

test("提交前外部改写 catalog 时拒绝且不覆盖外部内容", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  // 外部写入一份合法但与原文件字节不同的目录，用于触发提交前冲突检测。
  const external = `${JSON.stringify(
    {
      schemaVersion: 1,
      endpoints: [],
      profiles: [
        { id: "profile-external", label: "外部写入", persistence: "saved", owner: "memo-local-tts" },
      ],
      bindings: [],
    },
    null,
    2,
  )}\n`;

  withHook(t, "beforeCommitCheck", () => {
    fs.writeFileSync(catalogPath, external, "utf8");
  });

  await assertRejectsCode(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_CATALOG_CONFLICT",
  );
  assert.equal(readFileText(catalogPath), external, "外部改写不得被事务覆盖");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("提交前 catalog 被换成同目录链接时拒绝且不覆盖", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const ownerPath = path.join(root, "owner.json");

  withHook(t, "beforeCommitCheck", () => {
    fs.rmSync(catalogPath);
    fs.symlinkSync(ownerPath, catalogPath);
  });

  await assertRejectsCode(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_CATALOG_INVALID",
  );
  assert.ok(fs.lstatSync(catalogPath).isSymbolicLink(), "链接替换不得被当成普通文件覆盖");
  assert.deepEqual(listTempFiles(root), [], "失败后不得留下本次临时文件");
});

test("未知临时文件不被删除，本次临时文件被清理", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const foreign = path.join(root, ".catalog.tmp-foreign-keep");
  withHook(t, "beforeRename", () => {
    fs.writeFileSync(foreign, "foreign", "utf8");
  });

  await store.updateCatalog(root, applyFullCatalog);

  assert.equal(fs.existsSync(foreign), true, "未知归属的临时文件不得被删除");
  const leftover = listTempFiles(root).filter((name) => name !== ".catalog.tmp-foreign-keep");
  assert.deepEqual(leftover, [], "本次临时文件必须清理");
  assert.equal(fs.existsSync(lockTarget(root)), false);
  fs.rmSync(foreign);
});

test("跨进程双更新：一个繁忙或先后完整成功，不丢更新", async (t) => {
  const { spawn } = require("node:child_process");
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "const root = process.argv[1];",
    "const label = process.argv[2];",
    "store.updateCatalog(root, (draft) => {",
    "  draft.profiles = draft.profiles || [];",
    "  draft.profiles.push({ id: `profile-${label}`, label, persistence: 'saved', owner: 'memo-local-tts' });",
    "}).then(() => process.stdout.write(JSON.stringify({ ok: true })))",
    "  .catch((e) => process.stdout.write(JSON.stringify({ ok: false, code: e.code || e.message })));",
  ].join("\n");

  const run = (label) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, root, label], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        err += chunk.toString("utf8");
      });
      child.on("close", (code, signal) => {
        let parsed;
        try {
          parsed = JSON.parse(out);
        } catch {
          parsed = { ok: false, code: "NO_JSON_OUTPUT" };
        }
        // 诊断信息一并带回：失败时能看到落败方的真实 code、退出码与 stderr，避免哑失败。
        resolve({ ...parsed, label, exitCode: code, signal, stdoutRaw: out.trim(), stderr: err.trim() });
      });
    });

  const results = await Promise.all([run("alpha"), run("beta")]);
  const winners = results.filter((entry) => entry.ok);
  const busy = results.filter((entry) => entry.code === "ERR_STORE_BUSY");
  const diagnostics = JSON.stringify(results);

  assert.ok(winners.length >= 1, `至少一个更新成功：${diagnostics}`);
  assert.equal(
    winners.length + busy.length,
    2,
    `另一个必须是明确繁忙，而不是静默失败：${diagnostics}`,
  );

  const finalCatalog = await store.readManagedCatalog(root);
  assert.equal(
    finalCatalog.profiles.length,
    winners.length,
    `成功次数与最终资料条目数一致，说明没有丢失更新：${diagnostics}`,
  );
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, diagnostics);
  assert.equal(fs.existsSync(lockTarget(root)), false);
});

test("持锁进程未释放前，另一个进程读目录明确繁忙", async (t) => {
  const { spawn } = require("node:child_process");
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "const root = process.argv[1];",
    "store.__testHooks.raceHook.afterLockAcquire = () => { process.stdout.write('locked\\n'); };",
    "store.updateCatalog(root, (draft) => {",
    "  const until = Date.now() + 700;",
    "  while (Date.now() < until) {}",
    "  draft.profiles = [{ id: 'profile-hold', label: 'holder', persistence: 'saved', owner: 'memo-local-tts' }];",
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

  await assertRejectsCode(() => store.readManagedCatalog(root), "ERR_STORE_BUSY");

  await new Promise((resolve) => child.on("close", resolve));
  const after = await store.readManagedCatalog(root);
  assert.equal(after.profiles.length, 1);
  assert.equal(fs.existsSync(lockTarget(root)), false);
});

// 4A2 fix1：提交点(rename)前后失败必须给出真实阶段语义，不能伪装成“未提交且可安全重试”。
test("临时文件 0 写时拒绝：未提交、原字节不变（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  withHook(t, "beforeTempWrite", () => {
    patchFs(t, "writeSync", () => () => 0);
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_TEMP_WRITE",
    (error) => {
      assert.equal(error.commitState, "notCommitted");
      assert.equal(error.retrySafe, true);
      assert.equal(error.cleanup.ok, true);
    },
  );
  assert.equal(readFileText(catalogPath), original, "写入失败必须保持原字节");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("临时文件短写（逐字节推进）仍写全并提交成功（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  withHook(t, "beforeTempWrite", () => {
    patchFs(t, "writeSync", (original) => (fd, buffer, offset, length, position) =>
      original(fd, buffer, offset, Math.min(1, length), position),
    );
  });

  const committed = await store.updateCatalog(root, applyFullCatalog);
  assert.equal(committed.profiles[0].label, "讲师林");
  const onDisk = JSON.parse(readFileText(path.join(root, "catalog.json")));
  assert.equal(onDisk.bindings[0].id, "binding-lin-audio8");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("临时文件 fsync 失败：未提交、原字节不变（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  withHook(t, "beforeTempFsync", () => {
    patchFs(t, "fsyncSync", () => () => {
      throw ioError("EIO", "fsync 失败");
    });
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_TEMP_FSYNC",
    (error) => {
      assert.equal(error.commitState, "notCommitted");
      assert.equal(error.retrySafe, true);
      assert.equal(error.cleanup.ok, true);
    },
  );
  assert.equal(readFileText(catalogPath), original, "fsync 失败必须保持原字节");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("rename 未发生替换：未提交且可重试，原字节不变、临时与锁都清理（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  withHook(t, "beforeRename", () => {
    patchFs(t, "renameSync", () => () => {
      throw ioError("EPERM", "rename 失败");
    });
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_RENAME_FAILED",
    (error) => {
      assert.equal(error.commitState, "notCommitted");
      assert.equal(error.retrySafe, true);
      assert.equal(error.cleanup.ok, true);
      assert.equal(error.cause.code, "EPERM");
    },
  );
  assert.equal(readFileText(catalogPath), original, "rename 未发生则原字节不变");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("rename 结果不明（临时文件已不在原处）：unknown 且禁止自动重发（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
  const original = readFileText(catalogPath);

  withHook(t, "beforeRename", () => {
    patchFs(t, "renameSync", () => (from) => {
      // 模拟“替换可能已发生但无法确认”：先移走临时文件，再让 rename 报错。
      fs.unlinkSync(from);
      throw ioError("EIO", "rename 结果不明");
    });
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_COMMIT_UNKNOWN",
    (error) => {
      assert.equal(error.commitState, "unknown");
      assert.equal(error.retrySafe, false);
      assert.equal(error.cleanup.ok, true);
    },
  );
  assert.equal(readFileText(catalogPath), original);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("rename 成功后提交后读回 EIO：结构化 committed 且禁止重发，新字节已落盘（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const catalogPath = path.join(root, "catalog.json");
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

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_POST_COMMIT",
    (error) => {
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.equal(error.cleanup.ok, true, "临时与锁仍应尽量清理");
      assert.match(String(error.cause && (error.cause.code || error.cause.message)), /EIO/);
    },
  );

  // 直接用 readFileSync 绕开被 patch 的 readSync，确认提交实际已落盘。
  assert.equal(renamed, true);
  const onDisk = JSON.parse(readFileText(catalogPath));
  assert.equal(onDisk.profiles.length, 1);
  assert.equal(onDisk.profiles[0].label, "讲师林");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
});

test("清理 unlink 失败：报告 committed 与 cleanup 状态，不静默吞掉（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  withHook(t, "beforeRename", () => {
    patchFs(t, "unlinkSync", () => () => {
      throw ioError("EPERM", "unlink 失败");
    });
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_CLEANUP",
    (error) => {
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.equal(error.cleanup.ok, false);
      assert.equal(error.cleanup.lock.status, "unlink-failed");
    },
  );
  assert.equal(fs.existsSync(lockTarget(root)), true, "清理失败时锁仍在，如实报告而非声称无残留");
  // 落盘内容确实已提交。
  const onDisk = JSON.parse(readFileText(path.join(root, "catalog.json")));
  assert.equal(onDisk.profiles.length, 1);
});

test("锁身份被替换：不删除替换文件并报 identity-mismatch（fix1）", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const lock = lockTarget(root);
  const replacement = "memo-local-tts-catalog-lock-replaced";

  withHook(t, "beforeRename", () => {
    fs.rmSync(lock);
    fs.writeFileSync(lock, replacement, "utf8");
  });

  await assertRejectsWith(
    () => store.updateCatalog(root, applyFullCatalog),
    "ERR_STORE_CLEANUP",
    (error) => {
      assert.equal(error.commitState, "committed");
      assert.equal(error.retrySafe, false);
      assert.equal(error.cleanup.lock.status, "identity-mismatch");
    },
  );
  assert.equal(readFileText(lock), replacement, "身份不匹配的锁文件不得被删除或改写");
});

// 5C 并发窗口回归：子进程用真实事务持锁，并在指定 hook 处先落标记文件、再同步忙等，
// 让父进程能在确定时刻发起竞争（标记文件放在 root 之外，避免污染根目录分类）。
function spawnHoldingChild(root, hookName, markerPath, holdMs, doneMarkerPath) {
  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "const fs = require('node:fs');",
    "const root = process.argv[1];",
    "const hook = process.argv[2];",
    "const marker = process.argv[3];",
    "const holdMs = Number(process.argv[4]);",
    "const doneMarker = process.argv[5] || '';",
    "store.__testHooks.raceHook[hook] = () => {",
    "  fs.writeFileSync(marker, 'ready');",
    "  const until = Date.now() + holdMs;",
    "  while (Date.now() < until) {}",
    "};",
    "store.updateCatalog(root, (draft) => {",
    "  draft.profiles = draft.profiles || [];",
    "  draft.profiles.push({ id: 'profile-holder', label: 'holder', persistence: 'saved', owner: 'memo-local-tts' });",
    "}).then(() => {",
    "  if (doneMarker) fs.writeFileSync(doneMarker, 'done');",
    "  process.stdout.write('DONE');",
    "}).catch((e) => {",
    "  if (doneMarker) fs.writeFileSync(doneMarker, 'err');",
    "  process.stdout.write('ERR ' + (e.code || e.message));",
    "});",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["-e", script, root, hookName, markerPath, String(holdMs), doneMarkerPath || ""],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });
  return {
    child,
    done: new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ out: out.trim(), stderr: err.trim(), exitCode: code, signal }));
    }),
  };
}

function waitForMarker(markerPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(markerPath)) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`等待子进程持锁窗口标记超时：${markerPath}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("合作 writer 持锁且已写临时文件时，另一个进程的读与写都必须明确繁忙", async (t) => {
  const root = mktemp();
  const scratch = mktemp();
  t.after(() => {
    cleanup(root);
    cleanup(scratch);
  });
  await store.initialize(root);

  const marker = path.join(scratch, "hold-after-temp");
  const holder = spawnHoldingChild(root, "beforeTempWrite", marker, 700);
  t.after(() => {
    if (holder.child.exitCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await waitForMarker(marker);
  assert.equal(listTempFiles(root).length, 1, "窗口内必须存在合作方的事务临时文件");
  assert.equal(fs.existsSync(lockTarget(root)), true, "窗口内必须已持有事务锁");

  await assert.rejects(store.updateCatalog(root, applyFullCatalog), (error) => {
    assert.equal(error.code, "ERR_STORE_BUSY", `窗口内写必须繁忙，实际 ${error.code}`);
    return true;
  });
  await assert.rejects(store.readManagedCatalog(root), (error) => {
    assert.equal(error.code, "ERR_STORE_BUSY", `窗口内读必须繁忙，实际 ${error.code}`);
    return true;
  });

  const finished = await holder.done;
  assert.equal(finished.out, "DONE", `持锁子进程必须成功完成：${JSON.stringify(finished)}`);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, "窗口结束后不得残留临时文件或锁");
  const finalCatalog = await store.readManagedCatalog(root);
  assert.equal(finalCatalog.profiles.length, 1, "竞争不得丢掉持锁方的更新");
});

test("预检查通过之后、目录分类之前另一进程入场：仍必须明确繁忙而不是根未知内容", async (t) => {
  const root = mktemp();
  const scratch = mktemp();
  t.after(() => {
    cleanup(root);
    cleanup(scratch);
  });
  await store.initialize(root);

  const marker = path.join(scratch, "hold-entry");
  const originalReaddir = fs.readdirSync;
  let injected = false;
  let holder = null;

  // 受控 fs 注入：只在本次 updateCatalog 首次读取根目录时启动另一个进程的事务，
  // 精确复现“早查锁通过 → 分类前入场”的 TOCTOU 时序；不修改任何生产安全检查。
  fs.readdirSync = function patchedReaddir(target, ...rest) {
    if (!injected && typeof target === "string" && target === root) {
      injected = true;
      holder = spawnHoldingChild(root, "beforeTempWrite", marker, 700);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker) && Date.now() < deadline) {
        // 同步等待另一个进程进入持锁且已写临时文件的窗口。
      }
    }
    return originalReaddir.call(fs, target, ...rest);
  };
  t.after(() => {
    fs.readdirSync = originalReaddir;
    if (holder && holder.child.exitCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await assert.rejects(store.updateCatalog(root, applyFullCatalog), (error) => {
    assert.equal(
      error.code,
      "ERR_STORE_BUSY",
      `分类前入场也必须繁忙，实际 ${error.code}`,
    );
    return true;
  });

  const finished = await holder.done;
  assert.equal(finished.out, "DONE", `持锁子进程必须成功完成：${JSON.stringify(finished)}`);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, "窗口结束后不得残留临时文件或锁");
  const finalCatalog = await store.readManagedCatalog(root);
  assert.equal(finalCatalog.profiles.length, 1, "竞争不得丢掉持锁方的更新");
});

test("目录枚举快照含临时文件、抛错前合作事务已结束：必须繁忙而不是根未知内容", async (t) => {
  const root = mktemp();
  const scratch = mktemp();
  t.after(() => {
    cleanup(root);
    cleanup(scratch);
  });
  await store.initialize(root);

  const holdMarker = path.join(scratch, "hold");
  const doneMarker = path.join(scratch, "done");
  const originalReaddir = fs.readdirSync;
  let injected = false;
  let holder = null;
  let staleSnapshot = null;

  // 受控 fs 注入，复现“枚举拿到含 temp 的快照 → 合作事务在抛错前已 rename 并释放锁”的释放窗口：
  // 先取到含临时文件的快照，再等合作方完整结束，最后把过期快照交回分类逻辑。
  fs.readdirSync = function patchedReaddir(target, ...rest) {
    if (!injected && typeof target === "string" && target === root) {
      injected = true;
      holder = spawnHoldingChild(root, "beforeTempWrite", holdMarker, 300, doneMarker);
      const holdDeadline = Date.now() + 5000;
      while (!fs.existsSync(holdMarker) && Date.now() < holdDeadline) {
        // 等合作方持锁并写下临时文件。
      }
      staleSnapshot = originalReaddir.call(fs, target, ...rest);
      const doneDeadline = Date.now() + 8000;
      while (!fs.existsSync(doneMarker) && Date.now() < doneDeadline) {
        // 等合作事务完整结束：临时文件已清理、锁已释放。
      }
      return staleSnapshot;
    }
    return originalReaddir.call(fs, target, ...rest);
  };
  t.after(() => {
    fs.readdirSync = originalReaddir;
    if (holder && holder.child.exitCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await assert.rejects(store.updateCatalog(root, applyFullCatalog), (error) => {
    assert.equal(error.code, "ERR_STORE_BUSY", `过期快照窗口必须繁忙，实际 ${error.code}`);
    return true;
  });

  assert.ok(
    Array.isArray(staleSnapshot) && staleSnapshot.some((name) => name.startsWith(".catalog.tmp-")),
    "注入的快照必须包含合作方临时文件，才构成释放窗口",
  );
  const finished = await holder.done;
  assert.equal(finished.out, "DONE", `持锁子进程必须成功完成：${JSON.stringify(finished)}`);

  // 不重试写入、不返回成功、不删除任何文件：只保留合作方的更新，根目录干净。
  const finalCatalog = await store.readManagedCatalog(root);
  assert.equal(finalCatalog.profiles.length, 1, "父进程不得写入，也不得删除合作方资料");
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES, "根目录不得残留临时文件或锁");
  assert.equal(fs.existsSync(lockTarget(root)), false);
});

test("无锁时的未知内容仍拒绝：外来文件与崩溃残留临时文件都报根未知内容", async (t) => {
  const root = mktemp();
  t.after(() => cleanup(root));
  await store.initialize(root);

  const stranger = path.join(root, "stranger.txt");
  fs.writeFileSync(stranger, "x", "utf8");
  await assert.rejects(store.updateCatalog(root, applyFullCatalog), (error) => {
    assert.equal(error.code, "ERR_STORE_ROOT_NOT_EMPTY", "无锁的外来文件必须保持拒绝");
    return true;
  });
  await assert.rejects(store.readManagedCatalog(root), (error) => {
    assert.equal(error.code, "ERR_STORE_ROOT_NOT_EMPTY", "无锁的外来文件必须保持拒绝");
    return true;
  });
  fs.rmSync(stranger);

  const leftover = path.join(root, ".catalog.tmp-crash-leftover");
  fs.writeFileSync(leftover, "x", "utf8");
  await assert.rejects(store.updateCatalog(root, applyFullCatalog), (error) => {
    assert.equal(error.code, "ERR_STORE_ROOT_NOT_EMPTY", "无锁的崩溃残留必须保持拒绝");
    return true;
  });
  await assert.rejects(store.readManagedCatalog(root), (error) => {
    assert.equal(error.code, "ERR_STORE_ROOT_NOT_EMPTY", "无锁的崩溃残留必须保持拒绝");
    return true;
  });
  fs.rmSync(leftover);

  // 清理后恢复正常：修复只影响并发窗口，不影响稳定状态的判定。
  await store.updateCatalog(root, applyFullCatalog);
  const finalCatalog = await store.readManagedCatalog(root);
  assert.equal(finalCatalog.profiles.length, 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ROOT_ENTRIES);
  assert.equal(fs.existsSync(lockTarget(root)), false);
});
