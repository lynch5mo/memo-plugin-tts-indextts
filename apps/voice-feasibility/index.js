"use strict";
// 最小合法 App 模块导出：与 1.8.8 内置 app 插件同形，页面逻辑全在 index.html。
// 不实现任何宿主副作用，只提供一个可被宿主加载的 default class。
var lib_exports = {};
Object.defineProperty(lib_exports, "__esModule", { value: true });
Object.defineProperty(lib_exports, "default", {
  enumerable: true,
  get: () => APP,
});
module.exports = lib_exports;

var APP = class {
  constructor() {
    console.log("voice-feasibility-app");
  }
};
