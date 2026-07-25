#!/usr/bin/env bash
set -euo pipefail

tmp_dir="/tmp/abi-test-run"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir/src" "$tmp_dir/test" "$tmp_dir/docs"

cp -R src/. "$tmp_dir/src/"
cp -R test/. "$tmp_dir/test/"
cp -R docs/. "$tmp_dir/docs/"

find "$tmp_dir/src" "$tmp_dir/test" -type f -name "*.ts" -print0 | xargs -0 perl -pi -e 's/\.js"/\.ts"/g'

node --test "$tmp_dir/test/unit/"*.test.ts
