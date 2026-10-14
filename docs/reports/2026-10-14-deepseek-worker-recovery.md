# DeepSeek Worker 调用恢复验证

日期：2026-10-14；授权：主人明确授权排查和必要兼容修复，保留模型、供应商及密钥。

## 结果

DeepSeek V4.1 Flash / max 当前可以正常调用，真正的 Codex Worker 已成功接收任务并返回指定标记。未修改任何全局路由源码或配置，未更换模型/供应商，未读取或改写密钥，未重启 Codex 或代理。

原先 HTTP 400 的具体被拒参数仍未知；当前无法稳定重现，因此不归因于 Max、额度、模型不存在或插件代码，也不宣称完成了根因代码补丁。此次解决的是恢复可执行调用并重新验证。

## 验证

在已安装路由的既有兼容测试工具运行：

~~~text
node src/compatibility-test.mjs commandcode/deepseek-v4.1-flash --live --yes --quick --effort=max --json
node src/compatibility-test.mjs commandcode/deepseek-v4.1-flash --live --yes --effort=max --json
~~~

短文本返回 200，退出码 0。完整测试的基础响应、流式、强制工具调用、无状态工具结果回传、压缩均返回 200，退出码 0。工具使用其正常配置的凭据机制，主控没有提取凭据。

日志：

- /private/tmp/memo-deepseek-max-probe.PM2fYs
- /private/tmp/memo-deepseek-max-full.sXoukn

最初沙箱内测试只有 fetch failed，未到达上游；通过权限流程以相同命令运行后成功。不能把这一沙箱结果与最初 Worker 的上游 HTTP 400 混为一谈。

原路由仓库 HEAD 1e209887fd31ff99cb711909d04a7d2784104113，状态干净。repo-maintainer 分析退出码 0、0 个变更；日志 /private/tmp/memo-router-impact.dMax7P。该只读分析含 uv 的 no-project 提示，不作为产品测试结果。

真正的 Worker：/root/memo_multitts_task1，以原模型和 max 回复 MEMO_DEEPSEEK_WORKER_OK，诊断 turn 已结束。这个标记证明启动/任务交接，不证明产品代码完成，实际编码、运行测试和 GLM review 仍须执行。

## 执行稿复核

GLM 首轮指出累计 WAV 上限和旧配置迁移缺口；Friday 已修订至 v1.1，提交 0d42889。GLM 限定复核两项均为 ADDRESSED，无新增阻塞。后续按同一分工执行，128MiB 统一按 128×1024×1024 字节计，含最终 WAV 头部。

## 剩余风险

如果上游再拒绝真实编码请求，保留准确请求阶段及错误，再定位差异；不盲目更改配置或自动换供应商。基础协议测试和 Worker 标记均不能代替本机 Audio8/Memo 完整验收。
