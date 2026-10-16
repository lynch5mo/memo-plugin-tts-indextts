"use strict";

// GPT-SoVITS 契约夹具：按实际 api_v2.py 的 /tts 校验与响应结构起本地 HTTP 服务。
// 复用 Audio8 夹具的临时目录与 PCM16 WAV 生成器；不读取真实安装或权重。

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { makePcm16Wav, makeTempDir } = require("./audio8-fixture.js");

const GPT_SOVITS_SAMPLE_RATE = 32000;

// ref_audio_path 缺失时 api_v2.py check_params 的第一条校验错误。
const VALIDATION_ERROR = { message: "ref_audio_path is required" };

function writeReferenceAudio(dir, { frames = 2048, name = "reference.wav" } = {}) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, makePcm16Wav({ sampleRate: GPT_SOVITS_SAMPLE_RATE, frames }));
  return target;
}

// /docs 永远 200，用于证明 /docs 可连通不是身份证据；写路由只记录，正常不应被调用。
function startGptSovitsServer(config = {}) {
  const state = {
    requests: [],
    calls: { probe: 0, tts: 0, docs: 0, forbidden: 0 },
    ttsBodies: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url || "";
      const route = url.split("?")[0];
      state.requests.push({ method: req.method, path: route, url, body });
      if (typeof config.onRequest === "function") {
        config.onRequest(state, req.method, route);
      }

      const sendJson = (payload, status = 200) => {
        const text = Buffer.from(JSON.stringify(payload), "utf8");
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": text.length,
        });
        res.end(text);
      };
      const sendAudio = (payload, status = 200) => {
        res.writeHead(status, { "content-type": "audio/wav", "content-length": payload.length });
        res.end(payload);
      };

      if (route === "/docs") {
        state.calls.docs += 1;
        return sendJson({ openapi: "stub" }, 200);
      }

      if (route === "/tts" && req.method === "GET") {
        state.calls.probe += 1;
        return sendJson(config.validationError || VALIDATION_ERROR, config.validationStatus || 400);
      }

      if (route === "/tts" && req.method === "POST") {
        state.calls.tts += 1;
        let parsed = null;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          parsed = null;
        }
        state.ttsBodies.push(parsed);

        const plan =
          typeof config.synthesize === "function"
            ? config.synthesize(parsed, state.calls.tts)
            : {
                status: 200,
                body: makePcm16Wav({ sampleRate: GPT_SOVITS_SAMPLE_RATE, seed: state.calls.tts }),
              };

        if (plan && plan.hang) {
          return undefined;
        }
        const status = plan && plan.status !== undefined ? plan.status : 200;
        const payload = plan && plan.body ? plan.body : Buffer.from("error", "utf8");
        const emit = () =>
          status === 200
            ? sendAudio(payload, status)
            : sendJson({ message: payload.toString("utf8") }, status);
        if (plan && plan.delayMs) {
          setTimeout(emit, plan.delayMs);
          return undefined;
        }
        return emit();
      }

      if (
        ["/set_gpt_weights", "/set_sovits_weights", "/set_refer_audio", "/control"].includes(route)
      ) {
        state.calls.forbidden += 1;
        return sendJson({ message: "success" }, 200);
      }

      return sendJson({ detail: "unexpected path" }, 404);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        state,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = {
  GPT_SOVITS_SAMPLE_RATE,
  VALIDATION_ERROR,
  makeTempDir,
  makePcm16Wav,
  writeReferenceAudio,
  startGptSovitsServer,
};
