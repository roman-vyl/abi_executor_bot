# Runbook

Operational guide for running, checking, and troubleshooting Abi.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose, for the container path
- Bybit demo or testnet API credentials, only if you intend to exercise live Bybit calls

Install dependencies once:

```bash
npm install
```

## Local startup

```bash
npm run build
npm start
```

By default Abi starts in dry-run mode (`ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`) and
requires no Bybit credentials.

## Docker Compose startup

Set `BBB_DATA_ROOT` to the shared BBB host data root, then build and run the safe dry-run
container:

```bash
export BBB_DATA_ROOT=/path/to/bbb-data
docker compose up --build
```

The base compose file sets `ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`, and
`BYBIT_ENV=testnet`, and requires no Bybit keys. It mounts `${BBB_DATA_ROOT}/abi` to `/app/var`,
which is where the entry-package correlation store lives inside the container (see below).
Repo-local `./var` is not the production/local Compose durable-storage location.

The container process runs as the non-root `node` user (uid/gid 1000, built into the
`node:20-bookworm-slim` base image), not root. Only `/app/var` is owned by that user inside the
image; application code and dependencies stay root-owned and merely readable. The host
`${BBB_DATA_ROOT}/abi` directory (bind-mounted to `/app/var`) needs to be writable by uid/gid
1000, otherwise correlation-store creation/append/replay fails. On a Linux host this may require
an explicit:

```bash
mkdir -p "${BBB_DATA_ROOT}/abi"
chown 1000:1000 "${BBB_DATA_ROOT}/abi"
```

On Docker Desktop (macOS/Windows), bind-mount ownership goes through the
virtualization/file-sharing layer, and a numeric `chown` is usually not needed — only run it if
you actually hit a permission error on first start.

Container logs are structured: every ABI-controlled line is one JSON object
(`timestamp`/`level`/`service`/`event` plus event-specific fields), not free text.

```bash
docker compose logs -f abi
```

A normal startup emits, among others, `service_starting`, `correlation_replay_started`,
`correlation_replay_succeeded`/`correlation_replay_failed`, `readiness_ready`/`readiness_failed`,
and `server_listening`. Correlation-store replay runs asynchronously relative to the HTTP server
starting to listen, so the relative order between `server_listening` and the replay/readiness
events is not a guaranteed contract — the container can already be accepting connections before
`readiness_ready` fires, which is exactly what `/health` (and the container healthcheck) gates
on. A graceful `docker compose stop` emits `shutdown_started` then `shutdown_completed`.
Error-level events (`level: "error"`) go to stderr; everything else goes to stdout.

For an explicit demo-live override:

```bash
export BBB_SECRETS_ROOT=/path/to/bbb-secrets
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

This loads Bybit credentials from `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` on the host and sets
`ABI_DRY_RUN=false`, `ABI_LIVE_TRADING_ENABLED=true`, `BYBIT_ENV=demo`. `BBB_SECRETS_ROOT` is
required only for this Demo Compose path; the base Compose stack above starts with no secrets
root and no Bybit credentials. If `BBB_SECRETS_ROOT` is not set, the Demo Compose command fails
immediately with an explicit `BBB_SECRETS_ROOT must be set` error instead of starting without
credentials.

`${BBB_SECRETS_ROOT}/abi/bybit-demo.env` is the canonical Demo credential location — it is a
host-side file outside the ABI repo checkout and outside `BBB_DATA_ROOT`, never tracked or
copied into the image. It must contain only the two Bybit credential lines:

```bash
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
```

Execution-mode settings (`ABI_DRY_RUN`, `ABI_LIVE_TRADING_ENABLED`, `BYBIT_ENV`) stay in
`docker-compose.demo.yml` as deployment configuration — do not add them to the secret file.

Recommended host setup (example path — express any real path through `BBB_SECRETS_ROOT`):

```bash
mkdir -p "${BBB_SECRETS_ROOT}/abi"
chmod 700 "${BBB_SECRETS_ROOT}"
chmod 700 "${BBB_SECRETS_ROOT}/abi"
chmod 600 "${BBB_SECRETS_ROOT}/abi/bybit-demo.env"
```

## Credential hygiene

- Keep `.env` and other `.env.*` files local; only `.env.example` is tracked, with empty values.
- Keep Demo credentials only in `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` or runtime environment
  variables — never in a tracked file, and never repo-local.
- Use demo-only API credentials with the minimum permissions needed.
- Rotate a credential immediately if it appears in a commit, log, correlation-store file, ZIP,
  screenshot, or shared terminal output.
- Never put credentials in this document, other tracked files, or command examples.

To load credentials locally for non-Docker runs:

```bash
cp .env.example .env
# edit .env with your demo credentials
set -a
source .env
set +a
```

## Dry-run / live execution guard

Live Bybit writes require all of:

- `ABI_DRY_RUN=false`
- `ABI_LIVE_TRADING_ENABLED=true`
- `BYBIT_API_KEY` and `BYBIT_API_SECRET` set
- `BYBIT_ENV` set to `demo` or `testnet` (mainnet is always blocked)

Check the guard before relying on live behavior:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

The response's `canExecuteLive` field is `true` only when every condition above holds;
otherwise `blockedReasons` lists what is missing.

## Position sizing mode

`ABI_POSITION_SIZING_MODE` is `minimum` (default) or `risk`, independent of `BYBIT_ENV`.

- `risk` sizes each entry as `totalWalletBalance × risk_multiplier / 100 / |entry − stop|`, rounded down to `qtyStep`. `risk_multiplier` from Runtime is the percent itself (`1` = 1 %).
- `risk` needs `BYBIT_API_KEY` and `BYBIT_API_SECRET`; startup fails without them, also in dry-run.
- The account must be in cross (`REGULAR_MARGIN`) or portfolio margin. In Isolated margin every entry is declined with `margin_mode_not_supported`.
- `totalWalletBalance` counts every coin on the account in USD. Keep only USDT on the trading account, or accept that the bankroll moves with the price of other coins.
- Risk is net of fees and slippage: a real loss can be larger than the percent.
- A refusal is logged as `entry_package_declined` with its reason and returned to Runtime as `200 entry_package_declined`.
- The mode is shown in the `service_starting` event (`positionSizingMode`).

## Live-entry configuration file

`ABI_CONFIG_PATH` names an optional JSON file read once at start (stack:
`BBB_data/abi/config/abi.json`). Example: [`config/abi.example.json`](../config/abi.example.json).

```json
{
  "live_entry_mode": "touch_trigger",
  "touch_trigger_entry_order_type": "market"
}
```

- `live_entry_mode`: `ema_anchor` (default) or `touch_trigger`.
- `touch_trigger_entry_order_type`: `market` or `limit`; required with `touch_trigger`, optional (validated) with
  `ema_anchor`.
- Unset variable or missing file = `ema_anchor`. Invalid JSON, a root that is not an object (`[]`, `null`), an unknown
  key, a value outside the list, `touch_trigger` without an order type, or any other read error stops startup.
- To switch, edit the file and restart ABI.
- Entry order on Bybit (abi-touch-trigger-market-entry-v1):
  - `ema_anchor`: conditional Market with `triggerPrice`, `triggerDirection`, `triggerBy` (unchanged).
  - `touch_trigger` + `market`: plain Market, the same request without those three fields; Partial Market SL/TP,
    `orderLinkId`, correlation, confirmation and recovery are unchanged.
  - `touch_trigger` + `limit`: startup fails until limit entry exists (ABI-2).
- Do not enable `touch_trigger` on a trading stack before the Bybit Demo check (Partial SL/TP children linked by
  `parentOrderLinkId`, fill and child timing, partial Market fill reporting).

## Linear position binding mode and Hedge Mode activation

`ABI_BYBIT_LINEAR_POSITION_BINDING_MODE` is ABI's internal expected geometry for newly created
linear bindings. It accepts only `one_way` or `hedge` and defaults to the safe `one_way` value.
It does not affect spot bindings, which remain one-way. Runtime requests cannot select this value,
and ABI never calls Bybit's position-mode switch operation. `positionIdx` remains an internal
exchange mapping derived from each durable binding.

Do not set the policy to `hedge` for production until all of the following are true:

1. `abi-hedge-lifecycle-readiness-v1` tasks 1.1, 1.2, and 3.2 have accepted real flat Bybit Demo
   Hedge Mode evidence. Synthetic fixtures are not a substitute.
2. New admission is stopped and every active discriminator-less legacy or explicit one-way
   correlation binding has reached a durably closed state.
3. Operators have verified all relevant ABI-owned entry, protection, and close orders absent and
   all relevant physical positions flat. Do not rewrite inactive durable history as hedge.
4. An operator switches the Bybit linear account/instrument position mode outside ABI.
5. The hedge-aware build is deployed with `ABI_BYBIT_LINEAR_POSITION_BINDING_MODE=hedge`.
   Startup replay must succeed; any incompatible active record or unavailable/mismatched read-only
   position-mode evidence keeps lifecycle readiness false.
6. The first admission for each inactive instrument passes a fresh read-only mode check before its
   provisional durable claim. Begin with a controlled Demo/testnet rollout and retain a cleanup
   plan. Mainnet execution remains blocked by the existing live guard.

If any check fails, keep admission stopped and leave the policy at `one_way`; ABI must not attempt
to repair the exchange mode. The current repository intentionally ships no deployment override
that selects `hedge`.

Rollback before the first durable production hedge record may restore the prior one-way build only
after confirming no hedge exchange write occurred and restoring compatible Bybit mode externally.
After the first durable hedge record, every rollback build must remain hedge-aware. To return to
one-way: stop admission, recover or resolve every hedge-bound lifecycle, drain all relevant orders
and positions, verify flatness, switch Bybit externally, select `one_way`, and require successful
startup replay/policy validation before reopening admission. Never downgrade to a decoder or
lifecycle that ignores durable hedge geometry.

## Health and execution-mode checks

```bash
curl "http://127.0.0.1:8787/health"
curl "http://127.0.0.1:8787/execution/mode"
```

`/health` reports `entryPackageReady`, which becomes `true` once the correlation store has
finished replaying on startup. Entry-package and open-position routes are readiness-gated: until
replay completes, they fail closed with an `internal_error` response rather than acting on
state that might not be fully recovered.

## Entry-package correlation storage path

Abi's only durable state is the entry-package correlation store, controlled by
`ABI_ENTRY_PACKAGE_CORRELATION_PATH` (default `./var/abi_entry_package_correlation.jsonl` for
local, non-Docker runs). In the Docker Compose setup, `${BBB_DATA_ROOT}/abi` on the host is
mounted to `/app/var` in the container, so the store survives container rebuilds and restarts.

## Exchange facts store

`abi-exchange-facts-sqlite-foundation-v1` adds an ABI-internal SQLite store of Bybit exchange
facts (order records, executions) and orderId → trade cycle links. The exchange stream recorder
(below) writes into it; nothing writes links yet.

- Off by default. `ABI_EXCHANGE_FACTS_ENABLED=true` turns it on (only `true`/`false` are
  accepted). With it off ABI opens nothing, never loads the SQLite native driver and behaves as
  before.
- `ABI_EXCHANGE_FACTS_DB_PATH` defaults to `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3`. In
  Docker Compose that is `${BBB_DATA_ROOT}/abi/abi_exchange_facts_demo.sqlite3` on the Mac demo.
- One database per Bybit environment. The environment and category are written into the file
  when it is created and checked at every start; a mismatch leaves the store unavailable with
  `exchange_facts_store_failed` / `exchange_facts_environment_mismatch`.
- The store never stops trading. Any open or check failure (including
  `exchange_facts_driver_unavailable` when the SQLite driver cannot load) emits
  `exchange_facts_store_failed` at level `error`, and ABI starts and trades without the journal.
  `service_starting` and `GET /health` report `exchangeFactsStore: "unavailable"` (`/health` also
  gives `exchangeFactsStoreReason`); `/health` `ok` and status do not depend on the store. Fix the
  cause and restart ABI to bring the journal back.
- One database per Bybit account. ABI does not check the account. Before switching the API keys
  to another account, stop ABI and move the old database file aside.
- Exactly one ABI process per data directory. SQLite runs in `locking_mode=EXCLUSIVE` only to
  keep the WAL index in process memory (no `-shm` file); it is **not** a guard: file locks do not
  work on the Docker Desktop for macOS bind mount, so a second ABI on the same folder would
  corrupt the file. Deployment (one `abi` service) is what guarantees it.
- No other process may open the file while ABI runs: not the `sqlite3` CLI on the Mac, not
  another container, not a backup tool. Copy the file (with its `-wal`) only with ABI stopped.
  Other services will read facts through a future read-only ABI HTTP API.

## Exchange stream recorder

`abi-exchange-stream-recorder-v1` records ABI's private Bybit WebSocket stream into the exchange
facts store. It is read-only: it authenticates with ABI's key, subscribes to `order`,
`execution`, `position` and `wallet`, and pings; it never sends an order request.

- Runs only when the store is `enabled` and `BYBIT_API_KEY`/`BYBIT_API_SECRET` are set. URL by
  `BYBIT_ENV`: demo `wss://stream-demo.bybit.com/v5/private`, testnet
  `wss://stream-testnet.bybit.com/v5/private`, mainnet `wss://stream.bybit.com/v5/private`.
- Every record is stored as received: `order` → `order_state` fact, `execution` → `execution`
  fact, `position`/`wallet` → `account_snapshots`. Writes happen once per second (or per 500
  records) in one transaction; duplicates after reconnects are dropped by the store's keys.
- Coverage: `stream_connection_log` holds `connecting`, `connected`, `auth_ok`/`auth_failed`,
  `subscribed`/`subscribe_failed`, `disconnected` (with `code=…` or `stale`) and
  `buffer_overflow` rows. The stream is covered only between a `subscribed` row and the next
  `disconnected` row; Bybit does not replay what was sent while disconnected (later REST
  recovery fills those gaps).
- Reconnects forever after 1, 2, 5, 10, 30 s, then every 30 s; a connection with no frame for
  60 s is closed as `stale`.
- Never stops trading. Failures are emitted (`exchange_stream_disconnected`,
  `exchange_stream_auth_failed`, `exchange_stream_subscribe_failed`,
  `exchange_stream_write_failed`, `exchange_stream_record_rejected`,
  `exchange_stream_frame_invalid`; no secrets, no payloads) and shown in `GET /health`
  `exchangeStream` (`state`, `connectedSinceMs`, `lastMessageAtMs`, `reconnects`,
  `bufferedRecords`, `droppedRecords`, `lastWriteError`). At most 10 000 records wait in memory
  while the store fails; more are dropped and counted.
- On Bybit Demo, funding settlements are booked but were not pushed on the WS `execution`
  topic (stage 0, 2026-10-27); funding comes only from REST.
- Schema version 2 adds `account_snapshots` and `stream_connection_log`; a version 1 file is
  upgraded in place at the first start. An older ABI image refuses a version 2 file
  (`exchange_facts_schema_newer`) and runs without the journal.

### Exchange order linker

Links stored orders to strategy instances and trade cycles (OpenSpec
`abi-exchange-order-linker-v1`). Runs only with the store enabled, after the correlation store
has been replayed, every second on its own; no trading route calls it, and it never calls Bybit.

- An order whose `orderLinkId` is an ABI label (`abi-ep-…`) is linked as `entry` or `close`
  with the instance, cycle and generation that produced the label. The labels are recomputed
  from the correlation records for every generation, open and closed cycles alike.
- A Partial stop loss / take profit child (empty `orderLinkId`, `parentOrderLinkId` = an entry
  label) is linked through its entry as `stop_loss` / `take_profit`.
- Every later state, amendment and fill of a linked order belongs to the same cycle through its
  `orderId`; executions get no own link.
- Not linked, by design (`notLinkableOrders`): `foreign_label` (manual or other tool),
  `no_label` (account-wide cancel-all / close-all, liquidation, ADL), `child_type_unknown`,
  `parent_ambiguous`, `own_label_ambiguous`, `link_conflict`, `invalid_link`. Funding
  executions and position / wallet snapshots belong to no cycle.
- Waiting (`waitingOrders`): an ABI order whose label owner is not known yet
  (`own_label_unknown`) or a child whose entry has no link yet (`parent_not_found`). They are
  retried every second without deadline and linked as soon as the missing record is stored. A
  child that keeps waiting usually means the entry's record was lost in a stream drop.
- At every start the linker reads all facts again; already linked orders are skipped, so a
  restart is safe.
- `GET /health` `exchangeLinker`: `state` (`disabled`, `waiting_for_correlation`, `running`,
  `stopped`), `lastTickAtMs`, `linksWritten`, `waitingOrders`, `notLinkableOrders`,
  `lastError`. Events: `exchange_order_linker_started`, `exchange_order_linker_tick_failed`
  (`errorCode`), `exchange_order_linker_link_conflict` (`orderId`, `role`).

## Read-only sandbox smoke

Checks connectivity and credentials without placing orders:

```bash
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
npm run smoke:sandbox:read
```

Expected shape:

```text
mode.bybitEnvironment=demo|testnet
mode.canExecuteLive=<reported value; not required to be true for read-only checks>
health=true
balance=ok
active_orders=ok
open_positions=ok
```

## Local fake entry-package smoke

Exercises the entry-package apply/replace/cancel request sequence against a local fake HTTP
server — no Bybit credentials required, no real orders sent:

```bash
npm run smoke:entry-package:fake
```

## Basic troubleshooting

- **`/health` never reports `entryPackageReady: true`** — check the correlation-store file at
  `ABI_ENTRY_PACKAGE_CORRELATION_PATH` for a non-final corrupt line; replay fails readiness on
  any corruption other than a truncated final line. Under hedge policy, also check for active
  legacy/one-way bindings and `readiness_failed` mode-assurance diagnostics; unavailable or
  mismatched read-only evidence is intentionally fail-closed.
- **`/execution/mode` reports `canExecuteLive: false`** — read `blockedReasons` in the response;
  each entry names exactly which condition (dry-run flag, live-trading flag, credentials,
  environment) is unmet.
- **Active-orders, open-positions, or close-all return `skipped_bybit_query`** —
  `BYBIT_API_KEY`/`BYBIT_API_SECRET` are not set; the response's `wouldQueryBybit` field shows
  what would have been sent. The balance route has no such skip path — with missing or invalid
  credentials it calls Bybit and returns whatever error Bybit reports.
- **Container never becomes healthy** — check `docker compose logs abi`; the healthcheck polls
  `GET /health` and fails closed if the process is not listening.
