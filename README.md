# Memo GPT-SoVITS TTS Plugin

Phase 0 最小工程骨架。本仓库只包含可复现的插件声明、静态配置、图标与契约测试，不包含运行时实现。

当前范围：

- Memo TTS 插件 manifest 契约（`manifest.json`）
- 中英文静态文案（`i18n.json`）与静态语言选项（`options.json`）
- 自有 SVG 图标（`icon.svg`，无第三方商标素材）
- manifest 契约测试（`test/manifest.test.js`）

明确未实现：插件运行时入口、语音生成、Memo 安装、GPT-SoVITS 调用。Phase 边界见 `docs/phase-0-gates.md`。

## 验证

```bash
npm test
```

运行环境要求：Node 主版本 22。
