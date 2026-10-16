"use strict";

// 4A1 数据层：自有 namespace 的显式初始化与归属校验。
// 写权限依据是 initialize 建立的根、固定自有目录、完整记录与真实路径归属，不是 owner 字符串。
// owner.json 只是防误认领的本机完整性记录，不抵御同一操作系统用户的恶意伪造。
// 读取走 fd 加 O_NOFOLLOW 加 fstat(dev/ino) 加有界读取；父目录中间组件竞态仍为已知残余。

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { validateCatalogData } = require("../src/catalog.js");
// 4A4 只读导入：复用已验收 Audio8 probe/listVoices/voiceFingerprint，不新增后端调用面。
const audio8 = require("../src/backends/audio8.js");
const { request } = require("../src/http-client.js");

const OWNER_FILE = "owner.json";
const CATALOG_FILE = "catalog.json";
const STORE_KIND = "memo-local-tts-managed";
const STORE_SCHEMA_VERSION = 1;
const MAX_OWNER_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const SUBDIRS = Object.freeze(["sources", "voices", "derived", "operations"]);
const KNOWN_ENTRIES = Object.freeze([OWNER_FILE, CATALOG_FILE, ...SUBDIRS]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 4A2 目录事务：自有 operations/ 下的固定排他锁与根目录同目录临时文件。
const LOCK_FILE = ".catalog.lock";
const LOCK_KIND = "memo-local-tts-catalog-lock";
const LOCK_SCHEMA_VERSION = 1;
const TEMP_PREFIX = ".catalog.tmp-";
// 4A3 临时音色生命周期：自有目录内的最小不可变归属记录与前缀有界读取上限。
const OWNERSHIP_SCHEMA_VERSION = 1;
const SOURCE_RECORD_KIND = "memo-local-tts-source";
const OPERATION_RECORD_KIND = "memo-local-tts-voice-operation";
const MAX_OWNERSHIP_RECORD_BYTES = 16 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const AUDIO_HASH_CHUNK = 64 * 1024;
// 4A4 导入：label 安全长度上限与外部 meta.json 有界读取上限。
const MAX_LABEL_CHARS = 200;
const MAX_VOICE_META_BYTES = 64 * 1024;
// 4A5 新音色准备：multipart 注册契约与有界超时。
const PREPARE_ATTEMPT_KIND = "memo-local-tts-prepare-attempt";
const PREPARE_REGISTER_PATH = "/api/voices/register";
const PREPARE_AUDIO_FILE_NAME = "reference.audio";
const MAX_REFERENCE_TEXT_CHARS = 4096;
const DEFAULT_REGISTER_TIMEOUT_MS = 60000;
const MAX_REGISTER_TIMEOUT_MS = 120000;
const MAX_REGISTER_RESPONSE_BYTES = 1024 * 1024;
const LANGUAGE_PATTERN = /^[a-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
// referenceText 允许常见文本空白（TAB、LF、CRLF、CR 等；安装端按 " ".join(text.strip().split()) 归一），
// 但仍拒绝 \u0000-\u0008、\u000e-\u001f 与 DEL/C1 等非文本控制字符。
const REFERENCE_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/;

// 仅供测试注入竞态时序；生产路径不使用。发布打包器会剥离该属性。
const raceHook = {
  afterRootLstat: null,
  afterOwnerLstat: null,
  beforeOwnerRead: null,
  afterSubdirLstat: null,
  afterCatalogLstat: null,
  beforeCatalogRead: null,
  beforeCatalogClose: null,
  afterCreateFiles: null,
  afterLockAcquire: null,
  beforeCommitCheck: null,
  beforeRename: null,
  beforeTempWrite: null,
  beforeTempFsync: null,
};

function fire(name) {
  const hook = raceHook[name];
  if (typeof hook === "function") {
    hook();
  }
}

function createError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
}

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const DIRECTORY = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;

// 以 fd 打开目录：末段禁用符号链接，fstat 确认是目录并返回 dev/ino 作为身份绑定依据。
function openVerifiedDirectory(target, codeSymlink, codeNotDirectory) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    // macOS 上 O_NOFOLLOW 加 O_DIRECTORY 打开符号链接可能返回 ELOOP 或 ENOTDIR，
    // 因此以 lstat 结论判定，避免把"末段是链接"误报成"不是目录"。
    let current = null;
    try {
      current = fs.lstatSync(target);
    } catch {
      current = null;
    }
    if ((error && error.code === "ELOOP") || (current && current.isSymbolicLink())) {
      throw createError(codeSymlink, `${target} 的末段组件是符号链接，按策略拒绝。`, {
        cause: error,
      });
    }
    if (error && error.code === "ENOTDIR") {
      throw createError(codeNotDirectory, `${target} 不是目录。`, { cause: error });
    }
    throw error;
  }

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isDirectory()) {
      throw createError(codeNotDirectory, `${target} 不是目录。`);
    }
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    fs.closeSync(fd);
  }
}

// 路径身份复核：末段不得是符号链接，且 dev/ino 必须仍与已核验身份一致。
function assertPathIdentity(target, identity, code) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    throw createError(code, `${target} 已不可访问。`, { cause: error });
  }
  if (stats.isSymbolicLink() || stats.dev !== identity.dev || stats.ino !== identity.ino) {
    throw createError(code, `${target} 在校验后已被替换，按策略拒绝。`);
  }
}

// 有界读取：上限加一按位置读取，读取期间增长导致超限即拒绝。
function readBoundedFd(fd, maxBytes, code) {
  const cap = maxBytes + 1;
  const buffer = Buffer.allocUnsafe(cap);
  let offset = 0;
  while (offset < cap) {
    const bytesRead = fs.readSync(fd, buffer, offset, cap - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw createError(code, `内容超过上限 ${maxBytes} 字节，已在读取过程中停止。`);
  }
  return buffer.toString("utf8", 0, offset);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function resolveRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw createError("ERR_STORE_ROOT_MISSING", "root 必须是非空字符串路径。");
  }

  let stats;
  try {
    stats = fs.lstatSync(root);
  } catch {
    throw createError("ERR_STORE_ROOT_MISSING", `资料根不存在：${root}`);
  }
  if (stats.isSymbolicLink()) {
    throw createError("ERR_STORE_ROOT_SYMLINK", `资料根不能是符号链接：${root}`);
  }
  if (!stats.isDirectory()) {
    throw createError("ERR_STORE_ROOT_MISSING", `资料根不是目录：${root}`);
  }

  fire("afterRootLstat");

  const identity = openVerifiedDirectory(root, "ERR_STORE_ROOT_SYMLINK", "ERR_STORE_ROOT_MISSING");
  assertPathIdentity(root, identity, "ERR_STORE_ROOT_SYMLINK");

  return { realRoot: fs.realpathSync(root), identity };
}

function namespacePaths(realRoot) {
  return {
    root: realRoot,
    catalogPath: path.join(realRoot, CATALOG_FILE),
    sourcesRoot: path.join(realRoot, "sources"),
    voicesRoot: path.join(realRoot, "voices"),
    derivedRoot: path.join(realRoot, "derived"),
    operationsRoot: path.join(realRoot, "operations"),
  };
}

function readOwner(realRoot) {
  const ownerPath = path.join(realRoot, OWNER_FILE);

  let stats;
  try {
    stats = fs.lstatSync(ownerPath);
  } catch {
    throw createError("ERR_STORE_INCOMPLETE", `缺少 ${OWNER_FILE}，不自动补齐。`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 必须是真实普通文件，不能是链接。`);
  }
  if (stats.size > MAX_OWNER_BYTES) {
    throw createError(
      "ERR_STORE_OWNER_TOO_LARGE",
      `${OWNER_FILE} 超过上限 ${MAX_OWNER_BYTES} 字节。`,
    );
  }

  fire("afterOwnerLstat");

  let fd;
  try {
    fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ELOOP") {
      throw createError(
        "ERR_STORE_OWNER_INVALID",
        `${OWNER_FILE} 的末段组件是符号链接，按策略拒绝。`,
        { cause: error },
      );
    }
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 无法打开。`, { cause: error });
  }

  let text;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 不是普通文件。`);
    }
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw createError(
        "ERR_STORE_OWNER_INVALID",
        `${OWNER_FILE} 在校验后已被替换为另一个文件，按策略拒绝。`,
      );
    }
    if (opened.size > MAX_OWNER_BYTES) {
      throw createError(
        "ERR_STORE_OWNER_TOO_LARGE",
        `${OWNER_FILE} 超过上限 ${MAX_OWNER_BYTES} 字节。`,
      );
    }

    fire("beforeOwnerRead");

    text = readBoundedFd(fd, MAX_OWNER_BYTES, "ERR_STORE_OWNER_TOO_LARGE");

    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size > MAX_OWNER_BYTES) {
      throw createError(
        "ERR_STORE_OWNER_TOO_LARGE",
        `${OWNER_FILE} 在读取期间发生变化，按策略拒绝。`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 不是合法 JSON。`);
  }
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 必须是 JSON 对象。`);
  }
  if (owner.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 的 schemaVersion 不受支持。`);
  }
  if (owner.kind !== STORE_KIND) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 的 kind 不匹配。`);
  }
  if (typeof owner.namespaceId !== "string" || !UUID_PATTERN.test(owner.namespaceId)) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 的 namespaceId 不是随机 UUID。`);
  }
  if (typeof owner.createdAt !== "string" || Number.isNaN(Date.parse(owner.createdAt))) {
    throw createError("ERR_STORE_OWNER_INVALID", `${OWNER_FILE} 的 createdAt 不是合法时间。`);
  }
  if (owner.rootRealPath !== realRoot) {
    throw createError(
      "ERR_STORE_OWNER_MISMATCH",
      `${OWNER_FILE} 记录的 rootRealPath 与当前真实根不一致。`,
    );
  }
  return owner;
}

function assertSubdirs(realRoot) {
  for (const name of SUBDIRS) {
    const target = path.join(realRoot, name);
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch {
      throw createError("ERR_STORE_INCOMPLETE", `缺少自有子目录 ${name}，不自动补齐。`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw createError("ERR_STORE_SUBDIR_INVALID", `自有子目录 ${name} 必须是真实目录。`);
    }

    fire("afterSubdirLstat");

    const identity = openVerifiedDirectory(
      target,
      "ERR_STORE_SUBDIR_INVALID",
      "ERR_STORE_SUBDIR_INVALID",
    );
    assertPathIdentity(target, identity, "ERR_STORE_SUBDIR_INVALID");
    if (fs.realpathSync(target) !== target) {
      throw createError("ERR_STORE_SUBDIR_INVALID", `自有子目录 ${name} 的真实路径不属于当前根。`);
    }
  }
}

// catalog 的末段链接由 store 显式拒绝；同父目录链接的允许规则仍归现有 readCatalog。
// 关闭与返回前按路径再复核：末段不得为链接或非普通文件，dev/ino 必须与已核验 fd 一致。
// 这是缩小窗口，不消除父目录中间组件换名竞态；Node 没有 openat，无法宣称绝对消除 TOCTOU。
function assertCatalogPathIdentity(catalogPath, opened) {
  let stats;
  try {
    stats = fs.lstatSync(catalogPath);
  } catch (error) {
    throw createError("ERR_STORE_CATALOG_INVALID", "catalog.json 在读取后无法复核路径身份。", {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createError(
      "ERR_STORE_CATALOG_INVALID",
      "catalog.json 读取后已变成链接或非普通文件，按策略拒绝。",
    );
  }
  if (stats.dev !== opened.dev || stats.ino !== opened.ino) {
    throw createError(
      "ERR_STORE_CATALOG_INVALID",
      "catalog.json 在读取后被替换为另一个文件，按策略拒绝。",
    );
  }
}

// 同 fd 目录快照读取：lstat 拒链接/非常规，O_NOFOLLOW 打开，fstat 复核 dev/ino 与尺寸，
// 有界读取防增长，解析后用共享纯校验，关闭前后各按路径复核一次。返回快照与提交前比对所需身份。
function readCatalogSnapshot(catalogPath) {
  let stats;
  try {
    stats = fs.lstatSync(catalogPath);
  } catch (error) {
    throw createError("ERR_STORE_INCOMPLETE", "缺少 catalog.json，不自动补齐。", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createError("ERR_STORE_CATALOG_INVALID", "catalog.json 必须是真实普通文件，不能是链接。");
  }

  fire("afterCatalogLstat");

  let fd;
  try {
    fd = fs.openSync(catalogPath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    throw createError("ERR_STORE_CATALOG_INVALID", "catalog.json 无法按末段无链接方式打开。", {
      cause: error,
    });
  }

  let opened;
  let text;
  let parsed;
  let snapshot;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_STORE_CATALOG_INVALID", "catalog.json 不是普通文件。");
    }
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw createError(
        "ERR_STORE_CATALOG_INVALID",
        "catalog.json 在校验后已被替换为另一个文件，按策略拒绝。",
      );
    }
    if (opened.size > MAX_CATALOG_BYTES) {
      throw createError(
        "ERR_STORE_CATALOG_INVALID",
        `catalog.json 超过上限 ${MAX_CATALOG_BYTES} 字节。`,
      );
    }

    fire("beforeCatalogRead");

    text = readBoundedFd(fd, MAX_CATALOG_BYTES, "ERR_STORE_CATALOG_INVALID");

    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size > MAX_CATALOG_BYTES) {
      throw createError(
        "ERR_STORE_CATALOG_INVALID",
        "catalog.json 在读取期间发生变化，按策略拒绝。",
      );
    }

    try {
      parsed = JSON.parse(text);
    } catch {
      throw createError("ERR_STORE_CATALOG_INVALID", "catalog.json 不是合法 JSON。");
    }
    try {
      // 解析同 fd 内容后复用共享的纯 schema 校验，绝不按路径重读。
      snapshot = validateCatalogData(parsed);
    } catch (error) {
      throw createError(
        "ERR_STORE_CATALOG_INVALID",
        `catalog.json 无法通过目录校验：${error.message}`,
        { cause: error },
      );
    }

    // 关闭前按路径复核一次；关闭后再复核一次，闭合“读完到关闭”之间被替换的窗口。
    assertCatalogPathIdentity(catalogPath, opened);
    fire("beforeCatalogClose");
  } finally {
    fs.closeSync(fd);
  }

  assertCatalogPathIdentity(catalogPath, opened);

  return {
    snapshot,
    parsed,
    text,
    digest: sha256Hex(text),
    dev: opened.dev,
    ino: opened.ino,
    size: opened.size,
  };
}

// 只读消费：核验通过即丢弃快照，validateNamespace 复用的正是同一条 fd 读取路径。
function assertCatalog(catalogPath) {
  readCatalogSnapshot(catalogPath);
}

function classifyEntries(realRoot) {
  const entries = fs.readdirSync(realRoot).sort();
  const unknown = entries.filter((entry) => !KNOWN_ENTRIES.includes(entry));
  if (unknown.length > 0) {
    throw createError(
      "ERR_STORE_ROOT_NOT_EMPTY",
      `资料根含未知内容，拒绝认领：${unknown.join("、")}`,
      { unknownEntries: unknown },
    );
  }
  return entries;
}

function validateNamespaceSync(root) {
  const { realRoot, identity } = resolveRoot(root);
  const entries = classifyEntries(realRoot);

  if (entries.length === 0) {
    throw createError("ERR_STORE_INCOMPLETE", "资料根尚未初始化。");
  }

  const owner = readOwner(realRoot);
  if (!entries.includes(CATALOG_FILE)) {
    throw createError("ERR_STORE_INCOMPLETE", "缺少 catalog.json，不自动补齐。");
  }
  assertSubdirs(realRoot);
  assertCatalog(path.join(realRoot, CATALOG_FILE));

  assertPathIdentity(realRoot, identity, "ERR_STORE_ROOT_SYMLINK");

  return { ...namespacePaths(realRoot), namespaceId: owner.namespaceId };
}

// namespace 只读一致性策略（事务路径专用，不扩张到 validateNamespace/initialize）：
// 合作 writer 在持锁期间会在根目录创建 .catalog.tmp-*，而锁在 operations/ 下不参与根目录分类，
// 因此事务入口采用“早查锁 + 失败后针对性复核”三步，只处理已被证据证实的并发写入窗口：
//   1) 早查锁：已在持锁则立刻明确繁忙，不把合作方的临时文件当未知内容。
//   2) 复核：早查锁与 classifyEntries 之间仍可能有人入场（TOCTOU），
//      仅当此刻确实持锁、且全部未知条目都是本插件的提交临时文件时才改判繁忙。
//   3) 释放窗口：分类拿到的名字可能来自过期快照 —— 合作方此刻可能已经 rename 并释放锁。
//      此时只做一次只读根目录复核：若刚观测到的临时项都已消失，说明这是并发窗口而不是稳定残留，
//      改判繁忙且不重试写入、不返回成功、不删除任何文件；仍存在则保持拒绝。
// 无锁时的未知内容（外来文件、崩溃残留 temp）一律保持 ERR_STORE_ROOT_NOT_EMPTY；
// 不吞异常、不自动删除、不自动重试，也不把其它错误改判成繁忙。
function assertNotCooperatingWriterWindow(realRoot, error) {
  if (!error || error.code !== "ERR_STORE_ROOT_NOT_EMPTY") {
    return false;
  }
  const unknown = Array.isArray(error.unknownEntries) ? error.unknownEntries : null;
  if (!unknown || unknown.length === 0) {
    return false;
  }
  const isOwnCommitTemp = (name) => typeof name === "string" && name.startsWith(TEMP_PREFIX);
  if (!unknown.every(isOwnCommitTemp)) {
    return false;
  }
  if (lockPresent(realRoot)) {
    return true;
  }
  // 只读复核，绝不写入、覆盖或删除；复核本身失败时保持严格拒绝。
  let current;
  try {
    current = new Set(fs.readdirSync(realRoot));
  } catch {
    return false;
  }
  return unknown.every((name) => !current.has(name));
}

function precheckTransactionNamespace(root) {
  const { realRoot } = resolveRoot(root);
  if (lockPresent(realRoot)) {
    throw createError(
      "ERR_STORE_BUSY",
      "目录正被另一个事务修改，当前明确繁忙；不自动移除旧锁也不重试。",
    );
  }
  try {
    return validateNamespaceSync(root);
  } catch (error) {
    if (assertNotCooperatingWriterWindow(realRoot, error)) {
      throw createError(
        "ERR_STORE_BUSY",
        "目录正被另一个事务修改，当前明确繁忙；不自动移除旧锁也不重试。",
        { cause: error },
      );
    }
    throw error;
  }
}

function createNamespace(realRoot, identity) {
  const paths = namespacePaths(realRoot);

  for (const name of SUBDIRS) {
    try {
      fs.mkdirSync(path.join(realRoot, name), { recursive: false });
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw createError(
          "ERR_STORE_CONCURRENT",
          "初始化期间出现并发写入，未强行认领半成品。",
          { cause: error },
        );
      }
      throw error;
    }
  }

  const owner = {
    schemaVersion: STORE_SCHEMA_VERSION,
    kind: STORE_KIND,
    namespaceId: crypto.randomUUID(),
    rootRealPath: realRoot,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(realRoot, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.writeFileSync(
      paths.catalogPath,
      `${JSON.stringify(
        { schemaVersion: 1, endpoints: [], profiles: [], bindings: [] },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw createError(
        "ERR_STORE_CONCURRENT",
        "初始化期间出现并发写入，未强行认领半成品。",
        { cause: error },
      );
    }
    throw error;
  }

  fire("afterCreateFiles");

  // 初始化完成后立即用同一套校验复核最小根、固定子目录、owner 与 catalog。
  validateNamespaceSync(realRoot);

  return { ...paths, namespaceId: owner.namespaceId };
}

async function initialize(root) {
  const { realRoot, identity } = resolveRoot(root);
  const entries = classifyEntries(realRoot);

  if (entries.length === 0) {
    return createNamespace(realRoot, identity);
  }
  return validateNamespaceSync(root);
}

async function validateNamespace(root) {
  return validateNamespaceSync(root);
}

// 4A2 目录事务。锁是自有 operations/ 下的固定文件，只表示“有人正在写”，不是认证 token，
// 不输出敏感凭据；崩溃遗留锁与临时文件不自动认领或删除，交由人工处理。

function lockTarget(realRoot) {
  return path.join(realRoot, "operations", LOCK_FILE);
}

// 锁是否存在：末段是链接或普通文件都视为被占用（不跟随、不删除）。
function lockPresent(realRoot) {
  try {
    fs.lstatSync(lockTarget(realRoot));
    return true;
  } catch {
    return false;
  }
}

function acquireLock(realRoot, namespaceId) {
  const target = lockTarget(realRoot);
  const record = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    kind: LOCK_KIND,
    operationId: crypto.randomUUID(),
    namespaceId,
    rootRealPath: realRoot,
    createdAt: new Date().toISOString(),
  };

  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw createError(
        "ERR_STORE_BUSY",
        "目录正被另一个事务修改，当前明确繁忙；不自动移除旧锁也不重试。",
        { cause: error },
      );
    }
    throw createError("ERR_STORE_LOCK_INVALID", "无法创建排他锁文件。", { cause: error });
  }

  let opened;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_STORE_LOCK_INVALID", "锁文件不是普通文件。");
    }
    fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    removeOwnedFile(target, opened);
    throw error;
  }
  fs.closeSync(fd);

  return { target, dev: opened.dev, ino: opened.ino, operationId: record.operationId };
}

// 只清理“本次实际创建且身份一致”的文件：dev/ino 必须与打开时一致，否则不碰。
// 返回结构化状态而不是单一 false，避免“清理其实失败却声称无残留”。
function cleanupOwnedFile(target, identity) {
  if (!identity || typeof identity.dev !== "number" || typeof identity.ino !== "number") {
    return { target, status: "unknown-identity", ok: false, removed: false };
  }
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { target, status: "absent", ok: true, removed: false };
    }
    return { target, status: "inspect-failed", ok: false, removed: false, cause: error };
  }
  if (stats.dev !== identity.dev || stats.ino !== identity.ino) {
    // 身份不匹配：可能是别人替换的文件，绝不删除，如实报告。
    return { target, status: "identity-mismatch", ok: false, removed: false };
  }
  try {
    fs.unlinkSync(target);
    return { target, status: "removed", ok: true, removed: true };
  } catch (error) {
    return { target, status: "unlink-failed", ok: false, removed: false, cause: error };
  }
}

// 仅需布尔结果的调用点（锁创建失败时的尽力清理）保留薄封装。
function removeOwnedFile(target, identity) {
  const result = cleanupOwnedFile(target, identity);
  return result.removed;
}

// 只做身份观察、不删除：用于判断 rename 之后我们的文件是否仍在原处。
function inspectOwnedFile(target, identity) {
  if (!identity || typeof identity.dev !== "number" || typeof identity.ino !== "number") {
    return "unknown-identity";
  }
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "absent";
    }
    return "inspect-failed";
  }
  if (stats.dev !== identity.dev || stats.ino !== identity.ino) {
    return "foreign";
  }
  return "ours";
}
function writeTempCatalog(realRoot, text) {
  const target = path.join(realRoot, `${TEMP_PREFIX}${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw createError("ERR_STORE_TEMP_INVALID", "无法创建同目录临时文件。", { cause: error });
  }

  let opened;
  let stage = "write";
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError("ERR_STORE_TEMP_INVALID", "临时文件不是普通文件。");
    }

    // 用 Buffer 显式推进偏移：短写继续，0 写立即失败，避免“调用过 write 却没写全”。
    const buffer = Buffer.from(text, "utf8");
    fire("beforeTempWrite");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (typeof written !== "number" || written <= 0) {
        throw createError(
          "ERR_STORE_TEMP_WRITE",
          `临时文件写入未推进（offset=${offset}，written=${written}）。`,
        );
      }
      offset += written;
    }

    stage = "fsync";
    fire("beforeTempFsync");
    fs.fsyncSync(fd);
    // 目录 fsync：平台不支持时忽略，不改变已在文件层 fsync 的语义。
    try {
      const dirFd = fs.openSync(realRoot, fs.constants.O_RDONLY | DIRECTORY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // 目录 fsync 不可用不是致命错误。
    }
  } catch (error) {
    stage = error && error.code === "ERR_STORE_TEMP_WRITE" ? "write" : stage;
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    removeOwnedFile(target, opened);
    // 未 rename 之前失败都不构成提交；catalog 原字节不变。
    if (error && typeof error.code === "string" && error.code.startsWith("ERR_STORE_")) {
      throw error;
    }
    throw createError(
      stage === "fsync" ? "ERR_STORE_TEMP_FSYNC" : "ERR_STORE_TEMP_WRITE",
      stage === "fsync" ? "临时文件 fsync 未成功，未进入提交。" : "临时文件写入失败，未进入提交。",
      { cause: error },
    );
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    // 关闭失败也要保证本次临时文件可归属并可清理，然后报明确错误，不进入提交。
    removeOwnedFile(target, opened);
    throw createError("ERR_STORE_TEMP_CLOSE", "临时文件关闭失败，未进入提交。", { cause: error });
  }

  return { target, dev: opened.dev, ino: opened.ino };
}

// 深拷贝为可变草稿：只复制普通对象与数组，自有 __proto__ 键用数据属性写入，安全保留且不改原型。
function isDraftObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneDraft(value) {
  if (Array.isArray(value)) {
    return value.map(cloneDraft);
  }
  if (isDraftObject(value)) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: cloneDraft(item),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

// 只读目录快照：先整体核验 namespace，再检查事务锁；锁存在即明确繁忙，不返回正在修改的部分数据。
async function readManagedCatalog(root) {
  const paths = precheckTransactionNamespace(root);
  if (lockPresent(paths.root)) {
    throw createError(
      "ERR_STORE_BUSY",
      "目录正被另一个事务修改，读取明确繁忙；不返回可能处于修改中的数据。",
    );
  }
  return readCatalogSnapshot(paths.catalogPath).snapshot;
}

// 原子更新：可信本地 mutator 得到可变深拷贝草稿，可 async；不接受网页传入的代码。
// 阶段语义：rename 是提交点。rename 前失败 = notCommitted（只表示本次未提交，不代表外部文件没变）；
// rename 成功后读回/schema/清理失败 = committed 且不允许安全重试；rename 自身结果不明 = unknown。
async function updateCatalog(root, mutator) {
  if (typeof mutator !== "function") {
    throw createError("ERR_STORE_MUTATOR", "mutator 必须是可信本地调用方提供的函数。");
  }

  const initial = precheckTransactionNamespace(root);
  const realRoot = initial.root;
  const lock = acquireLock(realRoot, initial.namespaceId);
  let temp = null;
  let phase = "prepare";
  let commitState = "notCommitted";
  let committedSnapshot = null;
  let primaryError = null;
  let cleanup = null;

  try {
    fire("afterLockAcquire");

    // 持锁后重新核验 namespace 与最新 catalog，避免用锁前的陈旧状态覆盖外部更新。
    const verified = validateNamespaceSync(realRoot);
    const before = readCatalogSnapshot(verified.catalogPath);

    const draft = cloneDraft(before.parsed);
    await mutator(draft);

    let snapshot;
    try {
      snapshot = validateCatalogData(draft);
    } catch (error) {
      throw createError(
        "ERR_STORE_CATALOG_INVALID",
        `更新后的目录未通过校验：${error.message}`,
        { cause: error },
      );
    }
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
      throw createError(
        "ERR_STORE_CATALOG_TOO_LARGE",
        `更新后的 catalog.json 超过上限 ${MAX_CATALOG_BYTES} 字节。`,
      );
    }

    // 提交前重新核验根/固定目录/owner 身份，并检测未合作的外部改写（原字节摘要与 dev/ino）。
    fire("beforeCommitCheck");
    const reverified = validateNamespaceSync(realRoot);
    const current = readCatalogSnapshot(reverified.catalogPath);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.digest !== before.digest
    ) {
      throw createError(
        "ERR_STORE_CATALOG_CONFLICT",
        "catalog.json 在事务期间被外部改写，拒绝覆盖以避免丢失更新。",
      );
    }

    phase = "commit";
    temp = writeTempCatalog(realRoot, text);
    fire("beforeRename");
    try {
      fs.renameSync(temp.target, verified.catalogPath);
    } catch (renameError) {
      // 只观察不删除：临时文件仍在原处且身份一致 → rename 确实没发生替换，本次未提交；
      // 临时文件消失或身份变化 → 无法确定是否已替换，标为 unknown 且禁止自动重发。
      if (inspectOwnedFile(temp.target, temp) === "ours") {
        commitState = "notCommitted";
        throw createError(
          "ERR_STORE_RENAME_FAILED",
          "rename 未发生替换，本次未提交；仅表示本次未提交，不代表外部文件没有被改动。",
          { cause: renameError, commitState: "notCommitted", retrySafe: true },
        );
      }
      commitState = "unknown";
      throw createError(
        "ERR_STORE_COMMIT_UNKNOWN",
        "rename 未能确认是否完成替换，提交状态不明，禁止自动重发。",
        { cause: renameError, commitState: "unknown", retrySafe: false },
      );
    }

    // rename 已返回：提交点已越过，后续任何失败都不能再报成“未提交/可安全重试”。
    commitState = "committed";
    phase = "postCommit";
    try {
      // 提交后读回验证：确保落盘内容确实是通过共享校验的完整目录。
      committedSnapshot = readCatalogSnapshot(verified.catalogPath).snapshot;
    } catch (error) {
      throw createError(
        "ERR_STORE_POST_COMMIT",
        "提交后读回校验失败：目录可能已写入但未能确认，禁止自动重发。",
        { cause: error, commitState: "committed", retrySafe: false },
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const tempCleanup = temp ? cleanupOwnedFile(temp.target, temp) : null;
    const lockCleanup = cleanupOwnedFile(lock.target, lock);
    cleanup = {
      temp: tempCleanup ? { status: tempCleanup.status, ok: tempCleanup.ok } : { status: "none", ok: true },
      lock: { status: lockCleanup.status, ok: lockCleanup.ok },
      ok: (tempCleanup ? tempCleanup.ok : true) && lockCleanup.ok,
    };
    if (!cleanup.ok) {
      cleanup.tempCause = tempCleanup && tempCleanup.cause ? String(tempCleanup.cause.code || tempCleanup.cause.message) : null;
      cleanup.lockCause = lockCleanup.cause ? String(lockCleanup.cause.code || lockCleanup.cause.message) : null;
    }
  }

  if (primaryError) {
    // 清理细节附加到原始错误，绝不掩盖原始原因与提交阶段。
    if (primaryError.commitState === undefined) {
      primaryError.commitState = commitState;
    }
    if (primaryError.retrySafe === undefined) {
      primaryError.retrySafe = commitState === "notCommitted";
    }
    if (primaryError.phase === undefined) {
      primaryError.phase = phase;
    }
    primaryError.cleanup = cleanup;
    throw primaryError;
  }

  if (!cleanup.ok) {
    throw createError(
      "ERR_STORE_CLEANUP",
      "提交/回滚后的清理未完成，可能留下本次创建的锁或临时文件，禁止自动重发。",
      {
        commitState,
        retrySafe: false,
        phase: "cleanup",
        cleanup,
      },
    );
  }

  return committedSnapshot;
}

// 4A3 归属记录读取：有界同 fd、末段无链接、dev/ino 与尺寸复核，读后再按路径核对身份。
function readBoundedOwnedText(absPath, maxBytes, missingCode, invalidCode) {
  let stats;
  try {
    stats = fs.lstatSync(absPath);
  } catch (error) {
    throw createError(missingCode, `${absPath} 不存在。`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createError(invalidCode, `${absPath} 必须是真实普通文件，不能是链接。`);
  }
  if (stats.size > maxBytes) {
    throw createError(invalidCode, `${absPath} 超过上限 ${maxBytes} 字节。`);
  }

  let fd;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    throw createError(invalidCode, `${absPath} 无法按末段无链接方式打开。`, { cause: error });
  }

  let opened;
  let text;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError(invalidCode, `${absPath} 不是普通文件。`);
    }
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw createError(invalidCode, `${absPath} 在校验后已被替换，按策略拒绝。`);
    }
    if (opened.size > maxBytes) {
      throw createError(invalidCode, `${absPath} 超过上限 ${maxBytes} 字节。`);
    }
    text = readBoundedFd(fd, maxBytes, invalidCode);
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size > maxBytes) {
      throw createError(invalidCode, `${absPath} 在读取期间发生变化，按策略拒绝。`);
    }
  } finally {
    fs.closeSync(fd);
  }

  assertPathIdentity(absPath, { dev: opened.dev, ino: opened.ino }, invalidCode);
  return text;
}

function parseOwnershipRecord(text, expectedKind, invalidCode, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw createError(invalidCode, `${label} 不是合法 JSON。`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createError(invalidCode, `${label} 必须是 JSON 对象。`);
  }
  if (value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) {
    throw createError(invalidCode, `${label} 的 schemaVersion 不受支持。`);
  }
  if (value.kind !== expectedKind) {
    throw createError(invalidCode, `${label} 的 kind 不匹配。`);
  }
  return value;
}

// 音频摘要：分块有界流式读取，先看尺寸再用上限 + 1 累计停止，读前后复核身份与尺寸。
function hashAudioFileBounded(absPath, maxBytes, code) {
  let stats;
  try {
    stats = fs.lstatSync(absPath);
  } catch (error) {
    throw createError(code, `音频文件不存在：${absPath}`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createError(code, "音频必须是真实普通文件，不能是链接。");
  }
  if (stats.size > maxBytes) {
    throw createError(code, `音频 ${stats.size} 字节超过上限 ${maxBytes} 字节。`);
  }
  if (fs.realpathSync(absPath) !== absPath) {
    throw createError(code, "音频真实路径不属于当前 namespace。");
  }

  let fd;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    throw createError(code, "音频无法按末段无链接方式打开。", { cause: error });
  }

  let opened;
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(AUDIO_HASH_CHUNK);
  let total = 0;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw createError(code, "音频不是普通文件。");
    }
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw createError(code, "音频在校验后已被替换，按策略拒绝。");
    }
    if (opened.size > maxBytes) {
      throw createError(code, `音频 ${opened.size} 字节超过上限 ${maxBytes} 字节。`);
    }
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) {
        break;
      }
      total += read;
      if (total > maxBytes) {
        throw createError(code, `音频读取累计超过上限 ${maxBytes} 字节，已停止。`);
      }
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size > maxBytes) {
      throw createError(code, "音频在读取期间发生变化，按策略拒绝。");
    }
  } finally {
    fs.closeSync(fd);
  }

  assertPathIdentity(absPath, { dev: opened.dev, ino: opened.ino }, code);
  return hash.digest("hex");
}

function isSafeFileName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

// 归属核对：本 namespace、profile、operationId 三方一致，资料记录与 audioPath 形状合法，
// 音频存在且摘要与记录一致。记录只用于防误认领，不抵御同 OS 用户同时伪造整组记录。
function assertVoiceOwnership(realRoot, namespaceId, profile) {
  const profileId = profile.id;
  if (typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) {
    throw createError("ERR_STORE_LIFECYCLE_FORBIDDEN", "profile.id 必须是 UUID，无法核对归属。");
  }

  const profileDir = path.join(realRoot, "sources", profileId);
  let dirStats;
  try {
    dirStats = fs.lstatSync(profileDir);
  } catch (error) {
    throw createError("ERR_STORE_SOURCE_MISSING", `缺少来源目录 ${profileDir}。`, { cause: error });
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw createError("ERR_STORE_SOURCE_INVALID", "来源目录必须是真实目录，不能是链接。");
  }
  if (fs.realpathSync(profileDir) !== profileDir) {
    throw createError("ERR_STORE_SOURCE_INVALID", "来源目录真实路径不属于当前 namespace。");
  }

  const sourceText = readBoundedOwnedText(
    path.join(profileDir, "source.json"),
    MAX_OWNERSHIP_RECORD_BYTES,
    "ERR_STORE_SOURCE_MISSING",
    "ERR_STORE_SOURCE_INVALID",
  );
  const operationText = readBoundedOwnedText(
    path.join(realRoot, "operations", `voice-${profileId}.json`),
    MAX_OWNERSHIP_RECORD_BYTES,
    "ERR_STORE_OPERATION_MISSING",
    "ERR_STORE_OPERATION_INVALID",
  );

  const source = parseOwnershipRecord(sourceText, SOURCE_RECORD_KIND, "ERR_STORE_SOURCE_INVALID", "source.json");
  const operation = parseOwnershipRecord(
    operationText,
    OPERATION_RECORD_KIND,
    "ERR_STORE_OPERATION_INVALID",
    "voice-operation.json",
  );

  const pairs = [
    [source, "ERR_STORE_SOURCE_INVALID", "source.json"],
    [operation, "ERR_STORE_OPERATION_INVALID", "voice-operation.json"],
  ];
  for (const [record, code, label] of pairs) {
    if (record.namespaceId !== namespaceId) {
      throw createError(code, `${label} 的 namespaceId 与当前 namespace 不一致。`);
    }
    if (record.profileId !== profileId) {
      throw createError(code, `${label} 的 profileId 与目标 profile 不一致。`);
    }
    if (typeof record.operationId !== "string" || !UUID_PATTERN.test(record.operationId)) {
      throw createError(code, `${label} 的 operationId 不是 UUID。`);
    }
  }
  if (source.operationId !== operation.operationId) {
    throw createError("ERR_STORE_OPERATION_INVALID", "source 与 operation 记录的 operationId 不一致。");
  }
  if (operation.sourceRelativePath !== `sources/${profileId}/source.json`) {
    throw createError("ERR_STORE_OPERATION_INVALID", "operation.sourceRelativePath 不是固定的 source 记录路径。");
  }

  const relative = source.audioRelativePath;
  const parts = typeof relative === "string" ? relative.split("/") : [];
  if (parts.length !== 3 || parts[0] !== "sources" || parts[1] !== profileId || !isSafeFileName(parts[2])) {
    throw createError("ERR_STORE_SOURCE_INVALID", "audioRelativePath 必须是 sources/<profileId>/<单一安全文件名>。");
  }
  const audioPath = path.join(realRoot, "sources", profileId, parts[2]);

  const declared = profile.source;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw createError("ERR_STORE_SOURCE_INVALID", "profile.source 缺失，无法核对保存归属。");
  }
  if (declared.audioPath !== audioPath) {
    throw createError("ERR_STORE_SOURCE_INVALID", "profile.source.audioPath 与归属记录不一致。");
  }
  if (declared.referenceText !== source.referenceText) {
    throw createError("ERR_STORE_SOURCE_INVALID", "profile.source.referenceText 与 source 记录不一致。");
  }
  if (declared.language !== source.language) {
    throw createError("ERR_STORE_SOURCE_INVALID", "profile.source.language 与 source 记录不一致。");
  }

  const digest = hashAudioFileBounded(audioPath, MAX_AUDIO_BYTES, "ERR_STORE_SOURCE_INVALID");
  if (digest !== source.audioSha256) {
    throw createError("ERR_STORE_SOURCE_HASH_MISMATCH", "音频摘要与 source 记录不一致，拒绝保存/停用。");
  }

  return { source, operation, audioPath };
}

function assertProfileIdInput(profileId) {
  if (typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) {
    throw createError("ERR_STORE_LIFECYCLE_INPUT", "profileId 必须是 UUID。");
  }
}

function locateOwnedProfile(draft, namespaceId, profileId) {
  const profile = draft.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw createError("ERR_STORE_LIFECYCLE_NOT_FOUND", `profile ${profileId} 不存在于当前目录。`);
  }
  if (profile.owner !== namespaceId) {
    throw createError("ERR_STORE_LIFECYCLE_FORBIDDEN", "profile owner 与当前 namespace 不一致，拒绝按自有音色处理。");
  }
  return profile;
}

// saveTemporary：持锁后按最新目录核对归属，再把 temporary 提升为 saved，保留 ID/revision/params 与所有原文件。
async function saveTemporary(root, profileId) {
  assertProfileIdInput(profileId);
  const ns = precheckTransactionNamespace(root);
  const realRoot = ns.root;
  const namespaceId = ns.namespaceId;

  return updateCatalog(realRoot, async (draft) => {
    const profile = locateOwnedProfile(draft, namespaceId, profileId);
    const persistence = profile.persistence;
    if (persistence === "saved") {
      // 幂等：必须仍是合法自有完整记录，但不改身份、revision 或任何内容。
      assertVoiceOwnership(realRoot, namespaceId, profile);
      return;
    }
    if (persistence !== "temporary") {
      throw createError(
        "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
        `persistence=${persistence} 的音色不能保存为 saved。`,
      );
    }
    assertVoiceOwnership(realRoot, namespaceId, profile);
    profile.persistence = "saved";
  });
}

// endTemporary：持锁后把目标 temporary 音色的所有 binding 置 invalid，原非 invalid 的 revision 各 +1。
async function endTemporary(root, profileId) {
  assertProfileIdInput(profileId);
  const ns = precheckTransactionNamespace(root);
  const realRoot = ns.root;
  const namespaceId = ns.namespaceId;

  return updateCatalog(realRoot, async (draft) => {
    const profile = locateOwnedProfile(draft, namespaceId, profileId);
    if (profile.persistence !== "temporary") {
      throw createError(
        "ERR_STORE_LIFECYCLE_NOT_TEMPORARY",
        `persistence=${profile.persistence} 的音色不能停用，只有 temporary 可停用；saved/external 保留不动。`,
      );
    }
    assertVoiceOwnership(realRoot, namespaceId, profile);

    const pending = [];
    for (const binding of draft.bindings) {
      if (binding.profileId !== profileId) {
        continue;
      }
      if (binding.status === "invalid") {
        // 已失效的绑定不再涨 revision，重复停用保持幂等。
        continue;
      }
      if (!Number.isSafeInteger(binding.revision) || binding.revision + 1 > Number.MAX_SAFE_INTEGER) {
        throw createError(
          "ERR_STORE_REVISION_OVERFLOW",
          `binding ${binding.id} 的 revision 递增会超过安全整数上限，整次拒绝。`,
        );
      }
      pending.push(binding);
    }
    // 全部检查通过后再统一写入，避免部分生效。
    for (const binding of pending) {
      binding.revision += 1;
      binding.status = "invalid";
    }
  });
}

// 4A4 只读导入已有 Audio8 音色：不注册、不合成、不 reload、不切权重，不写外部目录。
function assertImportInput(options) {
  const endpointId = options && options.endpointId;
  const nativeVoiceId = options && options.nativeVoiceId;
  const label = options && options.label;
  if (typeof endpointId !== "string" || endpointId.trim() === "") {
    throw createError("ERR_STORE_IMPORT_INPUT", "endpointId 必须是非空字符串。");
  }
  if (!isSafeFileName(nativeVoiceId)) {
    throw createError("ERR_STORE_IMPORT_INPUT", "nativeVoiceId 必须是单一安全路径组件。");
  }
  if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL_CHARS) {
    throw createError("ERR_STORE_IMPORT_INPUT", `label 必须是 1 到 ${MAX_LABEL_CHARS} 字符的非空字符串。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    throw createError("ERR_STORE_IMPORT_INPUT", "label 不得包含控制字符。");
  }
}

// 读取外部 voicesRoot 内该音色的磁盘 meta.json，返回真实摘要；末段链接、越界与尺寸都拒绝。
function readExternalVoiceMeta(endpoint, nativeVoiceId) {
  let realVoicesRoot;
  try {
    realVoicesRoot = fs.realpathSync(endpoint.voicesRoot);
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_META_INVALID", "voicesRoot 不可解析。", { cause: error });
  }

  let realVoiceDir;
  try {
    realVoiceDir = fs.realpathSync(path.join(realVoicesRoot, nativeVoiceId));
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_META_MISSING", `音色目录不可解析：${nativeVoiceId}`, {
      cause: error,
    });
  }
  if (path.dirname(realVoiceDir) !== realVoicesRoot || path.basename(realVoiceDir) !== nativeVoiceId) {
    throw createError("ERR_STORE_IMPORT_META_INVALID", `音色目录 ${nativeVoiceId} 经链接逃出了 voicesRoot。`);
  }

  const text = readBoundedOwnedText(
    path.join(realVoiceDir, "meta.json"),
    MAX_VOICE_META_BYTES,
    "ERR_STORE_IMPORT_META_MISSING",
    "ERR_STORE_IMPORT_META_INVALID",
  );
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    throw createError("ERR_STORE_IMPORT_META_INVALID", `音色 ${nativeVoiceId} 的 meta.json 不是合法 JSON。`);
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw createError("ERR_STORE_IMPORT_META_INVALID", `音色 ${nativeVoiceId} 的 meta.json 必须是 JSON 对象。`);
  }
  let fingerprint;
  try {
    fingerprint = audio8.voiceFingerprint(meta);
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_META_INVALID", `音色 ${nativeVoiceId} 的 meta.json 身份字段不完整。`, {
      cause: error,
    });
  }
  return { meta, fingerprint };
}

// 只读核验：probe(runtime/manifest/精度) + 磁盘 meta + 内存候选目录交给 listVoices 复核在线一致性。
async function verifyImportCandidate(endpoint, namespaceId, profileId, bindingId, nativeVoiceId, label) {
  let probeResult;
  try {
    probeResult = await audio8.probe({ endpoint });
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_UNVERIFIED", `Audio8 端点只读核验失败：${error.message}`, {
      cause: error,
    });
  }
  if (!probeResult.ready || !probeResult.identity) {
    throw createError(
      "ERR_STORE_IMPORT_UNVERIFIED",
      `Audio8 端点未通过只读身份核验（${probeResult.state}），不发布 ready 绑定。`,
    );
  }
  const identity = probeResult.identity;

  const disk = readExternalVoiceMeta(endpoint, nativeVoiceId);

  const profile = {
    id: profileId,
    label,
    persistence: "external",
    owner: namespaceId,
  };
  const binding = {
    id: bindingId,
    profileId,
    backendId: "audio8",
    endpointId: endpoint.id,
    nativeVoiceId,
    modelFingerprint: identity.modelFingerprint,
    revision: 1,
    status: "ready",
    params: {},
    nativeVoiceFingerprint: disk.fingerprint,
  };
  const candidate = {
    schemaVersion: 1,
    endpoints: [endpoint],
    profiles: [profile],
    bindings: [binding],
  };

  let candidateSnapshot;
  try {
    candidateSnapshot = validateCatalogData(candidate);
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_UNVERIFIED", `候选绑定未通过目录校验：${error.message}`, {
      cause: error,
    });
  }

  const entry = await listCandidateBinding(endpoint, candidateSnapshot, bindingId, nativeVoiceId);
  if (!entry || entry.status !== "verified" || entry.usable !== true) {
    throw createError(
      "ERR_STORE_IMPORT_UNVERIFIED",
      `声音 ${nativeVoiceId} 未通过在线与磁盘一致核验（${entry ? entry.status : "missing"}），不发布 ready 绑定。`,
    );
  }
  if (entry.voiceFingerprint !== disk.fingerprint) {
    throw createError("ERR_STORE_IMPORT_UNVERIFIED", "在线核验指纹与磁盘 meta 指纹不一致。");
  }

  return { identity, fingerprint: disk.fingerprint, profile, binding };
}

// 用已验收 listVoices 在内存候选目录上复核拟建绑定，只读 GET，不注册不合成。
async function listCandidateBinding(endpoint, candidateSnapshot, bindingId, nativeVoiceId) {
  let listed;
  try {
    listed = await audio8.listVoices({ endpoint, catalog: candidateSnapshot });
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_UNVERIFIED", `在线声音核验失败：${error.message}`, {
      cause: error,
    });
  }
  return listed.find(
    (item) => item.bindingId === bindingId && item.nativeVoiceId === nativeVoiceId,
  );
}

// 提交前稳定性复核：在线实例身份、模型指纹与同名声音核验结果不得漂移。
async function assertImportStable(endpoint, namespaceId, firstIdentity, fingerprint, nativeVoiceId, profile, binding) {
  let second;
  try {
    second = await audio8.probe({ endpoint });
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_DRIFT", `提交前复核失败：${error.message}`, { cause: error });
  }
  if (
    !second.ready ||
    !second.identity ||
    second.identity.instanceId !== firstIdentity.instanceId ||
    second.identity.modelFingerprint !== firstIdentity.modelFingerprint
  ) {
    throw createError("ERR_STORE_IMPORT_DRIFT", "在线实例身份或模型指纹在导入期间漂移，拒绝发布旧绑定。");
  }

  let snapshot;
  try {
    snapshot = validateCatalogData({
      schemaVersion: 1,
      endpoints: [endpoint],
      profiles: [profile],
      bindings: [binding],
    });
  } catch (error) {
    throw createError("ERR_STORE_IMPORT_DRIFT", `提交前候选目录校验失败：${error.message}`, { cause: error });
  }
  const entry = await listCandidateBinding(endpoint, snapshot, binding.id, nativeVoiceId);
  if (!entry || entry.status !== "verified" || entry.usable !== true || entry.voiceFingerprint !== fingerprint) {
    throw createError("ERR_STORE_IMPORT_DRIFT", "同名声音元数据在导入期间漂移，拒绝发布旧绑定。");
  }
}

// 只读导入已有 Audio8 音色：端点必须已在目录登记，锁内以最新端点核验，成功发布 external profile + ready 绑定。
async function importExternal(root, options) {
  assertImportInput(options);
  const { endpointId, nativeVoiceId, label } = options;
  const ns = precheckTransactionNamespace(root);
  const realRoot = ns.root;
  const namespaceId = ns.namespaceId;

  return updateCatalog(realRoot, async (draft) => {
    const endpoint = draft.endpoints.find((entry) => entry.id === endpointId);
    if (!endpoint) {
      throw createError("ERR_STORE_IMPORT_ENDPOINT_MISSING", `端点 ${endpointId} 未在当前目录登记。`);
    }
    if (endpoint.backendId !== "audio8") {
      throw createError(
        "ERR_STORE_IMPORT_BACKEND_UNSUPPORTED",
        `端点 ${endpointId} 的 backendId=${endpoint.backendId}，未验证后端不导入 ready。`,
      );
    }
    if (endpoint.readiness !== "ready") {
      throw createError(
        "ERR_STORE_IMPORT_ENDPOINT_NOT_READY",
        `端点 ${endpointId} readiness=${endpoint.readiness}，目录声明未 ready。`,
      );
    }

    // 锁内固定端点快照：await 期间调用方改写原对象不影响本次核验与发布。
    const endpointSnapshot = cloneDraft(endpoint);

    const existing = draft.bindings.find(
      (entry) =>
        entry.backendId === "audio8" &&
        entry.endpointId === endpointId &&
        entry.nativeVoiceId === nativeVoiceId,
    );
    const existingProfile = existing
      ? draft.profiles.find((entry) => entry.id === existing.profileId)
      : null;

    const profileId = existing ? existing.profileId : crypto.randomUUID();
    const bindingId = existing ? existing.id : crypto.randomUUID();
    const verified = await verifyImportCandidate(
      endpointSnapshot,
      namespaceId,
      profileId,
      bindingId,
      nativeVoiceId,
      existing && existingProfile ? existingProfile.label : label,
    );

    if (existing && existingProfile) {
      if (existing.nativeVoiceFingerprint !== verified.fingerprint) {
        throw createError(
          "ERR_STORE_IMPORT_FINGERPRINT_CHANGED",
          "同一端点与声音的指纹已变化，需重新确认后再导入，不能无提示覆盖旧绑定。",
        );
      }
      if (existingProfile.persistence !== "external") {
        throw createError(
          "ERR_STORE_IMPORT_CONFLICT",
          "同端点同声音已有非 external 的自有记录，拒绝覆盖，需要显式重新确认。",
        );
      }
      // 幂等复用原 external 绑定：不新增、不改 revision/label、不改任何文件。
      return;
    }

    await assertImportStable(
      endpointSnapshot,
      namespaceId,
      verified.identity,
      verified.fingerprint,
      nativeVoiceId,
      verified.profile,
      verified.binding,
    );

    draft.profiles.push(verified.profile);
    draft.bindings.push(verified.binding);
  });
}

// 4A5 新音色准备：只向本 namespace 自有 voicesRoot 注册，一次 POST，不自动重发、不自动回滚。
function assertPrepareInput(options) {
  const input = options || {};
  if (typeof input.endpointId !== "string" || input.endpointId.trim() === "") {
    throw createError("ERR_STORE_PREPARE_INPUT", "endpointId 必须是非空字符串。");
  }
  if (
    typeof input.label !== "string" ||
    input.label.trim() === "" ||
    input.label.length > MAX_LABEL_CHARS ||
    CONTROL_CHAR_PATTERN.test(input.label)
  ) {
    throw createError("ERR_STORE_PREPARE_INPUT", `label 必须是 1 到 ${MAX_LABEL_CHARS} 字符且不含控制字符。`);
  }
  if (!Buffer.isBuffer(input.audio)) {
    throw createError("ERR_STORE_PREPARE_INPUT", "audio 必须是调用方提供的 Buffer，不接受任意文件路径读入。");
  }
  if (input.audio.length === 0) {
    throw createError("ERR_STORE_PREPARE_INPUT", "audio 不能为空。");
  }
  if (input.audio.length > MAX_AUDIO_BYTES) {
    throw createError("ERR_STORE_PREPARE_INPUT", `audio 超过上限 ${MAX_AUDIO_BYTES} 字节。`);
  }
  if (
    typeof input.referenceText !== "string" ||
    input.referenceText.trim() === "" ||
    input.referenceText.length > MAX_REFERENCE_TEXT_CHARS ||
    REFERENCE_TEXT_CONTROL_PATTERN.test(input.referenceText)
  ) {
    throw createError(
      "ERR_STORE_PREPARE_INPUT",
      `referenceText 必须是 1 到 ${MAX_REFERENCE_TEXT_CHARS} 字符，允许 TAB/LF/CRLF/CR 等文本空白，拒绝其他控制字符。`,
    );
  }
  if (typeof input.language !== "string" || !LANGUAGE_PATTERN.test(input.language)) {
    throw createError("ERR_STORE_PREPARE_INPUT", "language 必须是规范的 BCP-47 形状标签。");
  }
  if (input.persistence !== "temporary" && input.persistence !== "saved") {
    throw createError("ERR_STORE_PREPARE_INPUT", "persistence 只能是 temporary 或 saved。");
  }
  if (input.authorizationConfirmed !== true) {
    throw createError("ERR_STORE_PREPARE_INPUT", "authorizationConfirmed 必须显式为 true。");
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// 与安装 registration.py 的 " ".join(text.strip().split()) 等价：用于把磁盘/在线/响应 meta
// 的 reference_text 与本次原文按真实注册语义比对，而不是逐字节相等。
function normalizeReferenceText(text) {
  return String(text === undefined || text === null ? "" : text)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

// 独占创建自有文件：绝不覆盖旧资料，短写/0 写立即失败。
function writeExclusiveFile(target, buffer) {
  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_RECORDS", `无法独占创建 ${target}，拒绝覆盖旧资料。`, {
      cause: error,
    });
  }
  let opened;
  try {
    opened = fs.fstatSync(fd);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (typeof written !== "number" || written <= 0) {
        throw createError("ERR_STORE_PREPARE_RECORDS", `写入 ${target} 未推进。`);
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    removeOwnedFile(target, opened);
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    removeOwnedFile(target, opened);
    throw createError("ERR_STORE_PREPARE_RECORDS", `关闭 ${target} 失败。`, { cause: error });
  }
}

// 建立与 4A3 兼容的自有 source/operation 记录，全部独占创建且不覆盖旧资料。
function createOwnSourceRecords(realRoot, namespaceId, profileId, operationId, audio, referenceText, language) {
  const dir = path.join(realRoot, "sources", profileId);
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_RECORDS", "无法独占创建自有来源目录，拒绝认领旧资料。", {
      cause: error,
    });
  }
  if (fs.realpathSync(dir) !== dir) {
    throw createError("ERR_STORE_PREPARE_RECORDS", "自有来源目录真实路径不属于当前 namespace。");
  }

  const audioPath = path.join(dir, PREPARE_AUDIO_FILE_NAME);
  writeExclusiveFile(audioPath, audio);

  const sourceRecord = {
    schemaVersion: 1,
    kind: SOURCE_RECORD_KIND,
    namespaceId,
    profileId,
    operationId,
    audioRelativePath: `sources/${profileId}/${PREPARE_AUDIO_FILE_NAME}`,
    audioSha256: sha256Buffer(audio),
    referenceText,
    language,
  };
  writeExclusiveFile(
    path.join(dir, "source.json"),
    Buffer.from(`${JSON.stringify(sourceRecord, null, 2)}\n`, "utf8"),
  );

  const operationRecord = {
    schemaVersion: 1,
    kind: OPERATION_RECORD_KIND,
    namespaceId,
    profileId,
    operationId,
    sourceRelativePath: `sources/${profileId}/source.json`,
  };
  writeExclusiveFile(
    path.join(realRoot, "operations", `voice-${profileId}.json`),
    Buffer.from(`${JSON.stringify(operationRecord, null, 2)}\n`, "utf8"),
  );

  return { audioPath, sourceRecord, operationRecord };
}

// attempt journal：有界原子写 + 身份核对，只更新本次 owned journal，不写密钥或任意后端正文。
function writeAttemptJournal(realRoot, record, identity) {
  const target = path.join(realRoot, "operations", `attempt-${record.operationId}.json`);
  if (identity && inspectOwnedFile(target, identity) !== "ours") {
    throw createError("ERR_STORE_PREPARE_JOURNAL", "attempt journal 归属不一致，拒绝改写。");
  }
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_OWNERSHIP_RECORD_BYTES) {
    throw createError("ERR_STORE_PREPARE_JOURNAL", "attempt journal 超过上限。");
  }

  const temp = path.join(realRoot, "operations", `.attempt-${record.operationId}.tmp-${crypto.randomUUID()}`);
  const buffer = Buffer.from(text, "utf8");
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_JOURNAL", "无法创建 attempt 临时文件。", { cause: error });
  }
  let opened;
  // temp 只属于本次创建：清理一律走结构化 cleanupOwnedFile，并把结果随错误上报，
  // 不硬编码声称无残留；unlink 失败或身份被替换都如实暴露，未知归属不删。
  const cleanupTemp = () => cleanupOwnedFile(temp, opened);
  try {
    opened = fs.fstatSync(fd);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (typeof written !== "number" || written <= 0) {
        throw createError("ERR_STORE_PREPARE_JOURNAL", "attempt 写入未推进。");
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    error.cleanup = cleanupTemp();
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_JOURNAL", "attempt 关闭失败。", {
      cause: error,
      cleanup: cleanupTemp(),
    });
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    // 只清理本次创建且 dev/ino 一致的 temp，未知归属不删；源/op/attempt 本体保留。
    throw createError("ERR_STORE_PREPARE_JOURNAL", "attempt journal 落盘失败。", {
      cause: error,
      cleanup: cleanupTemp(),
    });
  }
  return { dev: opened.dev, ino: opened.ino };
}

// 真实注册契约：multipart(audio/text/name/overwrite=false)，固定有限超时，只发一次。
function buildRegisterMultipart(nativeVoiceId, referenceText, audio) {
  const boundary = `----memo-tts-${crypto.randomUUID()}`;
  const chunks = [];
  const push = (text) => chunks.push(Buffer.from(text, "utf8"));
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="audio"; filename="${PREPARE_AUDIO_FILE_NAME}"\r\n`);
  push("Content-Type: application/octet-stream\r\n\r\n");
  chunks.push(audio);
  push(`\r\n--${boundary}\r\n`);
  push("Content-Disposition: form-data; name=\"text\"\r\n\r\n");
  push(`${referenceText}\r\n`);
  push(`--${boundary}\r\n`);
  push("Content-Disposition: form-data; name=\"name\"\r\n\r\n");
  push(`${nativeVoiceId}\r\n`);
  push(`--${boundary}\r\n`);
  push("Content-Disposition: form-data; name=\"overwrite\"\r\n\r\n");
  push("false\r\n");
  push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat(chunks) };
}

function resolveRegisterTimeout(endpoint) {
  const value = endpoint.registerTimeoutMs;
  if (Number.isInteger(value) && value >= 1 && value <= MAX_REGISTER_TIMEOUT_MS) {
    return value;
  }
  return DEFAULT_REGISTER_TIMEOUT_MS;
}

function ownVoicesRoot(realRoot) {
  try {
    return fs.realpathSync(path.join(realRoot, "voices"));
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH", "本 namespace voices/ 不可解析。", {
      cause: error,
    });
  }
}

// 端点声明的 voicesRoot 必须就是本 namespace 的 voices/：任何网络调用前先拒绝外部安装目录。
function assertDeclaredVoicesRoot(realRoot, endpoint) {
  const own = ownVoicesRoot(realRoot);
  let declared;
  try {
    declared = fs.realpathSync(endpoint.voicesRoot);
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH", "端点 voicesRoot 不可解析。", {
      cause: error,
    });
  }
  if (declared !== own) {
    throw createError(
      "ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH",
      "端点 voicesRoot 不是本 namespace 的 voices/，拒绝向外部安装目录注册。",
    );
  }
}

// 在线 runtime 的 voicesRoot 也必须与本 namespace 完全一致（与 probe 的 voicesRoot 检查互为印证）。
function assertOnlineVoicesRoot(realRoot, identity) {
  const own = ownVoicesRoot(realRoot);
  const value = identity && typeof identity.voicesRoot === "string" ? identity.voicesRoot : "";
  let online = null;
  try {
    online = fs.realpathSync(value);
  } catch {
    online = null;
  }
  if (online !== own) {
    throw createError(
      "ERR_STORE_PREPARE_VOICES_ROOT_MISMATCH",
      "在线 runtime 的 voicesRoot 与本 namespace 不一致，拒绝注册。",
    );
  }
}

// 注册后核验：实例身份与模型指纹不得漂移，在线与磁盘 meta 指纹必须一致且 listVoices 判定 usable。
async function verifyRegisteredVoice(endpoint, firstIdentity, context) {
  const registered = { registrationState: "registered", registrationRetrySafe: false };

  // 元数据必须逐一对应本次输入，不能用"在线与磁盘彼此一致"代替"与本次输入一致"。
  const assertMatchesInput = (meta, where) => {
    const fail = (detail) =>
      createError("ERR_STORE_PREPARE_VERIFY_FAILED", `${where} 与本次注册输入不符：${detail}`, {
        ...registered,
      });
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      throw fail("元数据不是 JSON 对象。");
    }
    if (meta.name !== context.nativeVoiceId) {
      throw fail(`name=${JSON.stringify(meta.name)} 不是本次随机 nativeVoiceId。`);
    }
    if (normalizeReferenceText(meta.reference_text) !== normalizeReferenceText(context.referenceText)) {
      throw fail("reference_text 与本次原文按安装语义规范化后不一致。");
    }
    if (String(meta.source_sha256 || "") !== context.audioSha256) {
      throw fail("source_sha256 不是本次上传字节的真实摘要。");
    }
  };

  if (context.responseVoice !== undefined && context.responseVoice !== null) {
    assertMatchesInput(context.responseVoice, "注册响应 voice");
  }

  let second;
  try {
    second = await audio8.probe({ endpoint });
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_VERIFY_FAILED", `注册后复核失败：${error.message}`, {
      cause: error,
      ...registered,
    });
  }
  if (!second.ready || !second.identity) {
    throw createError("ERR_STORE_PREPARE_VERIFY_FAILED", "注册后在线身份未通过核验，不发布 ready。", {
      ...registered,
    });
  }
  if (
    second.identity.instanceId !== firstIdentity.instanceId ||
    second.identity.modelFingerprint !== firstIdentity.modelFingerprint
  ) {
    throw createError("ERR_STORE_PREPARE_DRIFT", "注册后在线实例身份或模型指纹漂移，拒绝发布旧绑定。", {
      ...registered,
    });
  }

  const disk = readExternalVoiceMeta(endpoint, context.nativeVoiceId);
  assertMatchesInput(disk.meta, "注册后磁盘 meta");
  const profile = {
    id: context.profileId,
    label: context.label,
    persistence: context.persistence,
    owner: context.namespaceId,
    source: {
      audioPath: context.audioPath,
      referenceText: context.referenceText,
      language: context.language,
    },
  };
  const binding = {
    id: context.bindingId,
    profileId: context.profileId,
    backendId: "audio8",
    endpointId: endpoint.id,
    nativeVoiceId: context.nativeVoiceId,
    modelFingerprint: second.identity.modelFingerprint,
    revision: 1,
    status: "ready",
    params: {},
    nativeVoiceFingerprint: disk.fingerprint,
  };

  let snapshot;
  try {
    snapshot = validateCatalogData({
      schemaVersion: 1,
      endpoints: [endpoint],
      profiles: [profile],
      bindings: [binding],
    });
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_VERIFY_FAILED", `候选绑定未通过目录校验：${error.message}`, {
      cause: error,
      ...registered,
    });
  }

  let entry;
  try {
    entry = await listCandidateBinding(endpoint, snapshot, binding.id, context.nativeVoiceId);
  } catch (error) {
    throw createError("ERR_STORE_PREPARE_VERIFY_FAILED", `注册后在线核验失败：${error.message}`, {
      cause: error,
      ...registered,
    });
  }
  if (!entry || entry.status !== "verified" || entry.usable !== true || entry.voiceFingerprint !== disk.fingerprint) {
    throw createError(
      "ERR_STORE_PREPARE_VERIFY_FAILED",
      `注册后的声音未通过在线与磁盘一致核验（${entry ? entry.status : "missing"}），不发布 ready。`,
      { ...registered },
    );
  }

  return { profile, binding };
}

async function prepareVoice(root, options) {
  assertPrepareInput(options);
  const { endpointId, label, referenceText, language, persistence } = options;
  // 首 await 前固定输入快照：Buffer 复制，防止调用方在等待期间改写。
  const audio = Buffer.from(options.audio);

  const ns = precheckTransactionNamespace(root);
  const realRoot = ns.root;
  const namespaceId = ns.namespaceId;

  const profileId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const nativeVoiceId = crypto.randomUUID();

  const journalBase = {
    schemaVersion: 1,
    kind: PREPARE_ATTEMPT_KIND,
    namespaceId,
    profileId,
    operationId,
    nativeVoiceId,
    endpointId,
  };
  let journalIdentity = null;
  let journalError = null;
  let postSent = false;
  let registrationState = "pending";

  const writeJournal = (stage, reason) => {
    try {
      journalIdentity = writeAttemptJournal(
        realRoot,
        { ...journalBase, stage, ...(reason ? { reason } : {}) },
        journalIdentity,
      );
      return null;
    } catch (error) {
      journalError = error;
      return error;
    }
  };

  const committed = await updateCatalog(realRoot, async (draft) => {
    const endpoint = draft.endpoints.find((entry) => entry.id === endpointId);
    if (!endpoint) {
      throw createError("ERR_STORE_PREPARE_ENDPOINT_MISSING", `端点 ${endpointId} 未在当前目录登记。`);
    }
    if (endpoint.backendId !== "audio8") {
      throw createError(
        "ERR_STORE_PREPARE_BACKEND_UNSUPPORTED",
        `端点 ${endpointId} 的 backendId=${endpoint.backendId}，未验证后端不准备新音色。`,
      );
    }
    if (endpoint.readiness !== "ready") {
      throw createError(
        "ERR_STORE_PREPARE_ENDPOINT_NOT_READY",
        `端点 ${endpointId} readiness=${endpoint.readiness}，目录声明未 ready。`,
      );
    }

    const endpointSnapshot = cloneDraft(endpoint);
    // 任何网络调用前先确认端点声明的 voicesRoot 就是本 namespace 的 voices/。
    assertDeclaredVoicesRoot(realRoot, endpointSnapshot);

    let probeResult;
    try {
      probeResult = await audio8.probe({ endpoint: endpointSnapshot });
    } catch (error) {
      throw createError("ERR_STORE_PREPARE_UNVERIFIED", `Audio8 端点只读核验失败：${error.message}`, {
        cause: error,
      });
    }
    if (!probeResult.ready || !probeResult.identity) {
      throw createError(
        "ERR_STORE_PREPARE_UNVERIFIED",
        `Audio8 端点未通过只读身份核验（${probeResult.state}），不创建音色。`,
      );
    }
    assertOnlineVoicesRoot(realRoot, probeResult.identity);

    const records = createOwnSourceRecords(
      realRoot,
      namespaceId,
      profileId,
      operationId,
      audio,
      referenceText,
      language,
    );
    // 初始 attempt journal 未能持久时必须在任何 POST 之前 fail closed。
    const pendingJournalError = writeJournal("pending");
    if (pendingJournalError) {
      throw createError(
        "ERR_STORE_PREPARE_JOURNAL",
        "初始 attempt journal 无法持久写入，拒绝在缺少记录的情况下发出注册请求。",
        {
          cause: pendingJournalError,
          journalError: pendingJournalError,
          journalCleanup: pendingJournalError.cleanup,
          registrationState: "pending",
        },
      );
    }

    const { boundary, body } = buildRegisterMultipart(nativeVoiceId, referenceText, audio);
    postSent = true;
    let response;
    try {
      response = await request({
        baseUrl: endpointSnapshot.baseUrl,
        path: PREPARE_REGISTER_PATH,
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        timeoutMs: resolveRegisterTimeout(endpointSnapshot),
        maxBytes: MAX_REGISTER_RESPONSE_BYTES,
      });
    } catch (error) {
      registrationState = "unknown";
      writeJournal("unknown", "network");
      throw createError(
        "ERR_STORE_PREPARE_REGISTER_UNKNOWN",
        "注册请求未确认完成（超时或断连），已发送的 POST 不自动重发，保留自有资料与 attempt。",
        { cause: error, registrationState, registrationRetrySafe: false, journalError },
      );
    }

    if (response.statusCode === 400 || response.statusCode === 409) {
      registrationState = "failed";
      writeJournal("failed", `http_${response.statusCode}`);
      throw createError(
        "ERR_STORE_PREPARE_REGISTER_FAILED",
        `注册被服务明确拒绝（HTTP ${response.statusCode}），原目录不变。`,
        { registrationState, registrationRetrySafe: false, upstreamStatus: response.statusCode, journalError },
      );
    }
    if (response.statusCode !== 200 || !response.json || response.json.ok !== true) {
      registrationState = "unknown";
      writeJournal("unknown", `http_${response.statusCode}`);
      throw createError(
        "ERR_STORE_PREPARE_REGISTER_UNKNOWN",
        `注册响应无法确认完成（HTTP ${response.statusCode}），保守记为 unknown，不自动重发。`,
        { registrationState, registrationRetrySafe: false, upstreamStatus: response.statusCode, journalError },
      );
    }

    registrationState = "registered";
    writeJournal("registered");
    const verified = await verifyRegisteredVoice(endpointSnapshot, probeResult.identity, {
      namespaceId,
      profileId,
      bindingId,
      nativeVoiceId,
      label,
      persistence,
      audioPath: records.audioPath,
      referenceText,
      language,
      audioSha256: sha256Buffer(audio),
      responseVoice: response.json ? response.json.voice : undefined,
    });

    draft.profiles.push(verified.profile);
    draft.bindings.push(verified.binding);
  }).catch((error) => {
    // 已发送 POST 的失败必须保留注册阶段语义，不能拿目录 notCommitted 推导可安全重发。
    if (postSent && error.registrationState === undefined) {
      error.registrationState = registrationState;
      error.registrationRetrySafe = false;
    }
    if (journalError && error.journalError === undefined) {
      error.journalError = journalError;
    }
    // journal 的 temp 清理结果必须可观测：不硬编码无残留，unlink 失败/身份替换都原样上报。
    // 独立字段承载，避免与 updateCatalog 自己的 cleanup（锁/目录 temp）互相覆盖。
    if (journalError && error.journalCleanup === undefined && journalError.cleanup !== undefined) {
      error.journalCleanup = journalError.cleanup;
    }
    throw error;
  });

  // 目录已提交：journal 末步失败必须可观测，不得静默返回成功，也不得把已发布当未提交回滚。
  const publishedJournalError = writeJournal("published");
  if (publishedJournalError) {
    throw createError(
      "ERR_STORE_PREPARE_JOURNAL_PUBLISHED",
      "目录已提交且 ready 已落盘，但 published attempt journal 写入失败，需人工核对后再决定是否重发。",
      {
        cause: publishedJournalError,
        journalError: publishedJournalError,
        journalCleanup: publishedJournalError.cleanup,
        registrationState: "registered",
        registrationRetrySafe: false,
        commitState: "committed",
        retrySafe: false,
        cleanup: { rolledBack: false, readyCommitted: true, temp: publishedJournalError.cleanup },
      },
    );
  }
  return committed;
}

module.exports = {
  initialize,
  validateNamespace,
  readManagedCatalog,
  updateCatalog,
  saveTemporary,
  endTemporary,
  importExternal,
  prepareVoice,
  SUBDIRS,
  STORE_KIND,
  STORE_SCHEMA_VERSION,
  MAX_OWNER_BYTES,
  LOCK_FILE,
  TEMP_PREFIX,
  // 仅供测试注入竞态时序；发布打包器会剥离该属性。
  __testHooks: { raceHook },
};
