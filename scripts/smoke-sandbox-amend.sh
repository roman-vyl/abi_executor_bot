#!/usr/bin/env bash
set -euo pipefail

if [[ "${ABI_CONFIRM_TESTNET_WRITE:-}" != "YES" ]]; then
  echo "Refusing amend smoke. Set ABI_CONFIRM_TESTNET_WRITE=YES explicitly."
  exit 1
fi

base_url="${ABI_BASE_URL:-http://127.0.0.1:8787}"
symbol="${ABI_SMOKE_SYMBOL:-BTCUSDT}"
side="${ABI_SMOKE_SIDE:-long}"
timestamp="$(date +%s)"
signal_id="${ABI_SMOKE_SIGNAL_ID:-abi-amend-smoke-$timestamp}"
instance_id="${ABI_SMOKE_INSTANCE_ID:-abi-amend-smoke:$symbol:manual:$timestamp}"
entry_price="${ABI_SMOKE_ENTRY_PRICE:?Set ABI_SMOKE_ENTRY_PRICE}"
amended_entry_price="${ABI_SMOKE_AMENDED_ENTRY_PRICE:?Set ABI_SMOKE_AMENDED_ENTRY_PRICE}"
stop_price="${ABI_SMOKE_STOP_PRICE:?Set ABI_SMOKE_STOP_PRICE}"
take_price="${ABI_SMOKE_TAKE_PRICE:?Set ABI_SMOKE_TAKE_PRICE}"
trigger_direction="${ABI_SMOKE_TRIGGER_DIRECTION:-rises_to}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/abi-amend-smoke.XXXXXX")"
cleanup_needed=false

signal_id_path="$(SIGNAL_ID="$signal_id" node -e 'process.stdout.write(encodeURIComponent(process.env.SIGNAL_ID))')"

json_get() {
  local path="$1"
  curl -fsS "$base_url$path"
}

json_post() {
  local path="$1"
  local payload="$2"
  curl -fsS -X POST "$base_url$path" -H "content-type: application/json" -d "$payload"
}

json_put() {
  local path="$1"
  local payload="$2"
  curl -fsS -X PUT "$base_url$path" -H "content-type: application/json" -d "$payload"
}

build_payload() {
  local requested_entry_price="$1"
  SIGNAL_ID="$signal_id" \
    INSTANCE_ID="$instance_id" \
    SYMBOL="$symbol" \
    SIDE="$side" \
    ENTRY_PRICE="$requested_entry_price" \
    STOP_PRICE="$stop_price" \
    TAKE_PRICE="$take_price" \
    TRIGGER_DIRECTION="$trigger_direction" \
    node -e '
const payload = {
  signal_id: process.env.SIGNAL_ID,
  instance_id: process.env.INSTANCE_ID,
  strategy_id: "abi-amend-smoke",
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
}

assert_status() {
  local response_file="$1"
  local expected_status="$2"
  RESPONSE_FILE="$response_file" EXPECTED_STATUS="$expected_status" node -e '
const payload = require(process.env.RESPONSE_FILE);
if (payload.status !== process.env.EXPECTED_STATUS) {
  console.error(`Unexpected status: expected ${process.env.EXPECTED_STATUS}, received ${payload.status ?? "missing"}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
'
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "$cleanup_needed" == "true" ]]; then
    echo "Amend smoke did not finish; attempting to cancel the entry order." >&2
    curl -fsS -X POST "$base_url/intents/$signal_id_path/cancel" >/dev/null || \
      echo "Automatic cancellation failed; check the sandbox account manually." >&2
  fi

  rm -rf "$tmp_dir"
  exit "$exit_code"
}

trap cleanup EXIT

echo "Abi amend sandbox smoke: $base_url"

mode_json="$(json_get /execution/mode)"
MODE_JSON="$mode_json" node -e '
const mode = JSON.parse(process.env.MODE_JSON);
if ((mode.bybitEnvironment !== "demo" && mode.bybitEnvironment !== "testnet") || mode.canExecuteLive !== true) {
  console.error("Refusing amend smoke: /execution/mode must report bybitEnvironment=demo/testnet and canExecuteLive=true");
  console.error(JSON.stringify(mode, null, 2));
  process.exit(1);
}
'

initial_payload="$(build_payload "$entry_price")"
amended_payload="$(build_payload "$amended_entry_price")"

json_post /signals "$initial_payload" >"$tmp_dir/create.json"
assert_status "$tmp_dir/create.json" "accepted_live_entry_order_created"
cleanup_needed=true
json_get "/intents/$signal_id_path/orders/entry" >"$tmp_dir/query-before.json"
assert_status "$tmp_dir/query-before.json" "ok"
json_put "/intents/$signal_id_path" "$amended_payload" >"$tmp_dir/update.json"
assert_status "$tmp_dir/update.json" "updated_live_entry_order_amended"
json_get "/intents/$signal_id_path/orders/entry" >"$tmp_dir/query-after.json"
assert_status "$tmp_dir/query-after.json" "ok"
json_post "/intents/$signal_id_path/cancel" "" >"$tmp_dir/cancel.json"
assert_status "$tmp_dir/cancel.json" "cancelled"
cleanup_needed=false

CREATE_FILE="$tmp_dir/create.json" \
  QUERY_BEFORE_FILE="$tmp_dir/query-before.json" \
  UPDATE_FILE="$tmp_dir/update.json" \
  QUERY_AFTER_FILE="$tmp_dir/query-after.json" \
  CANCEL_FILE="$tmp_dir/cancel.json" \
  node -e '
const create = require(process.env.CREATE_FILE);
const queryBefore = require(process.env.QUERY_BEFORE_FILE);
const update = require(process.env.UPDATE_FILE);
const queryAfter = require(process.env.QUERY_AFTER_FILE);
const cancel = require(process.env.CANCEL_FILE);

function triggerPrice(payload) {
  return payload?.bybitResponse?.result?.list?.[0]?.triggerPrice ?? payload?.entryOrder?.triggerPrice;
}

console.log(`create=${create.status}`);
console.log(`query_before=${queryBefore.status}`);
console.log(`update=${update.status}`);
console.log(`query_after=${queryAfter.status}`);
console.log(`cancel=${cancel.status}`);

const initialTriggerPrice = triggerPrice(queryBefore);
const amendedTriggerPrice = triggerPrice(queryAfter);
if (initialTriggerPrice !== undefined) {
  console.log(`initial_trigger_price=${initialTriggerPrice}`);
}
if (amendedTriggerPrice !== undefined) {
  console.log(`amended_trigger_price=${amendedTriggerPrice}`);
}
'
