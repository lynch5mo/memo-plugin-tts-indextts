#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memo-plugin-tts-gptsovits"
PLUGIN_VERSION="1.0.0"
ARTIFACT_NAME="memo-plugin-tts-gptsovits-${PLUGIN_VERSION}.memox"
SIDE_CAR_NAME="${ARTIFACT_NAME}.sha256"
FIXED_MTIME="202601010000"
RUNTIME_FILES=(
  "manifest.json"
  "index.js"
  "lib/audio.js"
  "i18n.json"
  "options.json"
  "icon.svg"
)

usage() {
  echo "Usage: build-memox.sh [--output-dir DIR]" >&2
  echo "  --output-dir DIR  existing safe output directory (defaults to <repo>/dist)" >&2
}

OUT=""
while (($# > 0)); do
  case "$1" in
    --output-dir) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "$OUT" ]]; then
  OUT="$SOURCE_ROOT/dist"
  mkdir -p "$OUT"
fi

for tool in zip unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "build-memox: required tool not found: $tool" >&2
    exit 1
  fi
done

OUT_STATE="$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const out = path.resolve(process.argv[1]);
if (out === path.dirname(out)) {
  process.stdout.write("bad");
  process.exit(0);
}
const lstat = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
let probe = out;
while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
  probe = path.dirname(probe);
}
if (lstat(probe)) {
  process.stdout.write("symlink");
  process.exit(0);
}
if (fs.existsSync(probe) && !fs.statSync(probe).isDirectory()) {
  process.stdout.write("notdir");
  process.exit(0);
}
if (probe !== out) {
  const anchor = fs.realpathSync(probe);
  const rel = path.relative(probe, out);
  let current = anchor;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (lstat(current)) {
      process.stdout.write("symlink");
      process.exit(0);
    }
    if (!fs.existsSync(current)) {
      process.stdout.write("missing");
      process.exit(0);
    }
  }
  process.stdout.write("missing");
  process.exit(0);
}
process.stdout.write(fs.realpathSync(out) === fs.realpathSync(probe) ? "ok" : "symlink");
' "$OUT")"
if [[ "$OUT_STATE" == "symlink" ]]; then
  echo "build-memox: output directory is or contains a symlink: $OUT" >&2
  exit 2
fi
if [[ "$OUT_STATE" == "missing" ]]; then
  echo "build-memox: output directory does not exist: $OUT" >&2
  exit 2
fi
if [[ "$OUT_STATE" == "notdir" ]]; then
  echo "build-memox: output directory is not a directory: $OUT" >&2
  exit 2
fi
if [[ "$OUT_STATE" != "ok" ]]; then
  echo "build-memox: invalid output directory: $OUT" >&2
  exit 2
fi
REAL_OUT="$(cd "$OUT" && pwd -P)"

if [[ ! -f "$SOURCE_ROOT/manifest.json" || ! -f "$SOURCE_ROOT/index.js" || ! -f "$SOURCE_ROOT/lib/audio.js" ]]; then
  echo "build-memox: source root is incomplete: $SOURCE_ROOT" >&2
  exit 1
fi

MANIFEST_PLUGIN_ID="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.pluginId))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_VERSION="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.version))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_IMPORT_TYPE="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.importType))' "$SOURCE_ROOT/manifest.json")"
if [[ "$MANIFEST_PLUGIN_ID" != "$PLUGIN_ID" ]]; then
  echo "build-memox: manifest pluginId mismatch: $MANIFEST_PLUGIN_ID" >&2
  exit 1
fi
if [[ "$MANIFEST_VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "build-memox: manifest version mismatch: $MANIFEST_VERSION" >&2
  exit 1
fi
if [[ ! "$MANIFEST_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-memox: invalid manifest version: $MANIFEST_VERSION" >&2
  exit 1
fi
if [[ "$MANIFEST_IMPORT_TYPE" != "commonjs" ]]; then
  echo "build-memox: manifest importType must be commonjs: $MANIFEST_IMPORT_TYPE" >&2
  exit 1
fi

if [[ -L "$SOURCE_ROOT/lib" ]]; then
  echo "build-memox: source lib is a symlink" >&2
  exit 1
fi
for file in "${RUNTIME_FILES[@]}"; do
  if [[ ! -f "$SOURCE_ROOT/$file" ]]; then
    echo "build-memox: missing runtime file: $file" >&2
    exit 1
  fi
  if [[ -L "$SOURCE_ROOT/$file" ]]; then
    echo "build-memox: runtime file is a symlink: $file" >&2
    exit 1
  fi
done

STAGE="$(mktemp -d "$REAL_OUT/.memox-build-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

for file in "${RUNTIME_FILES[@]}"; do
  mkdir -p "$(dirname "$STAGE/$file")"
  cp "$SOURCE_ROOT/$file" "$STAGE/$file"
  touch -t "$FIXED_MTIME" "$STAGE/$file"
done

if [[ -n "$(find "$STAGE" -type l -print -quit)" ]]; then
  echo "build-memox: symlink found in staging" >&2
  exit 1
fi
actual_files="$(cd "$STAGE" && find . -type f | sed 's#^\./##' | sort)"
expected_files="$(printf '%s\n' "${RUNTIME_FILES[@]}" | sort)"
if [[ "$actual_files" != "$expected_files" ]]; then
  echo "build-memox: staging contains unexpected or missing files" >&2
  exit 1
fi

(
  cd "$STAGE"
  zip -X -q "$STAGE/$ARTIFACT_NAME" "${RUNTIME_FILES[@]}"
)

listed="$(unzip -Z1 "$STAGE/$ARTIFACT_NAME")"
expected_list="$(printf '%s\n' "${RUNTIME_FILES[@]}")"
if [[ "$listed" != "$expected_list" ]]; then
  echo "build-memox: zip entry list does not match the runtime whitelist" >&2
  exit 1
fi
if ! unzip -tqq "$STAGE/$ARTIFACT_NAME" >/dev/null; then
  echo "build-memox: zip integrity check failed" >&2
  exit 1
fi

if [[ "${MEMOX_BUILD_SIMULATE_FINAL_MOVE_FAILURE:-}" == "1" ]]; then
  echo "build-memox: simulated final move failure" >&2
  exit 1
fi

(cd "$STAGE" && shasum -a 256 "$ARTIFACT_NAME") > "$STAGE/$SIDE_CAR_NAME"
mv "$STAGE/$ARTIFACT_NAME" "$REAL_OUT/$ARTIFACT_NAME"
mv "$STAGE/$SIDE_CAR_NAME" "$REAL_OUT/$SIDE_CAR_NAME"
echo "build-memox: wrote $REAL_OUT/$ARTIFACT_NAME"
