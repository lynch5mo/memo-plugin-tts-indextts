"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWav, joinWav, MAX_CONTAINER_BYTES } = require("../src/wav.js");
const {
  pcm16NonSilent,
  pcm16Silent,
  asciiChunk,
  buildWav,
  countAscii,
} = require("./helpers/wav-fixture.js");

function assertErrorCode(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("解析合法 PCM16 WAV 时返回采样率、声道、位深与逐样本 PCM", () => {
  const pcm = pcm16NonSilent(8, { channels: 2, amplitude: 1000 });
  const wav = buildWav({ pcm, sampleRate: 22050, channels: 2 });

  const parsed = parseWav(wav);

  assert.equal(parsed.sampleRate, 22050);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.bitsPerSample, 16);
  assert.deepEqual(Buffer.from(parsed.pcm), pcm);
});

test("接受 fmt 与 data 之间的合法额外 RIFF chunk", () => {
  const pcm = pcm16NonSilent(6, { amplitude: 1200 });
  const wav = buildWav({
    pcm,
    extraChunks: [asciiChunk("LIST", Buffer.from("INFOabcdef", "ascii"))],
  });

  const parsed = parseWav(wav);

  assert.deepEqual(Buffer.from(parsed.pcm), pcm);
  assert.equal(parsed.bitsPerSample, 16);
});

test("长度为奇数的额外 chunk 带补位字节时仍可解析", () => {
  const pcm = pcm16NonSilent(4, { amplitude: 900 });
  const oddChunk = asciiChunk("LIST", Buffer.from("INFOabcde", "ascii"));
  assert.equal(oddChunk.length, 8 + 9 + 1);

  const parsed = parseWav(buildWav({ pcm, extraChunks: [oddChunk] }));

  assert.deepEqual(Buffer.from(parsed.pcm), pcm);
});

test("拒绝 RIFF 声明长度与实际字节数不符的输入", () => {
  const pcm = pcm16NonSilent(8);
  const wav = buildWav({ pcm });
  const truncated = wav.subarray(0, wav.length - 2);

  assertErrorCode(() => parseWav(truncated), "ERR_WAV_MALFORMED");
  assertErrorCode(() => parseWav(buildWav({ pcm, riffSize: wav.length - 8 + 16 })), "ERR_WAV_MALFORMED");
});

test("拒绝 data 声明长度超过实际可用字节的输入", () => {
  const pcm = pcm16NonSilent(8);
  const wav = buildWav({ pcm, dataSize: pcm.length + 64 });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝长度自洽但末尾残留不成 chunk 的多余字节", () => {
  const pcm = pcm16NonSilent(4);
  const wav = buildWav({ pcm });
  const withTail = Buffer.concat([wav, Buffer.from([1, 2, 3, 4])]);
  withTail.writeUInt32LE(withTail.length - 8, 4);

  assertErrorCode(() => parseWav(withTail), "ERR_WAV_MALFORMED");
});

test("拒绝 PCM 为空的 WAV", () => {
  const wav = buildWav({ pcm: Buffer.alloc(0) });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_EMPTY_PCM");
});

test("拒绝纯静音 PCM", () => {
  const wav = buildWav({ pcm: pcm16Silent(64) });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_SILENT");
});

test("拒绝缺少 fmt chunk 的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(8), includeFmt: false });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝缺少 data chunk 的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(8), includeData: false });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝重复 data chunk 的 WAV", () => {
  const pcm = pcm16NonSilent(4);
  const wav = buildWav({ pcm, extraChunks: [asciiChunk("data", pcm)] });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝被截断的 fmt chunk", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4), fmt: { size: 12 } });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝非 PCM 编码格式", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4), audioFormat: 3 });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_UNSUPPORTED_FORMAT");
});

test("拒绝位深不是 16 的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4), bitsPerSample: 8 });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_UNSUPPORTED_FORMAT");
});

test("拒绝声道数超过 2 的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4, { channels: 4 }), channels: 4 });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_UNSUPPORTED_FORMAT");
});

test("拒绝 fmt 内部 blockAlign 与声道和位深不一致的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4), fmt: { blockAlign: 1 } });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝 fmt 内部 byteRate 与采样参数不一致的 WAV", () => {
  const wav = buildWav({ pcm: pcm16NonSilent(4), fmt: { byteRate: 1 } });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("拒绝 PCM 字节数不是 blockAlign 整数倍的 WAV", () => {
  const pcm = pcm16NonSilent(2).subarray(0, 3);
  const wav = buildWav({ pcm });

  assertErrorCode(() => parseWav(wav), "ERR_WAV_MALFORMED");
});

test("按内容而非扩展名或魔数拒绝伪装成 WAV 的字节", () => {
  const mp3ish = Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u00ff\u00fb\u0090\u0000", "latin1");
  const textish = Buffer.from("RIFF not really audio", "ascii");

  assertErrorCode(() => parseWav(mp3ish), "ERR_WAV_MALFORMED");
  assertErrorCode(() => parseWav(textish), "ERR_WAV_MALFORMED");
  assertErrorCode(() => parseWav("not a buffer"), "ERR_WAV_INPUT");
});

test("拒绝超过容器总量上限的单个 WAV", () => {
  const oversized = Buffer.alloc(MAX_CONTAINER_BYTES + 8);
  oversized.write("RIFF", 0, 4, "ascii");

  assertErrorCode(() => parseWav(oversized), "ERR_WAV_TOO_LARGE");
});

test("合并两段 WAV 后只有一个容器，PCM 逐样本顺序正确", () => {
  const first = pcm16NonSilent(5, { amplitude: 1000 });
  const second = pcm16NonSilent(7, { amplitude: 2000 });
  const joined = joinWav([
    buildWav({ pcm: first, sampleRate: 16000 }),
    buildWav({ pcm: second, sampleRate: 16000 }),
  ]);

  assert.equal(joined.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(joined.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(joined.readUInt32LE(4), joined.length - 8);
  assert.equal(joined.length, 44 + first.length + second.length);
  assert.equal(countAscii(joined, "RIFF"), 1);
  assert.equal(countAscii(joined, "WAVE"), 1);

  const parsed = parseWav(joined);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.deepEqual(Buffer.from(parsed.pcm), Buffer.concat([first, second]));
});

test("合并时拒绝采样率不一致", () => {
  const a = buildWav({ pcm: pcm16NonSilent(4), sampleRate: 16000 });
  const b = buildWav({ pcm: pcm16NonSilent(4), sampleRate: 22050 });

  assertErrorCode(() => joinWav([a, b]), "ERR_WAV_FORMAT_MISMATCH");
});

test("合并时拒绝声道数不一致", () => {
  const mono = buildWav({ pcm: pcm16NonSilent(4, { channels: 1 }), channels: 1 });
  const stereo = buildWav({ pcm: pcm16NonSilent(4, { channels: 2 }), channels: 2 });

  assertErrorCode(() => joinWav([mono, stereo]), "ERR_WAV_FORMAT_MISMATCH");
});

test("合并时任一段非法即整体失败，不返回部分音频", () => {
  const good = buildWav({ pcm: pcm16NonSilent(4) });
  const silent = buildWav({ pcm: pcm16Silent(4) });

  assertErrorCode(() => joinWav([good, silent]), "ERR_WAV_SILENT");
  assertErrorCode(() => joinWav([good, Buffer.from("not a wav", "ascii")]), "ERR_WAV_MALFORMED");
  assertErrorCode(() => joinWav([]), "ERR_WAV_INPUT");
  assertErrorCode(() => joinWav("not an array"), "ERR_WAV_INPUT");
});

test("合并输入总量超过 128MiB 时在分配合并缓冲区之前失败", () => {
  const block = buildWav({ pcm: pcm16NonSilent(512 * 1024, { amplitude: 1000 }) });
  const repeat = Math.ceil(MAX_CONTAINER_BYTES / block.length) + 2;
  const inputs = new Array(repeat).fill(block);
  const declaredTotal = repeat * (block.length - 44);
  assert.ok(declaredTotal > MAX_CONTAINER_BYTES, "测试样本累计必须超过上限");

  const allocations = [];
  const realAlloc = Buffer.alloc;
  const realAllocUnsafe = Buffer.allocUnsafe;
  Buffer.alloc = (size, ...rest) => {
    allocations.push(size);
    return realAlloc.call(Buffer, size, ...rest);
  };
  Buffer.allocUnsafe = (size, ...rest) => {
    allocations.push(size);
    return realAllocUnsafe.call(Buffer, size, ...rest);
  };
  try {
    assertErrorCode(() => joinWav(inputs), "ERR_WAV_TOO_LARGE");
  } finally {
    Buffer.alloc = realAlloc;
    Buffer.allocUnsafe = realAllocUnsafe;
  }

  const largestAllocation = allocations.length === 0 ? 0 : Math.max(...allocations);
  assert.ok(
    largestAllocation < MAX_CONTAINER_BYTES,
    `合并前最大分配 ${largestAllocation} 字节，必须小于 ${MAX_CONTAINER_BYTES}`,
  );
});
