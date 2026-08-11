"use strict";

const SAMPLE_RATE = 32000;
const DURATION_MS = 100;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function writeAscii(buffer, offset, text) {
  buffer.write(text, offset, "ascii");
}

function writeUInt32(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}

function writeUInt16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function createSilentWav({ sampleRate = SAMPLE_RATE, durationMs = DURATION_MS } = {}) {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = sampleCount * CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAscii(buffer, 0, "RIFF");
  writeUInt32(buffer, 4, 36 + dataSize);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  writeUInt32(buffer, 16, 16);
  writeUInt16(buffer, 20, 1);
  writeUInt16(buffer, 22, CHANNELS);
  writeUInt32(buffer, 24, sampleRate);
  writeUInt32(buffer, 28, sampleRate * CHANNELS * BYTES_PER_SAMPLE);
  writeUInt16(buffer, 32, CHANNELS * BYTES_PER_SAMPLE);
  writeUInt16(buffer, 34, BITS_PER_SAMPLE);
  writeAscii(buffer, 36, "data");
  writeUInt32(buffer, 40, dataSize);

  return buffer;
}

module.exports = { createSilentWav };
