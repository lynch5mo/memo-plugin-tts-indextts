# Phase 0 Gates

本文记录 Task 0 的最小边界，不把后续 Task 伪装为已实现。

## Gate A — 声明与契约

- manifest 只声明 Phase 0 所需 provider、语言、语速与静态 Gate 配置。
- `manifest.json`、`i18n.json`、`options.json` 可解析，manifest 契约测试通过。
- 最小 CommonJS 运行时入口 `index.js`（自包含）：`textToSpeech()` 返回 32kHz/16-bit/单声道/100ms 静音 WAV `Buffer`（Phase 0 占位，非真实 TTS）。
- 状态：Task 0 已验证；Task 1 运行时契约测试 GREEN，真实 Memo 发现/调用未验证。

## 安装安全契约（Task 1）

- `scripts/install-local.sh`：校验源码根、manifest 插件 ID/版本；对 canonical 真实 `~/Library/Application Support/Memo` **无条件 fail-closed 拒绝**（无论 Memo 是否运行），错误信息明确要求后续经批准的 Memo-owned `.memox` 流程；仅允许明确非真实临时 root 用于测试/验证。临时 root 流程先复制到 `plugin-staging/<run-id>/` 并校验，再移动到版本目录；同版本旧目录移入 `plugin-backups/.../<run-id>/`，不删除旧目录；只复制插件必需白名单文件，不触碰其他插件或 `plugins/index.json`。
- `scripts/verify-local.sh`：用 Node argv + `fs.realpathSync` 校验 canonical `plugins` 是 canonical root 的严格 descendant、canonical plugin dir 是 canonical `plugins` 的严格 descendant；拒绝 `root/plugins` symlink 指向 root 外、plugin dir symlink、恶意 version；再校验目标文件清单、源码哈希、manifest 契约和 Node `require()` 返回静音 WAV `Buffer`；不启动或关闭 Memo。
- 临时 root 注入通过 `--root DIR` 验证，可覆盖 staging/install/backup/verify 全流程；真实 root 任何写入均由脚本无条件拒绝。

## Gate A 结果：STOPPED_AT_GATE_A

- 真实 Memo 1.7.5 direct-directory discovery **FAIL**：重启后“设置 → 语音合成”与“三方集成 → 语音合成”均无 GPT-SoVITS，`plugins/index.json` 无本插件条目且 SHA 未变，`app.asar` 未改。
- 宿主只接受 Memo 自有导入格式：`.memox` 或 application/zip；TTS 页无 Import 按钮但 drop zone 接受该格式；main `installPlugins` 会解包、读 manifest、移动到版本目录并由 Memo 自身写 `index.json`。
- 本任务不得手工写 `plugins/index.json` 绕过；真实安装已回滚到 `plugin-backups/memo-plugin-tts-gptsovits/`。
- 后续需要用户批准新增“本地打包/.memox 安装契约”任务后再继续；本 Task 不实现该打包任务。

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
