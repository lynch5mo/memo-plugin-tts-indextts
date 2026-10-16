"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../manager/store.js");
const { readCatalog } = require("../src/catalog.js");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBDIRS = ["sources", "voices", "derived", "operations"];

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memo-4a1-"));
}

function readOwner(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8"));
}

async function assertErrorCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

test("空根初始化：固定路径、owner 字段、四个子目录、可读空目录", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await store.initialize(root);
  const realRoot = fs.realpathSync(root);

  assert.deepEqual(Object.keys(result).sort(), [
    "catalogPath",
    "derivedRoot",
    "namespaceId",
    "operationsRoot",
    "root",
    "sourcesRoot",
    "voicesRoot",
  ]);
  assert.equal(result.root, realRoot);
  assert.equal(result.catalogPath, path.join(realRoot, "catalog.json"));
  assert.equal(result.sourcesRoot, path.join(realRoot, "sources"));
  assert.equal(result.voicesRoot, path.join(realRoot, "voices"));
  assert.equal(result.derivedRoot, path.join(realRoot, "derived"));
  assert.equal(result.operationsRoot, path.join(realRoot, "operations"));

  const owner = readOwner(root);
  assert.equal(owner.schemaVersion, 1);
  assert.equal(owner.kind, "memo-local-tts-managed");
  assert.match(owner.namespaceId, UUID_RE);
  assert.equal(owner.rootRealPath, realRoot);
  assert.equal(owner.namespaceId, result.namespaceId);
  assert.ok(!Number.isNaN(Date.parse(owner.createdAt)));

  for (const name of SUBDIRS) {
    const stats = fs.lstatSync(path.join(realRoot, name));
    assert.ok(stats.isDirectory() && !stats.isSymbolicLink(), `${name} 必须是真实目录`);
  }

  const catalog = readCatalog(result.catalogPath);
  assert.deepEqual(catalog.endpoints, []);
  assert.deepEqual(catalog.profiles, []);
  assert.deepEqual(catalog.bindings, []);
});

test("已自有根复用：namespaceId 稳定且不覆写 owner/catalog", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await store.initialize(root);
  const ownerBefore = fs.readFileSync(path.join(root, "owner.json"), "utf8");

  fs.writeFileSync(
    first.catalogPath,
    JSON.stringify({
      schemaVersion: 1,
      endpoints: [],
      profiles: [
        { id: "profile-kept", label: "保留", persistence: "saved", owner: first.namespaceId },
      ],
      bindings: [],
    }),
    "utf8",
  );
  const catalogBefore = fs.readFileSync(first.catalogPath, "utf8");

  const second = await store.initialize(root);
  const third = await store.validateNamespace(root);

  assert.equal(second.namespaceId, first.namespaceId);
  assert.equal(third.namespaceId, first.namespaceId);
  assert.equal(fs.readFileSync(path.join(root, "owner.json"), "utf8"), ownerBefore);
  assert.equal(fs.readFileSync(first.catalogPath, "utf8"), catalogBefore);
  assert.equal(readCatalog(first.catalogPath).profiles.length, 1);
});

test("含未知内容的根拒绝认领且不改动未知文件", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stranger = path.join(root, "stranger.txt");
  fs.writeFileSync(stranger, "keep me", "utf8");

  await assertErrorCode(() => store.initialize(root), "ERR_STORE_ROOT_NOT_EMPTY");
  assert.equal(fs.readFileSync(stranger, "utf8"), "keep me");
  assert.equal(fs.existsSync(path.join(root, "owner.json")), false);
});

test("半初始化内容拒绝认领且不自动补齐", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "memo-local-tts-managed",
      namespaceId: "11111111-2222-3333-4444-555555555555",
      rootRealPath: fs.realpathSync(root),
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );

  await assertErrorCode(() => store.initialize(root), "ERR_STORE_INCOMPLETE");
  assert.equal(fs.existsSync(path.join(root, "catalog.json")), false, "不得自动补齐 catalog");
  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_INCOMPLETE");
});

test("root 为符号链接时拒绝", async (t) => {
  const parent = mktemp();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const realRoot = path.join(parent, "real");
  fs.mkdirSync(realRoot);
  const link = path.join(parent, "link");
  fs.symlinkSync(realRoot, link, "dir");

  await assertErrorCode(() => store.initialize(link), "ERR_STORE_ROOT_SYMLINK");
});

test("owner.json 为符号链接时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outsideDir = mktemp();
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, "owner.json");
  fs.writeFileSync(outside, "{}", "utf8");
  fs.symlinkSync(outside, path.join(root, "owner.json"));

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_INVALID");
});

test("子目录为符号链接时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(result.voicesRoot, { recursive: true, force: true });
  fs.symlinkSync(outside, result.voicesRoot, "dir");

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_SUBDIR_INVALID");
  await assertErrorCode(() => store.initialize(root), "ERR_STORE_SUBDIR_INVALID");
});

test("owner.rootRealPath 与真实根不符时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await store.initialize(root);

  const ownerPath = path.join(root, "owner.json");
  const owner = readOwner(root);
  owner.rootRealPath = path.join(root, "elsewhere");
  fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf8");

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_MISMATCH");
});

test("owner 字段非法时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await store.initialize(root);
  const ownerPath = path.join(root, "owner.json");

  const cases = [
    { schemaVersion: 2 },
    { kind: "something-else" },
    { namespaceId: "not-a-uuid" },
    { createdAt: "not-a-time" },
  ];
  for (const patch of cases) {
    const owner = { ...readOwner(root), ...patch };
    fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf8");
    await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_INVALID");
  }
});

test("owner.json 超过 16KiB 时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await store.initialize(root);

  const owner = readOwner(root);
  owner.padding = "x".repeat(17 * 1024);
  fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify(owner), "utf8");

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_TOO_LARGE");
});

test("catalog.json 非法时拒绝复用且不改写原文件", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  fs.writeFileSync(result.catalogPath, "{ not json", "utf8");
  await assertErrorCode(() => store.initialize(root), "ERR_STORE_CATALOG_INVALID");
  assert.equal(fs.readFileSync(result.catalogPath, "utf8"), "{ not json");
});

test("root 不存在或不是目录时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "x", "utf8");

  await assertErrorCode(() => store.initialize(path.join(root, "missing")), "ERR_STORE_ROOT_MISSING");
  await assertErrorCode(() => store.initialize(file), "ERR_STORE_ROOT_MISSING");
});

function withHook(t, name, fn) {
  store.__testHooks.raceHook[name] = fn;
  t.after(() => {
    store.__testHooks.raceHook[name] = null;
  });
}

function validOwnerJson(root, namespaceId) {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "memo-local-tts-managed",
    namespaceId,
    rootRealPath: fs.realpathSync(root),
    createdAt: new Date().toISOString(),
  });
}

test("owner 检查后被换成非末段普通链接仍拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await store.initialize(root);

  // 根之外一份约 20KiB 的合法 owner，用于模拟"检查后被指向大体积合法文件"。
  const decoy = path.join(outside, "decoy-owner.json");
  const owner = readOwner(root);
  owner.padding = "x".repeat(20 * 1024);
  fs.writeFileSync(decoy, JSON.stringify(owner), "utf8");

  withHook(t, "afterOwnerLstat", () => {
    fs.rmSync(path.join(root, "owner.json"));
    fs.symlinkSync(decoy, path.join(root, "owner.json"));
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_INVALID");
});

test("owner 检查后被换成另一个 inode 时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const first = await store.initialize(root);

  const replacement = path.join(outside, "replacement-owner.json");
  fs.writeFileSync(
    replacement,
    validOwnerJson(root, "11111111-2222-3333-4444-555555555555"),
    "utf8",
  );

  withHook(t, "afterOwnerLstat", () => {
    fs.rmSync(path.join(root, "owner.json"));
    fs.copyFileSync(replacement, path.join(root, "owner.json"));
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_INVALID");
  assert.equal(first.namespaceId.length > 0, true);
});

test("owner 同一 inode 在读取期间增长超过 16KiB 时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await store.initialize(root);

  withHook(t, "beforeOwnerRead", () => {
    fs.appendFileSync(path.join(root, "owner.json"), " ".repeat(17 * 1024));
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_OWNER_TOO_LARGE");
});

test("catalog 为同父目录符号链接时 store 显式拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  // 同父目录链接：目标就是本目录内的 owner.json，把它写成同时满足 owner 与空 catalog 的文档，
  // 于是 readCatalog 自身会放行（它允许同父目录链接），只有 store 的末段链接拒绝能拦住。
  const ownerPath = path.join(root, "owner.json");
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({
      ...readOwner(root),
      endpoints: [],
      profiles: [],
      bindings: [],
    }),
    "utf8",
  );
  fs.rmSync(result.catalogPath);
  fs.symlinkSync(ownerPath, result.catalogPath);

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
});

test("root 末段在检查后被换成符号链接时拒绝", async (t) => {
  const parent = mktemp();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "root");
  fs.mkdirSync(root);
  const decoyRoot = path.join(parent, "decoy-root");
  fs.mkdirSync(decoyRoot);
  let swapped = false;

  withHook(t, "afterRootLstat", () => {
    if (swapped) {
      return;
    }
    swapped = true;
    fs.rmdirSync(root);
    fs.symlinkSync(decoyRoot, root, "dir");
  });

  await assertErrorCode(() => store.initialize(root), "ERR_STORE_ROOT_SYMLINK");
  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_ROOT_SYMLINK");
});

test("子目录末段在检查后被换成符号链接时拒绝", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  let calls = 0;
  withHook(t, "afterSubdirLstat", () => {
    calls += 1;
    if (calls === 2) {
      fs.rmSync(result.voicesRoot, { recursive: true, force: true });
      fs.symlinkSync(outside, result.voicesRoot, "dir");
    }
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_SUBDIR_INVALID");
});

test("并发 initialize 不覆写且不会产生两个不同 namespace", async (t) => {
  const { spawn } = require("node:child_process");
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const storePath = path.join(__dirname, "..", "manager", "store.js");
  const script = [
    `const store = require(${JSON.stringify(storePath)});`,
    "store.initialize(process.argv[1]).then((r) => process.stdout.write(JSON.stringify({ ok: true, namespaceId: r.namespaceId })))",
    "  .catch((e) => process.stdout.write(JSON.stringify({ ok: false, code: e.code || e.message })));",
  ].join("\n");

  const children = Array.from({ length: 6 }, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, root], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString("utf8");
      });
      child.on("close", () => resolve(out));
    }),
  );

  const results = (await Promise.all(children)).map((out) => JSON.parse(out));
  const winners = results.filter((entry) => entry.ok);

  assert.ok(winners.length >= 1, "至少应有一个进程成功初始化");
  const namespaces = new Set(winners.map((entry) => entry.namespaceId));
  assert.equal(namespaces.size, 1, "所有成功者必须共享同一个 namespaceId");

  const finalNamespace = await store.validateNamespace(root);
  assert.equal(finalNamespace.namespaceId, winners[0].namespaceId);
  assert.equal(readOwner(root).namespaceId, winners[0].namespaceId);
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ["catalog.json", "derived", "operations", "owner.json", "sources", "voices"],
    "并发后不得留下半成品或多余文件",
  );
});

test("catalog 检查后被换成同目录 owner 链接时拒绝（fix2）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const ownerPath = path.join(root, "owner.json");
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({ ...readOwner(root), endpoints: [], profiles: [], bindings: [] }),
    "utf8",
  );

  withHook(t, "afterCatalogLstat", () => {
    fs.rmSync(result.catalogPath);
    fs.symlinkSync(ownerPath, result.catalogPath);
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
});

test("catalog 检查后被换成另一个 inode 时拒绝（fix2）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const decoy = path.join(outside, "valid-catalog.json");
  fs.writeFileSync(
    decoy,
    JSON.stringify({ schemaVersion: 1, endpoints: [], profiles: [], bindings: [] }),
    "utf8",
  );

  withHook(t, "afterCatalogLstat", () => {
    fs.rmSync(result.catalogPath);
    fs.copyFileSync(decoy, result.catalogPath);
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
});

test("catalog 同一 inode 在读取期间增长超过 1MiB 时拒绝（fix2）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  withHook(t, "beforeCatalogRead", () => {
    fs.appendFileSync(result.catalogPath, " ".repeat(1024 * 1024 + 1));
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
});

test("createNamespace 完成后整体校验失败则不返回成功（fix2）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 模拟初始化写入 owner/catalog 之后 catalog 被移除：整体复核必须拒绝，而不是返回成功。
  withHook(t, "afterCreateFiles", () => {
    fs.rmSync(path.join(fs.realpathSync(root), "catalog.json"));
  });

  await assertErrorCode(() => store.initialize(root), "ERR_STORE_INCOMPLETE");
});

test("catalog 在 fd 关闭阶段被换成同目录 owner 链接时拒绝（fix3）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const ownerPath = path.join(root, "owner.json");
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({ ...readOwner(root), endpoints: [], profiles: [], bindings: [] }),
    "utf8",
  );

  // 在文件内容已按已核验 fd 读完、准备关闭的窗口把路径本身换成同目录链接。
  withHook(t, "beforeCatalogClose", () => {
    fs.rmSync(result.catalogPath);
    fs.symlinkSync(ownerPath, result.catalogPath);
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
  assert.ok(fs.lstatSync(result.catalogPath).isSymbolicLink(), "负例确实换成了链接");
});

test("catalog 在 fd 关闭阶段被换成另一个 inode 时拒绝（fix3）", async (t) => {
  const root = mktemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = mktemp();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const result = await store.initialize(root);

  const decoy = path.join(outside, "valid-catalog.json");
  fs.writeFileSync(
    decoy,
    JSON.stringify({ schemaVersion: 1, endpoints: [], profiles: [], bindings: [] }),
    "utf8",
  );

  withHook(t, "beforeCatalogClose", () => {
    fs.rmSync(result.catalogPath);
    fs.copyFileSync(decoy, result.catalogPath);
  });

  await assertErrorCode(() => store.validateNamespace(root), "ERR_STORE_CATALOG_INVALID");
});
