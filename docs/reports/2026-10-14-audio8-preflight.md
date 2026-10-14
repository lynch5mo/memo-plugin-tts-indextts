# Audio8 本机接口预检

日期：2026-10-14；性质：主控对已安装模型的隔离预检，不是完整插件验收。

## 环境和保护边界

复用 /Users/lynch5mo/Applications/Audio8_TTS/onnx_runtime，CPU/int4、codec/fp16、5 线程，使用原有 default 音色。启动现有入口但禁写 Python bytecode，未运行改写 PID/日志文件的启动脚本，未修改源码、环境、权重、音色及用户输出。

自有实例监听 127.0.0.1:18024，PID 76908；启动和端口归属已通过自身启动日志与 lsof 核对。不连接、不停止主人的其他服务。

Memo 当前版本再次读取为 1.8.8。

## 实际结果

两次 POST /api/tts（text、voice_name=default、seed=42、max_new_tokens=1024）均返回 HTTP 200 / audio/wav，零重试。

| 输入 | 文件 | 字节 | 音频时长 | 合成耗时 |
| --- | --- | --- | --- | --- |
| 这是一段本地语音测试。请检查最后一句：今天的测试到此结束。 | chinese.wav | 639020 | 7.245 秒 | 10819ms |
| 欢迎回来。Today we are testing local speech synthesis. 最后一句：本次测试到此结束。 | mixed.wav | 778284 | 8.824 秒 | 11968ms |

输出目录：/private/tmp/memo-audio8-preflight-6NFksn。

当前 c2131ff 的生产 parseWav 校验两份真实输出均通过：44100Hz、单声道、PCM16、长度自洽、非静音。中文 RMS 2651.77/峰值 15993，中英混合 RMS 2550.12/峰值 18797（PCM16 样本值）。

独立 ffprobe 对中文输出再次确认 pcm_s16le、44100Hz、1 声道、16bit、7.244626 秒，退出码 0。两份生产解析验证命令退出码 0。

GET /api/system 记录服务自己的 footprint 指标：模型初始加载 current=923MB、peak=1072MB；两次合成后 current=1816MB、peak=1816MB。这不是整机占用，也不是采样 RSS 的峰值，更不能当作与 GPT-SoVITS 的公平性能比较。

## 证据边界

目前证实的是现有 Audio8 接口加载和合成、真实输出容器及非静音波形。没有确认实际朗读文本、末尾完整性、自然度或音色相似度；它们需要试听或经过授权的识别验证。没有从 WAV 伪造 EOS/完成标记。

此预检不经新的插件后端适配器，不经 Memo 导入/缓存/播放。P1/P2 验收仍待后续任务实施；服务关联只由本次受控启动明确，不能把任意已存在 manifest 文件当作其他进程加载了相同模型的证据。

源码和权重存在的 GPT-SoVITS 尚未做当前实例合成验证，不能因此标成双后端可用。
