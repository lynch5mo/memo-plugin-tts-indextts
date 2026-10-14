"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { splitText, MAX_INPUT_CODE_POINTS } = require("../src/text.js");

function codePoints(value) {
  return Array.from(value).length;
}

function assertSegmentsInvariant(text, maxChars, segments) {
  assert.ok(Array.isArray(segments));
  assert.equal(segments.join(""), text, "分段拼接必须精确等于原文");
  for (const segment of segments) {
    assert.ok(segment.length > 0, "不允许空分段");
    assert.ok(
      codePoints(segment) <= maxChars,
      `分段 ${JSON.stringify(segment)} 超出 ${maxChars} 个 code point`,
    );
  }
}

function assertErrorCode(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("中文长句按 code point 分段且拼接等于原文", () => {
  const text = "主人，今天的会议纪要在十分钟前已经发送到你的邮箱，请查收。";
  const segments = splitText(text, 7);

  assertSegmentsInvariant(text, 7, segments);
  assert.ok(segments.length > 1);
});

test("英文优先在空白边界分段，空格与标点不丢失", () => {
  const text = "Hello there, this is a multi-backend TTS smoke test, with punctuation!";
  const segments = splitText(text, 12);

  assertSegmentsInvariant(text, 12, segments);
  assert.ok(segments.length > 1);
  assert.ok(segments.some((segment) => segment.includes(" ")));
});

test("emoji 分段不会拆成半个代理对", () => {
  const text = "😀😀😀😀😀😀😀😀😀😀";
  const segments = splitText(text, 3);

  assertSegmentsInvariant(text, 3, segments);
  assert.deepEqual(segments.map(codePoints), [3, 3, 3, 1]);
  for (const segment of segments) {
    assert.ok(!segment.includes("\uFFFD"), "分段不应出现替换字符");
  }
});

test("混合空白与标点输入在多个上限下都保持精确覆盖", () => {
  const text = "第一段。\n\n第二段  with  spaces\tand\t空格检查🙂 ，结束！";

  for (const maxChars of [1, 2, 3, 5, 8, 13]) {
    const segments = splitText(text, maxChars);
    assertSegmentsInvariant(text, maxChars, segments);
  }
});

test("无空白的超长串按上限硬切分且不截断", () => {
  const text = "a".repeat(25);
  const segments = splitText(text, 10);

  assert.deepEqual(segments, ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
});

test("上限大于文本长度时返回单段", () => {
  const segments = splitText("短句。", 100);

  assert.deepEqual(segments, ["短句。"]);
});

test("空输入与纯空白输入明确失败", () => {
  assertErrorCode(() => splitText("", 10), "ERR_TEXT_EMPTY");
  assertErrorCode(() => splitText("   \n\t ", 10), "ERR_TEXT_EMPTY");
  assertErrorCode(() => splitText(undefined, 10), "ERR_TEXT_EMPTY");
});

test("总输入超过 10000 个 code point 时失败且不悄悄截断", () => {
  const limit = MAX_INPUT_CODE_POINTS;
  const atLimit = splitText("中".repeat(limit), 4000);

  assert.equal(atLimit.join(""), "中".repeat(limit));
  assertErrorCode(() => splitText("中".repeat(limit + 1), 4000), "ERR_TEXT_TOO_LONG");
  assertErrorCode(() => splitText("😀".repeat(limit + 1), 4000), "ERR_TEXT_TOO_LONG");
});

test("maxChars 非正整数时明确失败", () => {
  for (const maxChars of [0, -1, 1.5, Number.NaN, "10", undefined, null]) {
    assertErrorCode(() => splitText("文本", maxChars), "ERR_TEXT_MAX_CHARS");
  }
});
