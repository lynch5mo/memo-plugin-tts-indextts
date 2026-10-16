"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readCatalog,
  validateCatalogData,
  resolveBinding,
  MAX_CATALOG_BYTES,
  __testHooks,
} = require("../src/catalog.js");
const { encodeVoiceValue } = require("../src/voice-value.js");
const {
  makeCatalog,
  makeAudio8Endpoint,
  makeGptSovitsEndpoint,
  makeSavedProfile,
  makeAudio8Binding,
  makeGptSovitsBinding,
  AUDIO8_VOICE_FINGERPRINT,
  nestedProtoMetadata,
  makeTempDir,
  writeCatalogFile,
} = require("./helpers/catalog-fixture.js");

function assertErrorCode(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
      return true;
    },
  );
}

// 每个用例自建隔离目录，不触碰主人真实的资料目录。
function withCatalog(catalog, run) {
  const dir = makeTempDir();
  const filePath = writeCatalogFile(dir, catalog);
  try {
    run({ dir, filePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readFrom(catalog) {
  const dir = makeTempDir();
  const filePath = writeCatalogFile(dir, catalog);
  try {
    return readCatalog(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readCatalog 读取合法目录并保留既定字段", () => {
  const catalog = readFrom(makeCatalog());

  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.endpoints.length, 2);
  assert.equal(catalog.profiles.length, 1);
  assert.equal(catalog.bindings.length, 2);

  const audio8 = catalog.bindings.find((binding) => binding.backendId === "audio8");
  assert.equal(audio8.nativeVoiceFingerprint, AUDIO8_VOICE_FINGERPRINT);
  assert.deepEqual(audio8.params, {}, "nativeVoiceFingerprint 不得混入 params");
  assert.equal(audio8.params.nativeVoiceFingerprint, undefined);
});

test("readCatalog 返回独立且冻结的副本，不随文件再变化", () => {
  withCatalog(makeCatalog(), ({ filePath }) => {
    const first = readCatalog(filePath);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.endpoints));
    assert.ok(Object.isFrozen(first.endpoints[0]));

    assert.throws(() => {
      first.bindings[0].revision = 999;
    }, TypeError);

    const second = readCatalog(filePath);
    assert.equal(second.bindings[0].revision, 1);
    assert.notEqual(first.bindings[0], second.bindings[0]);
  });
});

test("readCatalog 拒绝非字符串路径且不做任何写入", () => {
  assertErrorCode(() => readCatalog(undefined), "ERR_CATALOG_INPUT");
  assertErrorCode(() => readCatalog(""), "ERR_CATALOG_INPUT");
  assertErrorCode(() => readCatalog(42), "ERR_CATALOG_INPUT");
});

test("readCatalog 只读：文件缺失时失败且不自动初始化目录", () => {
  const dir = makeTempDir();
  try {
    const missing = path.join(dir, "catalog.json");
    assertErrorCode(() => readCatalog(missing), "ERR_CATALOG_READ");
    assert.deepEqual(fs.readdirSync(dir), [], "不得创建目录或文件");
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalog 拒绝目录与非法 JSON", () => {
  const dir = makeTempDir();
  try {
    assertErrorCode(() => readCatalog(dir), "ERR_CATALOG_READ");

    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{ not json", "utf8");
    assertErrorCode(() => readCatalog(broken), "ERR_CATALOG_JSON");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalog 拒绝逃出所在目录的符号链接", () => {
  const realDir = makeTempDir();
  const linkDir = makeTempDir();
  try {
    writeCatalogFile(realDir, makeCatalog(), "catalog.json");
    const escape = path.join(linkDir, "catalog.json");
    fs.symlinkSync(path.join(realDir, "catalog.json"), escape);

    assertErrorCode(() => readCatalog(escape), "ERR_CATALOG_BOUNDARY");
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});

test("readCatalog 允许指向同目录内文件的符号链接", () => {
  const dir = makeTempDir();
  try {
    const real = writeCatalogFile(dir, makeCatalog(), "real.json");
    const link = path.join(dir, "catalog.json");
    fs.symlinkSync(real, link);

    const catalog = readCatalog(link);
    assert.equal(catalog.schemaVersion, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalog 在分配/读取前拒绝超过 1MiB 的目录文件", () => {
  const dir = makeTempDir();
  try {
    const big = path.join(dir, "catalog.json");
    fs.writeFileSync(big, Buffer.alloc(MAX_CATALOG_BYTES + 1, 0x20));
    assertErrorCode(() => readCatalog(big), "ERR_CATALOG_TOO_LARGE");
    assert.equal(fs.statSync(big).size, MAX_CATALOG_BYTES + 1, "拒绝不得改写原文件");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalog 接受恰好 1MiB 的合法 JSON", () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, "catalog.json");
    const base = JSON.stringify(makeCatalog());
    const padded = base + " ".repeat(MAX_CATALOG_BYTES - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(padded), MAX_CATALOG_BYTES);
    fs.writeFileSync(target, padded, "utf8");

    const catalog = readCatalog(target);
    assert.equal(catalog.schemaVersion, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("读取途中增长超过上限时拒绝（经内部读取入口，确定性）", () => {
  const dir = makeTempDir();
  try {
    const target = writeCatalogFile(dir, makeCatalog());
    const fd = fs.openSync(target, "r");
    try {
      assertErrorCode(
        () =>
          __testHooks.readCatalogText(fd, {
            beforeRead: () => fs.appendFileSync(target, " ".repeat(MAX_CATALOG_BYTES + 1)),
          }),
        "ERR_CATALOG_TOO_LARGE",
      );
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("核验后文件被换成其他 inode 时拒绝（经内部打开入口，确定性）", () => {
  const dir = makeTempDir();
  try {
    const target = writeCatalogFile(dir, makeCatalog(), "catalog.json");
    const other = writeCatalogFile(dir, makeCatalog(), "other.json");
    const staleIdentity = fs.statSync(other);
    assert.notEqual(staleIdentity.ino, fs.statSync(target).ino, "两个不同文件应具有不同 inode");

    assertErrorCode(() => {
      const fd = __testHooks.openCatalogFile(target, staleIdentity);
      fs.closeSync(fd);
    }, "ERR_CATALOG_READ");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("核验后文件被换成外链符号链接时拒绝（经内部打开入口，确定性）", (t) => {
  if (fs.constants.O_NOFOLLOW === undefined) {
    t.skip("当前平台不支持 O_NOFOLLOW");
    return;
  }
  const inside = makeTempDir();
  const outside = makeTempDir();
  try {
    const payload = writeCatalogFile(outside, makeCatalog(), "real.json");
    const link = path.join(inside, "catalog.json");
    fs.symlinkSync(payload, link);
    const identity = fs.statSync(payload);

    assertErrorCode(() => {
      const fd = __testHooks.openCatalogFile(link, identity);
      fs.closeSync(fd);
    }, "ERR_CATALOG_BOUNDARY");
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("readCatalog 校验 schemaVersion 与顶层结构", () => {
  for (const schemaVersion of [undefined, 2, "1", null, 1.0 + 0.5]) {
    assertErrorCode(() => readFrom(makeCatalog({ schemaVersion })), "ERR_CATALOG_SCHEMA");
  }
  for (const broken of [null, [], "catalog", 7]) {
    withCatalog(broken, ({ filePath }) => {
      assertErrorCode(() => readCatalog(filePath), "ERR_CATALOG_SCHEMA");
    });
  }
  for (const key of ["endpoints", "profiles", "bindings"]) {
    assertErrorCode(
      () => readFrom(makeCatalog({ [key]: undefined })),
      "ERR_CATALOG_SCHEMA",
    );
    assertErrorCode(() => readFrom(makeCatalog({ [key]: {} })), "ERR_CATALOG_SCHEMA");
  }
});

test("readCatalog 检测重复 ID", () => {
  assertErrorCode(
    () => readFrom(makeCatalog({ endpoints: [makeAudio8Endpoint(), makeAudio8Endpoint()] })),
    "ERR_CATALOG_DUPLICATE",
  );
  assertErrorCode(
    () => readFrom(makeCatalog({ profiles: [makeSavedProfile(), makeSavedProfile()] })),
    "ERR_CATALOG_DUPLICATE",
  );
  assertErrorCode(
    () => readFrom(makeCatalog({ bindings: [makeAudio8Binding(), makeAudio8Binding()] })),
    "ERR_CATALOG_DUPLICATE",
  );
});

test("readCatalog 拒绝不合法 endpoint", () => {
  const invalidEndpoints = [
    makeAudio8Endpoint({ id: "" }),
    makeAudio8Endpoint({ id: 5 }),
    makeAudio8Endpoint({ backendId: "unknown-backend" }),
    makeAudio8Endpoint({ baseUrl: "ftp://127.0.0.1:8800" }),
    makeAudio8Endpoint({ baseUrl: "http://user:pass@127.0.0.1:8800" }),
    makeAudio8Endpoint({ baseUrl: "not a url" }),
    makeAudio8Endpoint({ modelFingerprint: "" }),
    makeAudio8Endpoint({ readiness: "raedy" }),
    makeAudio8Endpoint({ voicesRoot: "relative/voices" }),
    makeAudio8Endpoint({ runtimeManifestPath: undefined }),
  ];
  for (const endpoint of invalidEndpoints) {
    assertErrorCode(
      () => readFrom(makeCatalog({ endpoints: [endpoint], bindings: [makeAudio8Binding()] })),
      "ERR_CATALOG_ENDPOINT",
    );
  }
});

test("readCatalog 拒绝不合法 profile", () => {
  const invalidProfiles = [
    makeSavedProfile({ id: "" }),
    makeSavedProfile({ persistence: "ephemeral" }),
    makeSavedProfile({ owner: "" }),
    makeSavedProfile({ source: "refs/lin.wav" }),
    makeSavedProfile({ source: { audioPath: "relative/lin.wav" } }),
  ];
  for (const profile of invalidProfiles) {
    assertErrorCode(
      () => readFrom(makeCatalog({ profiles: [profile] })),
      "ERR_CATALOG_PROFILE",
    );
  }
});

test("external 资料允许缺少 source，且不伪造可迁移声明", () => {
  const catalog = readFrom(
    makeCatalog({
      profiles: [
        makeSavedProfile({ id: "profile-ext", persistence: "external", source: undefined }),
      ],
      bindings: [makeAudio8Binding({ id: "binding-ext", profileId: "profile-ext" })],
    }),
  );

  const profile = catalog.profiles[0];
  assert.equal(profile.persistence, "external");
  assert.equal(profile.source, undefined);
  assert.equal(profile.migratable, undefined, "不得虚构可迁移标志");
});

test("readCatalog 保留嵌套 __proto__ 自有业务键且不改动原型", () => {
  const base = makeCatalog();
  base.endpoints[0].metadata = nestedProtoMetadata();
  const catalog = readFrom(base);

  const metadata = catalog.endpoints[0].metadata;
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype, "嵌套对象原型必须保持不变");
  assert.ok(
    Object.prototype.hasOwnProperty.call(metadata, "__proto__"),
    "合法的 __proto__ 自有键必须保留而不是被删除",
  );
  assert.equal(metadata["__proto__"].kept, "yes");
  assert.equal({}.kept, undefined, "不得污染全局原型");
});

test("readCatalog 检测缺失引用", () => {
  assertErrorCode(
    () => readFrom(makeCatalog({ bindings: [makeAudio8Binding({ profileId: "ghost" })] })),
    "ERR_CATALOG_REFERENCE",
  );
  assertErrorCode(
    () => readFrom(makeCatalog({ bindings: [makeAudio8Binding({ endpointId: "ghost" })] })),
    "ERR_CATALOG_REFERENCE",
  );
});

test("readCatalog 检测后端与模型指纹冲突", () => {
  assertErrorCode(
    () =>
      readFrom(
        makeCatalog({
          bindings: [makeAudio8Binding({ backendId: "gpt-sovits" })],
        }),
      ),
    "ERR_CATALOG_CONFLICT",
  );
  assertErrorCode(
    () =>
      readFrom(
        makeCatalog({
          bindings: [makeAudio8Binding({ modelFingerprint: "fp-drifted" })],
        }),
      ),
    "ERR_CATALOG_CONFLICT",
  );
});

test("readCatalog 拒绝不合法 binding", () => {
  const invalidBindings = [
    makeAudio8Binding({ id: "" }),
    makeAudio8Binding({ status: "maybe" }),
    makeAudio8Binding({ revision: 0 }),
    makeAudio8Binding({ revision: 1.5 }),
    makeAudio8Binding({ params: [] }),
    makeAudio8Binding({ params: "speed" }),
    makeAudio8Binding({ nativeVoiceFingerprint: undefined }),
    makeAudio8Binding({ nativeVoiceFingerprint: "  " }),
    makeAudio8Binding({ params: { nativeVoiceFingerprint: "nvf-lin-001" } }),
  ];
  for (const binding of invalidBindings) {
    assertErrorCode(
      () => readFrom(makeCatalog({ bindings: [binding] })),
      "ERR_CATALOG_BINDING",
    );
  }
});

test("ready 的 Audio8 绑定必须携带有效 SHA-256 nativeVoiceFingerprint", () => {
  for (const fingerprint of [
    undefined,
    "",
    "nvf-lin-001",
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    `${"a".repeat(63)} `,
  ]) {
    assertErrorCode(
      () =>
        readFrom(makeCatalog({ bindings: [makeAudio8Binding({ nativeVoiceFingerprint: fingerprint })] })),
      "ERR_CATALOG_BINDING",
    );
  }
});

test("非 ready 的 Audio8 绑定可缺指纹，提供时仍须是有效 SHA-256", () => {
  const missing = readFrom(
    makeCatalog({
      bindings: [makeAudio8Binding({ status: "unverified", nativeVoiceFingerprint: undefined })],
    }),
  );
  assert.equal(missing.bindings[0].nativeVoiceFingerprint, undefined);

  const provided = readFrom(
    makeCatalog({ bindings: [makeAudio8Binding({ status: "needsPreparation" })] }),
  );
  assert.equal(provided.bindings[0].nativeVoiceFingerprint, AUDIO8_VOICE_FINGERPRINT);

  assertErrorCode(
    () =>
      readFrom(
        makeCatalog({
          bindings: [makeAudio8Binding({ status: "unverified", nativeVoiceFingerprint: "short" })],
        }),
      ),
    "ERR_CATALOG_BINDING",
  );
});

test("binding params 不得包含身份字段，业务参数照常保留", () => {
  for (const key of ["backendId", "endpointId", "bindingId", "revision", "nativeVoiceFingerprint"]) {
    assertErrorCode(
      () => readFrom(makeCatalog({ bindings: [makeAudio8Binding({ params: { [key]: "x" } })] })),
      "ERR_CATALOG_BINDING",
    );
  }

  const catalog = readFrom(
    makeCatalog({ bindings: [makeAudio8Binding({ params: { temperature: 0.7 } })] }),
  );
  assert.equal(catalog.bindings[0].params.temperature, 0.7);
});

test("binding revision 必须是正安全整数", () => {
  assertErrorCode(
    () => readFrom(makeCatalog({ bindings: [makeAudio8Binding({ revision: Number.MAX_SAFE_INTEGER + 1 })] })),
    "ERR_CATALOG_BINDING",
  );
  assertErrorCode(
    () => readFrom(makeCatalog({ bindings: [makeAudio8Binding({ revision: 1e21 })] })),
    "ERR_CATALOG_BINDING",
  );

  const catalog = readFrom(
    makeCatalog({ bindings: [makeAudio8Binding({ revision: Number.MAX_SAFE_INTEGER })] }),
  );
  assert.equal(catalog.bindings[0].revision, Number.MAX_SAFE_INTEGER);
});

test("resolveBinding 返回固定的 endpoint/profile/binding 快照", () => {
  const catalog = readFrom(makeCatalog());
  const voiceValue = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  const snapshot = resolveBinding(catalog, "audio8", voiceValue);

  assert.equal(snapshot.endpoint.id, "ep-audio8");
  assert.equal(snapshot.profile.id, "profile-lin");
  assert.equal(snapshot.binding.id, "binding-lin-audio8");
  assert.equal(snapshot.endpoint.readiness, "ready", "不得把目录就绪度改写成其它结论");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.endpoint));
  assert.ok(Object.isFrozen(snapshot.binding));
});

test("resolveBinding 快照不随调用后的原目录对象变化", () => {
  const catalog = JSON.parse(JSON.stringify(makeCatalog()));
  const voiceValue = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  const snapshot = resolveBinding(catalog, "audio8", voiceValue);

  catalog.endpoints[0].baseUrl = "http://127.0.0.1:1";
  catalog.endpoints[0].readiness = "invalid";
  catalog.bindings[0].nativeVoiceId = "changed";
  catalog.bindings[0].params.speed = 1;

  assert.equal(snapshot.endpoint.baseUrl, "http://127.0.0.1:8799");
  assert.equal(snapshot.endpoint.readiness, "ready");
  assert.equal(snapshot.binding.nativeVoiceId, "lin");
  assert.deepEqual(snapshot.binding.params, {});
});

test("resolveBinding 快照保留嵌套 __proto__ 且不改动原型", () => {
  const catalog = makeCatalog();
  catalog.endpoints[0].metadata = nestedProtoMetadata();
  const voiceValue = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  const snapshot = resolveBinding(catalog, "audio8", voiceValue);

  const metadata = snapshot.endpoint.metadata;
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype, "嵌套对象原型必须保持不变");
  assert.ok(
    Object.prototype.hasOwnProperty.call(metadata, "__proto__"),
    "合法的 __proto__ 自有键必须保留而不是被删除",
  );
  assert.equal(metadata["__proto__"].kept, "yes");
  assert.equal(Object.getPrototypeOf(snapshot.endpoint), Object.prototype);
  assert.equal({}.kept, undefined, "不得污染全局原型");
});

test("resolveBinding 拒绝非法 model 与错后端", () => {
  const catalog = readFrom(makeCatalog());
  const audio8Value = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  assertErrorCode(() => resolveBinding(catalog, "bogus", audio8Value), "ERR_BINDING_MODEL");
  assertErrorCode(() => resolveBinding(catalog, "gpt-sovits", audio8Value), "ERR_BINDING_BACKEND_MISMATCH");
});

test("resolveBinding 拒绝缺失绑定、旧 revision 与 endpoint 不匹配", () => {
  const catalog = readFrom(makeCatalog());

  assertErrorCode(
    () =>
      resolveBinding(
        catalog,
        "audio8",
        encodeVoiceValue({
          backendId: "audio8",
          endpointId: "ep-audio8",
          bindingId: "ghost",
          revision: 1,
        }),
      ),
    "ERR_BINDING_MISSING",
  );

  assertErrorCode(
    () =>
      resolveBinding(
        catalog,
        "audio8",
        encodeVoiceValue({
          backendId: "audio8",
          endpointId: "ep-audio8",
          bindingId: "binding-lin-audio8",
          revision: 2,
        }),
      ),
    "ERR_BINDING_REVISION",
  );

  assertErrorCode(
    () =>
      resolveBinding(
        catalog,
        "audio8",
        encodeVoiceValue({
          backendId: "audio8",
          endpointId: "ep-other",
          bindingId: "binding-lin-audio8",
          revision: 1,
        }),
      ),
    "ERR_BINDING_ENDPOINT_MISMATCH",
  );
});

test("resolveBinding 拒绝不就绪的绑定与 endpoint", () => {
  const value = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  for (const status of ["unverified", "invalid", "needsPreparation"]) {
    const catalog = readFrom(makeCatalog({ bindings: [makeAudio8Binding({ status })] }));
    assertErrorCode(() => resolveBinding(catalog, "audio8", value), "ERR_BINDING_NOT_READY");
  }

  const unreadyEndpoint = readFrom(
    makeCatalog({
      endpoints: [makeAudio8Endpoint({ readiness: "unverified" })],
      bindings: [makeAudio8Binding()],
    }),
  );
  assertErrorCode(() => resolveBinding(unreadyEndpoint, "audio8", value), "ERR_ENDPOINT_NOT_READY");
});

test("resolveBinding 检测指纹冲突（即使绕过 readCatalog 直接传入）", () => {
  const catalog = JSON.parse(JSON.stringify(makeCatalog()));
  catalog.bindings[0].modelFingerprint = "fp-drifted";
  const value = encodeVoiceValue({
    backendId: "audio8",
    endpointId: "ep-audio8",
    bindingId: "binding-lin-audio8",
    revision: 1,
  });

  assertErrorCode(() => resolveBinding(catalog, "audio8", value), "ERR_BINDING_FINGERPRINT");
});

test("resolveBinding 校验入参形状与 voiceValue", () => {
  const catalog = readFrom(makeCatalog());

  assertErrorCode(
    () => resolveBinding(null, "audio8", "localtts:v1:AAAA"),
    "ERR_CATALOG_SCHEMA",
  );
  assertErrorCode(
    () => resolveBinding(catalog, "audio8", "not-a-voice-value"),
    "ERR_VOICE_VALUE_PREFIX",
  );
});

test("resolveBinding 支持 gpt-sovits 绑定", () => {
  const catalog = readFrom(makeCatalog());
  const value = encodeVoiceValue({
    backendId: "gpt-sovits",
    endpointId: "ep-gptsovits",
    bindingId: "binding-lin-gptsovits",
    revision: 3,
  });

  const snapshot = resolveBinding(catalog, "gpt-sovits", value);
  assert.equal(snapshot.endpoint.backendId, "gpt-sovits");
  assert.equal(snapshot.binding.nativeVoiceId, "lin");
  assert.equal(snapshot.binding.params.speed_factor, 1);
});

// 4A1-fix2：管理数据层复用纯 schema 校验，避免复制目录规则或按路径重读。
test("validateCatalogData 对内存数据做纯校验，不读取任何路径", () => {
  const catalog = makeCatalog();
  const frozen = structuredClone(catalog);

  // 合法数据：对象不必落盘，校验只依赖入参本身，返回冻结的规范化副本。
  const result = validateCatalogData(frozen);
  assert.equal(result.schemaVersion, 1);
  assert.ok(Object.isFrozen(result), "返回的规范化副本应被冻结");
  assert.equal(result.bindings.length, catalog.bindings.length);

  // 缺字段 / 结构错误：与 readCatalog 同一套 schema 错误码。
  assertErrorCode(
    () => validateCatalogData({ ...structuredClone(catalog), schemaVersion: 2 }),
    "ERR_CATALOG_SCHEMA",
  );
  assertErrorCode(
    () => validateCatalogData({ ...structuredClone(catalog), bindings: "not-array" }),
    "ERR_CATALOG_SCHEMA",
  );

  // 引用冲突仍由同一纯函数检出，证明它没有退化成只做浅层类型检查。
  const broken = structuredClone(catalog);
  broken.bindings[0].endpointId = "ep-missing";
  assertErrorCode(() => validateCatalogData(broken), "ERR_CATALOG_REFERENCE");
});

test("validateCatalogData 不改变入参、不写盘", () => {
  const dir = makeTempDir();
  try {
    const catalog = makeCatalog();
    const before = JSON.stringify(catalog);
    validateCatalogData(catalog);
    assert.equal(JSON.stringify(catalog), before, "纯校验不得修改入参对象");
    assert.deepEqual(fs.readdirSync(dir), [], "纯校验不得产生任何文件写入");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 4A1-fix3：validateCatalogData 必须是严格纯净函数，不得冻结或改写入参共享的嵌套对象。
test("validateCatalogData 深拷贝入参：输入保持可写，输出独立且冻结（fix3）", () => {
  const endpointMeta = { note: "keep" };
  const sourceMeta = { tag: { value: "s1" } };
  const paramValue = { nested: { x: 1 } };
  const catalog = makeCatalog({
    endpoints: [makeAudio8Endpoint({ metadata: endpointMeta }), makeGptSovitsEndpoint()],
    profiles: [
      makeSavedProfile({ source: { ...makeSavedProfile().source, meta: sourceMeta } }),
    ],
    bindings: [
      makeAudio8Binding({ params: { tuning: paramValue } }),
      makeGptSovitsBinding(),
    ],
  });

  const result = validateCatalogData(catalog);

  // 输入本体及所有嵌套对象都没有被冻结、保持可写。
  assert.equal(Object.isFrozen(catalog), false);
  assert.equal(Object.isFrozen(endpointMeta), false);
  assert.equal(Object.isFrozen(sourceMeta), false);
  assert.equal(Object.isFrozen(sourceMeta.tag), false);
  assert.equal(Object.isFrozen(paramValue), false);

  // 输出深冻结，且与输入不共享任何嵌套引用。
  assert.ok(Object.isFrozen(result), "输出根应冻结");
  assert.ok(Object.isFrozen(result.endpoints[0].metadata), "输出嵌套也应冻结");
  assert.ok(Object.isFrozen(result.profiles[0].source.meta.tag), "输出深层嵌套应冻结");
  assert.notEqual(result.endpoints[0].metadata, endpointMeta, "不得共享 metadata 引用");
  assert.notEqual(result.profiles[0].source.meta, sourceMeta, "不得共享 source 嵌套引用");
  assert.notEqual(result.bindings[0].params.tuning, paramValue, "不得共享 params 嵌套引用");

  // 调用后修改输入，输出保持不变。
  endpointMeta.note = "mutated";
  sourceMeta.tag.value = "s2";
  paramValue.nested.x = 2;
  assert.equal(result.endpoints[0].metadata.note, "keep");
  assert.equal(result.profiles[0].source.meta.tag.value, "s1");
  assert.equal(result.bindings[0].params.tuning.nested.x, 1);
  assert.equal(catalog.endpoints[0].metadata.note, "mutated", "输入本身仍可写");
});

test("validateCatalogData 保留嵌套 __proto__ 自有键且不改原型（fix3）", () => {
  const metadata = nestedProtoMetadata();
  const catalog = makeCatalog({
    endpoints: [makeAudio8Endpoint({ metadata }), makeGptSovitsEndpoint()],
  });

  const result = validateCatalogData(catalog);
  const outMeta = result.endpoints[0].metadata;

  assert.equal(Object.getPrototypeOf(outMeta), Object.prototype, "输出原型不得被篡改");
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype, "输入原型不得被篡改");
  assert.equal(Object.prototype.hasOwnProperty.call(outMeta, "__proto__"), true, "自有键必须保留");
  assert.deepEqual(outMeta.__proto__, { kept: "yes" });
  assert.equal(Object.getOwnPropertyDescriptor(outMeta, "__proto__").value.kept, "yes");
});
