"use strict";

// 4B2 显式启动入口：root 必须显式给出，只有 --initialize 才会创建自有资料目录。
// 不默认写用户目录，不自动打开浏览器，不启动或停止任何模型进程。

const store = require("./store.js");
const { createManagerServer, BIND_ADDRESS } = require("./server.js");

const USAGE_LINES = Object.freeze([
  "本地音色管理工具（Memo 多后端 TTS）",
  "",
  "用法：",
  "  node manager/index.js --root <资料根> [--port 0] [--initialize]",
  "",
  "参数：",
  "  --root <路径>   必填。显式指定本工具自己的资料根；不会被默认用户目录替代。",
  "  --port <端口>   可选。0（默认）表示自动分配；只监听 127.0.0.1，不接受外部地址。",
  "  --initialize    可选。仅当显式给出时才在空目录创建 owner.json、catalog.json 与子目录。",
  "  --help          显示本帮助。",
  "",
  "说明：",
  "  普通启动只校验既有资料目录，不会隐式初始化、不会创建或改写任何资料。",
  "  页面只访问本机 127.0.0.1；服务不提供任意文件读取、不控制模型进程。",
  "  停止：在本终端按 Ctrl+C。停止只关闭本服务，不停止模型、不删除资料与锁。",
]);

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function helpText() {
  return USAGE_LINES.join("\n");
}

function parseArgs(argv) {
  const options = { root: null, port: 0, initialize: false, help: false };
  const args = Array.isArray(argv) ? argv : [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--initialize") {
      options.initialize = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[index + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        throw createError("ERR_CLI_ROOT", "参数 --root 需要一个显式资料根路径。");
      }
      options.root = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw createError("ERR_CLI_PORT", "参数 --port 需要 0 到 65535 的整数。");
      }
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port > 65535) {
        throw createError("ERR_CLI_PORT", "参数 --port 需要 0 到 65535 的整数。");
      }
      options.port = port;
      index += 1;
      continue;
    }
    throw createError("ERR_CLI_FLAG", `未知参数 ${arg}，只支持 --root/--port/--initialize/--help。`);
  }

  if (!options.help && (typeof options.root !== "string" || options.root.trim() === "")) {
    throw createError("ERR_CLI_ROOT", "必须显式提供 --root <资料根>，不默认使用用户目录。");
  }
  return options;
}

async function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    return { help: true, text: helpText() };
  }
  if (options.initialize) {
    await store.initialize(options.root);
  }
  return createManagerServer({ root: options.root, port: options.port });
}

async function main() {
  let handle;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    if (options.initialize) {
      await store.initialize(options.root);
    }
    handle = await createManagerServer({ root: options.root, port: options.port });
  } catch (error) {
    process.stderr.write(`启动失败：${error.message}\n\n${helpText()}\n`);
    return 1;
  }

  process.stdout.write(`本机管理服务已启动：${handle.url}\n`);
  process.stdout.write(`监听地址：${BIND_ADDRESS}（仅本机）\n`);
  process.stdout.write(`资料根：${handle.root}\n`);
  process.stdout.write("按 Ctrl+C 停止。停止只关闭本服务，不停止模型、不删除资料与锁。\n");

  const shutdown = (signal) => {
    process.stdout.write(`收到 ${signal}，正在关闭本机管理服务。\n`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return null;
}

if (require.main === module) {
  main()
    .then((code) => {
      if (typeof code === "number") {
        process.exit(code);
      }
    })
    .catch((error) => {
      process.stderr.write(`启动失败：${error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  helpText,
  run,
  main,
  USAGE_LINES,
};
