"use strict";

// 4B2 中文管理页面：静态路由固定映射、安全头、遍历拒绝与页面源码安全不变量。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fx = require("./helpers/server-fixture.js");

const UI_DIR = path.join(__dirname, "..", "manager", "ui");

function readUi(name) {
  return fs.readFileSync(path.join(UI_DIR, name), "utf8");
}

test("静态路由只服务固定三件资源，内容类型、nosniff、no-store 与 CSP 正确", async (t) => {
  const env = await fx.setupServerEnv(t);
  const expected = [
    ["/", "text/html"],
    ["/app.js", "javascript"],
    ["/style.css", "text/css"],
  ];
  for (const [route, type] of expected) {
    const response = await fx.api(env.baseUrl, route);
    assert.equal(response.status, 200, `${route} 必须 200`);
    assert.ok(response.headers["content-type"].includes(type), `${route} content-type=${response.headers["content-type"]}`);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["cache-control"], "no-store");
    const csp = response.headers["content-security-policy"];
    assert.ok(csp, `${route} 必须带 CSP`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!csp.includes("unsafe-inline"), "CSP 不得含 unsafe-inline");
    assert.ok(!response.text.includes("memo-local-tts-managed"), "不得泄漏 store 源码");
  }

  const html = await fx.api(env.baseUrl, "/");
  assert.match(html.text, /\/app\.js/);
  assert.match(html.text, /\/style\.css/);
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.text), "页面不得引用外部资源");
});

test("任意文件读取与编码绕过都被拒绝：只按固定映射返回，不拼接 URL", async (t) => {
  const env = await fx.setupServerEnv(t);
  const attempts = [
    "/../manager/store.js",
    "/..%2fmanager%2fstore.js",
    "/%2e%2e%2fmanager%2fstore.js",
    "/manager/ui/index.html",
    "/ui/index.html",
    "/index.html",
    "/app.js.map",
    "/favicon.ico",
    "/manager/server.js",
  ];
  for (const route of attempts) {
    const response = await fx.api(env.baseUrl, route);
    assert.equal(response.status, 404, `${route} 必须 404，实际 ${response.status}`);
    assert.ok(!response.text.includes("memo-local-tts-managed"), `${route} 不得泄漏源码`);
    assert.ok(!response.text.includes("resourceDir"), `${route} 不得泄漏内部符号`);
  }
});

test("静态路由同样严格 Host 与跨站边界，且只允许 GET", async (t) => {
  const env = await fx.setupServerEnv(t);

  const badHost = await fx.api(env.baseUrl, "/", { headers: { host: "localhost:1" } });
  assert.equal(badHost.status, 403);

  const crossSite = await fx.api(env.baseUrl, "/", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);

  const forwarded = await fx.api(env.baseUrl, "/app.js", { headers: { "x-forwarded-host": "evil.example" } });
  assert.equal(forwarded.status, 403);

  const post = await fx.api(env.baseUrl, "/", { method: "POST", payload: Buffer.from("x", "utf8") });
  assert.equal(post.status, 405);
  assert.equal(env.audio8Server.state.calls.register, 0);
});

test("HTML 结构：中文界面、必需表单控件、已有音色与导入区、状态区 aria-live", () => {
  const html = readUi("index.html");
  assert.match(html, /<html lang="zh-CN">/);
  for (const id of [
    "prepare-form",
    "label-input",
    "audio-file",
    "reference-text",
    "language-input",
    "endpoint-select",
    "persistence-select",
    "authorization-check",
    "prepare-submit",
    "import-form",
    "import-endpoint",
    "import-native",
    "import-label",
    "import-submit",
    "voices-list",
    "status-message",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少控件 ${id}`);
  }
  assert.match(html, /aria-live="polite"/);
  for (const label of ["label-input", "audio-file", "reference-text", "language-input"]) {
    assert.match(html, new RegExp(`for="${label}"`), `${label} 必须有可见标签关联`);
  }
  assert.match(html, /type="checkbox"/);
  assert.match(html, /accept="audio\/\*"/);
});

test("页面源码安全：仅 textContent、无 innerHTML/存储/凭据外泄/自动重试", () => {
  const app = readUi("app.js");
  assert.ok(!app.includes("innerHTML"), "不得使用 innerHTML");
  assert.ok(!app.includes("outerHTML"));
  assert.ok(!app.includes("insertAdjacentHTML"));
  assert.ok(!/localStorage|sessionStorage/.test(app), "不得使用本地存储");
  assert.ok(!/document\.cookie\s*=/.test(app), "不得写 cookie");
  assert.ok(!/\beval\(/.test(app), "不得使用 eval");
  assert.ok(app.includes("textContent"), "必须用 textContent 渲染");
  assert.match(app, /x-memo-tts-csrf/i);
  // CSRF 只保存在模块作用域变量，不进 URL、不进存储。
  assert.match(app, /let csrfToken|const csrfToken|let csrf|let sessionCsrf/);
  assert.ok(!/\?token=|#token=/.test(app));
  // 在途禁用与不自动重试。
  assert.match(app, /\.disabled\s*=\s*true/);
  assert.ok(!/setInterval/.test(app), "不得有轮询重试");
  assert.ok(!/retry/i.test(app), "不得有自动重试逻辑");
  // 上传边界与编码方式。
  assert.match(app, /50 \* 1024 \* 1024/);
  assert.ok(!/\.\.\.new Uint8Array|\.\.\.bytes|\.\.\.buffer/.test(app), "不得 spread 巨型数组");
  assert.ok(app.includes("arrayBuffer"), "必须用 arrayBuffer 读取文件");
  // 不引用外部资源。
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(app));
});

test("样式：色板、本机字体、ID 等宽、窄屏单栏与可见焦点", () => {
  const css = readUi("style.css");
  for (const color of ["#F4F7FA", "#16293E", "#596D80", "#CBD6E0", "#245E8E", "#946729"]) {
    assert.ok(css.toUpperCase().includes(color.toUpperCase()), `缺少色板 ${color}`);
  }
  assert.match(css, /PingFang SC/);
  assert.match(css, /monospace/);
  assert.match(css, /@media[^{]*max-width/);
  assert.match(css, /:focus/);
  assert.match(css, /grid-template-columns/);
  assert.ok(!/https?:\/\//.test(css), "样式不得引用外部资源");
});
