# Memo GPT-SoVITS TTS Plugin

Phase 0 最小 GPT-SoVITS TTS provider 插件（静音 WAV 占位，非真实 TTS），并为本机 Gate A
提供 `.memox` 本地打包能力。

当前范围：

- Memo TTS 插件 manifest 契约（`manifest.json`）
- CommonJS 运行时入口（`index.js` + `lib/audio.js`）：`textToSpeech()` 返回
  32kHz/16-bit/单声道/100ms 静音 WAV `Buffer`
- 中英文静态文案（`i18n.json`）与静态语言选项（`options.json`）
- 自有 SVG 图标（`icon.svg`，无第三方商标素材）
- `.memox` 构建（`scripts/build-memox.sh`）与打包契约测试

明确未实现：真实 GPT-SoVITS `/tts`、真实 TTS 音频、`index.json`/`app.asar` 修改、市场发布、
签名、自动升级。Phase 边界见 `docs/phase-0-gates.md`。

## 构建 `.memox`

```bash
mkdir -p dist
scripts/build-memox.sh --output-dir dist
```

产物固定为 `dist/memo-plugin-tts-gptsovits-1.0.0.memox`，同目录生成 SHA-256 sidecar
`memo-plugin-tts-gptsovits-1.0.0.memox.sha256`。构建使用系统 `zip -X`，固定 entry 顺序、
mtime 与权限；连续两次构建 SHA-256 一致。二进制产物不进入 Git。

## Memo 原生导入（Gate A 专用）

1. 由用户在确认 Memo 可以退出并重启后，通过 Memo「三方集成 → 语音合成」原生投放区导入
   `dist/memo-plugin-tts-gptsovits-1.0.0.memox`。
2. 让 Memo 自己解包、登记并更新 `plugins/index.json`；不要通过 Finder 复制版本目录，
   不要运行 direct-root installer，不要手工编辑 `plugins/index.json`。
3. 验证见 `docs/phase-0-gates.md`；真实 Gate A 目前仍为 `STOPPED_AT_GATE_A`，未通过前
   不得宣称插件已被 Memo 接受。

## Direct-root 禁用

`scripts/install-local.sh` 对 canonical 真实 `~/Library/Application Support/Memo`
无条件 fail-closed 拒绝（包括 filesystem identity 等价 alias），错误信息要求使用
Memo 原生 `.memox` 流程。真实 Memo root 任何写入均由脚本拒绝。

## 验证

```bash
npm test
bash -n scripts/*.sh
```

运行环境要求：Node 主版本 22，系统 `zip`/`unzip`。
