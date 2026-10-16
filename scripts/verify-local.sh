#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memo-plugin-tts-gptsovits"

usage() {
  echo "Usage: verify-local.sh --root DIR [--plugin-version VERSION]" >&2
}

ROOT=""
PLUGIN_VERSION=""
while (($# > 0)); do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --plugin-version) PLUGIN_VERSION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$ROOT" || -z "$PLUGIN_VERSION" ]]; then
  usage
  exit 2
fi
if [[ -z "$ROOT" || "$ROOT" == "/" ]]; then
  echo "verify-local: invalid root: $ROOT" >&2
  exit 2
fi
if [[ ! "$PLUGIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "verify-local: invalid plugin version: $PLUGIN_VERSION" >&2
  exit 2
fi

PLUGIN_DIR="$ROOT/plugins/$PLUGIN_ID@$PLUGIN_VERSION"
if [[ ! -d "$ROOT" ]]; then
  echo "verify-local: root directory does not exist: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd -P)"
PLUGIN_DIR="$ROOT/plugins/$PLUGIN_ID@$PLUGIN_VERSION"
PATH_CHECK="$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const pluginDir = process.argv[2];
const realRoot = fs.realpathSync(root);
const realPlugins = fs.realpathSync(path.join(root, "plugins"));
const realPluginDir = fs.realpathSync(pluginDir);
const relative = path.relative(realRoot, realPlugins);
if (relative === "" || relative.split(path.sep).some((part) => part === "..")) {
  console.error("verify-local: plugins path escapes root: " + realPlugins);
  process.exit(2);
}
const pluginRelative = path.relative(realPlugins, realPluginDir);
if (pluginRelative === "" || pluginRelative.split(path.sep).some((part) => part === "..")) {
  console.error("verify-local: plugin path escapes plugins: " + realPluginDir);
  process.exit(2);
}
process.stdout.write("OK");
' "$ROOT" "$PLUGIN_DIR")"
if [[ "$PATH_CHECK" != "OK" ]]; then
  echo "verify-local: plugin path escapes root: $PLUGIN_DIR" >&2
  exit 2
fi

EXPECTED_FILES=(
  "index.js"
  "manifest.json"
  "i18n.json"
  "options.json"
  "icon.svg"
)

for file in "${EXPECTED_FILES[@]}"; do
  if [[ ! -f "$PLUGIN_DIR/$file" ]]; then
    echo "verify-local: missing $file" >&2
    exit 1
  fi
done

while IFS= read -r -d '' found; do
  if [[ -L "$found" ]]; then
    echo "verify-local: symlink found: $found" >&2
    exit 1
  fi
done < <(find "$PLUGIN_DIR" -print0)

actual_files="$(cd "$PLUGIN_DIR" && find . -type f | sed 's#^\./##' | sort)"
expected_files="$(printf '%s\n' "${EXPECTED_FILES[@]}" | sort)"
if [[ "$actual_files" != "$expected_files" ]]; then
  echo "verify-local: plugin dir contains unexpected or missing files" >&2
  exit 1
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for file in "${EXPECTED_FILES[@]}"; do
  source_hash="$(shasum -a 256 "$SOURCE_ROOT/$file" | awk '{print $1}')"
  installed_hash="$(shasum -a 256 "$PLUGIN_DIR/$file" | awk '{print $1}')"
  if [[ "$source_hash" != "$installed_hash" ]]; then
    echo "verify-local: hash mismatch for $file" >&2
    exit 1
  fi
done

MANIFEST_PLUGIN_ID="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.pluginId))' "$PLUGIN_DIR/manifest.json")"
MANIFEST_VERSION="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.version))' "$PLUGIN_DIR/manifest.json")"
if [[ "$MANIFEST_PLUGIN_ID" != "$PLUGIN_ID" ]]; then
  echo "verify-local: manifest pluginId mismatch: $MANIFEST_PLUGIN_ID" >&2
  exit 1
fi
if [[ "$MANIFEST_VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "verify-local: manifest version mismatch: $MANIFEST_VERSION" >&2
  exit 1
fi

node -e '
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pluginDir = process.argv[1];
const result = spawnSync(process.execPath, ["-e", `
const TTS = require(process.argv[1]).default;
const entry = require(process.argv[1]);
if (typeof entry.default !== "function") throw new Error("default export is not a constructor");
if (typeof entry.getEditorOptions !== "function") throw new Error("getEditorOptions export is missing");
new TTS().textToSpeech({ text: "你好" }).then((result) => {
  if (typeof result !== "string") throw new Error("unconfigured entry must return a fixed error string");
  if (!result.startsWith("语音合成失败：")) throw new Error("error string is not the fixed Chinese category");
  return entry.getEditorOptions({ fieldKey: "model", config: {}, query: {} });
}).then((options) => {
  if (!Array.isArray(options) || options.length !== 2) throw new Error("model options must list both engines");
  console.log("verify-local: require contract OK");
}).catch((error) => {
  console.error("verify-local: require contract failed:", error.message);
  process.exit(1);
});
`, path.join(pluginDir, "index.js")], { encoding: "utf8", timeout: 15000 });
if (result.status !== 0) {
  process.stderr.write(result.stderr || "");
  process.exit(result.status || 1);
}
process.stdout.write(result.stdout || "");
' "$PLUGIN_DIR"
