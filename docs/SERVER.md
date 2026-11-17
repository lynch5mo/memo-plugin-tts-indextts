# 服务端部署

整条链路只有一个服务：IndexTTS 2.5 加一层 HTTP 封装。下面按三种机器形态给步骤。

## 一、通用准备：装 IndexTTS 2.5

```bash
git clone https://github.com/index-tts/index-tts.git
cd index-tts
uv venv && source .venv/bin/activate      # 或者 python -m venv .venv
uv pip install -r requirements.txt
# 下载模型权重（约 5.2 GB）到 checkpoints/
```

权重与依赖以 IndexTTS 官方仓库为准。装好后的目录结构大致是：

```
index-tts/
  checkpoints/
    config.yaml
    gpt.pth
    s2mel.pth
    hf_cache/
  indextts/
  .venv/
```

## 二、放 API 封装

把本仓库 `server/api_server.py` 放到 `index-tts` 的同级目录，例如：

```
~/ai-studio/tts/
  api_server.py
  voices/            # 参考音，首次运行自动创建
  index-tts/         # 上面那个仓库
```

安装依赖：

```bash
uv pip install fastapi "uvicorn[standard]" pydantic imageio-ffmpeg
```

启动：

```bash
cd ~/ai-studio/tts/index-tts
.venv/bin/uvicorn --app-dir ~/ai-studio/tts api_server:app --host 127.0.0.1 --port 7861
```

启动后第一次请求会加载模型，约 25–35 秒。健康检查：

```bash
curl -s http://127.0.0.1:7861/health
# {"status":"ok","model":"IndexTTS-2.5","voices":["default"]}
```

### 关于 voice 目录

服务启动时如果 `voices/` 为空，会自动生成一个 `default.wav`（用合成音，仅用于让服务能起来）。真正好用的参考音请自己放：

```bash
cp 你的样本.wav ~/ai-studio/tts/voices/speaker.wav
```

要求：10–15 秒、干净人声、单声道、16 kHz 以上、没有背景音乐。16 kHz 也能用，但音色上限就到这了。

## 三、三种机器形态

### 形态 A：独立 GPU 主机 + Memo 在另一台 Mac（推荐）

服务只绑 `127.0.0.1`，Mac 侧用 SSH 隧道过来：

```bash
ssh -f -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:7861:127.0.0.1:7861 你的主机别名
curl -s http://127.0.0.1:7861/health
```

插件里 API 地址保持 `http://127.0.0.1:7861`。

想让隧道断线自动恢复，用 launchd（macOS）：

```xml
<!-- ~/Library/LaunchAgents/com.example.indextts-tunnel.plist -->
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/ssh</string>
  <string>-N</string>
  <string>-o</string><string>ServerAliveInterval=15</string>
  <string>-L</string><string>127.0.0.1:7861:127.0.0.1:7861</string>
  <string>你的主机别名</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

### 形态 B：单机（GPU 和 Memo 同一台机器）

不需要隧道，插件里 API 地址填 `http://127.0.0.1:7861` 即可。适合 Linux 桌面或带独显的 Windows（Windows 下用 Ubuntu 子系统或者原生 venv 均可，只要 IndexTTS 能跑起来）。

### 形态 C：Apple Silicon Mac

能跑，但要注意：

- IndexTTS 官方主要面向 CUDA；MPS 后端支持不完整，部分算子会退回 CPU，速度可能慢十倍以上
- 8 GB 统一内存的机器基本跑不动 2.5 的权重
- 建议只用于试听几十秒的样本，长视频还是用 NVIDIA 机器

如果坚持本机跑，把启动命令的 `--host 127.0.0.1` 保持不变，其余照形态 B。

## 四、常驻与守护

最省事的方式是 systemd（Linux）或 launchd（macOS）托管，崩溃自动重启。要点：

```ini
# /etc/systemd/system/indextts.service（示意）
[Service]
WorkingDirectory=/home/you/ai-studio/tts/index-tts
ExecStart=/home/you/ai-studio/tts/index-tts/.venv/bin/uvicorn \
  --app-dir /home/you/ai-studio/tts api_server:app --host 127.0.0.1 --port 7861
Restart=on-failure
RestartSec=5
```

注意两件事：

- **不要**绑 `0.0.0.0`。服务没有鉴权，暴露到局域网就等于对外开放。
- 显存是独占资源。和其他模型（文本大模型、图像/视频模型）同时跑会 OOM，建议按需启停。

## 五、开机自启与按需启停的取舍

IndexTTS 常驻占 6.5–8.2 GB 显存。如果这台机器还要跑别的模型，建议不要开机自启，用的时候再起：

```bash
# 起
uvicorn --app-dir ~/ai-studio/tts api_server:app --host 127.0.0.1 --port 7861
# 停
pkill -f "uvicorn.*api_server"
```

如果只跑配音，开机自启更省心。

## 六、验证清单

部署完成后按顺序验：

```bash
B=http://127.0.0.1:7861

# 1 健康
curl -s $B/health

# 2 音色列表
curl -s $B/voices

# 3 真合成一句（5–10 秒）
curl -s -X POST $B/tts -H 'Content-Type: application/json' \
  -d '{"text":"这是部署验证。","lang":"ZH","voice":"default"}' -o /tmp/probe.wav
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/probe.wav

# 4 时长对齐
curl -s -X POST $B/tts -H 'Content-Type: application/json' \
  -d '{"text":"这是部署验证。","lang":"ZH","voice":"default","target_duration_ms":3000}' -o /tmp/probe2.wav
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/probe2.wav
# 应输出 3.000 附近
```

四条都通过，再去 Memo 里配插件。

## 七、显存与性能参考

| 项 | 数值（RTX 4080 SUPER 16 GB） |
|---|---|
| 常驻显存 | 6.5–6.9 GB |
| 峰值显存 | 8.2 GB（长句） |
| 模型加载 | 25–35 秒 |
| 每段合成 | 4–8 秒（3–8 秒的句子） |
| RTF | 1.1–1.3 |
| 20 分钟视频（约 240 段） | 约 11–15 分钟 |
