"use strict";

// PCM WAV 校验与合并：只接受真实解析出来的 PCM16 波形，拒绝空/静音/畸形容器。

const MAX_CONTAINER_BYTES = 128 * 1024 * 1024;
const MAX_CHANNELS = 2;
const SUPPORTED_BITS_PER_SAMPLE = 16;
const PCM_FORMAT_CODE = 1;
const CANONICAL_HEADER_BYTES = 44;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function malformed(detail) {
  return createError("ERR_WAV_MALFORMED", `WAV 容器不合法：${detail}。`);
}

function unsupported(detail) {
  return createError(
    "ERR_WAV_UNSUPPORTED_FORMAT",
    `当前只支持 PCM16、最多 ${MAX_CHANNELS} 声道：${detail}。`,
  );
}

function readChunkId(buffer, offset) {
  return buffer.toString("latin1", offset, offset + 4);
}

function parseFmtChunk(body) {
  if (body.length < 16) {
    throw malformed(`fmt chunk 只有 ${body.length} 字节，短于 16 字节`);
  }

  const audioFormat = body.readUInt16LE(0);
  const channels = body.readUInt16LE(2);
  const sampleRate = body.readUInt32LE(4);
  const byteRate = body.readUInt32LE(8);
  const blockAlign = body.readUInt16LE(12);
  const bitsPerSample = body.readUInt16LE(14);

  if (audioFormat !== PCM_FORMAT_CODE) {
    throw unsupported(`编码格式码为 ${audioFormat}，不是 PCM（1）`);
  }
  if (bitsPerSample !== SUPPORTED_BITS_PER_SAMPLE) {
    throw unsupported(`位深为 ${bitsPerSample} 位，不是 ${SUPPORTED_BITS_PER_SAMPLE} 位`);
  }
  if (channels < 1 || channels > MAX_CHANNELS) {
    if (channels > MAX_CHANNELS) {
      throw unsupported(`声道数为 ${channels}`);
    }
    throw malformed(`声道数为 ${channels}`);
  }
  if (sampleRate < 1) {
    throw malformed(`采样率为 ${sampleRate}`);
  }

  const expectedBlockAlign = channels * (SUPPORTED_BITS_PER_SAMPLE / 8);
  if (blockAlign !== expectedBlockAlign) {
    throw malformed(`blockAlign 为 ${blockAlign}，与 ${channels} 声道 PCM16 的 ${expectedBlockAlign} 不符`);
  }
  if (byteRate !== sampleRate * expectedBlockAlign) {
    throw malformed(
      `byteRate 为 ${byteRate}，与 ${sampleRate}Hz/${channels} 声道的 ${sampleRate * expectedBlockAlign} 不符`,
    );
  }

  return { channels, sampleRate, bitsPerSample, blockAlign };
}

// 非静音按“每个声道在时间上是否变化”判定，不设响度阈值：
// 恒定直流、全零与单帧都属于没有时间变化的无声结果，必须拒绝。
function hasTemporalVariation(pcm, channels) {
  const frameBytes = channels * 2;
  const frames = pcm.length / frameBytes;
  if (frames <= 1) {
    return false;
  }
  for (let channel = 0; channel < channels; channel += 1) {
    const first = pcm.readInt16LE(channel * 2);
    for (let frame = 1; frame < frames; frame += 1) {
      if (pcm.readInt16LE(frame * frameBytes + channel * 2) !== first) {
        return true;
      }
    }
  }
  return false;
}

function assertTemporalVariation(pcm, channels) {
  if (!hasTemporalVariation(pcm, channels)) {
    throw createError(
      "ERR_WAV_SILENT",
      "音频在所有声道上都是恒定波形（全零、直流或单帧），没有任何时间变化，按契约拒绝返回。",
    );
  }
}

function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw createError("ERR_WAV_INPUT", `音频校验只接受 Buffer，收到 ${typeof buffer}。`);
  }
  if (buffer.length > MAX_CONTAINER_BYTES) {
    throw createError(
      "ERR_WAV_TOO_LARGE",
      `音频容器 ${buffer.length} 字节超过上限 ${MAX_CONTAINER_BYTES} 字节。`,
    );
  }
  if (buffer.length < 20) {
    throw malformed(`总长只有 ${buffer.length} 字节，不构成 RIFF/WAVE 容器`);
  }
  if (readChunkId(buffer, 0) !== "RIFF" || readChunkId(buffer, 8) !== "WAVE") {
    throw malformed("缺少 RIFF 标识或 WAVE 类型标识");
  }

  const riffSize = buffer.readUInt32LE(4);
  if (buffer.length !== 8 + riffSize) {
    throw malformed(`RIFF 声明 ${8 + riffSize} 字节，实际 ${buffer.length} 字节`);
  }

  let fmt = null;
  let pcm = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = readChunkId(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (bodyStart + size > buffer.length) {
      throw malformed(
        `${id} chunk 声明 ${size} 字节，超出容器剩余 ${buffer.length - bodyStart} 字节`,
      );
    }

    if (id === "fmt ") {
      if (fmt) {
        throw malformed("出现重复的 fmt chunk");
      }
      fmt = parseFmtChunk(buffer.subarray(bodyStart, bodyStart + size));
    } else if (id === "data") {
      if (pcm) {
        throw malformed("出现重复的 data chunk");
      }
      pcm = buffer.subarray(bodyStart, bodyStart + size);
    }

    offset = bodyStart + size + (size % 2);
  }

  if (offset !== buffer.length) {
    throw malformed(
      `chunk 序列在 ${offset} 字节处结束，与容器长度 ${buffer.length} 字节不符（可能缺少补位字节或存在残留字节）`,
    );
  }
  if (!fmt) {
    throw malformed("缺少 fmt chunk");
  }
  if (!pcm) {
    throw malformed("缺少 data chunk");
  }
  if (pcm.length === 0) {
    throw createError("ERR_WAV_EMPTY_PCM", "data chunk 长度为 0，没有任何 PCM 样本。");
  }
  if (pcm.length % fmt.blockAlign !== 0) {
    throw malformed(`PCM 长度 ${pcm.length} 不是 blockAlign ${fmt.blockAlign} 的整数倍`);
  }
  assertTemporalVariation(pcm, fmt.channels);

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    pcm,
  };
}

function writeCanonicalHeader(buffer, { sampleRate, channels, bitsPerSample, pcmBytes }) {
  const bytesPerSample = bitsPerSample / 8;
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write("WAVE", 8, 4, "ascii");
  buffer.write("fmt ", 12, 4, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(PCM_FORMAT_CODE, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(pcmBytes, 40);
}

function joinWav(buffers) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw createError("ERR_WAV_INPUT", "合并音频至少需要一段 WAV Buffer。");
  }

  const parsed = buffers.map((buffer) => parseWav(buffer));
  const first = parsed[0];
  let pcmBytes = 0;
  for (const part of parsed) {
    if (
      part.sampleRate !== first.sampleRate ||
      part.channels !== first.channels ||
      part.bitsPerSample !== first.bitsPerSample
    ) {
      throw createError(
        "ERR_WAV_FORMAT_MISMATCH",
        `待合并音频格式不一致：${first.sampleRate}Hz/${first.channels}声道 与 ${part.sampleRate}Hz/${part.channels}声道。`,
      );
    }
    pcmBytes += part.pcm.length;
  }

  const totalBytes = CANONICAL_HEADER_BYTES + pcmBytes;
  if (totalBytes > MAX_CONTAINER_BYTES) {
    throw createError(
      "ERR_WAV_TOO_LARGE",
      `合并后容器 ${totalBytes} 字节超过上限 ${MAX_CONTAINER_BYTES} 字节，已在分配前停止。`,
    );
  }

  const output = Buffer.allocUnsafe(totalBytes);
  writeCanonicalHeader(output, {
    sampleRate: first.sampleRate,
    channels: first.channels,
    bitsPerSample: first.bitsPerSample,
    pcmBytes,
  });
  let offset = CANONICAL_HEADER_BYTES;
  for (const part of parsed) {
    part.pcm.copy(output, offset);
    offset += part.pcm.length;
  }

  // 逐段核验已经保证合并结果同样有变化；这里对最终 PCM 再做一次相同检查，
  // 作为将来放宽逐段判定或改动拼接逻辑时的冗余防线。
  assertTemporalVariation(output.subarray(CANONICAL_HEADER_BYTES), first.channels);

  return output;
}

module.exports = {
  parseWav,
  joinWav,
  MAX_CONTAINER_BYTES,
  MAX_CHANNELS,
  SUPPORTED_BITS_PER_SAMPLE,
};
