#!/usr/bin/env bash
set -euo pipefail

if [[ "${ABI_CONFIRM_TESTNET_WRITE:-}" != "YES" ]]; then
  echo "Refusing contract matrix smoke. Set ABI_CONFIRM_TESTNET_WRITE=YES explicitly."
  exit 1
fi

base_url="${ABI_BASE_URL:-http://127.0.0.1:8787}"
symbol="${ABI_SMOKE_SYMBOL:-BTCUSDT}"
side="${ABI_SMOKE_SIDE:-long}"
entry_price="${ABI_SMOKE_ENTRY_PRICE:?Set ABI_SMOKE_ENTRY_PRICE}"
stop_price="${ABI_SMOKE_STOP_PRICE:?Set ABI_SMOKE_STOP_PRICE}"
take_price="${ABI_SMOKE_TAKE_PRICE:?Set ABI_SMOKE_TAKE_PRICE}"
trigger_direction="${ABI_SMOKE_TRIGGER_DIRECTION:-rises_to}"
timestamp="$(date +%s)"
run_id="${ABI_SMOKE_RUN_ID:-$timestamp}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/abi-contract-matrix.XXXXXX")"
current_signal_id=""

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
  local signal_id="$1"
  local instance_id="$2"
  local shape="$3"

  SIGNAL_ID="$signal_id" \
    INSTANCE_ID="$instance_id" \
    SYMBOL="$symbol" \
    SIDE="$side" \
    ENTRY_PRICE="$entry_price" \
    STOP_PRICE="$stop_price" \
    TAKE_PRICE="$take_price" \
    TRIGGER_DIRECTION="$trigger_direction" \
    SHAPE="$shape" \
    node -e '
const payload = {
  signal_id: process.env.SIGNAL_ID,
  instance_id: process.env.INSTANCE_ID,
  strategy_id: "abi-contract-matrix-smoke",
  symbol: process.env.SYMBOL,
  side: process.env.SIDE,
  entry: {
    type: "stop_market",
    trigger_price: process.env.ENTRY_PRICE,
    trigger_direction: process.env.TRIGGER_DIRECTION,
  },
};

if (process.env.SHAPE === "stop" || process.env.SHAPE === "full") {
  payload.stop_loss = {
    type: "stop_market",
    trigger_price: process.env.STOP_PRICE,
  };
}

if (process.env.SHAPE === "full" || process.env.SHAPE === "take_only") {
  payload.take_profit = {
    type: "take_profit_market",
    trigger_price: process.env.TAKE_PRICE,
  };
}

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

read_status() {
  local response_file="$1"
  RESPONSE_FILE="$response_file" node -e '
const payload = require(process.env.RESPONSE_FILE);
process.stdout.write(String(payload.status ?? "missing"));
'
}

assert_active_orders_empty() {
  local label="$1"
  local response_file="$tmp_dir/active-orders-$label.json"
  local attempt

  for attempt in 1 2 3 4 5; do
    json_get "/account/orders/active?symbol=$symbol" >"$response_file"
    if RESPONSE_FILE="$response_file" node -e '
const payload = require(process.env.RESPONSE_FILE);
const orders = payload?.bybitResponse?.result?.list;
if (payload.status !== "ok" || !Array.isArray(orders) || orders.length !== 0) {
  process.exit(1);
}
'; then
      return 0
    fi
    sleep 1
  done

  echo "Expected no active $symbol orders after $label." >&2
  cat "$response_file" >&2
  return 1
}

query_entry_until_found() {
  local signal_id="$1"
  local response_file="$2"
  local attempt

  for attempt in 1 2 3 4 5; do
    json_get "/intents/$signal_id/orders/entry" >"$response_file"
    if RESPONSE_FILE="$response_file" node -e '
const payload = require(process.env.RESPONSE_FILE);
const orders = payload?.bybitResponse?.result?.list;
if (payload.status !== "ok" || !Array.isArray(orders) || orders.length === 0) {
  process.exit(1);
}
'; then
      return 0
    fi
    sleep 1
  done

  echo "Entry order was not found for $signal_id after five attempts." >&2
  cat "$response_file" >&2
  return 1
}
cancel_current_intent() {
  if [[ -n "$current_signal_id" ]]; then
    curl -fsS -X POST "$base_url/intents/$current_signal_id/cancel" >/dev/null || \
      echo "Automatic cancellation failed for $current_signal_id; check the sandbox account manually." >&2
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  cancel_current_intent
  rm -rf "$tmp_dir"
  exit "$exit_code"
}

trap cleanup EXIT

run_create_query_cancel_case() {
  local label="$1"
  local shape="$2"
  local signal_id="abi-contract-$run_id-$label"
  local instance_id="abi-contract:$symbol:$run_id:$label"
  local payload
  payload="$(build_payload "$signal_id" "$instance_id" "$shape")"

  current_signal_id="$signal_id"
  json_post /signals "$payload" >"$tmp_dir/$label-create.json"
  assert_status "$tmp_dir/$label-create.json" "accepted_live_entry_order_created"

  query_entry_until_found "$signal_id" "$tmp_dir/$label-query.json"

  json_post "/intents/$signal_id/cancel" "" >"$tmp_dir/$label-cancel.json"
  assert_status "$tmp_dir/$label-cancel.json" "cancelled"
  current_signal_id=""
  assert_active_orders_empty "$label"

  echo "$label create=$(read_status "$tmp_dir/$label-create.json") query=$(read_status "$tmp_dir/$label-query.json") cancel=$(read_status "$tmp_dir/$label-cancel.json") active_orders=empty"
}

run_amend_transitions_case() {
  local label="D"
  local signal_id="abi-contract-$run_id-d"
  local instance_id="abi-contract:$symbol:$run_id:d"

  current_signal_id="$signal_id"
  json_post /signals "$(build_payload "$signal_id" "$instance_id" entry)" >"$tmp_dir/d-create.json"
  assert_status "$tmp_dir/d-create.json" "accepted_live_entry_order_created"

  json_put "/intents/$signal_id" "$(build_payload "$signal_id" "$instance_id" stop)" >"$tmp_dir/d-amend-stop.json"
  assert_status "$tmp_dir/d-amend-stop.json" "updated_live_entry_order_amended"

  json_put "/intents/$signal_id" "$(build_payload "$signal_id" "$instance_id" full)" >"$tmp_dir/d-amend-full.json"
  assert_status "$tmp_dir/d-amend-full.json" "updated_live_entry_order_amended"

  json_put "/intents/$signal_id" "$(build_payload "$signal_id" "$instance_id" stop)" >"$tmp_dir/d-amend-stop-again.json"
  assert_status "$tmp_dir/d-amend-stop-again.json" "updated_live_entry_order_amended"

  json_put "/intents/$signal_id" "$(build_payload "$signal_id" "$instance_id" entry)" >"$tmp_dir/d-amend-entry.json"
  assert_status "$tmp_dir/d-amend-entry.json" "updated_live_entry_order_amended"

  json_post "/intents/$signal_id/cancel" "" >"$tmp_dir/d-cancel.json"
  assert_status "$tmp_dir/d-cancel.json" "cancelled"
  current_signal_id=""
  assert_active_orders_empty "$label"

  echo "D create=$(read_status "$tmp_dir/d-create.json") amend_stop=$(read_status "$tmp_dir/d-amend-stop.json") amend_full=$(read_status "$tmp_dir/d-amend-full.json") amend_stop_again=$(read_status "$tmp_dir/d-amend-stop-again.json") amend_entry=$(read_status "$tmp_dir/d-amend-entry.json") cancel=$(read_status "$tmp_dir/d-cancel.json") active_orders=empty"
}

run_invalid_case() {
  local signal_id="abi-contract-$run_id-e"
  local instance_id="abi-contract:$symbol:$run_id:e"
  local payload
  local http_status
  payload="$(build_payload "$signal_id" "$instance_id" take_only)"

  http_status="$(curl -sS -o "$tmp_dir/e-invalid.json" -w "%{http_code}" -X POST "$base_url/signals" -H "content-type: application/json" -d "$payload")"
  if [[ "$http_status" != "400" && "$http_status" != "422" ]]; then
    echo "Expected invalid take-profit-only payload to return HTTP 400 or 422, received $http_status." >&2
    cat "$tmp_dir/e-invalid.json" >&2
    return 1
  fi

  assert_active_orders_empty "E"
  echo "E invalid_http=$http_status bybit_create=not_observed active_orders=empty"
}

echo "Abi BBB contract matrix smoke: $base_url"

mode_json="$(json_get /execution/mode)"
MODE_JSON="$mode_json" node -e '
const mode = JSON.parse(process.env.MODE_JSON);
if ((mode.bybitEnvironment !== "demo" && mode.bybitEnvironment !== "testnet") || mode.canExecuteLive !== true) {
  console.error("Refusing contract matrix smoke: /execution/mode must report bybitEnvironment=demo/testnet and canExecuteLive=true");
  console.error(JSON.stringify(mode, null, 2));
  process.exit(1);
}
'

assert_active_orders_empty "initial"
run_create_query_cancel_case "A" "entry"
run_create_query_cancel_case "B" "stop"
run_create_query_cancel_case "C" "full"
run_amend_transitions_case
run_invalid_case

trap - EXIT
rm -rf "$tmp_dir"
echo "BBB contract matrix smoke completed successfully."
