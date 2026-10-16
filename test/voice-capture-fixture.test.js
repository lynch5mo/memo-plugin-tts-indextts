"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const fixture = require("../scripts/voice-capture/fixture.js");
const judge = require("../scripts/voice-capture/judge.js");
const packApp = require("../scripts/voice-capture/pack-app.js");

const REPO = path.resolve(__dirname, "..");
const NONCE = "nonce-abc";
const CHALLENGE = "challenge-xyz";

function completeRecords() {
  return [
    { step: "session", ok: true, code: "OK" },
    { step: "expected", ok: true, code: "OK" },
    { step: "detail", ok: true, code: "OK", detail: { timelineIdsMatch: true, hasMediaLocator: true } },
    { step: "providers", ok: true, code: "OK" },
    { step: "synth-translation", ok: true, code: "OK", detail: { bytes: 1000 } },
    { step: "play", ok: true, code: "OK", detail: { started: true } },
    { step: "save", ok: true, code: "OK", detail: { saved: 2 } },
    { step: "extract", ok: true, code: "OK" },
  ];
}

function reportWith(records, runId) {
  return { provenance: { nonce: NONCE, runId: runId || "run-1", sessionId: "sess-1" }, records: records };
}

function provenance() {
  return { nonce: NONCE, logFailures: 0, fixtureManifestHash: "m", coreSourceHash: "c", challengeCode: CHALLENGE };
}

function witness() {
  return { challengeCode: CHALLENGE, screenshots: ["shot.png"], axRefs: ["ax-1"] };
}

test("planFixture keeps original duration and never pads to 10s", () => {
  const plan = fixture.planFixture({ ffmpegPath: "/x/ffmpeg", sourceWav: "/x/in.wav", outDir: "/x/out" });
  assert.equal(plan.mediaArgv[0], "/x/ffmpeg");
  assert.ok(plan.mediaArgv.includes("-shortest"));
  assert.ok(plan.mediaArgv.every((a) => typeof a === "string"));
});

test("buildExpected timeline matches duration and carries pinned digests", () => {
  const expected = fixture.buildExpected({
    fixtureId: "f1", segmentId: "seg", originalText: "原文", translationText: "translation",
    durationSec: 8.312744, mediaSha256: "a".repeat(64), pcmSha256: "b".repeat(64),
  });
  assert.equal(expected.timeline.length, 1);
  assert.equal(expected.timeline[0].endMs, 8313);
  assert.equal(expected.mediaSha256, "a".repeat(64));
  assert.equal(expected.pcmSha256, "b".repeat(64));
});

test("canonicalPcmArgv is fixed and includes no shell fragment", () => {
  const argv = fixture.canonicalPcmArgv("/x/ffmpeg", "/media/a.mp4");
  assert.equal(argv[0], "/x/ffmpeg");
  assert.ok(argv.includes("pcm_s16le"));
  assert.ok(!argv.some((a) => /[;&|]/.test(a)));
});

test("canonicalPcmDigest bounds decode time and reports the reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-slow-"));
  try {
    const slow = path.join(dir, "slow-ffmpeg");
    fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    fs.chmodSync(slow, 0o755);
    const digest = fixture.canonicalPcmDigest(slow, "/tmp/whatever", { timeoutMs: 300 });
    assert.equal(digest.ok, false);
    assert.equal(digest.reason, "decode-timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("judge does not treat missing evidence as FAIL", () => {
  const result = judge.evaluateGates({ report: { records: [] }, extracts: [], provenance: null });
  assert.equal(result.gates.A1.status, "NOT_RUN");
  assert.equal(result.finalA, "NOT_RUN");
  assert.equal(result.stageAComplete, false);
});

test("judge never signs A PASS from a hand-written page report alone", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords()),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }],
    provenance: null,
  });
  assert.equal(result.finalA, "NOT_RUN");
  assert.equal(result.stageAComplete, false);
  assert.equal(result.bGateOpen, false);
});

test("judge refuses a forged witness without the bound challenge code", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords()),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }],
    provenance: provenance(),
    nativeWitness: { challengeCode: "guessed", screenshots: ["x.png"], axRefs: ["a"] },
    ownerListening: { challengeCode: CHALLENGE, confirmedAt: "now" },
  });
  assert.equal(result.technicalComplete, true);
  assert.equal(result.finalA, "NOT_RUN");
  assert.equal(result.stageAComplete, false);
});

test("judge marks a cross-run extract as an evidence conflict", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords(), "run-1"),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-OTHER" }],
    provenance: provenance(),
    nativeWitness: witness(),
    ownerListening: { challengeCode: CHALLENGE, confirmedAt: "now" },
  });
  assert.equal(result.gates.A2.status, "FAIL");
  assert.equal(result.finalA, "FAIL");
  assert.equal(result.stageAComplete, false);
});

test("judge treats a core log write failure as a conflict", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords()),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }],
    provenance: { nonce: NONCE, logFailures: 1, challengeCode: CHALLENGE },
    nativeWitness: witness(),
    ownerListening: { challengeCode: CHALLENGE, confirmedAt: "now" },
  });
  assert.equal(result.gates.A1.status, "FAIL");
  assert.equal(result.finalA, "FAIL");
});

test("judge stops at PENDING_HUMAN when only owner listening is missing", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords()),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }],
    provenance: provenance(),
    nativeWitness: witness(),
    ownerListening: null,
  });
  assert.equal(result.technicalComplete, true);
  assert.equal(result.finalA, "PENDING_HUMAN");
  assert.equal(result.stageAComplete, false);
  assert.equal(result.bGateOpen, false);
});

test("judge stops at PENDING_OPERATOR even with witness and owner listening, never auto PASS", () => {
  const result = judge.evaluateGates({
    report: reportWith(completeRecords()),
    extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }],
    provenance: provenance(),
    nativeWitness: witness(),
    ownerListening: { challengeCode: CHALLENGE, confirmedAt: "2026-10-15T00:00:00Z" },
  });
  assert.equal(result.technicalComplete, true);
  assert.equal(result.finalA, "PENDING_OPERATOR");
  assert.equal(result.stageAComplete, false);
  assert.equal(result.bGateOpen, false);
});

test("judge marks A3 FAIL when the translation synthesis step failed", () => {
  const records = completeRecords().map((r) => (r.step === "synth-translation" ? { step: "synth-translation", ok: false, code: "E_TTS" } : r));
  const result = judge.evaluateGates({
    report: reportWith(records), extracts: [{ mediaSha256Match: true, nonSilent: true, runId: "run-1" }], provenance: provenance(),
  });
  assert.equal(result.gates.A3.status, "FAIL");
  assert.equal(result.finalA, "FAIL");
});

test("packApp builds a deterministic .memox with the app id and version", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-pack-test-"));
  try {
    const result = packApp.packApp({ sourceDir: path.join(REPO, "apps", "voice-feasibility"), outDir: outDir });
    assert.equal(result.pluginId, "memo-plugin-app-voice-feasibility");
    assert.deepEqual(result.entries, ["manifest.json", "index.js", "index.html"]);
    const again = packApp.packApp({ sourceDir: path.join(REPO, "apps", "voice-feasibility"), outDir: outDir });
    assert.equal(again.sha256, result.sha256);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("packApp rejects a manifest that is not the approved app id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-pack-bad-"));
  try {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ pluginId: "other", type: "app", importType: "module", minVersion: "1.8.8", apis: [] }));
    fs.writeFileSync(path.join(dir, "index.js"), "");
    fs.writeFileSync(path.join(dir, "index.html"), "");
    assert.throws(() => packApp.packApp({ sourceDir: dir, outDir: dir }), /E_FIXTURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
