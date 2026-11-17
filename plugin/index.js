"use strict";

/**
 * Memo TTS 插件：调用 ai-studio 上的 IndexTTS 2.5（vm2 沙箱，仅 Node 核心模块）。
 * 音色由服务端 voices 库提供；语速通过 target_duration_ms 让服务端把音频拉伸到目标时长。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:7861";
const DEFAULT_VOICE = "default";
// 基准语速：中文按字，英文按词
const BASE_CPS_ZH = 5.2;   // 字/秒
const BASE_WPS_EN = 4.0;   // 词/秒
const SAMPLE_RATE = 22050;
const ORACLE = "http://127.0.0.1:7872";   // 槽位预言机（只读，按需启动）
const MAX_TEXT = 20000;

function httpJson(method, urlStr, bodyStr, timeoutMs) {
  const http = require("http");
  const https = require("https");
  const URLImpl = (require("url") && require("url").URL) || URL;
  const url = new URLImpl(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        family: 4,
        headers: bodyStr
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function silentWav(ms) {
  const sr = SAMPLE_RATE, ch = 1, bps = 2;
  const n = Math.round((sr * (ms || 200)) / 1000);
  const size = n * ch * bps;
  const b = Buffer.alloc(44 + size);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + size, 4);
  b.write("WAVE", 8, "ascii"); b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * bps, 28);
  b.writeUInt16LE(ch * bps, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(size, 40);
  return b;
}

function detectLang(text, configured) {
  // 有假名按日语；只要有汉字就按中文（中文里嵌英文词交给模型处理，不要翻成 EN）；
  // 完全不含汉字且字母够多才按英语。配置只在文本无判定依据时兜底。
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
  if (kana > 0) return "JA";
  if (cjk >= 1) return "ZH";
  if (latin >= 4) return "EN";
  return configured === "EN" || configured === "JA" ? configured : "ZH";
}

function countUnits(text, lang) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (lang === "EN") return clean.split(/\s+/).filter(Boolean).length;
  return clean.replace(/[\s，。！？、；：""''（）《》…—,.!?;:'"()\[\]]/g, "").length;
}

function pick(opt, cfg, keys, dflt) {
  for (const k of keys) {
    if (opt && opt[k] != null && opt[k] !== "") return opt[k];
    if (cfg && cfg[k] != null && cfg[k] !== "") return cfg[k];
  }
  return dflt;
}

function resolveConfig(opt, cfg) {
  const baseRaw = String(pick(opt, cfg, ["baseUrl", "apiBase", "endpoint"], DEFAULT_BASE_URL));
  const baseUrl = baseRaw.replace(/\/+$/, "");
  const voice = String(pick(opt, cfg, ["voice", "voiceName"], DEFAULT_VOICE));
  const langRaw = String(pick(opt, cfg, ["language", "lang"], "ZH")).toUpperCase();
  const lang = langRaw.startsWith("EN") ? "EN" : langRaw.startsWith("JA") ? "JA" : "ZH";
  let speed = Number(pick(opt, cfg, ["speed", "rate"], 1.0));
  if (!Number.isFinite(speed) || speed <= 0) speed = 1.0;
  if (speed > 5) speed = speed / 50;   // 兼容 0-100 滑块
  speed = Math.max(0.5, Math.min(2.0, speed));
  return { baseUrl, voice, lang, speed };
}

class TTS {
  constructor(config) {
    // 宿主会传入存储的配置；只保存，不发请求
    this.config = config && typeof config === "object" ? config : {};
  }

  async textToSpeech(options) {
    const opt = options && typeof options === "object" ? options : {};
    try {
      const cfg = this.config || {};
      const text = String(opt.text || "").trim();
      if (text.length > MAX_TEXT) return "IndexTTS[E_LONG] 文本超过 " + MAX_TEXT + " 字符";
      if (!text.replace(/[\s，。！？、；：,.!?;:]/g, "")) return silentWav(200);

      const rc = resolveConfig(opt, cfg);
      const baseUrl = rc.baseUrl, speed = rc.speed;
      const lang = detectLang(text, rc.lang);

      // 音色：配置为 auto（默认）时，按文本询问本机助手所属项目，首次自动采集该播主音色
      let voice = rc.voice;
      if (!voice || voice === "auto") {
        try {
          const body = JSON.stringify({ text: text });
          const r = await httpJson("POST", ORACLE + "/voice/ensure", body, 60000);
          if (r.status === 200 && r.data) {
            const d = JSON.parse(r.data.toString("utf8"));
            if (d && d.ok && d.voice) voice = d.voice;
          }
        } catch (e) { /* 助手没起或采集失败，退回默认音色 */ }
        if (!voice || voice === "auto") voice = "speaker";
      }
      const units = countUnits(text, lang);
      const rate = (lang === "EN" ? BASE_WPS_EN : BASE_CPS_ZH) * speed;
      let targetMs = Math.max(600, Math.round((units / rate) * 1000));
      let maxMs = targetMs;

      // 优先向槽位预言机要真实时长：主要靠文本匹配（宿主不传资源 uuid）
      let oracleHit = null;
      try {
        const q = ORACLE + "/slot?text=" + encodeURIComponent(text);
        const o = await httpJson("GET", q, null, 600);
        if (o.status === 200 && o.data) {
          const d = JSON.parse(o.data.toString("utf8"));
          if (d && d.slot_ms > 0) {
            oracleHit = d;
            targetMs = d.slot_ms;
            maxMs = d.range_ms > 0 ? d.range_ms : d.slot_ms;
          }
        }
      } catch (e) { /* 预言机没起或没匹配到，退回估算 */ }

      // 健康预检，2 秒
      try {
        const h = await httpJson("GET", baseUrl + "/health", null, 2000);
        if (h.status !== 200) return "IndexTTS[E_DOWN] 服务异常 HTTP " + h.status;
      } catch (e) {
        return "IndexTTS[E_DOWN] 服务不可达：" + (e.code || e.message);
      }

      const body = JSON.stringify({
        text: text, lang: lang, voice: voice, speed: speed,
        target_duration_ms: targetMs, max_duration_ms: maxMs, temperature: 0.7,
      });

      let res;
      try {
        res = await httpJson("POST", baseUrl + "/tts", body, Number(opt.timeoutMs || 300000));
      } catch (e) {
        const code = e && e.code ? e.code : "";
        const msg = (e && e.message) || "";
        if (code === "ETIMEDOUT" || msg === "timeout" || msg.indexOf("timeout") >= 0) {
          return "IndexTTS[E_TIMEOUT] 合成超时";
        }
        if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
          return "IndexTTS[E_DOWN] 连接失败：" + code;
        }
        if (code === "ETIMEDOUT") return "IndexTTS[E_TIMEOUT] 合成超时";
        return "IndexTTS[E_FAIL] " + (e.message || String(e));
      }

      if (res.status === 404) return "IndexTTS[E_VOICE] 音色不存在";
      if (res.status !== 200) {
        let detail = "";
        try { detail = res.data.toString("utf8").slice(0, 200); } catch (e) {}
        return "IndexTTS[E_HTTP] HTTP " + res.status + (detail ? "：" + detail : "");
      }
      if (res.data.length <= 44) return "IndexTTS[E_EMPTY] 返回空音频";
      return res.data;
    } catch (err) {
      return "IndexTTS[E_FAIL] " + (err && err.message ? err.message : String(err));
    }
  }
}

function getEditorOptions() {
  return [
    { value: "speaker", label: "主讲人音色" },
    { value: "default", label: "默认音色" },
  ];
}

module.exports = { default: TTS, getEditorOptions };
