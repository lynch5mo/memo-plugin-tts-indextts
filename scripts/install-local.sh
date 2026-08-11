#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memo-plugin-tts-gptsovits"

usage() {
  echo "Usage: install-local.sh [--root DIR] [--run-id ID]" >&2
  echo "  --root DIR    Memo application-support root (defaults to \$HOME/Library/Application Support/Memo)" >&2
  echo "  --run-id ID   unique single-segment run id used for staging and backup dirs" >&2
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
if [[ -z "$ROOT" || "$ROOT" == "/" ]]; then
  echo "install-local: invalid root: $ROOT" >&2
  exit 2
fi

if [[ ! -d "$ROOT" ]]; then
  echo "install-local: root directory does not exist: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd -P)"
REAL_MEMO_ROOT=""
if [[ -d "$HOME/Library/Application Support/Memo" ]]; then
  REAL_MEMO_ROOT="$(cd "$HOME/Library/Application Support/Memo" && pwd -P)"
fi

TEST_ROOT_ONLY=0
if [[ -n "${INSTALL_TEST_ROOT:-}" ]]; then
  if [[ -n "$REAL_MEMO_ROOT" && "$ROOT" == "$REAL_MEMO_ROOT" ]]; then
    echo "install-local: INSTALL_TEST_ROOT is not allowed for the real Memo root" >&2
    exit 3
  fi
  TEST_ROOT_ONLY=1
fi

# Validate run id: one non-empty segment, no separators, dots, slashes, whitespace, or control chars.
if [[ "$RUN_ID" != "$(basename "$RUN_ID")" || "$RUN_ID" == "." || "$RUN_ID" == ".." || "$RUN_ID" == "" ]]; then
  echo "install-local: invalid run id: $RUN_ID" >&2
  exit 2
fi
if [[ "$RUN_ID" =~ [/\\[:space:][:cntrl:]] ]]; then
  echo "install-local: invalid run id: $RUN_ID" >&2
  exit 2
fi
if (( ${#RUN_ID} > 64 )); then
  echo "install-local: run id too long" >&2
  exit 2
fi

if [[ ! -f "$SOURCE_ROOT/manifest.json" || ! -f "$SOURCE_ROOT/index.js" || ! -f "$SOURCE_ROOT/lib/audio.js" ]]; then
  echo "install-local: source root is incomplete: $SOURCE_ROOT" >&2
  exit 1
fi
PLUGIN_VERSION="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.version))' "$SOURCE_ROOT/manifest.json")"
PLUGIN_ID_MANIFEST="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.pluginId))' "$SOURCE_ROOT/manifest.json")"
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
BACKUP_DIR="$BACKUP_ROOT/$RUN_ID"
PLUGIN_FILES=(
  "manifest.json"
  "index.js"
  "lib/audio.js"
  "i18n.json"
  "options.json"
  "icon.svg"
)

guard_memo_running() {
  if [[ -z "$REAL_MEMO_ROOT" || "$ROOT" != "$REAL_MEMO_ROOT" ]]; then
    return 0
  fi
  local main_pid=""
  local helper_pid=""
  main_pid="$(pgrep -x Memo 2>/dev/null || true)"
  helper_pid="$(pgrep -x 'Memo Helper' 2>/dev/null || true)"
  if [[ -n "$main_pid" || -n "$helper_pid" ]]; then
    echo "install-local: Memo is running; refusing to replace plugin directory" >&2
    exit 3
  fi
}

is_descendant() {
  local candidate="$1"
  local base="$2"
  [[ "$candidate" == "$base" || "$candidate" == "$base/"* ]]
}

for dir in "$STAGING_DIR" "$BACKUP_DIR" "$PLUGIN_DIR"; do
  if ! is_descendant "$(dirname "$dir")" "$ROOT"; then
    echo "install-local: path escapes root: $dir" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$dir")"
  if ! is_descendant "$(cd "$(dirname "$dir")" && pwd -P)/$(basename "$dir")" "$(cd "$ROOT" && pwd -P)"; then
    echo "install-local: path escapes root: $dir" >&2
    exit 2
  fi
done

guard_memo_running

if [[ -e "$STAGING_DIR" || -L "$STAGING_DIR" ]]; then
  echo "install-local: staging already exists; refusing reuse: $STAGING_DIR" >&2
  exit 2
fi
if [[ -e "$BACKUP_DIR" || -L "$BACKUP_DIR" ]]; then
  echo "install-local: backup run id already exists; refusing reuse: $BACKUP_DIR" >&2
  exit 2
fi

mkdir -p "$STAGING_DIR" "$BACKUP_ROOT"
if [[ -n "$(ls -A "$STAGING_DIR")" ]]; then
  echo "install-local: staging is not empty after creation" >&2
  exit 2
fi
for file in "${PLUGIN_FILES[@]}"; do
  mkdir -p "$(dirname "$STAGING_DIR/$file")"
  cp "$SOURCE_ROOT/$file" "$STAGING_DIR/$file"
done

guard_memo_running

while IFS= read -r -d '' found; do
  if [[ -L "$found" ]]; then
    echo "install-local: symlink found in staging: $found" >&2
    exit 2
  fi
done < <(find "$STAGING_DIR" -print0)

actual_files="$(cd "$STAGING_DIR" && find . -type f | sed 's#^\./##' | sort)"
expected_files="$(printf '%s\n' "${PLUGIN_FILES[@]}" | sort)"
if [[ "$actual_files" != "$expected_files" ]]; then
  echo "install-local: staging contains unexpected or missing files" >&2
  exit 2
fi

STAGING_MANIFEST="$STAGING_DIR/manifest.json"
STAGING_PLUGIN_ID="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.pluginId))' "$STAGING_MANIFEST")"
if [[ "$STAGING_PLUGIN_ID" != "$PLUGIN_ID" ]]; then
  echo "install-local: staged manifest pluginId mismatch" >&2
  exit 1
fi
STAGING_PLUGIN_VERSION="$(node -e 'const m = require(process.argv[1]); process.stdout.write(String(m.version))' "$STAGING_MANIFEST")"
if [[ "$STAGING_PLUGIN_VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "install-local: staged manifest version mismatch" >&2
  exit 1
fi

needs_backup=0
if [[ -e "$PLUGIN_DIR" || -L "$PLUGIN_DIR" ]]; then
  needs_backup=1
fi

guard_memo_running

if [[ "$needs_backup" -eq 1 ]]; then
  mv "$PLUGIN_DIR" "$BACKUP_DIR"
  echo "install-local: moved existing plugin dir to backup $BACKUP_DIR"
fi

if [[ "${INSTALL_SIMULATE_FINAL_MOVE_FAILURE:-}" == "1" ]]; then
  if [[ "$TEST_ROOT_ONLY" -ne 1 ]]; then
    echo "install-local: INSTALL_SIMULATE_FINAL_MOVE_FAILURE requires a test root" >&2
    exit 3
  fi
  echo "install-local: simulated final move failure" >&2
  if [[ "$needs_backup" -eq 1 && -e "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$PLUGIN_DIR"
  fi
  exit 1
fi

if ! mv "$STAGING_DIR" "$PLUGIN_DIR"; then
  echo "install-local: final move failed; restoring previous plugin dir" >&2
  if [[ "$needs_backup" -eq 1 && -e "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$PLUGIN_DIR" || echo "install-local: restore also failed; backup kept at $BACKUP_DIR" >&2
  fi
  exit 1
fi
echo "install-local: installed $PLUGIN_ID@$PLUGIN_VERSION to $PLUGIN_DIR"
