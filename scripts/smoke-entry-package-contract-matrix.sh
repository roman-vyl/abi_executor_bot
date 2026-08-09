#!/usr/bin/env bash
set -euo pipefail

# Entry-package smoke script: start a fake server, drive a request sequence,
# and verify the expected event log without touching a real Bybit account.
#
# The fake server records apply/replace/cancel requests so this exercises the
# request contract and sequencing, not real exchange behavior.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${FAKE_ABI_PORT:-18788}"
events_file="$(mktemp "${TMPDIR:-/tmp}/abi-entry-package-fake-smoke-events.XXXXXX.jsonl")"
server_pid=""

pick_port() {
  local candidate="$1"
  if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '%s' "$candidate"
    return 0
  fi

  node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close(() => process.stdout.write(String(port)));
});
'
}

stop_fake_server() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  stop_fake_server
  rm -f "$events_file"
  exit "$exit_code"
}

trap cleanup EXIT

port="$(pick_port "$port")"

FAKE_ABI_PORT="$port" \
FAKE_ABI_EVENTS_FILE="$events_file" \
node "$script_dir/fake-abi-entry-package-smoke-server.mjs" &
server_pid=$!

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 10 ]]; then
    echo "Fake Abi entry-package server did not become ready on port $port." >&2
    exit 1
  fi
  sleep 0.2
done

echo "Fake Abi entry-package smoke server ready on http://127.0.0.1:$port"

base_url="http://127.0.0.1:$port"
strategy_instance_id="abi-entry-package-smoke-instance"
trade_cycle_id="abi-entry-package-smoke-cycle-$$"
path="/v1/strategy-instances/$strategy_instance_id/trade-cycles/$trade_cycle_id/entry-package"

put_entry_package() {
  local payload="$1"
  curl -fsS -X PUT "$base_url$path" -H "content-type: application/json" -d "$payload"
}

desired_entry_payload() {
  SIDE="$1" ENTRY_PRICE="$2" STOP_PRICE="$3" TAKE_PRICE="$4" node -e '
const payload = {
  ticker: "BTCUSDT.P",
  desired_entry: {
    side: process.env.SIDE,
    source_plan_bar_open_time_ms: 1785000000000,
    planned_entry_price: process.env.ENTRY_PRICE,
    initial_stop_price: process.env.STOP_PRICE,
    initial_take_price: process.env.TAKE_PRICE,
    locked_exit_profile: "runner",
  },
  risk_multiplier: "1",
};
process.stdout.write(JSON.stringify(payload));
'
}

echo "1/5 apply (create)"
put_entry_package "$(desired_entry_payload long 100000 99000 103000)" >/dev/null

echo "2/5 replace via amend (same side, changed price)"
put_entry_package "$(desired_entry_payload long 101000 100000 104000)" >/dev/null

echo "3/5 replace via cancel-and-create (side changes)"
put_entry_package "$(desired_entry_payload short 100000 101000 97000)" >/dev/null

echo "4/5 cancel"
curl -fsS -X PUT "$base_url$path" -H "content-type: application/json" \
  -d '{"ticker":"BTCUSDT.P","desired_entry":null,"risk_multiplier":"1"}' >/dev/null

echo "5/5 already-absent cancel"
curl -fsS -X PUT "$base_url$path" -H "content-type: application/json" \
  -d '{"ticker":"BTCUSDT.P","desired_entry":null,"risk_multiplier":"1"}' >/dev/null

expected_events=(
  create
  replace_amend
  replace_cancel_and_create
  cancel_live
  cancel_already_absent
)

echo
echo "Fake entry-package smoke observed events:"
missing=0
for event in "${expected_events[@]}"; do
  if grep -q "\"event\":\"$event\"" "$events_file"; then
    echo "  ok $event"
  else
    echo "  missing $event" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "Expected entry-package smoke events were not fully observed." >&2
  echo "Events file:" >&2
  cat "$events_file" >&2
  exit 1
fi

echo "Entry-package contract matrix smoke summary: all ${#expected_events[@]} expected events observed."
echo "No Bybit credentials required; no Bybit orders were sent (fake server only)."
