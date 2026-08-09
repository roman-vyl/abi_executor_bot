#!/usr/bin/env bash
set -euo pipefail

node --import tsx --test test/unit/*.test.ts
