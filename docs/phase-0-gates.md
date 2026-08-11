# Phase 0 Gates

本文记录 Task 0 的最小边界，不把后续 Task 伪装为已实现。

## Gate A — 声明与契约

- manifest 只声明 Phase 0 所需 provider、语言、语速与静态 Gate 配置。
- `manifest.json`、`i18n.json`、`options.json` 可解析，manifest 契约测试通过。
- 状态：Task 0 已验证（GREEN）。

## Gate B — 本地服务与运行时发现

- 验证 GPT-SoVITS `127.0.0.1:9880` 的 `/openapi.json` 存在 `POST /tts`。
- 验证 Memo 能发现并加载插件。
- 状态：端口 OpenAPI 已验证；Memo runtime 发现未验证。

## Gate C — 真实 TTS 调用

- 调用 GPT-SoVITS 生成语音并在 Memo 中完成端到端使用。
- 状态：未验证；本 Task 不生成语音、不安装插件。

## 未验证项

- Memo runtime 插件发现/加载。
- GPT-SoVITS 实际合成质量与参数兼容性。
- 完整音色库 UI 与配置持久化。
