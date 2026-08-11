# Memo GPT-SoVITS TTS Plugin

Phase 0 GPT-SoVITS TTS provider for Memo with a deterministic local `.memox`
builder. English summary: this repository is not a working GPT-SoVITS adapter
yet. It builds a silence-only Phase 0 plugin and tests whether Memo can install
and load a third-party TTS plugin. Memo 1.7.5 installs the `.memox` and shows
the provider in its plugin list, but the bundled Temo editor hard-codes its TTS
provider dropdown to Edge and Volcengine, so GPT-SoVITS is not selectable there.
Gate A remains `STOPPED_AT_GATE_A`.

## 项目目标

为 Memo（macOS 原生应用）开发一个 GPT-SoVITS TTS provider 插件。本仓库当前处于
Phase 0：不生成真实语音，只提供可复现的 `.memox` 打包、安全契约测试和一个静音 WAV
占位运行时，用于验证 Memo 对第三方 TTS 插件的安装与加载链路。

## 当前能力与边界

- 自包含 CommonJS 入口 `index.js`：`textToSpeech()` 返回 32kHz/16-bit/单声道/100ms
  静音 WAV `Buffer`（占位，非真实 GPT-SoVITS 合成）。
- `manifest.json` 声明 `type: tts`、`importType: commonjs`、`platforms: [darwin]`、
  `arch: [arm64]`。
- `scripts/build-memox.sh` 使用系统 `zip -X` 构建确定性 `.memox`：固定白名单、entry
  顺序、mtime、0644 权限，拒绝 symlink/路径穿越/恶意 manifest；连续两次构建 SHA-256
  一致。
- 未实现：真实 GPT-SoVITS `/tts` 调用、真实音频、签名、市场发布、自动升级、修改
  Memo 的 `index.json` 或 `app.asar`。

## Memo 1.7.5 真实结果：Gate A STOP

2026-08-11 本机真实验证结果：

- Memo 1.7.5 原生接受本仓库构建的 `.memox`，由 Memo 自己创建插件目录并登记
  `plugins/index.json`；
- 重启后「三方集成 → 语音合成」显示 `GPT-SoVITS TTS v1.0.0`；
- 独立 Temo「文本转语音」窗口的服务下拉框只显示 Edge 与 Volcengine；
- 根因是 Memo 1.7.5 随附 Temo 前端硬编码 TTS provider 白名单
  `BA = ["edge", "volcengine"]`，没有可配置的第三方 TTS 扩展入口；
- 因此真实服务无法选择 GPT-SoVITS，Gate A 保持 `STOPPED_AT_GATE_A`，本项目目前
  **不是可用的 GPT-SoVITS 插件**。

本项目明确不采用以下绕过方式：把 `provider`、`pluginId` 或 `label` 伪装成
Edge/Volcengine；修改 Memo 前端资产、`app.asar` 或 `plugins/index.json`。

## 如何配合 Memo 作者开放接口

如需在 Memo 中使用第三方 TTS provider，请向 Memo 作者反馈开放以下任一能力：

1. Temo 移除 TTS provider 硬编码过滤，让所有已安装的 `type: tts` provider 进入服务列表；
2. 提供正式的第三方 TTS allowlist/扩展注册接口；
3. 升级到已支持上述能力的 Memo/Temo 版本。

宿主能力更新后，可按 `docs/phase-0-gates.md` 重新执行 Gate A 验收，无需重做已通过
的 `.memox` 安全与确定性工作。

## 构建 `.memox`

```bash
mkdir -p dist
scripts/build-memox.sh --output-dir dist
```

产物固定为 `dist/memo-plugin-tts-gptsovits-1.0.0.memox`，同目录生成 SHA-256 sidecar。
二进制产物、截图和本机证据均不进入 Git。

## Direct-root 禁用

`scripts/install-local.sh` 对 canonical 真实 `~/Library/Application Support/Memo`
无条件 fail-closed 拒绝（包括 filesystem identity 等价 alias），并要求使用 Memo 原生
`.memox` 流程。真实 Memo root 任何写入均由脚本拒绝。

## 构建与测试

```bash
npm test
bash -n scripts/*.sh
```

运行环境要求：Node 主版本 22，系统 `zip`/`unzip`。

## License

MIT。`package.json` 保留 `"private": true`，防止误发布到 npm；本仓库只面向 GitHub
源码分发。
