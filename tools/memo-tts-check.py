#!/usr/bin/env python3
"""跑长任务前的体检：逐段问预言机，报告命中率。

用法: memo-tts-check.py [项目目录或 uuid]
"""
import glob, json, os, sys, urllib.parse, urllib.request
from collections import Counter

ORACLE = "http://127.0.0.1:7872"
ROOT = os.path.expanduser("~/Library/Application Support/Memo/temp/memo")


def find_asset(arg: str):
    if not arg:
        cands = [p for p in glob.glob(os.path.join(ROOT, "*", "folders", "*", "*"))
                 if os.path.isdir(os.path.join(p, "tts"))]
        return max(cands, key=os.path.getmtime) if cands else None
    if os.path.isdir(arg):
        return arg
    hits = [p for p in glob.glob(os.path.join(ROOT, "*", "folders", "*", arg)) if os.path.isdir(p)]
    if not hits:
        raise SystemExit(f"找不到项目: {arg}")
    return max(hits, key=os.path.getmtime)


def segments(asset: str):
    for rev in glob.glob(os.path.join(asset, "transcriptions", "revisions", "*.json")):
        d = json.load(open(rev))
        segs = d.get("content", {}).get("convertResult", [])
        if segs:
            return segs
    pj = os.path.join(asset, "project.json")
    if os.path.exists(pj):
        d = json.load(open(pj))
        for key in ("translateResult", "convertResult"):
            v = d.get(key)
            if isinstance(v, str) and v.strip().startswith("["):
                segs = json.loads(v)
                if segs:
                    return segs
    return []


def query(text: str):
    u = ORACLE + "/slot?" + urllib.parse.urlencode({"text": text})
    try:
        with urllib.request.urlopen(u, timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def main() -> int:
    asset = find_asset(sys.argv[1] if len(sys.argv) > 1 else "")
    if not asset:
        raise SystemExit("找不到项目")
    segs = [s for s in segments(asset) if s.get("text", "").strip()]
    print(f"项目 {os.path.basename(asset)}  字幕 {len(segs)} 段")
    stats = Counter()
    misses = []
    for i, s in enumerate(segs):
        hit = query(s["text"].strip())
        if hit and hit.get("slot_ms"):
            stats[hit.get("match", "exact")] += 1
        else:
            stats["miss"] += 1
            if len(misses) < 5:
                misses.append((i, s["text"][:40]))
    total = sum(stats.values()) or 1
    print(f"精确 {stats['exact']}  相似 {stats['fuzzy']}  未命中 {stats['miss']}")
    print(f"命中率 {(total - stats['miss']) / total * 100:.1f}%")
    for i, t in misses:
        print(f"  未命中 #{i}: {t}")
    return 0 if stats["miss"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
