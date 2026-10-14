# Memo 多后端 TTS 实施启动记录

日期：2026-10-13；主控：Friday；状态：文档已定稿，编码任务在模型调用阶段受阻，尚未实现升级功能。

## 已交付

- 设计基线 v2：docs/design/2026-10-13-multi-backend-tts-design.md。
- 执行方案 v1：docs/execution/2026-10-13-multi-backend-tts-execution-plan.md；五项任务，从协议/音频底座到真实 Memo 验收。
- 隔离目录：/Users/lynch5mo/Work Documents/Mac/memo-plugin-tts-multibackend。
- 分支：friday/memo-multi-backend-tts；基线 c8b0616；文档提交 23e67a1、1287998。
- DeepSeek V4.1 Flash/max 编码，GLM 5.3 Flash/max review 与校验，Friday 主控；未改用其他模型。
- 原项目的未跟踪设计稿保留，既有 Memo、模型安装、声音及输出均未修改。

## 验证证据

原始 npm test 完整执行，退出码 0，28/28 通过；日志 /private/tmp/memo-multibackend-baseline.Ld6N0B。这些是原 Phase 0 测试，不能证明多后端或真实发声可用。

设计链接和五项 Task 结构已检查。当前产品源码仍为原静音占位版本，没有生成新 .memox、没有新语音、没有实际导入或升级 Memo。

## 编码任务受阻

DeepSeek worker 在首次模型请求就返回 HTTP 400 / invalid_request_error。路由日志确认请求已送达 Command Code，上游约 3239ms 后拒绝；没有具体参数原因，没有证据证明是插件代码、额度或模型名称问题。

该 worker 已结束，未重复盲重试、未修改产品代码。GLM 执行稿独立审查另外派发；其结果另行补记。

修复全局 Codex Router 或其上游调用兼容属于本插件项目以外的改动，需主人额外授权。当前不改模型角色、不读写密钥、不重启代理，也不让主控/GLM 替代指定 DeepSeek 编写代码。

## 已作决定及后果

- 原生 App worktree 对嵌套项目返回 Not a git repository；改用已授权、可逆的 git worktree 保持实现隔离。额外代价是保留一个本地开发检出。
- 临时音色首版采用明确停用、可恢复保留，不物理删除。原因是 Memo 无可靠结束/引用回调且 Audio8 无 DELETE；代价是暂存资料占用少量空间。

## 下一步

获得路由修复授权并证明 DeepSeek 可正常执行后，从 Task 1 的现有简报恢复，不重新派发已完成文档任务。GLM 审查和修复后的独立校验均保留；P0/P1/P2/P3 验收仍待执行。
