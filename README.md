# Memo 本地语音合成插件（Audio8 / GPT-SoVITS）

## 当前交付状态：部分实现，尚未完成完整产品验收

本仓库保存已实现的 TTS 基础、音色管理工具，以及未通过端到端验真的音色采集实验原型，不是功能全部完成的正式版本。

- 已有音色合成：Audio8 经插件入口和 Memo 原生界面取得过真实非静音音频；完整听感验收仍未关闭。
- 从当前视频采集讲者音色，再生成译文配音：尚未证实可行，也没有被证明不可行；不能作为已可用功能使用。
- 采集实验 App：已开发并原生导入过 0.1.1 验证候选，但尚未完成当前文稿读取、安全取样、译文合成和新音色闭环的原生验收。
- GPT-SoVITS：因无法可靠核验已加载模型身份，保持 fail-closed，不可声称双后端均已可用。
- 当前代码在本机复跑 `npm test` 为 419/419、无跳过；这是自动化测试结果，不等于上述真实使用流程已经通过。

最新交付范围、实际阻塞、剩余风险和后续验收条件见 [项目状态说明](docs/PROJECT_STATUS.md)；采集实验的边界和复现入口见 [实验原型说明](docs/voice-capture-experiment.md)。本仓库不包含本机回退配置、模型、音色数据、实机音视频或 Agent 原始日志。

本插件是 Memo 的本地 TTS provider，保留原有身份：

- pluginId 为 memo-plugin-tts-gptsovits
- provider.value 为 GPT-SoVITS TTS
- 目标版本 2.0.0，要求 Memo 1.8.8 或更高版本
- 宿主 importType 为 module，发布入口是自包含单文件 CommonJS，导出 default 与 getEditorOptions

TTS 基础的历史实测：源码与安装包契约已通过自动化测试；曾在 Memo 1.8.8 中完成 2.0.0 原生导入，并在正文 TTS 编辑器里产出一次真实 Audio8 合成（8.312744 秒 PCM16 44.1kHz 单声道）。完整原始实机记录仅保留本地，不随本次 GitHub 提交上传；公开摘要见项目状态说明。配置传参已实测（catalogPath 在通用设置里持久化，model/voiceName 由正文编辑器选择后随调用传入）；受控 revision 已测——namespace 逻辑 1→2 原生重选声音后缓存产生新 key/path，旧文件保留。人工听感、真实换录音/换模型/换 endpoint 后的缓存行为、新注册音色与 GPT-SoVITS 仍未验收；本文件不把模拟测试写成实机全量成功。

## 支持的后端与就绪状态

- Audio8：本地 ONNX 服务。插件只通过本机 loopback HTTP 调用已有的 /api/health、/api/voices、/api/memo/runtime 与 POST /api/tts。身份核验通过只说明在线模型组、路径、精度与本地清单一致，不等于实机试音通过。
- GPT-SoVITS：以本机 api_v2.py 的 POST /tts 为准。本机服务不提供可核验的已加载模型组身份接口，因此插件对 GPT-SoVITS 一律保持未验证：它不会出现在可用声音列表里，也不会发起合成请求。该后端需要后续任务裁决身份证据方案后才能放开。

## 音色资料目录

- 配置项 catalogPath 指向一个 catalog.json 文件，不是目录，且必须显式填写：在 Memo 通用设置里键盘输入真实 catalog.json 的绝对路径并保存（已实测持久化）。插件源码里的 ~/.local/share/memo-local-tts/catalog.json 只是调用方完全不传 catalogPath 时的兜底常量；宿主会把 manifest 里的空字符串传下来，插件对空串直接按未配置拒绝（ERR_PLUGIN_NOT_CONFIGURED），不会静默 fallback。仓内的本地管理工具也不使用该默认位置，它要求显式 --root。
- 插件只读取该文件，不创建也不修改它；资料目录由独立管理流程初始化。
- 目录里的 endpoint、profile、binding 与 revision 决定可选音色；更换参考音频、模型或 endpoint 必须提升 binding revision，否则旧选择会被拒绝。

## 构建

生成单文件发布入口（可复现，同一输入 byte-identical）：

    npm run build

生成可导入的 .memox 包与 sha256 sidecar（只写本地输出目录，不安装、不发布）：

    scripts/build-memox.sh --output-dir ./dist

构建器只打包固定白名单源文件，不执行用户目录代码，发布包内不含内部测试导出。

## 原生导入与选择入口（已现场实测）

1. 用 .memox 走 Memo 原生导入；实测导入后本机 plugins 的活动版本为 2.0.0，provider 仍为 GPT-SoVITS TTS。
2. 通用设置里只填 catalogPath：设置 → 语音合成 → 本地语音合成 → 该插件的 catalogPath 文本框，键盘输入 catalog.json 的绝对路径并保存（已实测持久化）。
3. 通用设置里的 model 与 voiceName 在 Memo 1.8.8 中显示为空 Select，不要把它们当作选择入口：宿主在通用设置只渲染 manifest 的静态 options，而这两个字段没有静态候选，宿主也不会在这条路径调用插件的动态选项接口。
4. 引擎与音色的选择在正文 TTS 编辑器里完成：首页左侧 Memo → 简单文字转语音（界面文案为文本转语音）→ 新建脚本 → 服务选 GPT-SoVITS TTS（保留的 provider 名）→ 角色 → 添加角色 → 命名 → 选择音色。该面板会动态列出 Audio8（在线身份已核验、尚未实机试音）以及 GPT 未配置，Audio8 默认音色显示已核验。
5. 在正文输入 @ 选择刚建的角色，再输入独立文本并合成。
6. 配置传参已实测：catalogPath 在设置里持久化，model/voiceName 由正文编辑器选择后随调用传入（现场 info.options 可见）。受控 revision 重选已见缓存新 key/path 且旧文件保留；真实换录音、换模型、换 endpoint 后的缓存行为仍需单独验收，不能由本仓库的模拟测试代替。

## 从 1.0.0 升级与回退

- 这是重置式升级：1.0.0 的旧配置（language 与 speed）不会自动映射成新模型参数。宿主仍会把旧值传进插件调用（现场 info.options 可见 language=ZH_CN、speed=20）；插件只从已核验绑定的 params 构造请求并走 src/backends/audio8.js 的采样参数白名单，未支持的键会被明确拒绝（见既有测试）。本仓库没有捕获真实网络请求体，因此不宣称线上请求体的具体内容，也不宣称旧设置已被清空。
- 旧版本配置按 pluginId@version 分开保存并保持原样；现场核对显示旧配置条目未被改写、新配置条目另建。本插件不读写真实 Memo 索引来做迁移。
- 需要回退时，用同样的原生导入方式重新导入 1.0.0 包即可：现场实测活动版本回到 1.0.0，再次导入 2.0.0 又回到 2.0.0（两个方向 nativeOpenExit=0）。旧 1.0.0 目录在磁盘上保留；代码里未见自动降级入口，因此回退依赖重新导入，而不是界面上的版本切换按钮。

## 显式启动服务

- Audio8：由使用者显式启动本机服务。仓库提供 scripts/audio8-service.py 作为只读身份辅助入口，默认只监听 loopback；它不注册音色、不切换权重、不启动第二个模型进程。
- GPT-SoVITS：由使用者显式启动本机 api_v2.py。插件不会调用 /set_gpt_weights、/set_sovits_weights、/set_refer_audio 或 /control。
- 插件不安装依赖、不下载权重、不设置开机自启。

## 本地音色管理工具（可选）

可选的本机辅助工具，用来准备自有讲师音色、查看已有音色并维护临时/持久生命周期；它不参与插件合成链路，也不是插件运行依赖。

    npm run manager -- --root <资料根> --initialize   # 仅首次，显式创建自有资料根
    npm run manager -- --root <资料根>                # 普通启动，只校验既有目录

只监听 127.0.0.1，停止用 Ctrl+C，只关闭本工具自己的服务，不停止模型、不删除资料与锁。详细说明见 docs/voice-manager.md。以下边界在使用前必须清楚：端点需要在 catalog.json 中人工配置（本批不提供端点写接口）；页面显示的目录声明状态不代表已在线试听；GPT-SoVITS 仍未验证且不可用；准备音色的授权责任在使用者。

## 实机验收门槛

以下列出已有实测及仍未关闭的边界；它们不构成整个项目已完成的声明：

- 原生导入与单文件 module 加载已现场实测通过；动态选项在正文 TTS 编辑器可用，但通用设置的 model/voiceName 下拉在本宿主版本为空（见上）。
- 缓存计算：同键重复合成已见同一分段缓存文件的键、字节、mtime 与 sha256 全部不变（现场未观测到请求计数，不能据此宣称服务收到零请求）；受控 revision 已测——namespace 逻辑 revision 1→2 并在原生界面重选声音后，缓存产生新 key/path，旧文件保留；真实换录音、换模型、换 endpoint 三类变更仍未测。
- 宿主缓存文件以 .mp3 作为扩展名，但独立探测其内容为 WAV（format_name=wav，44.1kHz 单声道）；不要据扩展名判定失败，也不要手动改写缓存。
- Audio8 真实合成：已在宿主内产出一次 8.312744 秒 PCM16 44.1kHz 单声道音频并有播放记录；人工听感与音色身份未确认。
- GPT-SoVITS 身份证据与真实合成：当前保持未验证且不可选（fail-closed）。
- 宿主对错误字符串的处理：插件只返回固定中文分类错误，不暴露原始错误码、服务正文或地址，以免误触宿主对英文错误串的自动重试。
