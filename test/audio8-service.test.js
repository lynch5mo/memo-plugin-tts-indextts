"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "audio8-service.py");
const VENV_PYTHON =
  "/Users/lynch5mo/Applications/Audio8_TTS/onnx_runtime/.venv/bin/python";

// 标准库 stub：身份值只存在于 runtime 对象里，不从命令行或目录回显。
const STUB_SERVICE = [
  "import os",
  "from pathlib import Path",
  "",
  'STUB_FINGERPRINT = "__FINGERPRINT__"',
  "",
  "",
  "class _StubApp:",
  "    def __init__(self):",
  "        self.get_paths = []",
  "",
  "    def get(self, path):",
  "        def decorator(func):",
  "            self.get_paths.append(path)",
  "            return func",
  "",
  "        return decorator",
  "",
  "",
  "class _StubVoices:",
  "    @property",
  "    def root(self):",
  '        return Path(os.environ["ARKTTS_VOICES_DIR"]).resolve()',
  "",
  "",
  "class _StubRuntime:",
  "    @property",
  "    def model_dir(self):",
  '        return Path(os.environ["ARKTTS_MODEL_DIR"]).resolve()',
  "",
  "    @property",
  "    def precision(self):",
  '        return os.environ.get("ARKTTS_PRECISION") or "stub-precision"',
  "",
  "    @property",
  "    def codec_precision(self):",
  '        return os.environ.get("ARKTTS_CODEC_PRECISION") or "stub-codec"',
  "",
  "    @property",
  "    def voices(self):",
  "        return _StubVoices()",
  "",
  "    @property",
  "    def manifest(self):",
  '        return {"model_fingerprint": STUB_FINGERPRINT, "sample_rate": 44100}',
  "",
  "",
  "app = _StubApp()",
  "",
  "",
  "def require_runtime():",
  "    return _StubRuntime()",
  "",
].join("\n");

function commandAvailable(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN_PYTHON = commandAvailable("uv", ["--version"]) && fs.existsSync(VENV_PYTHON);

function mktempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 用现有 uv 离线环境调用脚本；不安装依赖、不下载 Python。
function runHelper(args, { timeout = 60000 } = {}) {
  const cacheDir = mktempDir("memo-2b-uvcache-");
  try {
    const stdout = execFileSync(
      "uv",
      [
        "--cache-dir",
        cacheDir,
        "run",
        "--no-project",
        "--offline",
        "--no-python-downloads",
        "--python",
        VENV_PYTHON,
        "python",
        SCRIPT_PATH,
        ...args,
      ],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        encoding: "utf8",
        timeout,
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function makeStubInstall(fingerprint = "stub-runtime-fingerprint") {
  const root = mktempDir("memo-2b-stub-");
  const pkg = path.join(root, "arktts_runtime");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "__init__.py"), "", "utf8");
  fs.writeFileSync(
    path.join(pkg, "service.py"),
    STUB_SERVICE.replace("__FINGERPRINT__", fingerprint),
    "utf8",
  );
  return root;
}

function buildArgs(stubRoot, modelDir, voicesDir, extra = []) {
  return [
    "--install-root",
    stubRoot,
    "--model-dir",
    modelDir,
    "--voices-dir",
    voicesDir,
    "--precision",
    "int4",
    "--codec-precision",
    "fp16",
    ...extra,
  ];
}

function hasBytecodeCache(root) {
  return fs.existsSync(path.join(root, "arktts_runtime", "__pycache__"));
}

test("audio8-service.py 通过 Python 语法编译检查", (t) => {
  if (!CAN_RUN_PYTHON) {
    t.skip("uv 或 Audio8 venv 不可用");
    return;
  }
  const cacheDir = mktempDir("memo-2b-uvcache-");
  try {
    const stdout = execFileSync(
      "uv",
      [
        "--cache-dir",
        cacheDir,
        "run",
        "--no-project",
        "--offline",
        "--no-python-downloads",
        "--python",
        VENV_PYTHON,
        "python",
        "-c",
        [
          "import pathlib",
          `src = pathlib.Path(${JSON.stringify(SCRIPT_PATH)}).read_text(encoding="utf-8")`,
          `compile(src, ${JSON.stringify(SCRIPT_PATH)}, "exec")`,
          'print("syntax-ok")',
        ].join("\n"),
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.match(stdout, /syntax-ok/);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("self-check 的身份值来自 runtime 对象而非命令行", (t) => {
  if (!CAN_RUN_PYTHON) {
    t.skip("uv 或 Audio8 venv 不可用");
    return;
  }
  const stubRoot = makeStubInstall();
  const modelDir = mktempDir("memo-2b-model-");
  const voicesDir = mktempDir("memo-2b-voices-");
  t.after(() => {
    fs.rmSync(stubRoot, { recursive: true, force: true });
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(voicesDir, { recursive: true, force: true });
  });

  const result = runHelper(buildArgs(stubRoot, modelDir, voicesDir, ["--self-check"]));
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(payload.backendId, "audio8");
  assert.equal(payload.identityPath, "/api/memo/runtime");
  assert.equal(payload.modelFingerprint, "stub-runtime-fingerprint");
  assert.equal(fs.realpathSync(payload.modelDir), fs.realpathSync(modelDir));
  assert.equal(fs.realpathSync(payload.voicesRoot), fs.realpathSync(voicesDir));
  assert.equal(payload.precision, "int4");
  assert.equal(payload.codecPrecision, "fp16");
  assert.equal(typeof payload.instanceId, "string");
  assert.ok(payload.instanceId.length >= 16, "instanceId 应为进程随机值");

  assert.equal(hasBytecodeCache(stubRoot), false, "不得在安装目录写入 bytecode");
});

test("非 loopback 主机在导入安装包之前就被拒绝", (t) => {
  if (!CAN_RUN_PYTHON) {
    t.skip("uv 或 Audio8 venv 不可用");
    return;
  }
  const stubRoot = makeStubInstall();
  const modelDir = mktempDir("memo-2b-model-");
  const voicesDir = mktempDir("memo-2b-voices-");
  t.after(() => {
    fs.rmSync(stubRoot, { recursive: true, force: true });
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(voicesDir, { recursive: true, force: true });
  });

  for (const host of ["0.0.0.0", "10.0.0.5", "example.com"]) {
    const result = runHelper(
      buildArgs(stubRoot, modelDir, voicesDir, ["--host", host, "--self-check"]),
    );
    assert.notEqual(result.status, 0, `host ${host} 必须被拒绝`);
    assert.match(result.stderr, /loopback/);
  }
  assert.equal(hasBytecodeCache(stubRoot), false, "参数校验失败时不得导入安装包");
});

test("install-root、model-dir 与端口参数非法时失败", (t) => {
  if (!CAN_RUN_PYTHON) {
    t.skip("uv 或 Audio8 venv 不可用");
    return;
  }
  const stubRoot = makeStubInstall();
  const emptyRoot = mktempDir("memo-2b-empty-");
  const modelDir = mktempDir("memo-2b-model-");
  const voicesDir = mktempDir("memo-2b-voices-");
  t.after(() => {
    fs.rmSync(stubRoot, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(voicesDir, { recursive: true, force: true });
  });

  const noService = runHelper(buildArgs(emptyRoot, modelDir, voicesDir, ["--self-check"]));
  assert.notEqual(noService.status, 0);
  assert.match(noService.stderr, /service\.py/);

  const missingModel = runHelper(
    buildArgs(stubRoot, path.join(modelDir, "nope"), voicesDir, ["--self-check"]),
  );
  assert.notEqual(missingModel.status, 0);

  const relativeModel = runHelper([
    "--install-root",
    stubRoot,
    "--model-dir",
    "relative/model",
    "--self-check",
  ]);
  assert.notEqual(relativeModel.status, 0);
  assert.match(relativeModel.stderr, /绝对路径/);

  for (const port of ["0", "70000"]) {
    const badPort = runHelper(
      buildArgs(stubRoot, modelDir, voicesDir, ["--port", port, "--self-check"]),
    );
    assert.notEqual(badPort.status, 0);
  }
});

test("辅助入口只增加只读身份接口，不含注册、reload 或权重切换", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  assert.match(source, /\/api\/memo\/runtime/);
  assert.doesNotMatch(source, /@app\.post/);
  assert.doesNotMatch(source, /\.post\(/);
  assert.doesNotMatch(source, /voices\/register/);
  assert.doesNotMatch(source, /runtime\/reload/);
  assert.doesNotMatch(source, /set_gpt_weights|set_sovits_weights/);
  assert.doesNotMatch(source, /subprocess/);
  assert.doesNotMatch(source, /https?:\/\//);
});
