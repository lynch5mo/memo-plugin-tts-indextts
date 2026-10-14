# Memo 多后端本地语音插件执行方案

版本：v1.2；日期：2026-10-13；2026-10-14 根据 GLM 审查及实际 API 补充验收边界和同进程模型身份接口；状态：已获实施授权。设计事实与实现结果分开记录。

给执行 Agent：Friday 使用 superpowers:subagent-driven-development 逐任务派发；DeepSeek worker 只执行自己的任务简报，不再派生其他 Agent。每项任务先写测试、记录预期失败，再实现、验证、提交，最后交 GLM 独立审查。

目标：把现有静音占位插件升级为可真实发声的多后端插件，优先打通 Audio8，支持保存及临时使用讲师音色，并保留经独立验证的 GPT-SoVITS 接入。

架构：插件内部静态适配器直接调用本机模型服务。音色管理工具按需启动，只负责独立资料与绑定；不新增常驻合成代理。源码分模块，发布入口构建为单文件 CommonJS。

技术栈：Node.js 标准库、CommonJS、node:test、现有 Bash 打包工具；复用已安装 Audio8 ONNX 服务和 GPT-SoVITS，不在本轮自动安装或升级它们。

设计基线：[多后端设计稿](../design/2026-10-13-multi-backend-tts-design.md)。

## 全局约束

- 用户称呼为“主人”；交付文档、界面和错误说明使用中文，正文不加粗，不使用装饰性分割线。
- DeepSeek V4.1 Flash（max）负责产品代码、测试及修复；GLM 5.3 Flash（max）负责只读 review 和独立校验；Friday 负责设计、任务边界、裁决及验收。
- 保留 pluginId 为 memo-plugin-tts-gptsovits、provider.value 为 GPT-SoVITS TTS；目标版本 2.0.0，最低 Memo 1.8.8。importType 使用 module，导出 module.exports 的 default 与 getEditorOptions。
- 仅在隔离开发分支编写代码。允许为任务创建本地提交；不推送、不发布、不创建 PR、不自动归档知识库。
- 不修改真实 Memo 的 plugins/index.json、已安装插件目录或 app.asar；真实安装走 Memo 原生导入，升级及旧配置恢复另行记录。
- 不修改 Audio8、GPT-SoVITS 既有源码、环境、模型、音色及输出；本轮不自动安装依赖、下载权重、训练模型或设置开机自启。
- 所有写入、音色清理和进程控制须验证归属。不能关闭主人已启动的服务，不能删除已有音色，不能认领旧目录。
- 不返回静音占位 WAV，不自动换模型/音色，不隐式注册音色，不重试完成状态未知的合成 POST。
- HTTP 仅使用已配置的 loopback endpoint；不使用 Memo 的云代理 agent，不跟随重定向；URL、声音值和路径均不作为代码执行。
- 每次调用固定配置快照；模型服务串行能力来自其实际锁。超时只表示客户端停止等待，不代表推理停止。
- Audio8 不发送 speed、rate、emotion 或目标 language 等不存在的字段。GPT-SoVITS 不调用全局权重切换。
- 成功必须是有效、非静音 PCM WAV；分段完整覆盖输入，格式不一致或任一段失败则整体失败。
- 音色原始资料、后端绑定、派生缓存分离；声音选择值包含 backendId、endpointId、bindingId、revision。
- 临时音色由主人明确结束或保存，不能根据一次合成返回、窗口关闭或 options.uuid 自动删除。
- 未经真实合成验证的后端只能标为“未配置/未验证”。契约测试通过不等于本机可用。
- 完整验证输出保存在本计划专属日志；展示有限内容并保留真实退出码。生成语音只能存放开发目录，不覆盖用户文件。

## 验收分级与当前基线

- 基线提交：c8b06162c93c56dfe16163cc8f365603c9a0b14f；原始 28 项测试通过，但只证明 Phase 0 占位行为。
- P0：HTTP、音频、身份、目录及模型绑定的自动化契约通过。
- P1：本机现有 Audio8 经过插件入口合成，获得非静音、可播放且结尾完整的中文和中英混合语音。
- P2：真实 Memo 原生导入、引擎与音色菜单、生成音频、更新绑定后的缓存和下述重置式升级标准通过。
- 1.0.0 → 2.0.0 采用重置式升级：新版本首次运行使用其 manifest 默认值；旧 speed/language 不进入 Audio8 请求；保留旧 1.0.0 配置及可回退安装；主人重新选择引擎、catalogPath 和音色。不能把保留 pluginId 解释为自动迁移。若宿主实际保留其他值，记录并显式校正，不改真实索引绕过。
- P3：临时/持久音色及保护边界通过；GPT-SoVITS 单独实测通过后才标可用。
- 未达到的级别如实保留，不把 P0 说成整个插件已经可用。GPT 缺权重或环境不兼容时不擅自安装，保留适配器契约和具体未就绪原因。

## 文件与责任边界

| 路径 | 职责 |
| --- | --- |
| src/http-client.js | 有界、只连接本机的 HTTP 请求 |
| src/wav.js | PCM WAV 验证、解析和重新组装 |
| src/text.js | Unicode 文本完整分段 |
| src/voice-value.js、src/catalog.js | 声音身份与只读目录校验 |
| src/backends/audio8.js、src/backends/gpt-sovits.js | 两个后端的真实协议映射 |
| src/backends/index.js | 静态适配器注册与能力 |
| src/plugin.js、index.js | Memo 导出和单文件发布入口 |
| scripts/build-runtime.js | 固定源码集合构建，不加载用户扩展代码 |
| scripts/audio8-service.py | 复用原 FastAPI app 的同进程启动辅助入口，只增加只读模型身份接口 |
| manager/store.js、manager/server.js、manager/index.js | 按需音色资料管理与本机界面 |
| scripts/smoke-local.js | 显式启动/连接与真实语音验证 |
| test/*.test.js、test/helpers/* | 自动化行为及协议测试 |
| manifest.json、i18n.json、options.json | Memo 配置与动态菜单 |
| scripts/*-local.sh、scripts/build-memox.sh | 安全边界和可复现打包 |
| docs/reports/、README.md | 中文操作说明与实际验收证据 |

不添加通用队列框架、模型市场、云代理、任意插件加载器或语速后处理。

## 关键接口与资料格式

内部请求均为普通对象和 Buffer，不引入额外类型系统或依赖。

- HTTP：request({baseUrl, path, method, json, body, headers, timeoutMs, maxBytes}) → Promise<{statusCode, headers, body, json}>。json 是按响应类型解析的便捷字段，失败为 null；音频始终校验原始 body。默认合成超时 120000ms，探测 3000ms，单次响应上限 16MiB。
- WAV：parseWav(buffer) → {sampleRate, channels, bitsPerSample, pcm}；joinWav(buffers) → Buffer。首版支持 PCM16，最多 2 声道；最终 WAV 容器（含头部）上限 128MiB，累计大小在分配合并 Buffer 之前校验。
- 文本：splitText(text, maxChars) → string[]。以 Unicode code point 计数，段拼接必须等于输入；空输入明确失败，总输入最多 10000 个 code point，不悄悄截断。
- 声音身份：encodeVoiceValue({backendId, endpointId, bindingId, revision}) → string；decodeVoiceValue(value) → 同一对象。前缀 localtts:v1:，正文使用 base64url JSON；revision 为正整数。
- 目录：readCatalog(catalogPath) → {schemaVersion:1, endpoints:[], profiles:[], bindings:[]}；resolveBinding(catalog, model, voiceValue) → 固定 endpoint/profile/binding 快照。
- endpoint：id、backendId、baseUrl、modelFingerprint、readiness；Audio8 增加 runtimeManifestPath、voicesRoot、precision、codecPrecision。其路径只读、须核验真实路径及已确认的服务关联；单凭旧 manifest 文件不能宣称在线模型已确认。
- profile：id、label、persistence（saved/temporary/external）、source（audioPath/referenceText/language，可缺但不能声称可迁移）、owner。
- binding：id、profileId、backendId、endpointId、nativeVoiceId、modelFingerprint、revision、status（ready/unverified/invalid/needsPreparation）、params。参考资料、endpoint 或模型改变必须更新 revision。
- Audio8 binding 另保存 nativeVoiceFingerprint：由实际 name/reference_text/source_sha256/model_fingerprint/shape/dtype/sample_rate 的固定顺序对象计算 SHA-256，适配器导出 voiceFingerprint(meta) 供管理工具复用。合成前、列声音时比对当前元数据；同名外部声音被改写时旧绑定不可用，提示重新确认并增加 revision。该校验不能承诺宿主已经缓存的历史音频会自动清除，真实缓存边界需 Task5报告。
- 每个适配器：id、capabilities；probe(context)、listVoices(context)、synthesize({endpoint,binding,profile,text,parameters})。后者返回 {audio:Buffer}，不能伪造模型未提供的 EOS/完成原因。
- Audio8：POST /api/tts，text、voice_name 和已支持的采样参数；GET /api/health、GET /api/voices。中文/英文不以参考录音语言过滤声音。
- Audio8 身份接口：使用 scripts/audio8-service.py 直接运行已安装的 FastAPI app，不修改安装源码。GET /api/memo/runtime 从当前 require_runtime() 对象返回 {backendId:"audio8", modelFingerprint, modelDir, voicesRoot, precision, codecPrecision, instanceId}；instanceId 为本次服务进程随机值。适配器比对本机 manifest 指纹、modelDir/voicesRoot 真实路径、精度与在线报告，再比对声音元数据；只填 readiness=verified 不足以放行，裸服务缺接口时明确 unverified。辅助入口不切权重，不发起合成，不新增代理或模型进程；仅用本机已有 Python 环境，默认 loopback 监听，服务启动仍显式执行。
- GPT-SoVITS：以本机 api_v2.py 的 POST /tts 为准；ref_audio_path、prompt_text、prompt_lang、text_lang、media_type=wav、streaming_mode=false。参数、参考音频及已加载模型组须核实；不同权重使用明确独立 endpoint。
- Memo：new TTS(config).textToSpeech(options) → Promise<Buffer|string>；getEditorOptions({fieldKey,config,query,...}) → Promise<Array<{value,label}>>。model 为 audio8 或 gpt-sovits，voiceName 为版本化绑定值，catalogPath 为目录路径。
- 默认资料目录由管理工具显式初始化为 ~/.local/share/memo-local-tts；测试和本轮运行使用隔离目录。插件只读，不自行创建或修改这个目录。

## Review 重点

1. 旧声音值在更换引擎、参考录音、模型或地址后不能误用，也不能播放旧缓存：Task 2/3 负责。
2. Audio8 返回 200 但音频无效、静音或长句漏尾：Task 1/2/5 负责；无法从 WAV 判定 EOS 的缺口必须明确。
3. 超时发生后不能重复发送请求或清理仍可能在使用的资料：Task 1/4 负责。
4. 目录及 HTTP 边界中的符号链接、路径穿越、外部地址、重定向、异常响应：Task 1/2/4 负责。
5. 同名不同讲师、无原始录音的旧音色、音色注册失败或服务重启：Task 2/4/5 负责。

## Task 1：HTTP、音频与完整文本处理

文件：新增 src/http-client.js、src/wav.js、src/text.js、test/http-client.test.js、test/wav.test.js、test/text.test.js、test/helpers/wav-fixture.js。不改现有入口和发布版本。

接口：产出“关键接口”中 request、parseWav、joinWav、splitText；依赖仅 Node 标准库。

- [ ] 写失败测试：本地 HTTP 真服务器返回手工 PCM16 WAV；200 JSON、3xx、超时、16MiB 超限、非 loopback/凭据 URL 均失败；超时 POST 只发一次，不跟随重定向。
- [ ] 写 WAV 测试：可含合法额外 RIFF chunk；拒绝长度不符、空 PCM、纯静音、非法 fmt/data、采样率/声道/位深不一致；两份 WAV 合并后只有一个容器且 PCM 逐样本正确。
- [ ] 写累计边界测试：每份 WAV 均小于 16MiB，但累计 PCM 加最终容器头部超过 128MiB 时，joinWav 必须在合并分配前失败；使用重复引用合法非静音小块控制测试本身的内存，不能返回部分音频或靠单响应超限代替此测试。
- [ ] 写文本测试：中文、英文、emoji、空白及标点分段，join('') 精确等于原文；单段不超限；空输入和超过 10000 code point 明确失败。
- [ ] 运行 node --test test/http-client.test.js test/wav.test.js test/text.test.js，记录预期 RED，再最小实现上述接口。
- [ ] 使用有界内存及明确错误，不依赖全局 fetch 或上层代理；音频验证不是靠文件扩展名判断。
- [ ] 运行针对性测试及 npm test，保存完整输出和退出码；允许原 28 项测试继续体现未集成前基线。
- [ ] 自查范围，显式暂存本任务文件并本地提交；把报告交 Friday，不派生其他 Agent。

## Task 2：音色目录与两种后端适配器

文件：新增 src/voice-value.js、src/catalog.js、src/backends/audio8.js、src/backends/gpt-sovits.js、src/backends/index.js、scripts/audio8-service.py、test/catalog.test.js、test/backends.test.js、test/voice-value.test.js；协议 fixture 仅放 test/helpers/。Python 辅助入口无新依赖，使用既有环境；具体运行验证由 Task 5 负责，Task 2 需有可独立运行的辅助入口检查。

接口：消费 Task 1 的三个模块，产出 readCatalog、resolveBinding、encodeVoiceValue、decodeVoiceValue 及静态后端注册表。目录字段按“关键接口”统一，不自行改名。

- [ ] 写身份失败测试：非法版本/JSON/字段/非整数 revision 拒绝；model 和 voiceValue 后端不一致、旧 revision、重复 ID、缺绑定/未验证绑定明确失败。
- [ ] 写 Audio8 本地 HTTP 契约测试：health/voices 按已安装源码构造完整响应；POST 只含实际支持字段；服务不可达、声音缺失、模型指纹不符、配置关联未确认均不可用。
- [ ] 写 GPT 本地 HTTP 契约测试：参考音频/原文/语言映射、完整 WAV、JSON 错误；不得在每次合成切换全局权重；未验证 endpoint 不作为可用音色返回。
- [ ] 运行新测试，记录 RED；读取本机 Audio8 service.py/voices.py/runtime_manifest.json 及 GPT-SoVITS api_v2.py 的实际契约后实现。
- [ ] 音色校验包含 model_fingerprint；Audio8 的 health 不能证明指纹，必须要求本机 manifest 与 endpoint 的显式关联及有效性证据。未取得证据则保持 unverified。
- [ ] 增加同进程身份辅助入口及本地契约测试：身份来自实际 runtime 对象而不是目录声明；缺接口、在线路径/指纹/精度不同均失败。允许只读引用已有 voices root，但禁止自动注册、reload 或修改服务。Python 脚本参数只决定显式启动的现有 Audio8 app，不被 Memo 插件当成用户模块加载器。
- [ ] 分段首轮使用 120 code point；保留完整输入，不设置虚假的原生 speed；对分段格式变化及失败整体报错。
- [ ] splitText 保留原输入；若分段中存在纯空白片段，不发送该片段的合成 POST，但所有非空白文字必须顺序完整覆盖，不能用 trim 截掉正文。
- [ ] 分段调度跟踪最终 WAV 的累计字节数；一段加入后超过 128MiB 即整体失败、不再发送下一段，不把已经得到的音频返回为成功。测试累计超限后无后续 POST，并与 Task 1 的容器总上限一致。
- [ ] 合成读取一次目录形成快照；改变目录不能把进行中的请求换成另一个声音。外部旧 profiles 仅引用，缺源音频标清楚。
- [ ] 运行针对性测试和 npm test，保存完整输出；本地提交并报告。真实端点验证属于 Task 5，不把模拟服务当作本机模型验收。

## Task 3：Memo 入口、动态菜单和升级包

文件：新增 src/plugin.js、scripts/build-runtime.js、test/editor-options.test.js；修改 index.js、manifest.json、i18n.json、options.json、package.json、scripts/build-memox.sh、scripts/install-local.sh、scripts/verify-local.sh、test/audio.test.js、test/manifest.test.js、test/plugin-contract.test.js、test/memox-package.test.js、test/install-local.test.js、README.md。只修改与新入口、版本和安全契约相关部分。

接口：消费 Task 2 的目录和适配器；产出单文件 index.js，导出 default/getEditorOptions。使用 model、voiceName、catalogPath，默认 model=audio8；保留 provider 身份、版本 2.0.0、importType=module。

- [ ] 写入口失败测试：实际请求覆盖构造配置形成快照；Buffer 合格且不是静音；服务关闭/声音缺失返回中文错误；空输入失败，不再沿用静音占位断言。
- [ ] 写动态菜单测试：model 返回两个引擎及真实就绪说明；voiceName 随 request.config.model/query 变化，只返回匹配且验证过的绑定；跨语言可选。
- [ ] 写打包和升级测试：模块加载、default/getEditorOptions、固定打包白名单、同输入 byte-identical、源码内部依赖已打入 index.js；解包后独立运行不依赖项目源码或 manager。
- [ ] 写缓存身份测试：revision、endpoint、model 改变导致 voiceName 不同；manifest 的 ttsInput 包含 model/voiceName 等合成相关字段。此测试只证明插件输出身份，宿主缓存另由 Task 5 实测。
- [ ] 运行新/修订测试，记录 RED，然后实现单文件构建及入口。构建器只打包静态源码清单，不执行用户路径的模块，不引入运行时依赖。
- [ ] 去掉旧 0–100 speed 的输入映射；中文说明升级配置按 pluginId@version 存储，旧值不自动映射成模型参数。不读写真实 Memo 索引来“迁移”。
- [ ] 测试重置式升级：2.0.0 新默认配置生效，传入旧 speed/language 也不进入 Audio8 HTTP 请求；临时 Memo root 的旧 1.0.0 配置保持原样；缺少新音色选择时给明确错误。README 写出重新选择引擎、资料目录、音色及原生回退步骤；真实宿主行为由 Task 5 再核验。
- [ ] 保留原安全安装脚本“拒绝真实 Memo root”行为；版本/manifest 断言按新目标更新，不削弱符号链接、碰撞和回滚测试。
- [ ] 运行 npm test、node 语法检查、bash -n scripts/*.sh 和打包/解包执行测试，保存日志；本地提交后交 GLM 审查。

## Task 4：按需音色管理与临时/持久生命周期

文件：新增 manager/store.js、manager/server.js、manager/index.js、test/voice-manager.test.js、docs/voice-manager.md；修改 package.json、README.md，仅添加管理工具操作命令及说明。

接口：消费 Task 2 的目录格式、身份编码、HTTP 客户端；写入目录仅由 manager 实施。store 提供 initialize、importExternal、prepareVoice、saveTemporary、endTemporary；服务只监听 127.0.0.1，提供中文表单和清晰错误。

- [ ] 写失败测试：同名资料使用不同随机 ID；保存后可复用；临时转持久保留身份及已有引用；结束临时使绑定失效且不直接删除后端资料。
- [ ] 写事务测试：注册失败保持原 catalog 不变；成功后原子发布 ready 绑定；source 和 endpoint/model 变化 bump revision；Audio8 codes 不能复制给 GPT。
- [ ] 写边界测试：符号链接、穿越、非自有目录、HTTP 跨站修改请求拒绝；外部已有资料永不清理；超时未知请求保留资料且不自动重试。
- [ ] 写缺源资料测试：导入外部已注册音色不伪造 source；跨模型准备须有可读原录音、准确原文及明确授权确认。
- [ ] 运行新测试记录 RED；以 Node 标准库实现按需管理页面，含名称、参考文件、准确原文、语言、引擎、“临时使用/保存音色”选择和“我已取得声音使用授权”确认。
- [ ] 管理页面使用随机会话令牌/同源校验、上传大小上限 50MiB，不允许任意文件路径读取或代码执行；原始录音只进入自有 namespace。
- [ ] Audio8 注册通过真实 /api/voices/register，overwrite=false，随机命名；先准备成功再发布目录。记录所有权与 endpoint；需写入主人既有服务 voices 目录时交 Friday 走权限审批，不绕过限制。
- [ ] 首版“结束临时”只做可恢复停用，不提供物理删除；这是因 Memo 无可靠结束/引用回调且 Audio8 无 DELETE API 的保守实现，不擅自认领或清理既有音色。
- [ ] 不自动启动模型服务或按窗口关闭删除资料；工具按需打开关闭，不成为插件合成依赖。
- [ ] 运行针对性测试、npm test 和工具启动/关闭 smoke；记录日志，本地提交并报告。

## Task 5：本机端到端验证与交付记录

文件：新增 scripts/smoke-local.js、test/smoke-local.test.js、docs/reports/2026-10-13-multi-backend-tts-acceptance.md；修改 README.md 中经实测证实的说明。真实宿主操作由 Friday 主控，GLM 独立检查证据并进行验证。

接口：消费已构建 index.js 和 manager 目录；smoke-local 显式接收 catalog/output 路径和可选 Audio8 启动命令，不内置下载或升级逻辑。

- [ ] 写 smoke 参数与进程所有权失败测试：拒绝覆盖已有输出；未知进程不停止；仅停止本次启动并持有句柄的子进程；本地服务不在场给出明确失败状态。
- [ ] 记录 RED，编写验证入口；运行 npm test 和打包检查，先证明测试工具本身有效。
- [ ] 只读检查现有 Audio8 安装、模型指纹及端口。若已有人启动，连接但不停止；否则经 Friday 批准运行现有 Python 入口，禁写 bytecode、日志放本计划目录、不运行改写 PID 文件的启动脚本。
- [ ] 使用已有明确可用音色生成短中文、中英混合及覆盖末尾标记的长文本；输出独立 WAV，记录源文本、实际发声时长、耗时、进程峰值 RSS、返回采样率及非静音验证。听感与内容完整需实际试听，不能只看 RIFF。
- [ ] 本轮音色目录使用隔离位置；如做新音色准备，先用开发实例自有 voices root，不能测试性覆盖既有声音。
- [ ] Friday 在 Memo 1.8.8 原生导入包，记录 module 加载、隐藏配置传参、引擎/声音菜单刷新、生成和播放、旧版配置升级及 revision 缓存更替的真实结果。权限或原生导入审批受阻则标未验证，不能脚本改索引绕过。
- [ ] 检查 GPT-SoVITS 现有环境与模型组，具备条件才单独启动/合成；不具备则给出缺少项，不安装、不冒称双后端实测。A/B 只在两后端实际通过后做，不比较不同文本/音色得到虚假结论。
- [ ] GLM 对全分支做最终 review 和独立校验，明确 P0/P1/P2/P3 哪些通过；Important/Critical 交 DeepSeek 修复后复核。
- [ ] 最终报告列变更、提交、执行命令/退出码/日志、构建包路径、真实音频、旧数据保护、剩余缺口及回退方式；没有真实证据的项目保持未通过。

## 主控审查与交付规则

每任务提交后生成从任务 BASE 到 HEAD 的完整 diff 文件；交 GLM 对需求符合性和代码质量分别给结论，并按主人要求做独立校验。只读审查不改产品文件；发现需修复交同一 DeepSeek worker。测试在相同代码上只在必要验收或具体疑点下重跑，不靠反复绿色输出增加置信度。

每项任务最多五轮修复；不能更换主人指定的模型来“升级”，超限由 Friday 记录未决风险或明确最小方案修订。以设计基线而不是计划笔误裁决，但不得掩盖结构缺陷。

项目交付不自动合入 main、不自动上传 GitHub。保留可恢复开发分支和通过检查的 .memox；真实 Memo 导入前保留原生可回退路径。代码完成、真实模型发声和 Memo 内可用分别陈述。
