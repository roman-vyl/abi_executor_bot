#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "Error: run this script from the project root (package.json not found)." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required." >&2
  exit 1
fi

archive_dir="var/archives"
archive_name="abi_executor_bot_$(date +%Y%m%d_%H%M%S).zip"
archive_path="$archive_dir/$archive_name"

mkdir -p "$archive_dir"

zip -rq "$archive_path" . \
  -x '.git/' '.git/*' \
  -x 'node_modules/' 'node_modules/*' \
  -x 'dist/' 'dist/*' \
  -x 'var/' 'var/*' \
  -x '.env' '.env.*' \
  -x '*.zip' '*.swp' \
  -x '.DS_Store' '*/.DS_Store'

archive_absolute_path="$(cd "$archive_dir" && pwd)/$archive_name"
echo "Archive created: $archive_absolute_path"
