#!/usr/bin/env python3
"""从一段视频/音频里自动挑最干净的 12 秒，注册成 IndexTTS 音色。

用法: memo-tts-voice.py <媒体文件或 Memo 项目目录> [音色名] [--seconds 12]
不带音色名时用 文件名+时间戳。
"""
from __future__ import annotations
import array, base64, json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

SS = "http://127.0.0.1:7861"


def find_media(target: str) -> Path:
    p = Path(target).expanduser()
    if p.is_file():
        return p
    if p.is_dir():
        for pat in ("external/*.webm", "external/*.mp4", "external/*.m4a", "external/*.wav", "*.webm", "*.mp4"):
            hits = sorted(p.glob(pat))
            if hits:
                return hits[0]
    raise SystemExit(f"找不到媒体文件：{target}")


def decode(media: Path, tmpdir: Path) -> tuple[Path, int, int]:
    wav = tmpdir / "src16k.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(media), "-ar", "16000", "-ac", "1", str(wav)],
                   check=True, timeout=600)
    import wave
    with wave.open(str(wav)) as w:
        return wav, w.getframerate(), w.getnframes()


def best_window(wav: Path, sr: int, seconds: int) -> tuple[float, float]:
    """按 1 秒 RMS 滑窗，找能量高且稳定的区间。返回 (起点秒, 平均RMS)。"""
    import wave
    with wave.open(str(wav)) as w:
        raw = array.array("h")
        raw.frombytes(w.readframes(w.getnframes()))
    step = sr
    env = []
    for i in range(0, len(raw) - step + 1, step):
        seg = raw[i:i + step]
        env.append((sum(x * x for x in seg) / len(seg)) ** 0.5 / 32768)
    best, best_score = 0, -1
    n = seconds
    for i in range(len(env) - n + 1):
        win = env[i:i + n]
        mean = sum(win) / n
        var = sum((v - mean) ** 2 for v in win) / n
        if min(win) < mean * 0.25:      # 有明显静音段的窗口跳过
            continue
        score = mean - 3 * var ** 0.5
        if score > best_score:
            best, best_score = i, score
    return float(best), env[best:best + n] and sum(env[best:best + n]) / n


def register(name: str, wav_bytes: bytes) -> None:
    body = json.dumps({"name": name, "audio_b64": base64.b64encode(wav_bytes).decode()}).encode()
    req = urllib.request.Request(f"{SS}/voices", data=body, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=120).read()


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seconds = 12
    for a in sys.argv[1:]:
        if a.startswith("--seconds"):
            seconds = int(a.split("=", 1)[1])
    if not args:
        print(__doc__)
        return 2
    media = find_media(args[0])
    name = args[1] if len(args) > 1 else f"{media.stem[:12].replace(' ', '_')}_{int(time.time()) % 10000}"
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        wav, sr, nframes = decode(media, tmp)
        start, level = best_window(wav, sr, seconds)
        clip = tmp / "clip.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.1f}", "-t", str(seconds), "-i", str(wav),
                        "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-ar", "16000", "-ac", "1", str(clip)],
                       check=True, timeout=120)
        register(name, clip.read_bytes())
    dur = nframes / sr
    print(f"媒体 {media.name}（{dur:.1f}s）")
    print(f"选中区间 {start:.1f}s 起 {seconds}s，平均电平 {20 * __import__('math').log10(max(level, 1e-9)):+.1f} dBFS")
    print(f"已注册音色：{name}")
    print(f"在 Memo 插件设置里把「音色」填成 {name} 即可")
    if "--sample" in sys.argv:
        sample = tmp_sample(name)
        print(f"试听样本：{sample}")
        subprocess.run(["afplay", sample], check=False)
    return 0


def tmp_sample(name: str) -> str:
    """用该音色合成一句中英混合样本，返回文件路径。"""
    text = "指标只是个工具，真正重要的是你如何使用 ETF 和 price action。"
    body = json.dumps({"text": text, "lang": "ZH", "voice": name,
                       "target_duration_ms": 6000, "temperature": 0.7}).encode()
    req = urllib.request.Request(f"{SS}/tts", data=body, headers={"Content-Type": "application/json"})
    data = urllib.request.urlopen(req, timeout=300).read()
    out = Path.home() / "memo-voice-test3" / f"sample_{name}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return str(out)


if __name__ == "__main__":
    raise SystemExit(main())
