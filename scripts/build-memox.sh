#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memo-plugin-tts-gptsovits"
PLUGIN_VERSION="2.0.0"
ARTIFACT_NAME="memo-plugin-tts-gptsovits-${PLUGIN_VERSION}.memox"
SIDE_CAR_NAME="${ARTIFACT_NAME}.sha256"
FIXED_MTIME="202601010000"
RUNTIME_FILES=(
  "manifest.json"
  "index.js"
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
const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
let probe = out;
while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
  probe = path.dirname(probe);
}
if (probe !== out && lstat(probe)?.isSymbolicLink()) {
  process.stdout.write("symlink");
  process.exit(0);
}
if (probe !== out) {
  const anchor = path.parse(out).root;
  const relative = path.relative(probe, out);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  let current = probe;
  for (const part of parts) {
    current = path.join(current, part);
    if (lstat(current)?.isSymbolicLink()) {
      process.stdout.write("symlink");
      process.exit(0);
    }
  }
  process.stdout.write("missing");
  process.exit(0);
}
if (lstat(out)?.isSymbolicLink()) {
  process.stdout.write("symlink");
  process.exit(0);
}
if (!fs.statSync(out).isDirectory()) {
  process.stdout.write("notdir");
  process.exit(0);
}
if (path.resolve(out) !== fs.realpathSync(out)) {
  process.stdout.write("symlink");
  process.exit(0);
}
process.stdout.write("ok");
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

if [[ ! -f "$SOURCE_ROOT/manifest.json" || ! -f "$SOURCE_ROOT/index.js" ]]; then
  echo "build-memox: source root is incomplete: $SOURCE_ROOT" >&2
  exit 1
fi

MANIFEST_PLUGIN_ID="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.pluginId))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_VERSION="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.version))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_IMPORT_TYPE="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.importType))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_TYPE="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.type))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_PROVIDER="$(node -e 'const m = require(process.argv[1]); process.stdout.write(typeof m.provider === "object" && m.provider !== null ? JSON.stringify({ value: m.provider.value, label: m.provider.label }) : "invalid")' "$SOURCE_ROOT/manifest.json")"
MANIFEST_PLATFORMS="$(node -e 'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(m.platforms))' "$SOURCE_ROOT/manifest.json")"
MANIFEST_ARCH="$(node -e 'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(m.arch))' "$SOURCE_ROOT/manifest.json")"
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
if [[ "$MANIFEST_IMPORT_TYPE" != "module" ]]; then
  echo "build-memox: manifest importType must be module: $MANIFEST_IMPORT_TYPE" >&2
  exit 1
fi
if [[ "$MANIFEST_TYPE" != "tts" ]]; then
  echo "build-memox: manifest type must be tts: $MANIFEST_TYPE" >&2
  exit 1
fi
if [[ "$MANIFEST_PLATFORMS" != '["darwin"]' ]]; then
  echo "build-memox: manifest platforms must be exactly [darwin]: $MANIFEST_PLATFORMS" >&2
  exit 1
fi
if [[ "$MANIFEST_ARCH" != '["arm64"]' ]]; then
  echo "build-memox: manifest arch must be exactly [arm64]: $MANIFEST_ARCH" >&2
  exit 1
fi
if [[ "$MANIFEST_PROVIDER" == "invalid" ]]; then
  echo "build-memox: manifest provider must be an object with non-empty value/label" >&2
  exit 1
fi
MANIFEST_PROVIDER_VALUE="$(node -e 'const m = JSON.parse(process.argv[1]); process.stdout.write(String(m.value))' "$MANIFEST_PROVIDER")"
MANIFEST_PROVIDER_LABEL="$(node -e 'const m = JSON.parse(process.argv[1]); process.stdout.write(String(m.label))' "$MANIFEST_PROVIDER")"
if [[ -z "$MANIFEST_PROVIDER_VALUE" || -z "$MANIFEST_PROVIDER_LABEL" ]]; then
  echo "build-memox: manifest provider value/label must be non-empty" >&2
  exit 1
fi
if [[ "$MANIFEST_PROVIDER_VALUE" != "GPT-SoVITS TTS" || "$MANIFEST_PROVIDER_LABEL" != "GPT-SoVITS TTS" ]]; then
  echo "build-memox: manifest provider value/label must match the expected provider" >&2
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
  chmod 0644 "$STAGE/$file"
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

for target in "$REAL_OUT/$ARTIFACT_NAME" "$REAL_OUT/$SIDE_CAR_NAME"; do
  if [[ -L "$target" || -e "$target" ]] && [[ ! -f "$target" || -L "$target" ]]; then
    echo "build-memox: output target is not a regular file: $target" >&2
    exit 1
  fi
done

(cd "$STAGE" && shasum -a 256 "$ARTIFACT_NAME") > "$STAGE/$SIDE_CAR_NAME"
if [[ -f "$REAL_OUT/$ARTIFACT_NAME" ]]; then
  cp "$REAL_OUT/$ARTIFACT_NAME" "$STAGE/old-$ARTIFACT_NAME"
fi
mv "$STAGE/$ARTIFACT_NAME" "$REAL_OUT/$ARTIFACT_NAME"
if ! mv "$STAGE/$SIDE_CAR_NAME" "$REAL_OUT/$SIDE_CAR_NAME"; then
  echo "build-memox: sidecar publish failed; restoring previous artifact" >&2
  if [[ -f "$STAGE/old-$ARTIFACT_NAME" ]]; then
    mv "$STAGE/old-$ARTIFACT_NAME" "$REAL_OUT/$ARTIFACT_NAME"
  else
    rm -f "$REAL_OUT/$ARTIFACT_NAME"
  fi
  exit 1
fi
echo "build-memox: wrote $REAL_OUT/$ARTIFACT_NAME"
