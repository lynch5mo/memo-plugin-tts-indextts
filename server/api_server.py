"""IndexTTS 2.5 HTTP API：给 Memo 插件等客户端用。

POST /tts  {"text": "...", "lang": "ZH", "voice": "default", "speed": 1.0}
  -> audio/wav 字节流
GET  /health -> {"status","model","voices"}
GET  /voices -> 可用音色列表
"""
import io
import os
import tempfile
import threading
from pathlib import Path

import base64
import re
import wave
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

ROOT = Path("/home/lynch5mo/ai-studio/tts/index-tts")
VOICES = Path("/home/lynch5mo/ai-studio/tts/voices")
VOICES.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="IndexTTS API")
# 只绑定 127.0.0.1，允许任意来源便于 Memo 插件页面调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
_lock = threading.Lock()
_req_count = 0
from concurrent.futures import ThreadPoolExecutor
# 所有推理固定跑在同一个线程上：FastAPI 的同步端点走线程池，线程漂移会导致 CUDA 断言
INFER_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-infer")
REPETITION_PENALTY = float(os.environ.get("TTS_REP_PENALTY", "3.0") or 3.0)
TOP_P = float(os.environ.get("TTS_TOP_P", "0.8") or 0.8)
TOP_K = int(os.environ.get("TTS_TOP_K", "30") or 30)
RECYCLE_EVERY = int(os.environ.get("TTS_RECYCLE", "0") or 0)
_tts = None


MAX_TEXT_CHARS = 20000
MAX_REF_B64 = 28 * 1024 * 1024      # 约 20 MB 原始音频
ALLOWED_LANGS = {"ZH", "EN", "JA"}


class TTSRequest(BaseModel):
    text: str
    lang: str = "ZH"
    voice: str = "default"
    speed: float = 1.0
    temperature: float = 0.7  # 低于 0.4 会让 logits 溢出成 inf/nan，导致 CUDA 断言
    target_duration_ms: Optional[int] = None
    max_duration_ms: Optional[int] = None   # 硬上限：输出绝不超过它（Memo 的 range）
    ref_audio_b64: Optional[str] = None   # 直接上传参考音（base64 wav），优先于 voice


def load_model():
    global _tts
    if _tts is None:
        os.chdir(ROOT)
        import sys
        sys.path.insert(0, str(ROOT))
        from indextts.infer_v2_5 import IndexTTS2
        _tts = IndexTTS2(
            cfg_path=str(ROOT / "checkpoints/config.yaml"),
            model_dir=str(ROOT / "checkpoints"),
            use_bf16=(os.environ.get("TTS_BF16", "1") != "0"),
            use_cuda_kernel=False,
            use_torch_compile=False,
            use_qwen_emo=False,
        )
    return _tts


def reset_model():
    """丢弃当前模型实例并释放显存，供下一次 load_model() 重建。"""
    global _tts
    _tts = None
    try:
        import gc
        import torch
        gc.collect()
        torch.cuda.empty_cache()
    except Exception:
        pass


# 实测自然语速（speaker 音色）：用于按目标时长反推 duration_factor
NAT_WPS_EN = float(os.environ.get("TTS_NAT_WPS_EN", "2.13") or 2.13)   # 词/秒
NAT_CPS_ZH = float(os.environ.get("TTS_NAT_CPS_ZH", "3.79") or 3.79)   # 字/秒


def count_units(text: str, lang: str) -> int:
    clean = " ".join(text.split())
    if lang == "EN":
        return len([w for w in clean.split(" ") if w])
    import re as _re
    return len(_re.sub(r"[\s，。！？、；：,.!?;:'\"()\[\]（）《》…—]", "", clean))


def voice_path(name: str) -> Path:
    files = sorted(VOICES.glob("*.wav"))
    if not files:
        raise HTTPException(status_code=503, detail="没有可用音色")
    if name in ("", "default"):
        return files[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
        raise HTTPException(status_code=400, detail="音色名只允许字母、数字、下划线和短横线")
    p = VOICES / f"{name}.wav"
    if not p.is_file() or VOICES not in p.resolve().parents:
        raise HTTPException(status_code=404, detail="音色不存在")
    return p


def _wav_duration(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getnframes() / float(w.getframerate())


LOUDNORM_TARGET = os.environ.get("TTS_LOUDNORM", "I=-16:TP=-1.5:LRA=11")


def finalize_audio(data: bytes, target_ms: int | None) -> bytes:
    """统一响度并对齐时长：loudnorm → atempo → 精确裁剪/补静音到目标。

    模型原始输出峰值约 -15 dBFS、RMS 约 -34 dBFS，偏轻 12–18 dB；
    这里按 EBU R128（默认 -16 LUFS）拉齐，再保证时长误差在 ±10 ms 内。
    """
    import subprocess
    import tempfile
    from pathlib import Path
    import imageio_ffmpeg

    src_dur = _wav_duration(data)
    filters = []
    if LOUDNORM_TARGET:
        filters.append(f"loudnorm={LOUDNORM_TARGET}")

    if target_ms:
        target_s = max(0.2, target_ms / 1000.0)
        tempo = src_dur / target_s
        tempo = min(1.90, max(0.65, tempo))
        filters.append("atempo=%.4f" % tempo)
        # atempo 之后仍可能有几毫秒误差，用 apad+atrim 精确对齐
        filters.append(f"apad=whole_dur={target_s:.3f}")
        filters.append(f"atrim=0:{target_s:.3f}")

    if not filters:
        return data

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fi:
        fi.write(data)
        src = Path(fi.name)
    dst = src.with_name(src.stem + "-final.wav")
    try:
        subprocess.run([exe, "-v", "error", "-y", "-i", str(src),
                        "-filter:a", ",".join(filters), "-ar", "22050", "-ac", "1", str(dst)],
                       check=True, timeout=180)
        return dst.read_bytes()
    finally:
        src.unlink(missing_ok=True)
        dst.unlink(missing_ok=True)


def stretch_to_target(data, target_ms):
    """用 ffmpeg atempo 把音频拉伸/压缩到目标时长，保持音高不变。"""
    import subprocess
    import tempfile
    from pathlib import Path
    import imageio_ffmpeg

    src_dur = _wav_duration(data)
    target_s = max(0.2, target_ms / 1000.0)
    tempo = src_dur / target_s
    if tempo <= 0:
        return data
    # 只在 ±30% 内做轻微对齐；超出说明目标时长不合理，宁可原音返回，避免拉伸失真
    # 超出合理区间时按边界尽力压缩/放慢，而不是原样返回（原来直接放弃会导致音频大幅超时）
    if tempo > 1.90:
        tempo = 1.90
    elif tempo < 0.65:
        tempo = 0.65
    chain = []
    t = tempo
    while t > 2.0:
        chain.append("atempo=2.0"); t /= 2.0
    while t < 0.5:
        chain.append("atempo=0.5"); t /= 0.5
    chain.append("atempo=%.4f" % t)

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fi:
        fi.write(data); src = Path(fi.name)
    dst = src.with_name(src.stem + "-fit.wav")
    try:
        subprocess.run([exe, "-v", "error", "-y", "-i", str(src), "-filter:a", ",".join(chain), str(dst)],
                       check=True, timeout=120)
        return dst.read_bytes()
    finally:
        src.unlink(missing_ok=True)
        dst.unlink(missing_ok=True)


class VoiceRequest(BaseModel):
    name: str
    audio_b64: str


@app.post("/voices")
def create_voice(req: VoiceRequest):
    """注册音色：上传 wav（base64），保存为 voices/<name>.wav。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", req.name or ""):
        raise HTTPException(status_code=400, detail="音色名只允许字母、数字、下划线和短横线")
    if req.name == "default":
        raise HTTPException(status_code=400, detail="default 为保留名")
    if len(req.audio_b64) > MAX_REF_B64:
        raise HTTPException(status_code=413, detail="音频过大")
    try:
        raw = base64.b64decode(req.audio_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="audio_b64 不是合法 base64")
    if len(raw) < 8000:
        raise HTTPException(status_code=400, detail="音频太短，至少 1 秒")
    if not raw.startswith(b"RIFF"):
        raise HTTPException(status_code=400, detail="只接受 WAV 格式")
    dst = VOICES / f"{req.name}.wav"
    dst.write_bytes(raw)
    return {"name": req.name, "bytes": len(raw)}


@app.delete("/voices/{name}")
def delete_voice(name: str):
    if name == "default":
        raise HTTPException(status_code=400, detail="default 不可删除")
    p = voice_path(name)
    p.unlink(missing_ok=True)
    return {"deleted": name}


ENROLL_HTML = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>IndexTTS 音色采集</title>
<style>
body{font:14px -apple-system,"PingFang SC",sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:18px}button{padding:8px 14px;margin:6px 6px 6px 0;border-radius:6px;border:1px solid #ccc;background:#f7f7f7;cursor:pointer}
button.rec{background:#ffe8e8;border-color:#e88}button:disabled{opacity:.5;cursor:default}
input{padding:8px;border:1px solid #ccc;border-radius:6px;width:220px}
#log{white-space:pre-wrap;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:10px;margin-top:14px;min-height:60px}
</style></head><body>
<h1>IndexTTS 音色采集</h1>
<p>录 5 秒或 10 秒干净的人声（不要有音乐和杂音），上传后即可在 Memo 插件里用这个名字作为音色。</p>
<div>
  <input id="name" placeholder="音色名，如 zhangsan">
  <button id="rec5">录 5 秒</button>
  <button id="rec10">录 10 秒</button>
  <button id="stop" disabled>停止</button>
</div>
<div id="log"></div>
<script>
let mediaRecorder=null, chunks=[], timer=null;
const log=m=>{document.getElementById("log").textContent+=m+"\n"};
document.getElementById("stop").onclick=()=>{ if(mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop(); };
async function record(sec){
  const name=document.getElementById("name").value.trim();
  if(!name){alert("先填音色名");return}
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(name)){alert("音色名只能字母数字下划线短横线");return}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const ctx=new AudioContext(), src=ctx.createMediaStreamSource(stream), dest=ctx.createMediaStreamDestination();
    src.connect(dest);
    mediaRecorder=new MediaRecorder(dest.stream,{mimeType:"audio/webm;codecs=opus"});
    chunks=[];
    mediaRecorder.ondataavailable=e=>chunks.push(e.data);
    mediaRecorder.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop()); ctx.close();
      clearTimeout(timer);
      document.getElementById("stop").disabled=true;
      const blob=new Blob(chunks,{type:"audio/webm"});
      log(`录完，${(blob.size/1024).toFixed(0)} KB，正在转 WAV 并上传…`);
      const buf=await blob.arrayBuffer();
      const dctx=new AudioContext();
      const audio=await dctx.decodeAudioData(buf);
      const wav=encodeWav(audio);
      dctx.close();
      const b64=arrayBufferToBase64(wav);
      const r=await fetch("/voices",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name:name,audio_b64:b64})});
      const t=await r.text();
      log(r.status===200?`✅ 已保存音色 ${name}，在 Memo 插件里填这个名字即可`:`❌ 失败 ${r.status} ${t}`);
    };
    mediaRecorder.start();
    log(`开始录音，${sec} 秒…`);
    document.getElementById("stop").disabled=false;
    timer=setTimeout(()=>{ if(mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop(); }, sec*1000);
  }catch(e){ log("❌ 无法录音："+e.message); }
}
function encodeWav(audio){
  const ch=1, sr=audio.sampleRate, data=audio.getChannelData(0);
  const buf=new ArrayBuffer(44+data.length*2), dv=new DataView(buf);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};
  w(0,"RIFF"); dv.setUint32(4,36+data.length*2,true); w(8,"WAVE"); w(12,"fmt ");
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,ch,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*ch*2,true); dv.setUint16(32,ch*2,true);
  dv.setUint16(34,16,true); w(36,"data"); dv.setUint32(40,data.length*2,true);
  let o=44; for(let i=0;i<data.length;i++){ const s=Math.max(-1,Math.min(1,data[i])); dv.setInt16(o,s<0?s*0x8000:s*0x7FFF,true); o+=2; }
  return buf;
}
function arrayBufferToBase64(buf){ let bin=""; const bytes=new Uint8Array(buf); const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk){ bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk)); }
  return btoa(bin); }
document.getElementById("rec5").onclick=()=>record(5);
document.getElementById("rec10").onclick=()=>record(10);
</script></body></html>"""


@app.get("/enroll")
def enroll_page():
    from fastapi.responses import HTMLResponse
    return HTMLResponse(ENROLL_HTML)


@app.on_event("startup")
def _startup():
    # 预热放在推理线程上，保证加载与推理同线程
    INFER_EXECUTOR.submit(load_model).result()


@app.get("/health")
def health():
    return {"status": "ok" if _tts is not None else "loading",
            "model": "IndexTTS-2.5",
            "voices": [p.stem for p in sorted(VOICES.glob("*.wav"))]}


@app.get("/voices")
def voices():
    return {"voices": [p.stem for p in sorted(VOICES.glob("*.wav"))]}


@app.post("/tts")
def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(req.text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail=f"text 超过 {MAX_TEXT_CHARS} 字符上限")
    if req.lang not in ALLOWED_LANGS:
        raise HTTPException(status_code=400, detail="lang 只支持 ZH / EN / JA")
    if req.ref_audio_b64 and len(req.ref_audio_b64) > MAX_REF_B64:
        raise HTTPException(status_code=413, detail="参考音频过大")
    tmp_ref = None
    if req.ref_audio_b64:
        try:
            raw = base64.b64decode(req.ref_audio_b64, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="ref_audio_b64 不是合法 base64")
        if len(raw) < 1000:
            raise HTTPException(status_code=400, detail="参考音频太短")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(raw)
            tmp_ref = Path(f.name)
        ref = tmp_ref
    else:
        ref = voice_path(req.voice)
    # 模型首次加载也放到推理线程上，避免“主线程加载 + 工作线程推理”的混用
    model = INFER_EXECUTOR.submit(load_model).result()
    if model is None:
        raise HTTPException(status_code=503, detail="模型未就绪")
    with _lock:
        global _req_count
        _req_count += 1
        if RECYCLE_EVERY and _req_count % RECYCLE_EVERY == 0:
            print(f"[recycle] after {_req_count} requests, reloading model", flush=True)
            reset_model()
            model = load_model()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out = tmp.name
        try:
            speed = max(0.5, min(2.0, req.speed))
            duration_factor = 1.0 / speed
            target_ms = None
            if req.target_duration_ms and req.target_duration_ms > 0:
                target_ms = max(200, min(600000, int(req.target_duration_ms)))
            if req.max_duration_ms and req.max_duration_ms > 0:
                cap_ms = max(200, min(600000, int(req.max_duration_ms)))
                if target_ms is None or target_ms > cap_ms:
                    target_ms = cap_ms
            if target_ms:
                # 先让模型自己按目标说话（音质优于事后变速），残差再交给 atempo
                nat_ms = count_units(req.text, req.lang) / (NAT_WPS_EN if req.lang == "EN" else NAT_CPS_ZH) * 1000.0
                duration_factor = max(0.40, min(1.80, float(target_ms) / nat_ms))
            print(f"[req] lang={req.lang} voice={req.voice} chars={len(req.text)} "
                  f"target={target_ms} factor={duration_factor:.2f} temp={req.temperature}", flush=True)
            temperature = max(0.5, min(1.5, req.temperature))  # 下限 0.5：过低温度会触发采样 nan
            INFER_EXECUTOR.submit(
                model.infer,
                spk_audio_prompt=str(ref), text=req.text, output_path=out,
                lang=req.lang, verbose=False, duration_factor=duration_factor,
                temperature=temperature,
                repetition_penalty=REPETITION_PENALTY, top_p=TOP_P, top_k=TOP_K,
            ).result()
            if not Path(out).is_file():
                raise HTTPException(status_code=500, detail="合成未产出音频")
            data = Path(out).read_bytes()
            if len(data) <= 44 or not data.startswith(b"RIFF"):
                raise HTTPException(status_code=500, detail="合成结果不是有效 WAV")
            data = finalize_audio(data, target_ms)
        except HTTPException:
            raise
        except Exception as exc:
            msg = str(exc)
            if "device-side assert" in msg or "CUDA error" in msg:
                # CUDA 上下文已损坏，进程无法继续服务；交给启动脚本的守护循环重建
                import sys
                print("[FATAL] CUDA context corrupted, exiting for restart", flush=True)
                sys.stdout.flush()
                os._exit(3)
            # 采样出现 nan/inf 会把模型状态带坏，重置后重试一次
            first_err = type(exc).__name__
            reset_model()
            try:
                model = load_model()
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp2:
                    out2 = tmp2.name
                try:
                    model.infer(
                        spk_audio_prompt=str(ref), text=req.text, output_path=out2,
                        lang=req.lang, verbose=False, duration_factor=duration_factor,
                        temperature=temperature,
                    )
                    if not Path(out2).is_file() or not Path(out2).read_bytes().startswith(b"RIFF"):
                        raise RuntimeError("retry produced no wav")
                    data = Path(out2).read_bytes()
                    if True:
                        src_d = _wav_duration(data)
                        data = stretch_to_target(data, target_ms)
                        return Response(content=data, media_type="audio/wav",
                                        headers={"X-Src-Dur": f"{src_d:.3f}",
                                                 "X-Target-Ms": str(target_ms),
                                                 "X-Final-Dur": f"{_wav_duration(data):.3f}"})
                    return Response(content=data, media_type="audio/wav")
                finally:
                    Path(out2).unlink(missing_ok=True)
            except Exception as exc2:
                raise HTTPException(status_code=500,
                                    detail=f"合成失败: {first_err} → 重置后仍失败 {type(exc2).__name__}")
        finally:
            Path(out).unlink(missing_ok=True)
            if tmp_ref:
                tmp_ref.unlink(missing_ok=True)
    return Response(content=data, media_type="audio/wav")
