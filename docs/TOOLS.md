# 辅助工具（可选，macOS 侧）

三个脚本都在 `tools/`，都是可选。只装插件、不起任何助手也能用——只是时长按字数估算，可能和字幕槽位差一成。

## 1. 槽位助手 `memo-slot-oracle.py`

**作用**：按文本查 Memo 数据目录里这段字幕的起止时间，让服务端把音频做成严格等于槽位长度。

**为什么需要**：Memo 调插件时不传 `st/et`，插件拿不到真实时长；而 Memo 合并音频按实际文件长度拼、字幕偏移按 `et−st` 累加，两者不一致时时间轴会漂移，导出还会报错。

**怎么跑**：

```bash
python3 tools/memo-slot-oracle.py
# 默认监听 127.0.0.1:7872，数据根目录 ~/Library/Application Support/Memo/temp/memo
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ORACLE_PORT` | 7872 | 监听端口 |
| `MEMO_DATA_ROOT` | `~/Library/Application Support/Memo/temp/memo` | Memo 数据目录 |
| `TTS_BASE` | `http://127.0.0.1:7861` | 音色注册时用的服务端地址 |
| `FFMPEG_BIN` | 自动探测 | ffmpeg 路径 |

**常驻**（launchd，崩溃自动拉起）：

```xml
<!-- ~/Library/LaunchAgents/com.example.memo-slot-oracle.plist -->
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/python3</string>
  <string>/绝对路径/tools/memo-slot-oracle.py</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key>
<dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
```

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.example.memo-slot-oracle.plist
curl -s http://127.0.0.1:7872/healthz
```

**接口**：

```
GET  /slot?text=<文本>[&file=<uuid>]
     → {"slot_ms":7060,"range_ms":7060,"st_ms":0,"et_ms":7060,
        "seg_index":0,"seg_total":679,"track":"translate","match":"exact"}
     → 404 {"reason":"text_not_matched"}

POST /voice/ensure  {"text":"<文本>"}
     → {"ok":true,"voice":"auto_xxxxxxxx","cached":false,"start_s":28.0}

GET  /healthz   GET /stats
```

**匹配策略**（自动，无需干预）：

1. 精确匹配：去掉标点、空白、全半角差异后比字面
2. 相似度：≥0.78 且明显领先第二名，用于改过术语的字幕
3. 位置兜底：相似度 + 预期时长 + 段序综合打分，证据不足时宁可返回未命中
4. 全部未命中：返回 404，插件退回字数估算，并把句子记进 `/tmp/oracle-miss.log`

你改字幕时 Memo 会写回 `project.json`，助手按文件 mtime 自动重建索引，改完立刻生效，不需要重启。

**支持的数据格式**：

- 新格式 `transcriptions/revisions/*.json` 的 `content.convertResult`
- 老格式 `project.json` 的 `convertResult` / `translateResult`（JSON 字符串）
- 更老的 `transcriptions/*.json` 里 `result` 的 VTT 文本

## 2. 音色采集 `memo-tts-voice.py`

**作用**：从某个视频里自动挑最干净的 12 秒，注册成音色。

插件默认 `voice=auto` 时会自动做这件事，所以只有想手动指定音色、或者想听样本时才需要它。

```bash
python3 tools/memo-tts-voice.py <视频文件或项目目录> <音色名> --sample
# --sample 会立刻用这个音色合成一句中英混合样本并播放
```

挑选规则：全片解码成 16 kHz 单声道，按 1 秒滑窗算能量，跳过有静音断档的窗口，取能量高且稳定的 12 秒，响度归一到 -18 LUFS。

## 3. 跑前体检 `memo-tts-check.py`

**作用**：长任务前扫一遍，看有多少段能被槽位助手认出来。

```bash
python3 tools/memo-tts-check.py            # 最近在用的项目
python3 tools/memo-tts-check.py <uuid|目录>
```

输出：

```
项目 c1d2048c  字幕 679 段
精确 679  相似 0  未命中 0
命中率 100.0%
```

低于 100% 会列出前几条未命中的句子，通常是改得太狠、或者翻译换了版本。这些段会退回估算，时长可能不准。

## 4. 一个可选的本地服务：语音线切换

如果你在同一张显卡上还要跑别的模型线（文本大模型、图像/视频），需要一个切换脚本，把当前线停掉再起另一条。示例：

```bash
#!/usr/bin/env bash
# 切到语音线：停文本线，起 TTS
pkill -f "strata" 2>/dev/null
uvicorn --app-dir ~/ai-studio/tts api_server:app --host 127.0.0.1 --port 7861
```

这部分没有放进工具集，因为它和你的机器布局强相关。
