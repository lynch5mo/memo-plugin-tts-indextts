# 音色采集实验原型：未完成实机验真

## 定位与限制

此目录保存开发中的验证器，不是已完成的视频音色采集插件。目标是在不修改 Memo 本体的条件下，验证“当前文稿媒体与字幕→获准采样→音色准备→译文配音”的可行性。最新状态以 [项目状态说明](PROJECT_STATUS.md) 为准。

- App ID：`memo-plugin-app-voice-feasibility`。
- 当前源码版本：0.1.1。
- 依赖宿主：Memo 1.8.8 或更高版本，目标环境 macOS ARM64。
- 当前原生验真：A1、A2、A3 均未完成；B 未执行。
- 包存在或能够导入，不代表采样、音色注册或译文配音已经成功。

## 组成

| 位置 | 用途 |
| --- | --- |
| `apps/voice-feasibility/` | 独立 App 页面、最小 module 入口与 manifest |
| `scripts/voice-capture/fixture.js` | 从自有 WAV 制备静态画面 MP4、预期原文和译文、摘要 |
| `scripts/voice-capture/core.js` | 仅服务本次 fixture 的本地会话、已登记媒体快照与取样 |
| `scripts/voice-capture/judge.js` | 汇总技术状态，不自行签发原生 A 验收或启动 B |
| `scripts/voice-capture/pack-app.js` | 将固定三文件打成实验 App 包 |
| `scripts/voice-capture/cli.js` | `fixture`、`pack`、`core`、`register-media`、`judge` 子命令 |
| `test/voice-capture-*.test.js` | 隔离自动化测试；不替代原生验证 |

## 本地构建与单测

从仓库根目录执行：

```bash
node --test test/voice-capture-fixture.test.js test/voice-capture-core.test.js
node scripts/voice-capture/cli.js pack --out ./dist/voice-feasibility
```

当前打包器需要现成的 `zip`、`unzip` 和系统 `touch`，不下载依赖。输出 `.memox` 和摘要 sidecar；不要把构建行为理解为自动安装。只有操作者明确同意后才应经 Memo 自身入口导入新包。

试验媒体没有放入仓库。制备时必须提供一份有权使用的本地 WAV：

```bash
node scripts/voice-capture/cli.js fixture \
  --source-wav /path/to/authorized-sample.wav \
  --original-text '与采样逐字对应的原文' \
  --translation-text '用于试音的另一语言译文' \
  --out ./output/voice-capture-fixture \
  --ffmpeg /path/to/ffmpeg
```

此命令需要现成 FFmpeg/ffprobe 环境。候选长度不是声线质量保证；本机 Audio8 注册代码的参考音频限制为 0.5–30 秒。原文应对应参考录音，不是参考录音的翻译。没有准确原文时不能拿译文替代。

## 为什么不提供一条“运行即完成”的命令

关键数据必须来自真实 Memo，而不能由验证器内置的 fixture 冒充宿主返回：

1. 在 Memo 原生创建唯一测试文稿，取得媒体定位、文稿三元组、原文/译文和时间轴。
2. 核对真实 App 来源，固定允许的精确 Origin 和 Host；不能允许任意来源或 `null`。
3. 由操作者确认确切媒体及来源链，登记 `mediaId`、文稿身份、文件身份和摘要，不能授权整个媒体目录。
4. 运行 App 原生步骤，核对采样、译文合成、播放与保存的同轮证据。
5. 人工确认对应音频的内容与末句后，由负责人裁决 A。不能用命令行参数、手写 JSON 或某个 `sourceKind` 字段直接代签。

缺少这些步骤时，技术工具应保留未运行、失败或待人工/操作者状态，不能宣布闭环通过。当前 CLI 和核心仍是开发期实验代码，实际返回形状、来源门禁及完整边界需要继续验证，不应作为通用本地文件服务或生产服务部署。

## 未实现或未验收

- 尚未在新 App 中实测取回当前视频、原文、译文和完整时间轴。
- 尚未实测打包后的 App Origin、受限令牌引导与安全裁切。
- 页面已加入译文合成、播放和保存代码，但真实宿主返回、最终文件与人工听感未验收。
- 尚未完成抽取样本到新音色注册、绑定及跨语言合成；当前环境未执行 B。
- 无字幕自动转写、多人自动区分、人声分离、复杂候选评分和严格时长/口型对齐不在首版验证范围。
- 本地模型文件在位不等于已验证可离线运行；不得自动转用云服务、下载模型或注册真人声音。

## 安全边界

实验 App 不应修改 Memo 本体、已安装插件文件或数据库，不使用运行时注入；现有管理页的 CSP、cookie 与同源保护不得为实验放宽。

核心不应在权限检查之前解码任意客户端路径；只有已批准的确切媒体才能被打开。所有裁切使用固定可执行文件及 argv，不把媒体 URL、路径或字幕拼成 shell 命令。能力令牌只放内存及专用请求头，不放 URL、日志或仓库。

注册未知完成状态不得自动重发；模型注册、目录提交、合成与人工验收是不同状态。没有 A 通过的负责人裁决，不应启动 B。上述边界是实验必须满足的要求，不构成完整安全审计已通过的声明。
