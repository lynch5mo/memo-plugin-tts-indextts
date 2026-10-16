"use strict";

// 静态后端注册表：只映射随插件一起打包的适配器模块，不动态加载、不执行任何路径或用户模块。

const audio8 = require("./audio8.js");
const gptSovits = require("./gpt-sovits.js");

const backends = Object.freeze({
  audio8,
  "gpt-sovits": gptSovits,
});

const BACKEND_IDS = Object.freeze(["audio8", "gpt-sovits"]);

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getBackend(id) {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(backends, id)) {
    throw createError(
      "ERR_BACKEND_UNKNOWN",
      `未知后端 ${JSON.stringify(id)}；注册表是静态白名单，不动态加载用户模块。`,
    );
  }
  return backends[id];
}

function listBackends() {
  return [...BACKEND_IDS];
}

module.exports = { getBackend, listBackends, backends };
