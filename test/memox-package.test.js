"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(REPO_ROOT, "scripts", "build-memox.sh");
const PLUGIN_ID = "memo-plugin-tts-gptsovits";
const PLUGIN_VERSION = "2.0.0";
const ARTIFACT_NAME = `memo-plugin-tts-gptsovits-${PLUGIN_VERSION}.memox`;
const SIDE_CAR_NAME = `${ARTIFACT_NAME}.sha256`;
const RUNTIME_FILES = [
  "manifest.json",
  "index.js",
  "i18n.json",
  "options.json",
  "icon.svg",
];

const FIXED_DOS = dosDateTime(2026, 1, 1, 0, 0, 0);

function dosDateTime(year, month, day, hour, minute, second) {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const date =
    ((d.getUTCFullYear() - 1980) << 9) |
    ((d.getUTCMonth() + 1) << 5) |
    d.getUTCDate();
  const time =
    (d.getUTCHours() << 11) |
    (d.getUTCMinutes() << 5) |
    Math.floor(d.getUTCSeconds() / 2);
  return { date, time };
}

function makeOutputDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-out-")));
}

function runBuild(outputDir, env = {}) {
  return spawnSync("bash", [BUILD, "--output-dir", outputDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 65535);
    i--
  ) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "end-of-central-directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.ok(cdOffset + cdSize <= eocd, "central directory out of bounds");

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.ok(p + 46 <= buf.length, "truncated central directory");
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "bad central directory entry");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({
      name,
      mode: (buf.readUInt32LE(p + 38) >>> 16) & 0xffff,
      dosDate: buf.readUInt16LE(p + 14),
      dosTime: buf.readUInt16LE(p + 12),
      extraLen,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function assertSafeName(name) {
  assert.ok(name.length > 0, "empty entry name");
  assert.equal(name.includes("\0"), false, `NUL in entry name: ${name}`);
  assert.equal(name.startsWith("/"), false, `absolute entry name: ${name}`);
  assert.equal(name.startsWith("\\"), false, `absolute entry name: ${name}`);
  assert.equal(name.includes("\\"), false, `backslash entry name: ${name}`);
  assert.equal(/^[A-Za-z]:/.test(name), false, `drive-letter entry name: ${name}`);
  assert.equal(name.endsWith("/"), false, `directory entry: ${name}`);
  const parts = name.split("/");
  assert.equal(
    parts.some((part) => part === "" || part === "." || part === ".."),
    false,
    `unsafe entry name: ${name}`,
  );
}

function assertSafeZip(zipPath, options = {}) {
  const entries = readZipEntries(zipPath);
  const expectedOrder = options.expectedOrder || RUNTIME_FILES;
  assert.deepEqual(
    entries.map((entry) => entry.name),
    expectedOrder,
    "entry order or whitelist mismatch",
  );
  assert.equal(
    new Set(entries.map((entry) => entry.name)).size,
    entries.length,
    "duplicate entries",
  );
  for (const entry of entries) {
    assertSafeName(entry.name);
    assert.equal(
      entry.mode & 0xf000,
      0x8000,
      `non-regular entry: ${entry.name}`,
    );
    assert.equal(
      entry.mode & 0o777,
      0o644,
      `unexpected permissions: ${entry.name}`,
    );
    if (options.expectFixedMetadata !== false) {
      assert.equal(
        entry.dosDate,
        FIXED_DOS.date,
        `unexpected mtime date: ${entry.name}`,
      );
      assert.equal(
        entry.dosTime,
        FIXED_DOS.time,
        `unexpected mtime time: ${entry.name}`,
      );
      assert.equal(
        entry.extraLen,
        0,
        `unexpected zip extra field: ${entry.name}`,
      );
    }
  }
}

function extract(artifact, dir) {
  return spawnSync("unzip", ["-q", artifact, "-d", dir], {
    encoding: "utf8",
    timeout: 20000,
  });
}

function makeSourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-src-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(BUILD, path.join(root, "scripts", "build-memox.sh"));
  for (const file of RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
  }
  return root;
}

function runFixtureBuild(root, outputDir, env = {}) {
  return spawnSync("bash", [
    path.join(root, "scripts", "build-memox.sh"),
    "--output-dir",
    outputDir,
  ], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(file, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data || "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(entry.dosTime ?? FIXED_DOS.time, 10);
    local.writeUInt16LE(entry.dosDate ?? FIXED_DOS.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(entry.dosTime ?? FIXED_DOS.time, 12);
    head.writeUInt16LE(entry.dosDate ?? FIXED_DOS.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    const external = (entry.external == null ? 0o100644 * 0x10000 : entry.external) >>> 0;
    head.writeUInt32LE(external, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(
    file,
    Buffer.concat([...chunks, centralBuf, eocd]),
  );
}

test("builds a byte-identical package with exact whitelist order and fixed metadata", { timeout: 30000 }, () => {
  const outA = makeOutputDir();
  const outB = makeOutputDir();
  const first = runBuild(outA);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /wrote/);
  const second = runBuild(outB);
  assert.equal(second.status, 0, second.stderr);

  for (const dir of [outA, outB]) {
    const artifact = path.join(dir, ARTIFACT_NAME);
    assert.ok(fs.existsSync(artifact), "artifact missing");
    assert.ok(fs.existsSync(path.join(dir, SIDE_CAR_NAME)), "sidecar missing");
    assertSafeZip(artifact);
  }

  const hashA = sha256(path.join(outA, ARTIFACT_NAME));
  const hashB = sha256(path.join(outB, ARTIFACT_NAME));
  assert.equal(hashA, hashB, "two builds must be byte-identical");
  assert.equal(
    fs.readFileSync(path.join(outA, SIDE_CAR_NAME), "utf8"),
    `${hashA}  ${ARTIFACT_NAME}\n`,
    "sidecar must contain the artifact hash",
  );

  const integrity = spawnSync("unzip", ["-tqq", path.join(outA, ARTIFACT_NAME)], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(integrity.status, 0, integrity.stderr);
});

test("package extracts and loads as the existing CommonJS provider", { timeout: 30000 }, async () => {
  const out = makeOutputDir();
  const built = runBuild(out);
  assert.equal(built.status, 0, built.stderr);

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-x-"));
  const unpacked = extract(path.join(out, ARTIFACT_NAME), extractDir);
  assert.equal(unpacked.status, 0, unpacked.stderr);

  const extracted = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        extracted.push(rel);
      }
    }
  };
  walk(extractDir, "");
  assert.deepEqual(extracted.sort(), RUNTIME_FILES.slice().sort(), "unexpected extracted files");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf8")),
    require(path.join(REPO_ROOT, "manifest.json")),
    "manifest must be unchanged",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extractDir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.pluginId, PLUGIN_ID);
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(manifest.importType, "module");

  const entry = require(path.join(extractDir, "index.js"));
  assert.equal(typeof entry.default, "function");
  assert.equal(typeof entry.getEditorOptions, "function");
  // 解包后的入口在未配置资料时必须给固定中文分类错误，而不是静音占位 WAV。
  const result = await new entry.default().textToSpeech({ text: "你好" });
  assert.equal(Buffer.isBuffer(result), false, "packaged entry must not return a silence placeholder");
  assert.equal(typeof result, "string");
  assert.match(result, /^语音合成失败：/);
});

test("packaged index.js is self-contained and has no relative require", { timeout: 30000 }, () => {
  const out = makeOutputDir();
  const built = runBuild(out);
  assert.equal(built.status, 0, built.stderr);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-no-rel-"));
  const unpacked = extract(path.join(out, ARTIFACT_NAME), extractDir);
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const entry = fs.readFileSync(path.join(extractDir, "index.js"), "utf8");
  assert.doesNotMatch(entry, /require\s*\(\s*["']\./, "packaged index.js must not require relative modules");
  const TTS = require(path.join(extractDir, "index.js")).default;
  assert.equal(typeof TTS, "function");
});

test("existing symlink component in output path is rejected", { timeout: 30000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-exist-sym-"));
  const real = path.join(parent, "real");
  const alias = path.join(parent, "alias");
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(path.join(real, "sub"), { recursive: true });
  fs.symlinkSync(real, alias, "dir");
  const outputDir = path.join(alias, "sub");
  const result = runBuild(outputDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/i);
  assert.equal(
    fs.existsSync(path.join(real, "sub", ARTIFACT_NAME)),
    false,
    "artifact must not be written through the symlink component",
  );
});

test("source file mode 0755 still produces zip entries with mode 0644", { timeout: 30000 }, () => {
  const root = makeSourceFixture();
  fs.chmodSync(path.join(root, "index.js"), 0o755);
  const out = makeOutputDir();
  const built = runFixtureBuild(root, out);
  assert.equal(built.status, 0, built.stderr);
  const entries = readZipEntries(path.join(out, ARTIFACT_NAME));
  const indexEntry = entries.find((entry) => entry.name === "index.js");
  assert.ok(indexEntry, "index.js entry missing");
  assert.equal(indexEntry.mode & 0o777, 0o644, "zip entry must be 0644 regardless of source mode");
});

test("manifest type and provider shape are strictly validated", { timeout: 30000 }, () => {
  const out = makeOutputDir();

  const badType = makeSourceFixture();
  const typeManifest = JSON.parse(
    fs.readFileSync(path.join(badType, "manifest.json"), "utf8"),
  );
  typeManifest.type = "llm";
  fs.writeFileSync(path.join(badType, "manifest.json"), JSON.stringify(typeManifest));
  const badTypeRun = runFixtureBuild(badType, out);
  assert.notEqual(badTypeRun.status, 0);
  assert.match(badTypeRun.stderr, /manifest|type/i);
  assert.equal(fs.existsSync(path.join(out, ARTIFACT_NAME)), false);

  const noProvider = makeSourceFixture();
  const noProviderManifest = JSON.parse(
    fs.readFileSync(path.join(noProvider, "manifest.json"), "utf8"),
  );
  delete noProviderManifest.provider;
  fs.writeFileSync(path.join(noProvider, "manifest.json"), JSON.stringify(noProviderManifest));
  const noProviderRun = runFixtureBuild(noProvider, out);
  assert.notEqual(noProviderRun.status, 0);
  assert.match(noProviderRun.stderr, /manifest|provider/i);

  const blankProvider = makeSourceFixture();
  const blankManifest = JSON.parse(
    fs.readFileSync(path.join(blankProvider, "manifest.json"), "utf8"),
  );
  blankManifest.provider = { value: "", label: "GPT-SoVITS TTS" };
  fs.writeFileSync(path.join(blankProvider, "manifest.json"), JSON.stringify(blankManifest));
  const blankRun = runFixtureBuild(blankProvider, out);
  assert.notEqual(blankRun.status, 0);
  assert.match(blankRun.stderr, /manifest|provider/i);
});

test("manifest platforms and arch must be exact contract arrays", { timeout: 30000 }, () => {
  const cases = [
    { key: "platforms", value: ["win32"], match: /manifest|platform/i },
    { key: "platforms", value: ["darwin", "win32"], match: /manifest|platform/i },
    { key: "platforms", value: [], match: /manifest|platform/i },
    { key: "platforms", value: "darwin", match: /manifest|platform/i },
    { key: "arch", value: ["x64"], match: /manifest|arch/i },
    { key: "arch", value: ["arm64", "x64"], match: /manifest|arch/i },
    { key: "arch", value: [], match: /manifest|arch/i },
    { key: "arch", value: "arm64", match: /manifest|arch/i },
  ];
  for (const entry of cases) {
    const out = makeOutputDir();
    const root = makeSourceFixture();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest[entry.key] = entry.value;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runFixtureBuild(root, out);
    assert.notEqual(result.status, 0, `${entry.key}=${JSON.stringify(entry.value)} must be rejected`);
    assert.match(result.stderr, entry.match, `${entry.key}=${JSON.stringify(entry.value)} wrong error`);
    assert.equal(
      fs.existsSync(path.join(out, ARTIFACT_NAME)),
      false,
      `${entry.key}=${JSON.stringify(entry.value)} must not publish an artifact`,
    );
  }
});

test("artifact or sidecar directory collision is rejected before publishing", { timeout: 30000 }, () => {
  const out = makeOutputDir();
  fs.mkdirSync(path.join(out, ARTIFACT_NAME), { recursive: true });
  const result = runBuild(out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact|sidecar|regular file/i);
  assert.equal(fs.existsSync(path.join(out, ARTIFACT_NAME, "index.js")), false, "artifact dir must not receive the zip");

  const out2 = makeOutputDir();
  fs.mkdirSync(path.join(out2, SIDE_CAR_NAME), { recursive: true });
  const result2 = runBuild(out2);
  assert.notEqual(result2.status, 0);
  assert.match(result2.stderr, /artifact|sidecar|regular file/i);
  assert.equal(fs.existsSync(path.join(out2, SIDE_CAR_NAME, "sidecar")), false, "sidecar dir must not receive the hash");
});

test("rejects unsafe output directories without publishing artifacts", { timeout: 30000 }, () => {
  const cases = [];

  const missing = path.join(makeOutputDir(), "does-not-exist");
  cases.push({ name: "missing", outputDir: missing, match: /output directory/i });

  const fileDir = path.join(makeOutputDir(), "not-a-dir");
  fs.writeFileSync(fileDir, "file\n");
  cases.push({ name: "file", outputDir: fileDir, match: /output directory/i });

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-sym-"));
  const realDir = path.join(parent, "real");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(realDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const symlinkDir = path.join(parent, "linked");
  fs.symlinkSync(realDir, symlinkDir, "dir");
  cases.push({
    name: "output dir symlink",
    outputDir: symlinkDir,
    match: /symlink/i,
    noArtifactAt: realDir,
  });

  const nestedReal = path.join(parent, "nested-real");
  fs.mkdirSync(nestedReal, { recursive: true });
  const nestedLink = path.join(parent, "nested-link");
  fs.symlinkSync(nestedReal, nestedLink, "dir");
  fs.mkdirSync(path.join(nestedReal, "sub"), { recursive: true });
  cases.push({
    name: "output dir symlink component",
    outputDir: path.join(nestedLink, "sub"),
    match: /symlink/i,
    noArtifactAt: path.join(nestedReal, "sub"),
  });

  for (const entry of cases) {
    const result = runBuild(entry.outputDir);
    assert.notEqual(result.status, 0, `${entry.name}: build must fail`);
    assert.match(result.stderr, entry.match, `${entry.name}: wrong error`);
    const checked = entry.noArtifactAt || entry.outputDir;
    if (fs.existsSync(checked)) {
      assert.equal(
        fs.existsSync(path.join(checked, ARTIFACT_NAME)),
        false,
        `${entry.name}: artifact must not exist`,
      );
    }
  }
});

test("rejects malicious manifests and incomplete or symlinked sources", { timeout: 30000 }, () => {
  const out = makeOutputDir();

  const badVersion = makeSourceFixture();
  const manifestPath = path.join(badVersion, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = "1.0.1";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const badVersionRun = runFixtureBuild(badVersion, out);
  assert.notEqual(badVersionRun.status, 0);
  assert.match(badVersionRun.stderr, /manifest|version/i);
  assert.equal(fs.existsSync(path.join(out, ARTIFACT_NAME)), false);

  const traversalVersion = makeSourceFixture();
  const traversalManifest = JSON.parse(
    fs.readFileSync(path.join(traversalVersion, "manifest.json"), "utf8"),
  );
  traversalManifest.version = "../evil";
  fs.writeFileSync(
    path.join(traversalVersion, "manifest.json"),
    JSON.stringify(traversalManifest),
  );
  const traversalRun = runFixtureBuild(traversalVersion, out);
  assert.notEqual(traversalRun.status, 0);
  assert.match(traversalRun.stderr, /manifest|version/i);

  const badId = makeSourceFixture();
  const idManifest = JSON.parse(
    fs.readFileSync(path.join(badId, "manifest.json"), "utf8"),
  );
  idManifest.pluginId = "other-plugin";
  fs.writeFileSync(path.join(badId, "manifest.json"), JSON.stringify(idManifest));
  const badIdRun = runFixtureBuild(badId, out);
  assert.notEqual(badIdRun.status, 0);
  assert.match(badIdRun.stderr, /manifest/i);

  const missingFile = makeSourceFixture();
  fs.unlinkSync(path.join(missingFile, "options.json"));
  const missingRun = runFixtureBuild(missingFile, out);
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /missing runtime file/i);
  assert.equal(fs.existsSync(path.join(out, ARTIFACT_NAME)), false);

  const symlinkSource = makeSourceFixture();
  const outside = path.join(symlinkSource, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  fs.unlinkSync(path.join(symlinkSource, "i18n.json"));
  fs.symlinkSync(outside, path.join(symlinkSource, "i18n.json"));
  const symlinkRun = runFixtureBuild(symlinkSource, out);
  assert.notEqual(symlinkRun.status, 0);
  assert.match(symlinkRun.stderr, /symlink/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
  assert.equal(fs.existsSync(path.join(out, ARTIFACT_NAME)), false);
});

test("crafted malicious archive policy fixtures match the intended entry policy", { timeout: 30000 }, () => {
  // Policy fixtures only, not production validation: they exercise this test's
  // own reader so the host unpacker remains the authoritative safety boundary.
  // Production build validation is covered by the actual-artifact tests.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-memox-evil-"));
  const fixtures = [
    {
      name: "duplicate entries",
      entries: [
        { name: "manifest.json", data: "a" },
        { name: "manifest.json", data: "b" },
      ],
    },
    {
      name: "absolute path",
      entries: [{ name: "/tmp/evil.txt", data: "x" }],
    },
    {
      name: "parent traversal",
      entries: [{ name: "../evil.txt", data: "x" }],
    },
    {
      name: "nested traversal",
      entries: [{ name: "lib/../../evil.txt", data: "x" }],
    },
    {
      name: "backslash path",
      entries: [{ name: "evil\\x.txt", data: "x" }],
    },
    {
      name: "symlink entry",
      entries: [{ name: "manifest.json", external: 0o120777 << 16 }],
    },
    {
      name: "special file entry",
      entries: [{ name: "manifest.json", external: 0o010600 << 16 }],
    },
    {
      name: "extra file outside whitelist",
      entries: [
        ...RUNTIME_FILES.map((file) => ({ name: file, data: "x" })),
        { name: "README.md", data: "x" },
      ],
    },
  ];

  for (const fixture of fixtures) {
    const file = path.join(dir, `${fixture.name.replace(/\s+/g, "-")}.zip`);
    writeZip(file, fixture.entries);
    assert.throws(
      () => assertSafeZip(file),
      undefined,
      `${fixture.name} must be rejected`,
    );
  }
});

test("failed rebuild preserves the previous package atomically", { timeout: 30000 }, () => {
  const out = makeOutputDir();
  const first = runBuild(out);
  assert.equal(first.status, 0, first.stderr);

  const artifact = path.join(out, ARTIFACT_NAME);
  const sidecar = path.join(out, SIDE_CAR_NAME);
  const oldHash = sha256(artifact);
  const oldSidecar = fs.readFileSync(sidecar, "utf8");

  const failed = runBuild(out, {
    MEMOX_BUILD_SIMULATE_FINAL_MOVE_FAILURE: "1",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /simulated final move failure/i);
  assert.equal(sha256(artifact), oldHash, "old artifact must be unchanged");
  assert.equal(
    fs.readFileSync(sidecar, "utf8"),
    oldSidecar,
    "old sidecar must be unchanged",
  );
  const leftovers = fs
    .readdirSync(out)
    .filter((name) => name.includes(".tmp") || name.startsWith("."));
  assert.deepEqual(leftovers, [], "no temp residue may remain");
});
