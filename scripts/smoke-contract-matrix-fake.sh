#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
port="${FAKE_ABI_PORT:-18787}"
events_file="$(mktemp "${TMPDIR:-/tmp}/abi-fake-smoke-events.XXXXXX.jsonl")"
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
node "$script_dir/fake-abi-smoke-server.mjs" &
server_pid=$!

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 10 ]]; then
    echo "Fake Abi server did not become ready on port $port." >&2
    exit 1
  fi
  sleep 0.2
done

echo "Fake Abi smoke server ready on http://127.0.0.1:$port"

ABI_CONFIRM_TESTNET_WRITE=YES \
ABI_BASE_URL="http://127.0.0.1:$port" \
ABI_SMOKE_SYMBOL=BTCUSDT \
ABI_SMOKE_SIDE=long \
ABI_SMOKE_ENTRY_PRICE=200000 \
ABI_SMOKE_STOP_PRICE=190000 \
ABI_SMOKE_TAKE_PRICE=220000 \
ABI_SMOKE_TRIGGER_DIRECTION=rises_to \
bash "$script_dir/smoke-sandbox-contract-matrix.sh"
smoke_exit=$?

expected_events=(
  create_entry_only
  create_stop_only
  create_stop_take
  amend_entry_only_to_stop_only
  amend_stop_only_to_stop_take
  amend_stop_take_to_stop_only
  amend_stop_only_to_entry_only
  invalid_take_without_stop_rejected
)

echo
echo "Fake smoke observed events:"
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
  echo "Expected fake smoke events were not fully observed." >&2
  echo "Events file:" >&2
  cat "$events_file" >&2
  exit 1
fi

echo "Fake contract matrix smoke summary: all ${#expected_events[@]} expected events observed."
echo "No Bybit credentials required; no Bybit orders were sent."

exit "$smoke_exit"
