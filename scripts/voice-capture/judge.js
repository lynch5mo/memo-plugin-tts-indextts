"use strict";
// 技术检查汇总器（架构契约版）。它只汇总机器可核验的技术条件，绝不签发 A 的最终通过，也绝不由 JSON 自动开 B。
// 状态语义：NOT_RUN 未执行或缺必要步骤；FAIL 真实错误或身份/证据冲突（优先于未运行）；
// PENDING_HUMAN 技术条件与主控原生见证都齐、只缺主人听感；最终 PASS 由主控核对原生见证加主人确认后形成。
const ERROR_CODES = Object.freeze(["E_FIXTURE", "E_CONTEXT", "E_MEDIA", "E_ORIGIN", "E_BRIDGE", "E_TTS"]);

const STEP_TO_CODE = Object.freeze({
  session: "E_ORIGIN",
  expected: "E_CONTEXT",
  detail: "E_CONTEXT",
  providers: "E_BRIDGE",
  synth: "E_TTS",
  "synth-translation": "E_TTS",
  play: "E_TTS",
  save: "E_BRIDGE",
  extract: "E_MEDIA",
});

function stepOf(records, name) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i] && records[i].step === name) return records[i];
  }
  return null;
}

function technical(id, verdict, code, detail) {
  if (verdict === "pass") return { id: id, status: "PASS", code: "OK", detail: detail || null };
  if (verdict === "fail") return { id: id, status: "FAIL", code: code || "E_CONTEXT", detail: detail || null };
  return { id: id, status: "NOT_RUN", code: code || "E_CONTEXT", detail: detail || "step-not-observed" };
}

function fromStep(id, step, extraOk) {
  if (!step) return technical(id, "not-run", STEP_TO_CODE[id], "step-not-observed");
  const ok = step.ok === true && (extraOk === undefined || extraOk(step) === true);
  return technical(id, ok ? "pass" : "fail", step.code || STEP_TO_CODE[id], step.detail);
}

function rollup(name, results, extra) {
  let status;
  if (results.some((r) => r.status === "FAIL")) status = "FAIL";
  else if (results.length > 0 && results.every((r) => r.status === "PASS")) status = "PASS";
  else status = "NOT_RUN";
  return Object.assign({ name: name, status: status, checks: results }, extra || {});
}

// input: { report, extracts, provenance, nativeWitness, ownerListening, challengeCode, observedOrigins, allowOrigin }
function evaluateGates(input) {
  const report = input.report || null;
  const provenance = input.provenance || null;
  const records = report && Array.isArray(report.records) ? report.records : [];
  const extracts = Array.isArray(input.extracts) ? input.extracts : [];
  const challengeCode = input.challengeCode || (provenance && provenance.challengeCode) || null;

  // 来源绑定：页面报告的 nonce 必须等于核心 provenance 的 nonce；核心日志写失败直接判冲突。
  const provenanceOk =
    provenance !== null && report !== null &&
    typeof provenance.nonce === "string" && provenance.nonce.length > 0 &&
    report.provenance && report.provenance.nonce === provenance.nonce;
  const logConflict = provenance !== null && provenance.logFailures > 0;

  const session = stepOf(records, "session");
  const expectedStep = stepOf(records, "expected");
  const detail = stepOf(records, "detail");
  const providers = stepOf(records, "providers");
  const synth = stepOf(records, "synth-translation");
  const play = stepOf(records, "play");
  const save = stepOf(records, "save");
  const extract = stepOf(records, "extract");

  const provenanceCheck = provenanceOk
    ? technical("evidence-provenance", "pass", "OK", "nonce-matched")
    : technical("evidence-provenance", "not-run", "E_CONTEXT", "no-matching-core-provenance");
  const logCheck = logConflict
    ? technical("log-integrity", "fail", "E_CONTEXT", "core-log-write-failed")
    : provenance !== null
      ? technical("log-integrity", "pass", "OK", null)
      : technical("log-integrity", "not-run", "E_CONTEXT", "no-core-evidence");

  const gateA1 = rollup("A1-context", [
    provenanceCheck,
    logCheck,
    fromStep("session", session),
    fromStep("expected", expectedStep),
    fromStep("detail", detail, (s) => s.detail && s.detail.timelineIdsMatch === true),
    fromStep("detail-media", detail, (s) => s.detail && s.detail.hasMediaLocator === true),
  ]);

  const gateA2 = rollup("A2-extract", [
    fromStep("extract", extract),
    technical("media-pin-matched", extracts.length && extracts.every((e) => e.mediaSha256Match === true) ? "pass" : extracts.length ? "fail" : "not-run", "E_MEDIA", extracts.length ? { count: extracts.length } : null),
    technical("extract-nonsilent", extracts.length && extracts.every((e) => e.nonSilent === true) ? "pass" : extracts.length ? "fail" : "not-run", "E_MEDIA", null),
    technical("same-run-binding", extracts.length && extracts.every((e) => e.runId === (report && report.provenance && report.provenance.runId)) ? "pass" : extracts.length ? "fail" : "not-run", "E_CONTEXT", null),
  ], { observedOrigins: input.observedOrigins || [], allowOrigin: input.allowOrigin || null });

  const gateA3 = rollup("A3-synthesize", [
    fromStep("providers", providers),
    fromStep("synth-translation", synth),
    fromStep("play", play),
    fromStep("save", save),
  ]);

  const gateB = {
    name: "B-register-and-cross-lingual",
    status: "NOT_RUN",
    checks: [
      technical("new-voice-registered", "not-run", "E_TTS", "B 未执行"),
      technical("cross-lingual-synth", "not-run", "E_TTS", "B 未执行"),
    ],
  };

  const technicalFail = [gateA1, gateA2, gateA3].some((g) => g.status === "FAIL");
  const technicalComplete = [gateA1, gateA2, gateA3].every((g) => g.status === "PASS");

  // 主控原生见证：必须带与本次绑定同一 challenge；没有它技术再绿也只能停在 NOT_RUN/PENDING。
  const witness = input.nativeWitness || null;
  const witnessOk = !!(witness && challengeCode && witness.challengeCode === challengeCode &&
    Array.isArray(witness.screenshots) && witness.screenshots.length > 0 &&
    Array.isArray(witness.axRefs) && witness.axRefs.length > 0);
  const witnessCheck = witnessOk
    ? technical("native-witness", "pass", "OK", { screenshots: witness.screenshots.length })
    : technical("native-witness", "not-run", "E_CONTEXT", "no-operator-native-witness");

  const owner = input.ownerListening || null;
  const ownerOk = !!(owner && challengeCode && owner.challengeCode === challengeCode && owner.confirmedAt);
  const ownerCheck = ownerOk
    ? technical("owner-listened", "pass", "OK", null)
    : technical("owner-listened", "not-run", "E_TTS", "owner-confirmation-recording-required");

  let finalA;
  if (technicalFail) finalA = "FAIL";
  else if (!technicalComplete) finalA = "NOT_RUN";
  else if (!witnessOk) finalA = "NOT_RUN";
  else if (!ownerOk) finalA = "PENDING_HUMAN";
  else finalA = "PENDING_OPERATOR";

  return {
    schemaVersion: 3,
    errorCodes: ERROR_CODES,
    states: ["PASS", "FAIL", "NOT_RUN", "PENDING_HUMAN", "PENDING_OPERATOR"],
    provenance: { nonceMatched: provenanceOk, challengeBound: !!(challengeCode && witnessOk) },
    gates: { A1: gateA1, A2: gateA2, A3: gateA3, B: gateB },
    operatorChecks: { nativeWitness: witnessCheck, ownerListening: ownerCheck },
    technicalComplete: technicalComplete,
    finalA: finalA,
    // 机器汇总永远不签发 A 通过，也不由 JSON 自动开 B。
    stageAComplete: false,
    bGateOpen: false,
  };
}

module.exports = { ERROR_CODES: ERROR_CODES, evaluateGates: evaluateGates };
