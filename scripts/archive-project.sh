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

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required." >&2
  exit 1
fi

if ! commit_short_sha="$(git rev-parse --short HEAD 2>/dev/null)"; then
  echo "Error: cannot determine the current Git commit." >&2
  exit 1
fi

archive_dir="archives"
archive_name="abi_executor_bot_$(date +%Y%m%d)_$commit_short_sha.zip"
archive_path="$archive_dir/$archive_name"

mkdir -p "$archive_dir"
rm -f "$archive_path"

zip -rq "$archive_path" . \
  -x '.git/' '.git/*' './.git/' './.git/*' \
  -x 'node_modules/' 'node_modules/*' './node_modules/' './node_modules/*' \
  -x 'dist/' 'dist/*' './dist/' './dist/*' \
  -x 'var/' 'var/*' './var/' './var/*' \
  -x 'archives/' 'archives/*' './archives/' './archives/*' \
  -x '.env' '.env.*' './.env' './.env.*' \
  -x '*.zip' '*.swp' './*.zip' './*.swp' \
  -x '.DS_Store' '*/.DS_Store' './.DS_Store' './*/.DS_Store'

archive_absolute_path="$(cd "$archive_dir" && pwd)/$archive_name"
echo "Archive created: $archive_absolute_path"
