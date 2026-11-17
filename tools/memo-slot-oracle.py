#!/usr/bin/env python3
"""memo-slot-oracle：只读查询 Memo 字幕槽位。

GET /slot?file=<asset uuid>&text=<文本>
    → {"slot_ms":et-st, "range_ms":下一段起点-本段起点, "st_ms", "et_ms",
       "seg_index", "seg_total", "track":"asr|translate", "match":"exact|normalized"}
GET /healthz  GET /stats
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
import difflib
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import base64
import hashlib
import shutil
import subprocess
import tempfile
import urllib.request
import wave
import array
from urllib.parse import urlparse, parse_qs

ROOT = Path(os.environ.get("MEMO_DATA_ROOT", "~/Library/Application Support/Memo/temp/memo")).expanduser()
PORT = int(os.environ.get("ORACLE_PORT", "7872"))
_cache: dict[str, tuple[float, dict]] = {}
# 每次合成的“已占用槽位”记录：同一项目里一段字幕只可能占一个槽位，
# 认领过的槽位不再参与其他文本的匹配，能大幅降低改字幕后的认错率。
CLAIMS: dict[str, dict] = {}
CLAIM_IDLE = 900   # 15 分钟无访问则重置，下一次合成重新开始认领


def norm(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "")
    t = re.sub(r"[\s，。！？、；：,.!?;:'\"()\[\]（）《》…—\-–—]", "", t)
    return t.lower()


def ts_to_ms(value: str) -> int:
    m = re.match(r"(\d+):(\d+):(\d+)[.,](\d+)", value.strip())
    if not m:
        return 0
    h, mi, s, ms = m.groups()
    return int(h) * 3600000 + int(mi) * 60000 + int(s) * 1000 + int(ms.ljust(3, "0")[:3])


def build_asset(asset_dir: Path) -> dict:
    """返回 {track: {normtext: [(st_ms, et_ms, idx, total, range_ms)]}}。"""
    tracks: dict[str, dict] = {}
    rev_dir = asset_dir / "transcriptions" / "revisions"
    revs = sorted(rev_dir.glob("revision-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if revs:
        try:
            content = json.loads(revs[0].read_text(encoding="utf-8")).get("content", {})
            segs = content.get("convertResult") or []
        except Exception:
            segs = []
        if segs:
            tracks["asr"] = index_segments(segs)
    # 译文轨：最新的 translation artifact
    runs = sorted((asset_dir / "transcriptions" / "runs").glob("*/artifact.json"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for art in runs:
        try:
            d = json.loads(art.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("kind") != "translation":
            continue
        segs = (d.get("after") or {}).get("translateResult") or []
        if segs:
            tracks["translate"] = index_segments(segs)
            break
    return tracks


def _as_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip().startswith("["):
        try:
            out = json.loads(value)
            return out if isinstance(out, list) else []
        except Exception:
            return []
    return []


def build_from_project_json(asset_dir: Path, tracks: dict) -> None:
    """老布局：st/et 与文本都在 project.json 的 convertResult / translateResult（JSON 字符串）。"""
    pj = asset_dir / "project.json"
    if not pj.is_file():
        return
    try:
        d = json.loads(pj.read_text(encoding="utf-8"))
    except Exception:
        return
    for key, track in (("translateResult", "translate"), ("convertResult", "asr")):
        segs = _as_list(d.get(key))
        if segs and track not in tracks:
            idx = index_segments(segs)
            if idx:
                tracks[track] = idx


def build_from_legacy_result(asset_dir: Path, tracks: dict) -> None:
    """更老的布局：transcriptions/*.json 里 result 是 "[st --> et] text" 文本。"""
    for f in sorted((asset_dir / "transcriptions").glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        result = d.get("result")
        if not isinstance(result, str) or "-->" not in result:
            continue
        segs = []
        for m in re.finditer(r"\[([\d:.]+)\s*-->\s*([\d:.]+)\]\s*([^\[]*)", result):
            text = m.group(3).strip()
            if text:
                segs.append({"st": m.group(1), "et": m.group(2), "text": text})
        if segs:
            idx = index_segments(segs)
            if idx and "asr" not in tracks:
                tracks["asr"] = idx
            return


def index_segments(segs: list[dict]) -> dict:
    out: dict[str, list] = {}
    total = len(segs)
    starts = [ts_to_ms(s.get("st", "")) for s in segs]
    for i, seg in enumerate(segs):
        st = starts[i]
        et = ts_to_ms(seg.get("et", ""))
        nxt = starts[i + 1] if i + 1 < total else et
        range_ms = max(0, nxt - st)
        key = norm(seg.get("text", ""))
        if not key:
            continue
        out.setdefault(key, []).append((st, et, i, total, range_ms))
    return out


FFMPEG = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
TTS = os.environ.get("TTS_BASE", "http://127.0.0.1:7861")
VOICE_CACHE = Path(os.environ.get("VOICE_CACHE_DIR", "~/Library/Caches/memo-tts")).expanduser()
VOICE_LOCK: dict[str, float] = {}


def media_of(asset: Path) -> Path | None:
    for pat in ("external/*.webm", "external/*.mp4", "external/*.m4a", "external/*.wav"):
        hits = sorted(asset.glob(pat))
        if hits:
            return hits[0]
    pj = asset / "project.json"
    if pj.is_file():
        try:
            d = json.loads(pj.read_text(encoding="utf-8"))
        except Exception:
            return None
        for key in ("audioPath", "videoPath", "filePath"):
            v = d.get(key)
            if v:
                f = Path(os.path.expanduser(v))
                if f.is_file():
                    return f
    return None


def server_voices() -> list[str]:
    try:
        with urllib.request.urlopen(f"{TTS}/voices", timeout=5) as r:
            return json.loads(r.read().decode()).get("voices", [])
    except Exception:
        return []


def best_window(wav_path: Path, seconds: int) -> float:
    with wave.open(str(wav_path)) as w:
        sr = w.getframerate()
        raw = array.array("h")
        raw.frombytes(w.readframes(w.getnframes()))
    step = sr
    env = []
    for i in range(0, len(raw) - step + 1, step):
        seg = raw[i:i + step]
        env.append((sum(x * x for x in seg) / len(seg)) ** 0.5 / 32768)
    best, best_score = 0, -1.0
    for i in range(max(0, len(env) - seconds + 1)):
        win = env[i:i + seconds]
        mean = sum(win) / len(win)
        if min(win) < mean * 0.25:
            continue
        var = sum((v - mean) ** 2 for v in win) / len(win)
        score = mean - 3 * var ** 0.5
        if score > best_score:
            best, best_score = i, score
    return float(best)


def capture_voice(asset: Path, name: str) -> dict:
    media = media_of(asset)
    if media is None:
        return {"ok": False, "reason": "media_not_found"}
    if name in server_voices():
        return {"ok": True, "voice": name, "cached": True}
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        src = tmp / "src.wav"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(media), "-ar", "16000", "-ac", "1", str(src)],
                       check=True, timeout=900)
        start = best_window(src, 12)
        clip = tmp / "clip.wav"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{start:.1f}", "-t", "12", "-i", str(src),
                        "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-ar", "16000", "-ac", "1", str(clip)],
                       check=True, timeout=180)
        payload = json.dumps({"name": name,
                              "audio_b64": base64.b64encode(clip.read_bytes()).decode()}).encode()
    req = urllib.request.Request(f"{TTS}/voices", data=payload, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=120).read()
    VOICE_CACHE.mkdir(parents=True, exist_ok=True)
    (VOICE_CACHE / f"{name}.json").write_text(json.dumps(
        {"asset": asset.name, "media": str(media), "start_s": start}), encoding="utf-8")
    return {"ok": True, "voice": name, "cached": False, "start_s": start}


def asset_for_text(text: str) -> Path | None:
    key = norm(text)
    if not key:
        return None
    for asset in all_assets():
        tracks = load_asset(asset.name)
        for track in ("translate", "asr"):
            if key in tracks.get(track, {}):
                return asset
    return None


def auto_voice_for(text: str) -> dict:
    asset = asset_for_text(text)
    if asset is None:
        return {"ok": False, "reason": "asset_not_found"}
    name = "auto_" + asset.name[:8]
    if VOICE_LOCK.get(name, 0) > time.time() - 30:
        pass
    VOICE_LOCK[name] = time.time()
    try:
        return capture_voice(asset, name)
    except subprocess.CalledProcessError as exc:
        return {"ok": False, "reason": f"ffmpeg_failed:{exc.returncode}"}
    except Exception as exc:
        return {"ok": False, "reason": type(exc).__name__}


def all_assets() -> list[Path]:
    return sorted(ROOT.glob("*/folders/*/*"),
                  key=lambda p: (p / "transcriptions").stat().st_mtime if (p / "transcriptions").exists() else 0,
                  reverse=True)


def claims_for(asset_name: str, stamp: float) -> dict:
    rec = CLAIMS.get(asset_name)
    if not rec or rec["stamp"] != stamp or time.time() - rec["touch"] > CLAIM_IDLE:
        rec = {"stamp": stamp, "touch": time.time(), "map": {}, "used": set()}
        CLAIMS[asset_name] = rec
    rec["touch"] = time.time()
    return rec


def est_ms(text: str) -> float:
    """按语言粗估这句自然说话需要多久，用于位置守恒的兜底。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]+", text))
    if cjk >= latin:
        return cjk / 3.79 * 1000
    return latin / 2.13 * 1000


def positional_find(key: str, tracks: dict, used: set) -> dict | None:
    """改得很狠时：用“相似度 + 预期时长 + 段序”给未占用槽位打分。

    段序先验来自 Memo 基本按顺序合成（并发 5，抖动有限），因此靠前的未占用段
    优先；相似度低于 0.55 且没有序先验优势时宁可不认，避免把时长对调。
    """
    want = est_ms(key)
    pool = []
    for track in ("translate", "asr"):
        for cand, entries in tracks.get(track, {}).items():
            if not cand:
                continue
            st, et, idx, total, rng = min(entries, key=lambda e: (e[0], e[4]))
            if (track, idx) in used:
                continue
            pool.append((track, idx, cand, st, et, rng, total))
    if not pool:
        return None
    pool.sort(key=lambda x: x[2] and x[1])
    order = {}
    for rank, item in enumerate(pool):
        order[item[1]] = rank
    scored = []
    for rank, (track, idx, cand, st, et, rng, total) in enumerate(pool):
        slot = max(1, et - st)
        dur_fit = 1.0 - min(1.0, abs(math.log((want + 1) / (slot + 1))) / 1.2)
        sim = difflib.SequenceMatcher(None, key, cand).ratio()
        order_fit = 1.0 if rank < 6 else max(0.0, 1.0 - (rank - 6) / 40.0)
        score = 0.45 * sim + 0.30 * dur_fit + 0.25 * order_fit
        scored.append((score, sim, rank, {"slot_ms": et - st, "range_ms": rng, "st_ms": st,
                                          "et_ms": et, "seg_index": idx, "seg_total": total,
                                          "track": track, "match": "positional",
                                          "ambiguous": len(entries)}))
    scored.sort(key=lambda x: x[0], reverse=True)
    best = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    # 证据不足就不认：相似度太低且序先验也不强时，交给估算更安全
    if best[1] < 0.35 and best[2] > 6:
        return None
    if best[0] - second < 0.06 and best[1] < 0.55:
        return None
    return best[3]


def fuzzy_find(key: str, tracks: dict, used: set | None = None) -> tuple[dict | None, float]:
    """文本被改动（换术语、删词）时按相似度兜底。

    取相似度最高的两段比较：最高 >= 0.78 且比第二名高 0.04 才算认准；
    否则宁可返回未命中，交给估算，避免把相邻的相似句认错。
    """
    scored: list[tuple[float, dict]] = []
    for track in ("translate", "asr"):
        for cand, entries in tracks.get(track, {}).items():
            if not key or not cand:
                continue
            if not (0.55 <= len(key) / len(cand) <= 1.8):
                continue
            ratio = difflib.SequenceMatcher(None, key, cand).ratio()
            if ratio < 0.70:
                continue
            st, et, idx, total, rng = min(entries, key=lambda e: (e[0], e[4]))
            if used and (track, idx) in used:
                continue
            scored.append((ratio, {"slot_ms": et - st, "range_ms": rng, "st_ms": st, "et_ms": et,
                                   "seg_index": idx, "seg_total": total, "track": track,
                                   "match": "fuzzy", "ambiguous": len(entries)}))
    if not scored:
        return None, 0.0
    scored.sort(key=lambda x: x[0], reverse=True)
    top_ratio, top_hit = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if top_ratio >= 0.78 and (top_ratio - second >= 0.04 or top_ratio >= 0.95):
        return top_hit, top_ratio
    return None, top_ratio


def query_text(text: str, uuid: str = "") -> dict | None:
    key = norm(text)
    if not key:
        return None
    targets = [p for p in all_assets() if not uuid or p.name == uuid]
    for asset in targets:
        tracks = load_asset(asset.name)
        for track in ("translate", "asr"):
            entries = tracks.get(track, {}).get(key)
            if entries:
                st, et, idx, total, rng = min(entries, key=lambda e: (e[0], e[4]))
                hit = {"slot_ms": et - st, "range_ms": rng, "st_ms": st, "et_ms": et,
                       "seg_index": idx, "seg_total": total, "track": track,
                       "match": "exact", "ambiguous": len(entries), "asset": asset.name}
                rec = claims_for(asset.name, _cache.get(asset.name, (0, {}))[0])
                rec["used"].add((track, idx))
                rec["map"][key] = hit
                return hit
    # 精确匹配失败：同一项目内按相似度兜底（应对改过术语的字幕）
    for asset in targets:
        tracks = load_asset(asset.name)
        rec = claims_for(asset.name, _cache.get(asset.name, (0, {}))[0])
        used = rec["used"]
        hit, ratio = fuzzy_find(key, tracks, used)
        if hit:
            hit["asset"] = asset.name
            hit["similarity"] = round(ratio, 3)
            used.add((hit["track"], hit["seg_index"]))
            rec["map"][key] = hit
            return hit
        hit = positional_find(key, tracks, used)
        if hit:
            hit["asset"] = asset.name
            used.add((hit["track"], hit["seg_index"]))
            rec["map"][key] = hit
            return hit
    return None


def load_asset(uuid: str) -> dict:
    if not uuid:
        return {}
    hit = _cache.get(uuid)
    if hit and hit[0] >= (ROOT.stat().st_mtime if ROOT.exists() else 0):
        pass
    candidates = [c for c in ROOT.glob(f"*/folders/*/{uuid}") if (c / "transcriptions").is_dir()]
    if not candidates:
        return {}
    # 同名 uuid 可能出现在多个工作区：取项目/转录最新的那个
    asset_dir = max(candidates, key=lambda c: max(
        [ (c / "project.json").stat().st_mtime if (c / "project.json").exists() else 0,
          (c / "transcriptions").stat().st_mtime ], default=0))
    stamp = max((p.stat().st_mtime for p in asset_dir.rglob("*.json")), default=0)
    if uuid in _cache and _cache[uuid][0] == stamp:
        return _cache[uuid][1]
    tracks = build_asset(asset_dir)
    build_from_project_json(asset_dir, tracks)
    build_from_legacy_result(asset_dir, tracks)
    _cache[uuid] = (stamp, tracks)
    return tracks


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默
        pass

    def _access(self, text: str, hit: dict | None):
        try:
            line = json.dumps({"t": time.strftime("%H:%M:%S"),
                               "hit": bool(hit),
                               "slot_ms": (hit or {}).get("slot_ms"),
                               "text": (text or "")[:40]}, ensure_ascii=False)
            with open("/tmp/oracle-access.log", "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if u.path != "/voice/ensure":
            return self._json(404, {"reason": "not_found"})
        try:
            payload = json.loads(raw.decode() or "{}")
        except Exception:
            return self._json(400, {"reason": "bad_json"})
        res = auto_voice_for(payload.get("text", ""))
        return self._json(200 if res.get("ok") else 404, res)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/healthz":
            return self._json(200, {"ok": True, "root": str(ROOT), "assets": len(_cache)})
        if u.path == "/stats":
            return self._json(200, {"assets": sorted(_cache), "port": PORT})
        if u.path != "/slot":
            return self._json(404, {"reason": "not_found"})
        uuid = (q.get("file") or [""])[0]
        text = (q.get("text") or [""])[0]
        hit = query_text(text, uuid)
        self._access(text, hit)
        if hit is None:
            try:
                with open("/tmp/oracle-miss.log", "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"t": time.strftime("%H:%M:%S"), "text": (text or "")[:80]},
                                        ensure_ascii=False) + "\n")
            except Exception:
                pass
        if hit is None:
            return self._json(404, {"reason": "text_not_matched"})
        return self._json(200, hit)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"memo-slot-oracle on 127.0.0.1:{PORT} root={ROOT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
