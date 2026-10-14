"use strict";

// 文本分段：以 Unicode code point 计数，保证分段拼接精确等于输入，不截断、不丢弃空白与标点。

const MAX_INPUT_CODE_POINTS = 10000;
const WHITESPACE = /\s/u;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertMaxChars(maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw createError(
      "ERR_TEXT_MAX_CHARS",
      `分段上限必须是正整数 code point，收到 ${JSON.stringify(maxChars)}。`,
    );
  }
}

function splitText(text, maxChars) {
  assertMaxChars(maxChars);

  if (typeof text !== "string" || text.trim() === "") {
    throw createError("ERR_TEXT_EMPTY", "待合成文本为空或只有空白字符，已拒绝发送空任务。");
  }

  const points = Array.from(text);
  if (points.length > MAX_INPUT_CODE_POINTS) {
    throw createError(
      "ERR_TEXT_TOO_LONG",
      `待合成文本共 ${points.length} 个 code point，超过上限 ${MAX_INPUT_CODE_POINTS}，不做截断。`,
    );
  }

  const segments = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + maxChars, points.length);
    if (end < points.length) {
      for (let index = end - 1; index > start; index -= 1) {
        if (WHITESPACE.test(points[index])) {
          end = index + 1;
          break;
        }
      }
    }
    segments.push(points.slice(start, end).join(""));
    start = end;
  }

  return segments;
}

module.exports = { splitText, MAX_INPUT_CODE_POINTS };
