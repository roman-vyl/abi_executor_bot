#!/usr/bin/env bash
set -euo pipefail

if [[ "${ABI_CONFIRM_TESTNET_WRITE:-}" != "YES" ]]; then
  echo "Refusing write smoke. Set ABI_CONFIRM_TESTNET_WRITE=YES explicitly."
  exit 1
fi

base_url="${ABI_BASE_URL:-http://127.0.0.1:8787}"
signal_id="${ABI_SMOKE_SIGNAL_ID:-abi-testnet-smoke-$(date +%s)}"
instance_id="${ABI_SMOKE_INSTANCE_ID:-abi-testnet-smoke:BTCUSDT:manual}"
symbol="${ABI_SMOKE_SYMBOL:-BTCUSDT}"
side="${ABI_SMOKE_SIDE:-long}"
entry_price="${ABI_SMOKE_ENTRY_PRICE:?Set ABI_SMOKE_ENTRY_PRICE}"
stop_price="${ABI_SMOKE_STOP_PRICE:?Set ABI_SMOKE_STOP_PRICE}"
take_price="${ABI_SMOKE_TAKE_PRICE:?Set ABI_SMOKE_TAKE_PRICE}"
trigger_direction="${ABI_SMOKE_TRIGGER_DIRECTION:-rises_to}"

json_get() {
  local path="$1"
  curl -fsS "$base_url$path"
}

json_post() {
  local path="$1"
  local payload="$2"
  curl -fsS -X POST "$base_url$path" -H "content-type: application/json" -d "$payload"
}

echo "Abi write testnet smoke: $base_url"

mode_json="$(json_get /execution/mode)"
MODE_JSON="$mode_json" node -e '
const mode = JSON.parse(process.env.MODE_JSON);
if ((mode.bybitEnvironment !== "demo" && mode.bybitEnvironment !== "testnet") || mode.canExecuteLive !== true) {
  console.error("Refusing write smoke: /execution/mode must report bybitEnvironment=demo/testnet and canExecuteLive=true");
  console.error(JSON.stringify(mode, null, 2));
  process.exit(1);
}
'

payload="$(
  SIGNAL_ID="$signal_id" INSTANCE_ID="$instance_id" SYMBOL="$symbol" SIDE="$side" ENTRY_PRICE="$entry_price" STOP_PRICE="$stop_price" TAKE_PRICE="$take_price" TRIGGER_DIRECTION="$trigger_direction" node -e '
const payload = {
  signal_id: process.env.SIGNAL_ID,
  instance_id: process.env.INSTANCE_ID,
  strategy_id: "abi-testnet-smoke",
  symbol: process.env.SYMBOL,
  side: process.env.SIDE,
  entry: {
    type: "stop_market",
    trigger_price: process.env.ENTRY_PRICE,
    trigger_direction: process.env.TRIGGER_DIRECTION,
  },
  stop_loss: {
    type: "stop_market",
    trigger_price: process.env.STOP_PRICE,
  },
  take_profit: {
    type: "take_profit_market",
    trigger_price: process.env.TAKE_PRICE,
  },
};
process.stdout.write(JSON.stringify(payload));
'
)"

json_post /signals "$payload" >/tmp/abi-smoke-create-order.json
json_get "/intents/$signal_id/orders/entry" >/tmp/abi-smoke-query-order.json
curl -fsS -X POST "$base_url/intents/$signal_id/cancel" >/tmp/abi-smoke-cancel-order.json

node -e '
for (const [name, file] of [
  ["create", "/tmp/abi-smoke-create-order.json"],
  ["query_entry", "/tmp/abi-smoke-query-order.json"],
  ["cancel", "/tmp/abi-smoke-cancel-order.json"],
]) {
  const payload = require(file);
  console.log(`${name}=${payload.status}`);
}
'
