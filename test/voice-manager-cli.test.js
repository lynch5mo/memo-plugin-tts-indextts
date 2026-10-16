"use strict";

// 4B2 显式 CLI：参数解析、显式初始化、正常启动/关闭、help 与信号只关自己 server。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const cli = require("../manager/index.js");
const store = require("../manager/store.js");
const fx = require("./helpers/server-fixture.js");

function mktemp(prefix = "memo-4b2-cli-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("parseArgs：显式 root、port、--initialize 与 --help 解析正确", () => {
  const parsed = cli.parseArgs(["--root", "/tmp/example", "--port", "8123", "--initialize"]);
  assert.equal(parsed.root, "/tmp/example");
  assert.equal(parsed.port, 8123);
  assert.equal(parsed.initialize, true);
  assert.equal(parsed.help, false);

  const minimal = cli.parseArgs(["--root", "/tmp/example"]);
  assert.equal(minimal.port, 0);
  assert.equal(minimal.initialize, false);

  assert.equal(cli.parseArgs(["--help"]).help, true);
  assert.equal(cli.parseArgs(["-h"]).help, true);
});

test("parseArgs：缺 root、未知 flag、非法 port、非 loopback 地址都拒绝", () => {
  const bad = [
    [],
    ["--port", "0"],
    ["--root", "/tmp/example", "--nope"],
    ["--root", "/tmp/example", "--port", "abc"],
    ["--root", "/tmp/example", "--port", "-1"],
    ["--root", "/tmp/example", "--port", "70000"],
    ["--root", "/tmp/example", "--port", "8080.5"],
    ["--host", "0.0.0.0", "--root", "/tmp/example"],
    ["--root", "/tmp/example", "--listen", "0.0.0.0"],
    ["--root"],
  ];
  for (const argv of bad) {
    assert.throws(() => cli.parseArgs(argv), `${argv.join(" ")} 必须拒绝`);
  }
});

test("help 为中文用法说明，且不含任何实际令牌或路径拼装说明", () => {
  const help = cli.helpText();
  assert.match(help, /用法/);
  assert.match(help, /--root/);
  assert.match(help, /--initialize/);
  assert.match(help, /--port/);
  assert.match(help, /127\.0\.0\.1/);
  assert.ok(!/=====|token|localStorage/i.test(help));
});

test("普通启动未初始化目录直接失败，不隐式创建内容", async (t) => {
  const root = mktemp();
  t.after(() => fx.cleanup(root));
  await assert.rejects(cli.run(["--root", root]), (error) => {
    assert.equal(error.code, "ERR_STORE_INCOMPLETE");
    return true;
  });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("--initialize 显式初始化后启动：只监听 127.0.0.1、url 无令牌、close 后可释放", async (t) => {
  const root = mktemp();
  t.after(() => fx.cleanup(root));
  const handle = await cli.run(["--root", root, "--initialize", "--port", "0"]);

  try {
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}`);
    assert.ok(handle.url.startsWith("http://127.0.0.1:"));
    assert.ok(!/[?&]token=/.test(handle.url));
    assert.ok(fs.existsSync(path.join(root, "owner.json")));
    assert.ok(fs.existsSync(path.join(root, "catalog.json")));
    for (const name of ["sources", "voices", "derived", "operations"]) {
      assert.ok(fs.statSync(path.join(root, name)).isDirectory(), `${name} 必须是目录`);
    }
    const session = await fx.bootstrapSession(handle.url);
    assert.equal(session.response.status, 200);
  } finally {
    await handle.close();
  }

  await assert.rejects(fx.api(handle.url, "/api/session"), (error) => {
    assert.ok(error && error.code, "关闭后必须连接失败");
    return true;
  });
});

test("SIGTERM 只关闭自己 server：子进程退出码 0，端口不再接受连接", async (t) => {
  const root = mktemp();
  t.after(() => fx.cleanup(root));
  await store.initialize(root);

  const cliPath = path.join(__dirname, "..", "manager", "index.js");
  const child = spawn(process.execPath, [cliPath, "--root", root, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  });

  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`未在期限内读到启动 url：${buffer}`)), 8000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程提前退出，code=${code}`));
    });
  });

  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  await assert.rejects(fx.api(url, "/api/session"), (error) => {
    assert.ok(error && error.code, "关闭后必须连接失败");
    return true;
  });
  // 资料目录保持原样，不因关闭被删除。
  assert.ok(fs.existsSync(path.join(root, "catalog.json")));
});
