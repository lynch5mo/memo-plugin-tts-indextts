"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const registry = require("../src/backends/index.js");
const { BACKENDS } = require("../src/catalog.js");

test("注册表静态映射 audio8 与 gpt-sovits 两个后端", () => {
  assert.deepEqual(registry.listBackends(), ["audio8", "gpt-sovits"]);
  assert.deepEqual([...registry.listBackends()].sort(), [...BACKENDS].sort());

  for (const id of ["audio8", "gpt-sovits"]) {
    const backend = registry.getBackend(id);
    assert.equal(backend.id, id);
    assert.equal(typeof backend.capabilities, "object");
    assert.equal(typeof backend.probe, "function");
    assert.equal(typeof backend.listVoices, "function");
    assert.equal(typeof backend.synthesize, "function");
  }
});

test("注册表复用同一模块实例且对外冻结", () => {
  assert.equal(registry.getBackend("audio8"), registry.getBackend("audio8"));
  assert.equal(registry.getBackend("gpt-sovits"), registry.getBackend("gpt-sovits"));
  assert.ok(Object.isFrozen(registry.backends));
  assert.throws(() => {
    registry.backends.audio8 = null;
  }, TypeError);
});

test("未知后端一律 fail-closed，不接受原型键或路径注入", () => {
  const rejected = [
    "",
    "audio8.js",
    "../audio8.js",
    "/tmp/evil.js",
    "unknown",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    null,
    undefined,
    42,
    {},
    [],
  ];
  for (const id of rejected) {
    assert.throws(
      () => registry.getBackend(id),
      (error) => {
        assert.equal(error.code, "ERR_BACKEND_UNKNOWN", `期望拒绝 ${String(id)}`);
        return true;
      },
    );
  }
});

test("注册表源码不含动态加载或代码执行路径", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "backends", "index.js"),
    "utf8",
  );

  assert.match(source, /require\("\.\/audio8\.js"\)/);
  assert.match(source, /require\("\.\/gpt-sovits\.js"\)/);
  assert.doesNotMatch(source, /eval\(/);
  assert.doesNotMatch(source, /new Function|Function\(/);
  assert.doesNotMatch(source, /import\(/);
  assert.doesNotMatch(source, /require\([^"']/);
  assert.doesNotMatch(source, /process\./);
});
