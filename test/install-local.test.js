const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const INSTALL = path.join(REPO_ROOT, "scripts", "install-local.sh");
const VERIFY = path.join(REPO_ROOT, "scripts", "verify-local.sh");
const PLUGIN_ID = "memo-plugin-tts-gptsovits";
const PLUGIN_VERSION = "2.0.0";
const PLUGIN_DIR = `${PLUGIN_ID}@${PLUGIN_VERSION}`;
const EXPECTED_FILES = [
  "manifest.json",
  "index.js",
  "i18n.json",
  "options.json",
  "icon.svg",
];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memo-install-test-"));
  const memoRoot = path.join(root, "Memo");
  for (const dir of [
    "plugins",
    "plugin-staging",
    "plugin-backups",
    `plugins/${PLUGIN_DIR}`,
  ]) {
    fs.mkdirSync(path.join(memoRoot, dir), { recursive: true });
  }
  fs.writeFileSync(
    path.join(memoRoot, "plugins", PLUGIN_DIR, "old-marker.txt"),
    "old\n",
  );
  return memoRoot;
}

function run(script, args, env = {}, cwd = REPO_ROOT) {
  return spawnSync("bash", [script, ...args], {
    cwd,
    env: { ...process.env, INSTALL_TEST_ROOT: "1", ...env },
    encoding: "utf8",
    timeout: 20000,
  });
}

function installOk(root, runId) {
  return run(INSTALL, ["--root", root, "--run-id", runId]);
}

function verifyOk(root) {
  return run(VERIFY, ["--root", root, "--plugin-version", PLUGIN_VERSION]);
}

test("normal install -> verify -> backup keeps old plugin", { timeout: 30000 }, () => {
  const root = makeRoot();
  const installed = installOk(root, "run-normal");
  assert.equal(installed.status, 0, installed.stderr);
  for (const file of EXPECTED_FILES) {
    assert.ok(
      fs.existsSync(path.join(root, "plugins", PLUGIN_DIR, file)),
      `missing ${file}`,
    );
  }
  assert.equal(fs.existsSync(path.join(root, "plugins", PLUGIN_DIR, "old-marker.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "plugin-backups", PLUGIN_ID, "run-normal", "old-marker.txt"), "utf8"), "old\n");
  assert.equal(fs.readdirSync(path.join(root, "plugin-staging")).length, 0);
  const verified = verifyOk(root);
  assert.equal(verified.status, 0, verified.stderr);
});

test("run id traversal is rejected and cannot move another plugin", { timeout: 20000 }, () => {
  const root = makeRoot();
  const victim = path.join(root, "plugins", "other-plugin@9.9.9");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "marker.txt"), "keep\n");
  const result = installOk(root, "../plugins/other-plugin@9.9.9");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid run id/i);
  assert.equal(fs.readFileSync(path.join(victim, "marker.txt"), "utf8"), "keep\n");
  assert.equal(fs.readdirSync(path.join(root, "plugin-staging")).length, 0);
});

test("pre-seeded staging is rejected", { timeout: 20000 }, () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "plugin-staging", "run-pre"), { recursive: true });
  const result = installOk(root, "run-pre");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staging already exists/i);
});

test("staging symlink or extra file is rejected", { timeout: 20000 }, () => {
  const root = makeRoot();
  const outside = path.join(root, "outside-sentinel.txt");
  fs.writeFileSync(outside, "outside\n");
  const staging = path.join(root, "plugin-staging", "run-sym");
  fs.mkdirSync(staging, { recursive: true });
  fs.symlinkSync(outside, path.join(staging, "options.json"));
  fs.writeFileSync(path.join(staging, "extra.txt"), "extra\n");
  const result = installOk(root, "run-sym");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staging already exists|symlink|unexpected or missing/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
  assert.equal(fs.existsSync(path.join(root, "plugins", PLUGIN_DIR, "extra.txt")), false);
});

test("real canonical Memo root is always rejected read-only", { timeout: 20000 }, () => {
  const realRoot = path.join(os.homedir(), "Library", "Application Support", "Memo");
  if (!fs.existsSync(realRoot)) {
    return;
  }
  for (const env of [{ INSTALL_TEST_ROOT: "" }, { INSTALL_TEST_ROOT: "1" }]) {
    const result = run(INSTALL, ["--root", realRoot, "--run-id", "should-never-install"], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /direct installation to the real Memo root is unsupported/i);
  }
});

test("real Memo root filesystem aliases are rejected before staging is created", { timeout: 20000 }, () => {
  const realRoot = path.join(os.homedir(), "Library", "Application Support", "Memo");
  if (!fs.existsSync(realRoot)) {
    return;
  }
  const before = fs.readdirSync(realRoot).sort();
  const aliases = new Set();
  aliases.add(path.join(os.homedir(), "Library", "Application Support", "memo"));
  const symlinkParent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-real-alias-"));
  const symlinkAlias = path.join(symlinkParent, "MemoAlias");
  try {
    fs.symlinkSync(realRoot, symlinkAlias, "dir");
    aliases.add(symlinkAlias);
  } catch {}
  for (const alias of aliases) {
    if (!fs.existsSync(alias)) continue;
    for (const env of [{ INSTALL_TEST_ROOT: "" }, { INSTALL_TEST_ROOT: "1" }]) {
      const result = run(INSTALL, ["--root", alias, "--run-id", "legal-run"], env);
      assert.notEqual(result.status, 0, alias + " must be rejected");
      assert.match(result.stderr, /direct installation to the real Memo root is unsupported/i);
    }
    assert.equal(fs.existsSync(path.join(realRoot, "plugin-staging", "legal-run")), false);
    assert.deepEqual(fs.readdirSync(realRoot).sort(), before);
  }
});

test("fake Memo command line is irrelevant to a temp-root install", { timeout: 25000 }, async () => {
  const root = makeRoot();
  const fake = path.join(root, "Memo.app.fake");
  fs.mkdirSync(path.join(fake, "Contents", "MacOS"), { recursive: true });
  const fakeBin = path.join(fake, "Contents", "MacOS", "Memo");
  fs.writeFileSync(fakeBin, "#!/bin/sh\nsleep 2\n", { mode: 0o755 });
  const child = spawn(fakeBin, [], { cwd: root, detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  try {
    const result = run(INSTALL, ["--root", root, "--run-id", "run-fake"], { INSTALL_TEST_ROOT: "" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
});

test("plugins symlink escaping root is rejected by install and verify", { timeout: 20000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-symlink-root-"));
  const root = path.join(parent, "Memo");
  const outside = path.join(parent, "outside");
  for (const dir of ["plugin-staging", "plugin-backups"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(outside, PLUGIN_DIR), { recursive: true });
  for (const file of EXPECTED_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file));
    fs.mkdirSync(path.dirname(path.join(outside, PLUGIN_DIR, file)), { recursive: true });
    fs.writeFileSync(path.join(outside, PLUGIN_DIR, file), content);
  }
  fs.symlinkSync(outside, path.join(root, "plugins"), "dir");

  const installed = installOk(root, "run-symlink");
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, /path escapes root/i);
  assert.equal(fs.existsSync(path.join(outside, PLUGIN_DIR, "old-marker.txt")), false);

  const verified = verifyOk(root);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /path escapes root|path escapes plugins/i);
  assert.equal(fs.existsSync(path.join(outside, PLUGIN_DIR, "index.js")), true);
});

test("plugin dir symlink escaping root is rejected by verify", { timeout: 20000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-plugin-symlink-"));
  const root = path.join(parent, "Memo");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  for (const file of EXPECTED_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file));
    fs.mkdirSync(path.dirname(path.join(outside, file)), { recursive: true });
    fs.writeFileSync(path.join(outside, file), content);
  }
  fs.symlinkSync(outside, path.join(root, "plugins", PLUGIN_DIR), "dir");

  const verified = verifyOk(root);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /path escapes plugins|symlink/i);
});

test("apostrophe in root path is safe", { timeout: 20000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "memo-quote-"));
  const root = path.join(parent, "Memo'quoted");
  for (const dir of [
    "plugins",
    "plugin-staging",
    "plugin-backups",
    `plugins/${PLUGIN_DIR}`,
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "plugins", PLUGIN_DIR, "old-marker.txt"), "old\n");
  const installed = installOk(root, "run-quote");
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(fs.existsSync(path.join(root, "plugins", PLUGIN_DIR, "index.js")));
  const verified = verifyOk(root);
  assert.equal(verified.status, 0, verified.stderr);
});

test("malicious plugin version and backup collision are rejected", { timeout: 20000 }, () => {
  const root = makeRoot();
  const versionResult = run(VERIFY, ["--root", root, "--plugin-version", "../other"]);
  assert.notEqual(versionResult.status, 0);
  assert.match(versionResult.stderr, /invalid plugin version/i);
  const first = installOk(root, "run-same");
  assert.equal(first.status, 0, first.stderr);
  const second = installOk(root, "run-same");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /backup run id already exists/i);
});

test("final move failure restores the previous plugin dir", { timeout: 20000 }, () => {
  const root = makeRoot();
  const installed = installOk(root, "run-ok");
  assert.equal(installed.status, 0, installed.stderr);
  const failed = run(INSTALL, ["--root", root, "--run-id", "run-fail"], {
    INSTALL_SIMULATE_FINAL_MOVE_FAILURE: "1",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /final move failed|simulated final move failure/i);
  assert.ok(fs.existsSync(path.join(root, "plugins", PLUGIN_DIR, "index.js")));
  assert.equal(fs.existsSync(path.join(root, "plugin-backups", PLUGIN_ID, "run-fail")), false);
});
