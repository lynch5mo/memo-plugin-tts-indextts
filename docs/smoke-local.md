# 本地端到端验收工具（5A）

scripts/smoke-local.js 是只做证据记录的验收工具：它经已构建的单文件插件入口 index.js 合成音频，把源文本、WAV 与一份结构化报告写进一个全新的输出目录。它不直连后端适配器，不改 catalog、音色目录、模型或原始录音。

本工具的自动运行只在隔离 fixture 上做证据记录。真实宿主里的选择入口在正文 TTS 编辑器（通用设置只填 catalogPath；Memo 1.8.8 通用设置里的 model 与 voiceName 是空 Select，不是入口，详见 README 的原生导入与选择入口一节）。真实 Audio8 启动、真实讲师录音与人工听感仍需主控另行授权与确认。

## 用法

    node scripts/smoke-local.js --catalog <catalog.json> --voice <localtts:v1:...> --output <新目录> [选项]

必填参数：

- --catalog：已构建插件使用的 catalog.json 路径，只读。
- --voice：形如 localtts:v1:... 的音色选择值；后端由该值绑定决定，不做自动 fallback。
- --output：新建输出目录。必须不存在；已存在、是文件或是符号链接都会直接拒绝，不会覆盖。

选项：

- --plugin：插件入口路径，默认是仓库根的 index.js（构建产物）。
- --fixture-only：标记本次为隔离 fixture 运行，报告里 fixtureOnly=true，不冒充真实模型。
- --start-command 与 --start-arg：显式启用受控子进程。默认不启动任何服务，只连接已运行的服务。
- --help：显示中文帮助。

## 启动顺序与就绪等待

工具先做一次只读探测，再决定下一步，绝不无条件抢先启动进程：

- 不带 --start-command：只连接已运行的服务。端口无人监听时直接以“服务未启动或不可达”失败，不启动任何进程，也不阻止任何外部服务。
- 带 --start-command 且端口无人监听：先启动本次工具持有的子进程，再按有界 deadline 轮询就绪（默认 10 秒，测试可收窄）。就绪后继续；超时或子进程早退则以失败退出，并终止本次启动的进程，不自动重试。
- 带 --start-command 但端口已有服务在监听：不启动第二个进程、不争用端口，只连接本次运行，并且绝不持有或停止该外部进程。报告里会写明 started=false 与原因 port-already-listening。

子进程一律用固定可执行文件加 argv 数组启动，shell=false；URL、音色值与 catalog 内容都不会被当成命令执行。

## 输出内容

输出目录内固定产生：

- cases/<id>/source.txt：该用例的原始文本，逐字保存。
- cases/<id>/audio.wav：插件返回的完整 WAV。
- report.json：结构化报告。
- report.md：同一份报告的中文版本。

report.json 记录：插件入口路径与 SHA256、插件构建输入摘要、源码 HEAD 与未提交文件计数、音色身份（backend/endpoint/binding/revision/nativeVoiceId/label）、连通性检查结果、每个用例的源文本 SHA256 与字节数、音频 SHA256 与字节数、采样率/声道/位深、时长、单调时钟耗时、峰值样本，以及阶段结论与人工验证开关。

口径边界：

- listenVerified、contentEndingVerified、speakerSimilarityVerified 一律默认 false，只能由人工试听填写。WAV 通过容器与时间变化校验不等于全文读完，也不等于音色身份正确。
- 工具不自动 ASR、不新增依赖、不做付费调用。
- 峰值 RSS 在没有可归属的本次子进程证据时记 null，不用运行时 footprint 或进程当前 RSS 冒充峰值。

## 阶段划分

- P0 本次 smoke 自动检查：只代表本次运行实际做过并校验的部分（参数、输出独占、经插件合成、WAV 有效、源文本完整、失败不标成功），不代表全部项目契约都已通过。
- P1 真实 Audio8 发声：宿主内已有人工执行的一次真实合成记录（8.312744 秒 PCM16 44.1kHz 单声道），但人工听感未确认，本工具也不会自动标记通过，因此仍为 notVerified。
- P2 真实 Memo 原生导入、菜单与缓存：原生导入已实测一次（活动版本 2.0.0）；同键重复合成的缓存文件键、字节、mtime 与 sha256 均未变化；受控 revision 已测（namespace 逻辑 1→2 原生重选声音后产生新 key/path、旧文件保留），但真实换录音、换模型、换 endpoint 未测，整体仍为 notVerified。
- P3 音色生命周期与第二后端：不在本工具范围；GPT-SoVITS 仍未验证。

fixture 运行会把 P0 标为 passed（含义仅限本次自动检查），同时把 P1/P2/P3 保持 notVerified；后端 id 是 audio8 的模拟服务不能被写成真实模型 P1 通过。

## 失败与重试

- 一次请求只调用一次插件合成，不自动重试。
- 任一组用例失败，整次运行标为失败，不会把部分音频标成完整结果。
- 失败记录只保留固定分类、耗时与 retrySafe=false 这类状态，绝不写入后端正文、URL、密码或会话令牌。
- 注册或合成未确认完成时属于未知状态，需要人工核对；工具不会自动重发，也不把未知当成功。

## 进程所有权（受控子进程）

--start-command 是显式开关，默认不启用。启用时：

- 使用固定可执行文件加 argv 数组启动，shell=false，不接收 URL、音色值或 catalog 内容作为命令。
- 只停止本次启动并持有句柄的子进程；已存在的外部服务只读连接，永不停止。
- 不按端口扫描杀进程，不用旧 PID 冒认归属。
- spawn 失败（例如 ENOENT）与子进程早退都走结构化失败，不会未捕获异常或无限挂起。
- 先 SIGTERM，宽限期内未退出才对本次句柄升级 SIGKILL；SIGINT/SIGTERM 也只清理本次持有的句柄。
- 本地请求超时或取消不代表服务端推理已经停止，未知完成状态不会被重发。
- 子进程输出只写本次输出目录，且捕获有上限。

真实使用该开关启动 Audio8 属于主控另行授权的动作，本工具不自动执行。

## 未验证范围（本工具自动运行未覆盖）

- 真实 Audio8 注册与合成耗时、真实讲师录音与授权语义。
- 本工具不驱动浏览器：窄屏布局、键盘可达性与其它界面交互都不在它的自动断言范围内。这只说明工具覆盖边界；主控已在 5B 用真实宿主界面做过人工交互，不等同于界面未验证。
- 真实换录音、换模型、换 endpoint（非受控 revision）时的缓存替换行为。
- GPT-SoVITS 的可用性；本工具对它 fail-closed。

## 相关命令

    node scripts/smoke-local.js --help
    npm test
