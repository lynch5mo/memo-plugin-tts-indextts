"use strict";

// 测试专用 WAV 构造工具：只生成受控的合法样本与畸形样本，不进入产品代码。

const DEFAULT_SAMPLE_RATE = 24000;

function pcm16NonSilent(sampleCount, { channels = 1, amplitude = 6000 } = {}) {
  const buffer = Buffer.alloc(sampleCount * channels * 2);
  for (let frame = 0; frame < sampleCount; frame += 1) {
    const value = frame % 2 === 0 ? amplitude : -amplitude;
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(value, (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

function pcm16Silent(sampleCount, { channels = 1 } = {}) {
  return Buffer.alloc(sampleCount * channels * 2);
}

// 每个声道各自取一个恒定值，用于构造直流（非零恒定）波形与左右不同的双声道波形。
function pcm16ConstantPerChannel(channelValues, frameCount) {
  const channels = channelValues.length;
  const buffer = Buffer.alloc(frameCount * channels * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(channelValues[channel], (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

function asciiChunk(id, payload, declaredSize) {
  const size = declaredSize === undefined ? payload.length : declaredSize;
  const padding = payload.length % 2 === 1 ? 1 : 0;
  const buffer = Buffer.alloc(8 + payload.length + padding);
  buffer.write(id, 0, 4, "ascii");
  buffer.writeUInt32LE(size, 4);
  payload.copy(buffer, 8);
  return buffer;
}

function fmtChunk({
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = 1,
  bitsPerSample = 16,
  audioFormat = 1,
  size = 16,
  blockAlign,
  byteRate,
} = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const body = Buffer.alloc(16);
  body.writeUInt16LE(audioFormat, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE(
    byteRate === undefined ? sampleRate * channels * bytesPerSample : byteRate,
    8,
  );
  body.writeUInt16LE(
    blockAlign === undefined ? channels * bytesPerSample : blockAlign,
    12,
  );
  body.writeUInt16LE(bitsPerSample, 14);
  return asciiChunk("fmt ", body.subarray(0, size));
}

function buildWav({
  pcm = pcm16NonSilent(8),
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = 1,
  bitsPerSample = 16,
  audioFormat = 1,
  fmt: fmtOverrides,
  dataSize,
  riffSize,
  extraChunks = [],
  includeFmt = true,
  includeData = true,
  dataChunkId = "data",
} = {}) {
  const fmtPart = includeFmt
    ? fmtChunk({ sampleRate, channels, bitsPerSample, audioFormat, ...(fmtOverrides || {}) })
    : Buffer.alloc(0);
  const dataPart = includeData ? asciiChunk(dataChunkId, pcm, dataSize) : Buffer.alloc(0);
  const body = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    fmtPart,
    ...extraChunks,
    dataPart,
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(riffSize === undefined ? body.length : riffSize, 4);
  return Buffer.concat([header, body]);
}

function makeToneWav(options = {}) {
  const sampleCount = options.sampleCount === undefined ? 240 : options.sampleCount;
  const channels = options.channels === undefined ? 1 : options.channels;
  const amplitude = options.amplitude === undefined ? 6000 : options.amplitude;
  const pcm = pcm16NonSilent(sampleCount, { channels, amplitude });
  return { pcm, wav: buildWav({ ...options, pcm, channels }) };
}

function countAscii(buffer, needle) {
  const pattern = Buffer.from(needle, "ascii");
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = buffer.indexOf(pattern, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + 1;
  }
}

module.exports = {
  DEFAULT_SAMPLE_RATE,
  pcm16NonSilent,
  pcm16Silent,
  pcm16ConstantPerChannel,
  asciiChunk,
  fmtChunk,
  buildWav,
  makeToneWav,
  countAscii,
};
