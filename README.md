# Memo × IndexTTS：本地语音克隆配音插件

把 [Memo](https://memo.ac) 的配音（TTS）接到你自己跑的 **IndexTTS 2.5** 上：用视频里原本那个人的声音，生成整篇配音，直接导出成片。

不需要云端账号，不上传素材，一切都在你自己的机器上。

- Memo 插件：`memo-plugin-tts-indextts`
- 服务端：IndexTTS 2.5 + 一层很薄的 HTTP 封装（FastAPI）
- 可选工具：槽位查询助手（让每段音频严格贴合字幕时间轴）、音色采集脚本

## 它解决什么问题

Memo 自带的在线 TTS 按字符计费，长视频成本高，而且音量、音色、时长都不受你控制。这个插件把整条链路搬到本地：

| 能力 | 说明 |
|---|---|
| 音色克隆 | 从视频里自动截一段干净人声当参考音，合成时沿用说话人的音色 |
| 时长贴合 | 每段音频精确等于字幕槽位长度（误差毫秒级），时间轴不漂移 |
| 语言自动识别 | 中英日按文本自动判断；中文里夹英文术语不会丢词 |
| 响度统一 | 输出按 EBU R128 拉到 -16 LUFS，不再是模型原始的轻音量 |
| 断点续跑 | Memo 按内容哈希缓存，重跑只补没生成的段 |

## 快速开始

### 1. 准备一台能跑 IndexTTS 的机器

IndexTTS 2.5 需要 NVIDIA GPU（16 GB 显存比较舒服，8 GB 能跑但上下文受限）。三种常见形态：

- **有独立 GPU 主机**：服务和 Memo 不在同一台机器上，用 SSH 隧道连过去（推荐）
- **单机**：GPU 和服务、Memo 都在一台机器上，插件直接连 `127.0.0.1`
- **纯 Mac**：Apple Silicon 能跑但很慢，MPS 支持不完整，只适合短素材

详细步骤见 [docs/SERVER.md](docs/SERVER.md)。

### 2. 安装插件

下载 [Releases](../../releases) 里的 `memo-plugin-tts-indextts-x.y.z.memox`，双击即可导入 Memo。

或者手动：把 `plugin/` 下的 `manifest.json`、`index.js`、`i18n.json`、`icon.svg` 放进
`~/Library/Application Support/Memo/plugins/memo-plugin-tts-indextts@<版本>/`，并在 `plugins/index.json` 的 `plugins[]` 和 `versions{}` 里登记。

### 3. 配置

Memo → 设置 → 插件 → **IndexTTS TTS**：

| 字段 | 默认值 | 说明 |
|---|---|---|
| API 地址 | `http://127.0.0.1:7861` | 服务端地址；跨机器时填隧道本地端口 |
| 音色 | `auto` | `auto` 表示按视频自动采集；也可填具体音色名 |
| 语言 | 英语 | 只是兜底，实际按文本自动判断 |
| 语速 | 1.0 | 全局倍率 |

### 4. 用

打开项目 → 配音 → 选 **IndexTTS TTS** → 生成 → 导出。

第一次合成时如果启用了槽位助手，会有一到两秒的自动采集；之后每段几十毫秒。

## 架构

```
Memo（Electron）
  └ 插件 memo-plugin-tts-indextts（vm2 沙箱，只有 http/https）
        │  POST /tts  {text, lang, voice, target_duration_ms, max_duration_ms}
        │  GET  /health  GET /voices
        ▼
IndexTTS API（FastAPI，127.0.0.1:7861）
        │  单线程推理 + 串行锁 + 崩溃自愈 + 响度/时长收尾
        ▼
IndexTTS 2.5（bf16，常驻 6.5–8.2 GB）

可选：槽位助手（127.0.0.1:7872，只读 Memo 数据目录）
  插件合成前问它“这段字幕多长”，得到精确的 et−st 与 range
```

## 为什么需要“槽位助手”

Memo 调插件时只传文本，不传字幕起止时间。没有起止时间，只能按字数估算时长，估出来的和真实槽位差一成以上——后果是：

- 时间轴被 Memo 反复调整，进度条迟迟不结束
- 导出时报 `Replacement audio does not support export timeline trimming yet`

槽位助手会在 Memo 的数据目录里按文本查到真实的 `st/et`，让每段音频严格等于槽位。它是可选的：不起也能用，只是时长没那么准。

工具在 `tools/memo-slot-oracle.py`，用法见 [docs/TOOLS.md](docs/TOOLS.md)。

## 已知限制

- 音色相似度上限由参考音决定。参考音是 16 kHz 单声道时，别指望和录音棚素材一个效果。
- 要贴合很快的语速时，音频会被加速到 1.5–2 倍，音色会变；这是物理限制，换更好/更快的参考音能缓解。
- 单卡 4080 SUPER 上，每段 5–8 秒，20 分钟视频约 11 分钟合成。
- 插件沙箱没有文件系统权限，所以所有文件相关的活（槽位、音色采集）都在 Mac 侧的辅助进程里做。

## 目录

```
plugin/        Memo 插件源码
server/        IndexTTS 的 HTTP 封装
tools/         槽位助手、音色采集、跑前体检
docs/          部署、工具、故障排查
dist/          打包好的 .memox
```

## 许可证

MIT，见 [LICENSE](LICENSE)。

---

# Memo × IndexTTS (English)

A Memo TTS plugin that talks to your own **IndexTTS 2.5** server, so you can dub a video in the original speaker's voice, fully offline.

- `plugin/` – Memo plugin (manifest, index.js)
- `server/` – thin FastAPI wrapper around IndexTTS 2.5
- `tools/` – optional macOS helper that reads Memo's data directory to get exact subtitle slot lengths

Quick start: run `server/api_server.py` on a machine with an NVIDIA GPU, install `dist/*.memox` into Memo, set the API address to that server. See [docs/SERVER.md](docs/SERVER.md) for details (Chinese).
