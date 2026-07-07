#!/usr/bin/env bash
set -euo pipefail

base_url="${ABI_BASE_URL:-http://127.0.0.1:8787}"
symbol="${ABI_SMOKE_SYMBOL:-BTCUSDT}"

json_get() {
  local path="$1"
  curl -fsS "$base_url$path"
}

echo "Abi read-only testnet smoke: $base_url"

mode_json="$(json_get /execution/mode)"
MODE_JSON="$mode_json" node -e '
const mode = JSON.parse(process.env.MODE_JSON);
if (mode.bybitEnvironment !== "demo" && mode.bybitEnvironment !== "testnet") {
  console.error("Refusing smoke: /execution/mode must report bybitEnvironment=demo or testnet");
  process.exit(1);
}
console.log("mode.bybitEnvironment=" + mode.bybitEnvironment);
console.log("mode.canExecuteLive=" + mode.canExecuteLive);
'

json_get /health >/tmp/abi-smoke-health.json
json_get "/account/balance?coin=USDT" >/tmp/abi-smoke-balance.json
json_get "/account/orders/active?symbol=$symbol" >/tmp/abi-smoke-active-orders.json
json_get "/account/positions/open?symbol=$symbol" >/tmp/abi-smoke-open-positions.json

node -e '
for (const [name, file] of [
  ["health", "/tmp/abi-smoke-health.json"],
  ["balance", "/tmp/abi-smoke-balance.json"],
  ["active_orders", "/tmp/abi-smoke-active-orders.json"],
  ["open_positions", "/tmp/abi-smoke-open-positions.json"],
]) {
  const payload = require(file);
  console.log(`${name}=${payload.status ?? payload.ok}`);
}
'
