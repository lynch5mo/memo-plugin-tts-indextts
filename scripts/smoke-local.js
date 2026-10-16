"use strict";

// 5A 端到端验收工具（仅 fixture / 证据记录）：经已构建单文件插件入口合成，不直连适配器。
// 不启动模型（除非显式 --start-command 且由主控另行授权）、不重试、不把部分结果标成功。

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const { readCatalog, resolveBinding } = require("../src/catalog.js");
const { decodeVoiceValue } = require("../src/voice-value.js");
const wav = require("../src/wav.js");
const { MODULE_ORDER } = require("./build-runtime.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PLUGIN_ENTRY = path.join(PROJECT_ROOT, "index.js");
const REPORT_JSON_NAME = "report.json";
const REPORT_MD_NAME = "report.md";
const CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_START_WAIT_MS = 10000;
const STOP_GRACE_MS = 2000;
const MAX_CAPTURED_LOG_BYTES = 8192;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_UNVERIFIED = 2;

const SUPPORTED_BACKEND = "audio8";

// 仅记录本次工具自己启动并持有的子进程句柄，供信号处理与 finally 清理使用。
let activeOwned = null;

// 固定三组验收文本：中文、中英混合、含末尾标记的长文本（超过 120 code point，必然分段）。
const SMOKE_CASES = Object.freeze([
  {
    id: "zh",
    label: "中文短句",
    text: "本地音色验收：这是一段中文短句，用于确认合成流程可以返回完整音频。",
  },
  {
    id: "mixed",
    label: "中英混合",
    text: "本地音色验收 mixed sentence: 请确认 Audio8 与 Memo 的组合可以正常合成。",
  },
  {
    id: "long-tail",
    label: "长文本含末尾标记",
    text: [
      "本段用于验证长文本分段合成：请确认每一段都按顺序拼接，且没有任何字符被截断或丢弃。",
      "验收要点包括：源文本必须逐字保存为 source.txt；返回音频必须通过 WAV 容器与时间变化校验；",
      "报告必须记录字节数、采样率、声道数、位深、时长与单调时钟耗时；",
      "任何一段失败都不得把本次运行标成成功，也不得把部分音频当成完整结果。",
      "同时请人工试听确认声音身份与内容完整；在人工确认之前，listenVerified 与 contentEndingVerified 必须保持 false。",
      "【末尾标记：如果听到这句话，说明长文本已经读到结尾】",
    ].join(""),
  },
]);

const FAILURE_TEXT = Object.freeze({
  ERR_CATALOG_INPUT: "catalog 路径参数非法，未执行任何合成。",
  ERR_CATALOG_READ: "无法读取 catalog，未执行任何合成。",
  ERR_CATALOG_JSON: "catalog 不是合法 JSON，未执行任何合成。",
  ERR_CATALOG_SCHEMA: "catalog 结构不符合契约，未执行任何合成。",
  ERR_VOICE_VALUE_INPUT: "音色值非法，未执行任何合成。",
  ERR_VOICE_VALUE_PREFIX: "音色值缺少 localtts 前缀，未执行任何合成。",
  ERR_VOICE_VALUE_ENCODING: "音色值编码非法，未执行任何合成。",
  ERR_VOICE_VALUE_JSON: "音色值正文非法，未执行任何合成。",
  ERR_VOICE_VALUE_SHAPE: "音色值字段不符合契约，未执行任何合成。",
  ERR_VOICE_VALUE_FIELD: "音色值字段非法，未执行任何合成。",
  ERR_VOICE_VALUE_REVISION: "音色值 revision 非法，未执行任何合成。",
  ERR_BINDING_MISSING: "音色值指向的绑定不在 catalog 中，未执行任何合成。",
  ERR_BINDING_REVISION: "音色值已过期（revision 不一致），未执行任何合成。",
  ERR_BINDING_ENDPOINT_MISMATCH: "音色值与绑定端点不一致，未执行任何合成。",
  ERR_BINDING_BACKEND_MISMATCH: "音色值与请求后端不一致，未执行任何合成。",
  ERR_SMOKE_ARGS: "命令行参数非法。",
  ERR_SMOKE_OUTPUT_EXISTS: "输出路径已存在，拒绝覆盖。",
  ERR_SMOKE_OUTPUT: "输出路径非法或不可创建。",
  ERR_SMOKE_BACKEND_UNVERIFIED: "该后端未验证，本工具不连接、不合成。",
  ERR_SMOKE_SERVICE_UNREACHABLE: "服务未启动或不可达，本工具不自动启动。",
  ERR_SMOKE_PROCESS_START: "受控子进程启动失败，已终止本次启动的进程。",
  ERR_SMOKE_START_TIMEOUT: "受控子进程未在限时内就绪，已终止本次启动的进程，不自动重试。",
  ERR_SMOKE_UNEXPECTED: "运行中发生未预期错误，本次结果不标成功。",
  ERR_SMOKE_PLUGIN_ENTRY: "插件入口缺少默认导出，无法经插件合成。",
  ERR_SMOKE_CASE_FAILED: "用例失败，本次运行不标成功。",
});

const USAGE_LINES = Object.freeze([
  "本地端到端验收工具（5A，仅 fixture / 证据记录）",
  "",
  "用法：",
  "  node scripts/smoke-local.js --catalog <catalog.json> --voice <localtts:v1:...> --output <新目录> [选项]",
  "",
  "必填：",
  "  --catalog <路径>   已构建插件使用的 catalog.json 路径（只读）。",
  "  --voice <值>       形如 localtts:v1:... 的音色选择值，backend 由该值绑定决定，不自动 fallback。",
  "  --output <目录>    新建输出目录；必须不存在，不覆盖、不跟随符号链接。",
  "",
  "选项：",
  "  --plugin <路径>    插件入口，默认使用仓库根 index.js（已构建单文件入口）。",
  "  --fixture-only     标记为隔离 fixture 运行；报告 fixtureOnly=true，不冒充真实模型。",
  "  --start-command <可执行文件>  显式启用受控子进程（默认不启动任何服务）。",
  "  --start-arg <值>   传给 --start-command 的固定参数，可重复；不使用 shell。",
  "  --help             显示本帮助。",
  "",
  "说明：",
  "  不带 --start-command 时只连接已运行的服务，绝不启动模型，也绝不停止外部服务。",
  "  带 --start-command 且端口无人监听时，先启动本次持有的进程，再按有界 deadline 等待就绪；",
  "  超时或进程早退会终止本次启动的进程并以失败退出，不自动重试。",
  "  带 --start-command 但端口已有服务时，不启动第二个进程，只连接，绝不持有或停止外部服务。",
  "  合成经插件默认入口 textToSpeech；一次请求不重试，失败不标完整。",
  "  listenVerified / contentEndingVerified / speakerSimilarityVerified 默认 false，需人工试听填写。",
  "  P0 只表示本次运行实际做过的自动检查，不代表全部项目契约都已通过。",
  "  真实 Audio8 启动、音色写入与 Memo 原生导入都需主控另行授权与人工验收。",
]);

function createError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
}

function helpText() {
  return USAGE_LINES.join("\n");
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fixedFailureText(code) {
  return FAILURE_TEXT[code] || "运行失败，未把本次结果标成成功。";
}

// 启动就绪等待阈值只允许收窄，不能放大默认值。
function resolveStartWait(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_START_WAIT_MS) {
    return DEFAULT_START_WAIT_MS;
  }
  return value;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const options = {
    catalog: null,
    voice: null,
    output: null,
    plugin: DEFAULT_PLUGIN_ENTRY,
    fixtureOnly: false,
    startCommand: null,
    startArgs: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--fixture-only") {
      options.fixtureOnly = true;
      continue;
    }
    const takesValue = ["--catalog", "--voice", "--output", "--plugin", "--start-command", "--start-arg"];
    if (takesValue.includes(arg)) {
      const value = args[index + 1];
      if (typeof value !== "string" || value === "") {
        throw createError("ERR_SMOKE_ARGS", `参数 ${arg} 需要一个值。`);
      }
      index += 1;
      if (arg === "--catalog") {
        options.catalog = value;
      } else if (arg === "--voice") {
        options.voice = value;
      } else if (arg === "--output") {
        options.output = value;
      } else if (arg === "--plugin") {
        options.plugin = value;
      } else if (arg === "--start-command") {
        options.startCommand = value;
      } else {
        options.startArgs.push(value);
      }
      continue;
    }
    throw createError("ERR_SMOKE_ARGS", `未知参数 ${arg}，只支持帮助中列出的固定参数。`);
  }

  if (!options.help) {
    if (typeof options.catalog !== "string" || options.catalog === "") {
      throw createError("ERR_SMOKE_ARGS", "必须显式提供 --catalog。");
    }
    if (typeof options.voice !== "string" || options.voice === "") {
      throw createError("ERR_SMOKE_ARGS", "必须显式提供 --voice。");
    }
    if (typeof options.output !== "string" || options.output === "") {
      throw createError("ERR_SMOKE_ARGS", "必须显式提供 --output。");
    }
    if (options.startArgs.length > 0 && options.startCommand === null) {
      throw createError("ERR_SMOKE_ARGS", "--start-arg 只能与 --start-command 一起使用。");
    }
  }
  return options;
}

// 输出目录独占新建：已存在（含符号链接）一律拒绝，绝不覆盖。
function createOutputDir(outputPath) {
  const absolute = path.resolve(outputPath);
  let stats = null;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw createError("ERR_SMOKE_OUTPUT", "无法检查输出目录状态。");
    }
  }
  if (stats) {
    throw createError(
      "ERR_SMOKE_OUTPUT_EXISTS",
      stats.isSymbolicLink()
        ? "输出路径是符号链接，按策略拒绝，避免写出预期目录。"
        : "输出路径已存在，拒绝覆盖已有输出。",
    );
  }
  const parent = path.dirname(absolute);
  if (!fs.statSync(parent).isDirectory()) {
    throw createError("ERR_SMOKE_OUTPUT", "输出目录的父路径不是目录。");
  }
  fs.mkdirSync(absolute, { recursive: false });
  const created = fs.lstatSync(absolute);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw createError("ERR_SMOKE_OUTPUT", "输出目录创建结果不是普通目录。");
  }
  return absolute;
}

// 所有输出文件一律 wx：出现任何已存在内容就失败，不覆盖。
function writeExclusiveFile(target, data) {
  fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
}

function checkConnectivity(baseUrl, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return Promise.resolve({ reachable: false, reason: "endpoint baseUrl 无法解析" });
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(payload);
    };
    socket.setTimeout(timeoutMs, () => finish({ reachable: false, reason: "连接超时" }));
    socket.on("connect", () => finish({ reachable: true, reason: "" }));
    socket.on("error", () => finish({ reachable: false, reason: "连接失败" }));
  });
}

// 受控子进程：固定可执行文件 + argv 数组、shell=false；只停止本次 spawn 并持有的句柄。
// spawn 失败（ENOENT/EACCES 等）走 error 事件，done 必定有界完成，绝不抛未捕获异常或挂起。
function runWithOwnedProcess(options = {}) {
  const file = options.file;
  if (typeof file !== "string" || file.trim() === "") {
    throw createError("ERR_SMOKE_PROCESS_FILE", "必须显式提供受控子进程的可执行文件。");
  }
  const args = Array.isArray(options.args) ? options.args.map((item) => String(item)) : [];

  const state = {
    pid: undefined,
    stdout: "",
    stderr: "",
    truncated: false,
    stopRequested: false,
    forcedKill: false,
    exitCode: null,
    signal: null,
    error: null,
  };

  let child;
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    state.error = { code: "ERR_SMOKE_PROCESS_START", message: boundedMessage(error) };
    return {
      pid: undefined,
      state,
      done: Promise.resolve(state),
      stop() {},
    };
  }
  state.pid = child.pid;

  const capture = (field) => (chunk) => {
    if (state[field].length >= MAX_CAPTURED_LOG_BYTES) {
      state.truncated = true;
      return;
    }
    state[field] += chunk.toString("utf8").slice(0, MAX_CAPTURED_LOG_BYTES - state[field].length);
  };
  if (child.stdout) {
    child.stdout.on("data", capture("stdout"));
  }
  if (child.stderr) {
    child.stderr.on("data", capture("stderr"));
  }

  let settle = null;
  let killTimer = null;
  const clearKillTimer = () => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const done = new Promise((resolve) => {
    settle = (payload) => {
      clearKillTimer();
      resolve(payload);
    };
  });

  let settled = false;
  const finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    settle(state);
  };

  child.on("error", (error) => {
    state.error = { code: error && typeof error.code === "string" ? error.code : "ERR_SMOKE_PROCESS_START", message: boundedMessage(error) };
    finish();
  });
  child.on("close", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
    finish();
  });

  const handle = {
    pid: child.pid,
    state,
    done,
    stop() {
      if (state.stopRequested) {
        return;
      }
      state.stopRequested = true;
      if (typeof child.pid !== "number") {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // 进程已退出时忽略。
      }
      // 只对本次句柄升级：宽限期内未退出则 SIGKILL，绝不无限等待。
      killTimer = setTimeout(() => {
        killTimer = null;
        if (state.exitCode !== null || state.signal !== null || state.error !== null) {
          return;
        }
        state.forcedKill = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出时忽略。
        }
      }, STOP_GRACE_MS);
      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    },
  };

  // 供 main 的信号处理使用：只记录本次持有的句柄。
  activeOwned = handle;
  done.then(() => {
    if (activeOwned === handle) {
      activeOwned = null;
    }
  });
  return handle;
}

function boundedMessage(error) {
  const text = error && error.message ? String(error.message) : String(error || "");
  return text.slice(0, 200);
}

async function waitForConnectivity(baseUrl, deadlineMs, intervalMs = 200, isAborted = null) {
  const started = Date.now();
  for (;;) {
    if (typeof isAborted === "function" && isAborted()) {
      return { reachable: false, reason: "受控子进程已退出或启动失败" };
    }
    const remaining = deadlineMs - (Date.now() - started);
    const result = await checkConnectivity(baseUrl, Math.max(50, Math.min(500, remaining)));
    if (result.reachable) {
      return result;
    }
    if (Date.now() - started >= deadlineMs) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function digestBuildInputs() {
  const lines = [];
  for (const id of MODULE_ORDER) {
    let digest = "missing";
    try {
      digest = sha256Hex(fs.readFileSync(path.join(PROJECT_ROOT, id)));
    } catch {
      digest = "missing";
    }
    lines.push(`${id} ${digest}`);
  }
  return sha256Hex(Buffer.from(lines.join("\n"), "utf8"));
}

function readSourceInfo() {
  const info = { head: null, dirtyTrackedCount: null, dirtyUntrackedCount: null };
  try {
    info.head = execFileSync("git", ["-C", PROJECT_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["-C", PROJECT_ROOT, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = status.split("\n").filter((line) => line.trim() !== "");
    info.dirtyTrackedCount = lines.filter((line) => !line.startsWith("??")).length;
    info.dirtyUntrackedCount = lines.filter((line) => line.startsWith("??")).length;
  } catch {
    // git 不可用时保持 null；不会用 HEAD 冒称内容版本。
  }
  return info;
}

function analyzeAudio(buffer) {
  const parsed = wav.parseWav(buffer);
  const bytesPerSample = parsed.bitsPerSample / 8;
  const frameBytes = parsed.channels * bytesPerSample;
  let peak = 0;
  let nonZero = 0;
  const scanBytes = Math.min(parsed.pcm.length, 400000);
  for (let offset = 0; offset + 2 <= scanBytes; offset += 2) {
    const value = Math.abs(parsed.pcm.readInt16LE(offset));
    if (value > peak) {
      peak = value;
    }
    if (value !== 0) {
      nonZero += 1;
    }
  }
  return {
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: parsed.bitsPerSample,
    pcmBytes: parsed.pcm.length,
    durationSeconds: parsed.pcm.length / frameBytes / parsed.sampleRate,
    peakSample: peak,
    nonZeroSamples: nonZero,
  };
}

// 只用插件固定的中文分类文案做粗分类，绝不记录后端正文或原始错误对象。
function classifyPluginMessage(message) {
  if (typeof message !== "string") {
    return { category: "unknown", unknownCompletion: false };
  }
  if (message.includes("超出时限")) {
    return { category: "timeout", unknownCompletion: true };
  }
  if (message.includes("繁忙")) {
    return { category: "busy", unknownCompletion: false };
  }
  if (message.includes("尚未通过在线核验")) {
    return { category: "not-verified", unknownCompletion: false };
  }
  return { category: "plugin-category", unknownCompletion: false };
}

function buildMarkdown(report) {
  const lines = [];
  lines.push("# 本地端到端验收记录（5A）");
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 运行模式：${report.fixtureOnly ? "隔离 fixture（fixtureOnly=true）" : "本机连接（实机未验证）"}`);
  lines.push(`- 结果：${report.status === "passed" ? "本次 smoke 自动检查通过" : "失败"}`);
  lines.push(`- P0 口径：${report.p0Scope}`);
  lines.push(`- 插件入口：${report.plugin.entry}`);
  lines.push(`- 插件入口 SHA256：${report.plugin.indexSha256}`);
  lines.push(`- 插件构建输入摘要：${report.plugin.buildInputsSha256}`);
  lines.push(`- 源码 HEAD：${report.source.head === null ? "未记录（git 不可用）" : report.source.head}`);
  lines.push(`- 未提交文件计数：已跟踪 ${report.source.dirtyTrackedCount}，未跟踪 ${report.source.dirtyUntrackedCount}`);
  lines.push(`- 输出目录：${report.output.dir}`);
  lines.push("");
  lines.push("## 身份");
  lines.push("");
  if (report.identity === null) {
    lines.push("- 未解析出音色身份（运行在解析阶段失败）。");
  } else {
    lines.push(`- 音色值：${report.identity.voiceValue}`);
    lines.push(
      `- 后端/端点/绑定：${report.identity.backendId} / ${report.identity.endpointId} / ${report.identity.bindingId}（revision ${report.identity.revision}）`,
    );
    lines.push(`- 资料标签：${report.identity.label}`);
  }
  lines.push("");
  lines.push("## 用例结果");
  lines.push("");
  if (report.cases.length === 0) {
    lines.push("- 未执行任何用例。");
  }
  for (const item of report.cases) {
    if (item.result === "ok") {
      lines.push(
        `- ${item.label}：通过；源文本 ${item.sourceBytes} 字节，音频 ${item.audioBytes} 字节，${item.format.sampleRate}Hz/${item.format.channels}ch/${item.format.bitsPerSample}bit，时长 ${item.durationSeconds.toFixed(3)}s，耗时 ${item.elapsedMs}ms，峰值样本 ${item.peakSample}`,
      );
    } else {
      lines.push(`- ${item.label}：失败；分类 ${item.category}；耗时 ${item.elapsedMs}ms；未自动重发`);
    }
  }
  lines.push("");
  lines.push("## 阶段结论");
  lines.push("");
  lines.push(`- P0 本次 smoke 自动检查：${report.phases.p0}（仅代表本次实际执行的检查）`);
  lines.push(`- P1 真实 Audio8 发声：${report.phases.p1}`);
  lines.push(`- P2 真实 Memo 原生导入：${report.phases.p2}`);
  lines.push(`- P3 生命周期与第二后端：${report.phases.p3}`);
  lines.push("");
  lines.push("## 人工验收（默认未完成）");
  lines.push("");
  lines.push(`- listenVerified：${report.verification.listenVerified}`);
  lines.push(`- contentEndingVerified：${report.verification.contentEndingVerified}`);
  lines.push(`- speakerSimilarityVerified：${report.verification.speakerSimilarityVerified}`);
  lines.push(`- 峰值 RSS：${report.resources.peakRssBytes === null ? "未测（无真实子进程证据）" : report.resources.peakRssBytes}`);
  lines.push("");
  lines.push("WAV 有效不等于全文读完，也不等于音色身份正确；以上三项必须由人工试听填写，本工具不会自动标记。");
  lines.push("");
  if (report.failureCode) {
    lines.push(`失败分类：${report.failureCode}（${report.failureMessage}）`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function writeReports(outputDir, report) {
  writeExclusiveFile(path.join(outputDir, REPORT_JSON_NAME), `${JSON.stringify(report, null, 2)}\n`);
  writeExclusiveFile(path.join(outputDir, REPORT_MD_NAME), buildMarkdown(report));
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "unknown";
  }
}

async function runSmoke(options) {
  const outputDir = createOutputDir(options.output);
  const pluginEntry = path.resolve(options.plugin || DEFAULT_PLUGIN_ENTRY);

  const report = {
    tool: "memo-tts-local-smoke",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixtureOnly: options.fixtureOnly === true,
    status: "failed",
    exitCode: EXIT_FAILED,
    command: {
      node: process.version,
      platform: process.platform,
      argv: (Array.isArray(options.rawArgv) ? options.rawArgv : []).slice(0, 40),
    },
    plugin: {
      entry: pluginEntry,
      indexSha256: fs.existsSync(pluginEntry) ? sha256Hex(fs.readFileSync(pluginEntry)) : null,
      buildInputsSha256: digestBuildInputs(),
    },
    source: readSourceInfo(),
    identity: null,
    output: { dir: outputDir },
    connectivity: { reachable: false, reason: "" },
    cases: [],
    verification: {
      listenVerified: false,
      contentEndingVerified: false,
      speakerSimilarityVerified: false,
    },
    phases: { p0: "failed", p1: "notVerified", p2: "notVerified", p3: "notVerified" },
    p0Scope: "本次 smoke 实际执行的自动检查（参数、输出独占、经插件合成、WAV 有效、源文本完整、失败不标成功），不代表全部项目契约都已通过。",
    safety: { retries: 0, partialSuccess: false, externalServiceStopped: false, ownedProcess: null },
    resources: { peakRssBytes: null, peakRssMethod: "未测（没有可归属的本次子进程证据）" },
    failureCode: null,
    failureMessage: null,
  };

  const fail = (code, message) => {
    report.failureCode = code;
    report.failureMessage = message || fixedFailureText(code);
    report.status = "failed";
    report.phases.p0 = "failed";
    report.exitCode = code === "ERR_SMOKE_BACKEND_UNVERIFIED" ? EXIT_UNVERIFIED : EXIT_FAILED;
  };

  let owned = null;
  try {
    const attempt = async () => {
      let catalog;
      let decoded;
      let resolved;
      try {
        catalog = readCatalog(path.resolve(options.catalog));
        decoded = decodeVoiceValue(options.voice);
        resolved = resolveBinding(catalog, decoded.backendId, options.voice);
      } catch (error) {
        fail(error && error.code, fixedFailureText(error && error.code));
        return;
      }

      const profile = catalog.profiles.find((item) => item.id === resolved.binding.profileId) || null;
      report.identity = {
        voiceValue: options.voice,
        backendId: decoded.backendId,
        endpointId: decoded.endpointId,
        bindingId: decoded.bindingId,
        revision: decoded.revision,
        nativeVoiceId: resolved.binding.nativeVoiceId,
        modelFingerprint: resolved.binding.modelFingerprint,
        profileId: resolved.binding.profileId,
        label: profile ? String(profile.label) : "",
      };

      if (decoded.backendId !== SUPPORTED_BACKEND) {
        fail("ERR_SMOKE_BACKEND_UNVERIFIED");
        return;
      }

      let plugin;
      try {
        plugin = require(pluginEntry);
      } catch {
        plugin = null;
      }
      if (!plugin || typeof plugin.default !== "function") {
        fail("ERR_SMOKE_PLUGIN_ENTRY");
        return;
      }

      // 启动顺序：先在探测，再决定启动还是只连接。端口已有服务时绝不启动第二个进程争用。
      const baseUrl = resolved.endpoint.baseUrl;
      const firstProbe = await checkConnectivity(baseUrl, CONNECT_TIMEOUT_MS);
      if (options.startCommand && firstProbe.reachable) {
        report.connectivity = {
          ...firstProbe,
          baseUrlHost: safeHost(baseUrl),
          mode: "externalExisting",
        };
        report.safety.ownedProcess = {
          started: false,
          spawnShell: false,
          reason: "port-already-listening",
          note: "端口已有服务，只连接本次运行，不持有也不停止该进程。",
        };
      } else if (options.startCommand) {
        owned = runWithOwnedProcess({
          file: options.startCommand,
          args: options.startArgs,
          cwd: PROJECT_ROOT,
        });
        report.safety.ownedProcess = {
          pid: owned.pid,
          started: true,
          spawnShell: false,
          reason: "started-by-tool",
        };
        const startWaitMs = resolveStartWait(options.startWaitMs);
        const ready = await waitForConnectivity(baseUrl, startWaitMs, 200, () => {
          return owned.state.exitCode !== null || owned.state.signal !== null || owned.state.error !== null;
        });
        report.connectivity = { ...ready, baseUrlHost: safeHost(baseUrl), mode: "startedByTool" };
        if (!ready.reachable) {
          fail(owned.state.error ? "ERR_SMOKE_PROCESS_START" : "ERR_SMOKE_START_TIMEOUT");
          return;
        }
      } else {
        report.connectivity = { ...firstProbe, baseUrlHost: safeHost(baseUrl), mode: "externalExisting" };
        if (!firstProbe.reachable) {
          fail("ERR_SMOKE_SERVICE_UNREACHABLE");
          return;
        }
      }

      const tts = new plugin.default({
        catalogPath: path.resolve(options.catalog),
        model: decoded.backendId,
        voiceName: options.voice,
      });

      for (const smokeCase of SMOKE_CASES) {
        const caseDir = path.join(outputDir, "cases", smokeCase.id);
        fs.mkdirSync(caseDir, { recursive: true });
        const source = Buffer.from(smokeCase.text, "utf8");
        const sourceFile = path.join(caseDir, "source.txt");
        writeExclusiveFile(sourceFile, source);

        const startedAtNs = process.hrtime.bigint();
        let result;
        let thrown = null;
        try {
          result = await tts.textToSpeech({ text: smokeCase.text });
        } catch (error) {
          thrown = error;
        }
        const elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAtNs) / 1000) / 1000;

        if (thrown || !Buffer.isBuffer(result)) {
          const classified = classifyPluginMessage(typeof result === "string" ? result : null);
          report.cases.push({
            id: smokeCase.id,
            label: smokeCase.label,
            result: "failed",
            category: thrown ? "plugin-threw" : classified.category,
            unknownCompletion: thrown ? true : classified.unknownCompletion,
            retrySafe: false,
            sourceFile,
            sourceBytes: source.length,
            sourceSha256: sha256Hex(source),
            elapsedMs,
            audioFile: null,
            audioBytes: null,
          });
          fail("ERR_SMOKE_CASE_FAILED", `用例 ${smokeCase.label} 失败，本次运行不标成功。`);
          return;
        }

        const audio = result;
        let analysis;
        try {
          analysis = analyzeAudio(audio);
        } catch {
          report.cases.push({
            id: smokeCase.id,
            label: smokeCase.label,
            result: "failed",
            category: "invalid-wav",
            unknownCompletion: false,
            retrySafe: false,
            sourceFile,
            sourceBytes: source.length,
            sourceSha256: sha256Hex(source),
            elapsedMs,
            audioFile: null,
            audioBytes: audio.length,
          });
          fail("ERR_SMOKE_CASE_FAILED", `用例 ${smokeCase.label} 返回的音频未通过 WAV 校验。`);
          return;
        }

        const audioFile = path.join(caseDir, "audio.wav");
        writeExclusiveFile(audioFile, audio);
        report.cases.push({
          id: smokeCase.id,
          label: smokeCase.label,
          result: "ok",
          category: null,
          unknownCompletion: false,
          retrySafe: false,
          sourceFile,
          sourceBytes: source.length,
          sourceSha256: sha256Hex(source),
          elapsedMs,
          audioFile,
          audioBytes: audio.length,
          audioSha256: sha256Hex(audio),
          format: {
            sampleRate: analysis.sampleRate,
            channels: analysis.channels,
            bitsPerSample: analysis.bitsPerSample,
          },
          durationSeconds: analysis.durationSeconds,
          peakSample: analysis.peakSample,
          nonZeroSamples: analysis.nonZeroSamples,
        });
      }

      report.status = "passed";
      report.phases.p0 = "passed";
      report.exitCode = EXIT_OK;
    };

    try {
      await attempt();
    } catch (error) {
      // 未预期异常也必须落成失败报告，绝不把没有音频的运行标成成功。
      if (!report.failureCode) {
        fail("ERR_SMOKE_UNEXPECTED", fixedFailureText(error && error.code) || FAILURE_TEXT.ERR_SMOKE_UNEXPECTED);
      }
    }
  } finally {
    if (owned) {
      owned.stop();
      await Promise.race([owned.done, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 1000))]);
      report.safety.ownedProcess = {
        ...report.safety.ownedProcess,
        pid: owned.pid,
        started: true,
        spawnShell: false,
        stopRequested: owned.state.stopRequested,
        forcedKill: owned.state.forcedKill,
        spawnError: owned.state.error,
        exitCode: owned.state.exitCode,
        signal: owned.state.signal,
      };
      report.safety.externalServiceStopped = false;
    }
  }

  writeReports(outputDir, report);
  return { report, exitCode: report.exitCode };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${helpText()}\n`);
    return EXIT_FAILED;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }
  options.rawArgv = argv;

  // 信号只清理本次工具自己启动并持有的子进程；外部既有服务永不受影响。
  const shutdown = async (signal) => {
    if (activeOwned) {
      activeOwned.stop();
      await Promise.race([
        activeOwned.done,
        new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 1000)),
      ]);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  let result;
  try {
    result = await runSmoke(options);
  } catch (error) {
    process.stderr.write(`${fixedFailureText(error && error.code)}\n`);
    return EXIT_FAILED;
  }

  const report = result.report;
  process.stdout.write(
    `${result.exitCode === EXIT_OK ? "通过" : "失败"}：P0=${report.phases.p0}，输出目录 ${report.output.dir}\n`,
  );
  if (result.exitCode !== EXIT_OK) {
    process.stderr.write(`${report.failureCode || "ERR_SMOKE_CASE_FAILED"}：${report.failureMessage || "运行失败"}\n`);
  }
  return result.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(EXIT_FAILED);
    });
}

module.exports = {
  parseArgs,
  helpText,
  runSmoke,
  runWithOwnedProcess,
  waitForConnectivity,
  createOutputDir,
  analyzeAudio,
  SMOKE_CASES,
  MODULE_ORDER,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_UNVERIFIED,
  DEFAULT_START_WAIT_MS,
};
