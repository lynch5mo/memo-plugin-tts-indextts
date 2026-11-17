# HTTP 接口

Base URL 默认 `http://127.0.0.1:7861`。所有接口都无鉴权，所以服务必须只绑回环地址，跨机器时走 SSH 隧道。

## GET /health

```json
{"status":"ok","model":"IndexTTS-2.5","voices":["default","speaker"]}
```

注意：`ok` 只表示模型加载完成，**不保证能合成**。推理偶尔会因为数值问题崩掉，用 `/tts` 真合成一句才算数。

## GET /voices

```json
{"voices":["default","speaker","auto_c1d2048c"]}
```

## POST /voices

注册一个参考音。

```json
{"name":"speaker","audio_b64":"<base64 wav>"}
```

| 约束 | 值 |
|---|---|
| name | 只允许字母、数字、下划线、短横线，1–64 字符；`default` 保留 |
| 格式 | 只收 WAV（RIFF），单声道，建议 16 kHz 以上 |
| 时长 | 至少 1 秒，建议 10–15 秒 |
| 大小 | base64 不超过服务端上限（默认 8 MB） |

返回：`{"name":"speaker","bytes":383854}`

## DELETE /voices/{name}

删除音色，`default` 不可删。

## GET /enroll

浏览器录音页。给没有辅助工具的机器用：打开 `http://127.0.0.1:7861/enroll`，录 5 秒或 10 秒，直接注册成音色。

## POST /tts

```json
{
  "text": "要合成的文本",
  "lang": "ZH",
  "voice": "speaker",
  "speed": 1.0,
  "temperature": 0.7,
  "target_duration_ms": 4220,
  "max_duration_ms": 4420,
  "ref_audio_b64": null
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| text | 是 | 最大 20000 字符 |
| lang | 否 | `ZH` / `EN` / `JA`，默认 `ZH`。标错会毁音质——模型用它选语言嵌入 |
| voice | 否 | 音色名，默认 `default` |
| speed | 否 | 0.5–2.0，影响模型原生语速（`duration_factor = 1/speed`） |
| temperature | 否 | 默认 0.7，下限 0.5。**低于 0.5 会触发 CUDA 断言**，服务端强制钳制 |
| target_duration_ms | 否 | 目标时长。给了就先把模型语速调过去，残差再用 atempo 收，最后补静音/裁剪到精确值 |
| max_duration_ms | 否 | 硬上限。`target` 超过它时按它处理 |
| ref_audio_b64 | 否 | 直接上传参考音（base64 wav），优先于 `voice` |

返回：`audio/wav`（22050 Hz 单声道，EBU R128 -16 LUFS，峰值 -1.5 dBFS）。

错误：

| 状态 | 含义 |
|---|---|
| 400 | 文本为空 / 语言不支持 / base64 非法 |
| 404 | 音色不存在 |
| 413 | 文本或参考音超限 |
| 500 | 合成失败（服务端会重置模型重试一次） |
| 503 | 模型未就绪 |

## 时长对齐是怎么做的

给了 `target_duration_ms` 时：

```
natural_ms = 字数 ÷ 实测自然语速 × 1000     # 中文 3.79 字/秒，英文 2.13 词/秒
duration_factor = clamp(target_ms / natural_ms, 0.40, 1.80)
```

先让模型按这个系数自己说快/说慢（音质优于事后变速），生成后再：

```
tempo = 实际时长 ÷ 目标时长
atempo = clamp(tempo, 0.65, 1.90)
apad + atrim → 精确到目标毫秒
```

两个常数可以用环境变量覆盖：`TTS_NAT_WPS_EN`、`TTS_NAT_CPS_ZH`。换参考音后自然语速会变，重新标定一次更准。

## 其他环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTS_BF16` | 1 | 0 表示用 fp32（显存翻倍，一般不必要） |
| `TTS_REP_PENALTY` | 3.0 | 重复惩罚。上游默认 10 会更容易触发 CUDA 断言 |
| `TTS_TOP_P` / `TTS_TOP_K` | 0.8 / 30 | 采样参数，一般不用改 |
| `TTS_LOUDNORM` | `I=-16:TP=-1.5:LRA=11` | 响度收尾参数；设为空字符串则不做响度处理 |
| `TTS_RECYCLE` | 0 | 每 N 次请求重载模型（排查显存碎片时用） |
