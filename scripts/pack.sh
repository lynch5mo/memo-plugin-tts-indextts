#!/usr/bin/env bash
# 把 plugin/ 打成可双击导入的 .memox（zip，文件在根目录）
set -euo pipefail
cd "$(dirname "$0")/.."
ver=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['version'])")
out="dist/memo-plugin-tts-indextts-${ver}.memox"
mkdir -p dist
rm -f "$out"
( cd plugin && zip -qr "../$out" manifest.json index.js i18n.json icon.svg -x '.DS_Store' )
echo "已生成 $out"
