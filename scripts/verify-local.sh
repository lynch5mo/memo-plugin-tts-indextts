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

PLUGIN_DIR="$ROOT/plugins/$PLUGIN_ID@$PLUGIN_VERSION"
EXPECTED_FILES=(
  "index.js"
  "lib/audio.js"
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

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for file in "${EXPECTED_FILES[@]}"; do
  source_hash="$(shasum -a 256 "$SOURCE_ROOT/$file" | awk '{print $1}')"
  installed_hash="$(shasum -a 256 "$PLUGIN_DIR/$file" | awk '{print $1}')"
  if [[ "$source_hash" != "$installed_hash" ]]; then
    echo "verify-local: hash mismatch for $file" >&2
    exit 1
  fi
done

MANIFEST_PLUGIN_ID="$(node -p "require('$PLUGIN_DIR/manifest.json').pluginId")"
MANIFEST_VERSION="$(node -p "require('$PLUGIN_DIR/manifest.json').version")"
if [[ "$MANIFEST_PLUGIN_ID" != "$PLUGIN_ID" ]]; then
  echo "verify-local: manifest pluginId mismatch: $MANIFEST_PLUGIN_ID" >&2
  exit 1
fi
if [[ "$MANIFEST_VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "verify-local: manifest version mismatch: $MANIFEST_VERSION" >&2
  exit 1
fi

node -e "
const TTS = require('$PLUGIN_DIR/index.js').default;
if (typeof TTS !== 'function') throw new Error('default export is not a constructor');
new TTS().textToSpeech({ text: '' }).then((buffer) => {
  if (!Buffer.isBuffer(buffer)) throw new Error('textToSpeech did not return a Buffer');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF WAV');
  if (buffer.length !== 44 + 3200 * 2) throw new Error('unexpected WAV length');
  console.log('verify-local: require contract OK');
}).catch((error) => {
  console.error('verify-local: require contract failed:', error.message);
  process.exit(1);
});
"
