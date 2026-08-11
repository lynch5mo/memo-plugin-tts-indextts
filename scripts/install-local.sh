#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memo-plugin-tts-gptsovits"

usage() {
  echo "Usage: install-local.sh [--root DIR] [--run-id ID]" >&2
  echo "  --root DIR    Memo application-support root (defaults to \$HOME/Library/Application Support/Memo)" >&2
  echo "  --run-id ID   unique run id used for staging and backup dirs (defaults to a timestamp)" >&2
}

ROOT=""
RUN_ID=""
while (($# > 0)); do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  ROOT="$HOME/Library/Application Support/Memo"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_VERSION="$(node -p "require('$SOURCE_ROOT/manifest.json').version")"
PLUGIN_ID_MANIFEST="$(node -p "require('$SOURCE_ROOT/manifest.json').pluginId")"

if [[ ! -f "$SOURCE_ROOT/manifest.json" || ! -f "$SOURCE_ROOT/index.js" || ! -f "$SOURCE_ROOT/lib/audio.js" ]]; then
  echo "install-local: source root is incomplete: $SOURCE_ROOT" >&2
  exit 1
fi
if [[ "$PLUGIN_ID_MANIFEST" != "$PLUGIN_ID" ]]; then
  echo "install-local: manifest pluginId mismatch: $PLUGIN_ID_MANIFEST" >&2
  exit 1
fi
if [[ ! "$PLUGIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "install-local: invalid plugin version: $PLUGIN_VERSION" >&2
  exit 1
fi

PLUGIN_DIR="$ROOT/plugins/$PLUGIN_ID@$PLUGIN_VERSION"
STAGING_DIR="$ROOT/plugin-staging/$RUN_ID"
BACKUP_ROOT="$ROOT/plugin-backups/$PLUGIN_ID"
PLUGIN_FILES=(
  "manifest.json"
  "index.js"
  "lib/audio.js"
  "i18n.json"
  "options.json"
  "icon.svg"
)

if [[ -n "${INSTALL_ALLOW_RUNNING_MEMO:-}" ]]; then
  echo "install-local: INSTALL_ALLOW_RUNNING_MEMO is set; skipping running-Memo guard (test injection only)" >&2
else
  if pgrep -f "/Applications/Memo.app" >/dev/null 2>&1; then
    echo "install-local: Memo is running; refusing to replace plugin directory" >&2
    exit 3
  fi
fi

mkdir -p "$STAGING_DIR" "$BACKUP_ROOT"
for file in "${PLUGIN_FILES[@]}"; do
  mkdir -p "$(dirname "$STAGING_DIR/$file")"
  cp "$SOURCE_ROOT/$file" "$STAGING_DIR/$file"
done

STAGING_MANIFEST="$STAGING_DIR/manifest.json"
if [[ "$(node -p "require('$STAGING_MANIFEST').pluginId")" != "$PLUGIN_ID" ]]; then
  echo "install-local: staged manifest pluginId mismatch" >&2
  exit 1
fi
if [[ "$(node -p "require('$STAGING_MANIFEST').version")" != "$PLUGIN_VERSION" ]]; then
  echo "install-local: staged manifest version mismatch" >&2
  exit 1
fi
if [[ ! -f "$STAGING_DIR/index.js" || ! -f "$STAGING_DIR/lib/audio.js" ]]; then
  echo "install-local: staged entry files missing" >&2
  exit 1
fi

if [[ -e "$PLUGIN_DIR" ]]; then
  BACKUP_DIR="$BACKUP_ROOT/$RUN_ID"
  mkdir -p "$(dirname "$BACKUP_DIR")"
  mv "$PLUGIN_DIR" "$BACKUP_DIR"
  echo "install-local: moved existing plugin dir to backup $BACKUP_DIR"
fi

mkdir -p "$(dirname "$PLUGIN_DIR")"
mv "$STAGING_DIR" "$PLUGIN_DIR"
echo "install-local: installed $PLUGIN_ID@$PLUGIN_VERSION to $PLUGIN_DIR"
