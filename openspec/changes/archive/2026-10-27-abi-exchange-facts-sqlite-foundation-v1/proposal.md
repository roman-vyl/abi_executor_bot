## Why

The owner wants ABI to keep a detailed journal of what happens on Bybit: every order state, every fill (price, quantity, fee, time, `execId`), every cancel, so that any fact can be pulled later by `orderId` / `orderLinkId`. Today ABI keeps none of it: the execution decoder reads only `execTime` and `execQty`, child SL/TP `orderId`s live only in memory, and the correlation JSONL holds one state snapshot per trade cycle (audit 2026-10-25, `/mnt/project-files/abi-facts-journal/`).

Decisions taken by the owner on 2026-10-25 (17:24, 17:49, 18:29):

- ABI alone writes exchange facts into its own SQLite. The SQLite schema is ABI's **internal storage**. The only future inter-service contract is a read-only ABI HTTP API (option C); the Central Journal never opens the file and never copies the facts into its own database. Shared reading of one SQLite file across containers is rejected: on Docker Desktop for macOS a bind mount has no working `fcntl` locks (option A). A Docker named volume (option B) stays a reserve.
- The files live physically in `BBB_data/abi` (the folder ABI already mounts as `/app/var`), like the MDS database, **one database per Bybit environment** (`demo`, `testnet`, `mainnet`). ABI checks at open that the database belongs to its `BYBIT_ENV` and refuses to start otherwise.
- One database belongs to one environment **and one Bybit account**. Foundation does not query the account UID; switching API keys to another account must not continue writing into the old database (operational rule, RUNBOOK).
- Driver `better-sqlite3` pinned exactly to `12.9.0` with the lockfile; Node stays 20. Installing the driver must not touch order execution.
- Facts and links are separate. **One exchange order = one link row, keyed by Bybit `orderId`**, written once when the `orderId` is known; before that the intent lives only in the correlation JSONL. Facts whose order has no link stay unattributed. Aggregated positions are never used for attribution.
- Two fact kinds, meaning the **form of the Bybit record**: `order_state` (an order record) and `execution` (an execution record of any `execType`, Funding included), plus an indexed `exec_type` column.
- `order_state` deduplication by `orderId`, `updatedTime` and a fingerprint of a fixed list of normalized state fields, with a versioned rule; `execution` by `execId`.
- The read cursor is a monotonic internal `event_seq` (facts) and `link_seq` (links), not a Bybit time.
- Verified on demo (trade 6072511f): `order/history` rows carry `parentOrderLinkId` = entry `orderLinkId` for the Partial SL/TP children, whose own `orderLinkId` is empty; `execution/list` rows carry only `orderId`.

This change is step 1 of several: **SQLite Foundation** only.

## What Changes

- New module `src/exchangeFacts/` with a store over `better-sqlite3@12.9.0`: opens or creates the environment's database, checks environment and schema, writes facts and links in transactions with deduplication, and reads facts and links after a cursor (internal functions for tests and the later API).
- Internal storage schema v1: `exchange_facts`, `order_links`, `schema_meta`.
- New config `ABI_EXCHANGE_FACTS_ENABLED` (default `false`) and `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3`). When enabled, the service opens the store at startup and reports it in `service_starting`; when disabled nothing is opened and the service behaves exactly as today.
- Exact dependency pin and lockfile; Docker image builds without a compiler.

## Non-goals

- No WebSocket subscription and no REST collection of facts (later changes).
- No writes from the entry, protection, close or recovery paths. Nothing in order execution calls the store.
- No change to the Runtime ↔ ABI HTTP contracts, the correlation JSONL, the mutex or the live guard.
- No read API for the Central Journal and no Central Journal change (later change).
- No Bybit account UID query, no distributed locks.
- No Node upgrade, no `bbb_stack` change. Turning the store on for the Mac demo is a separate step on the owner's word.

## Trading safety, idempotency, recovery

- Default off: dry-run, demo/testnet live execution and the mainnet guard are unchanged.
- When enabled and the database cannot be opened, belongs to another environment, or has a newer or foreign schema, startup fails with an explicit error (no silent degrade).
- Deduplication is enforced by the database (unique keys), so the same fact delivered twice (later: WebSocket then REST) is stored once, while any change of an order's state is kept.
- One ABI process per data directory is an operational contract enforced by deployment; SQLite locking on the macOS bind mount does not enforce it.
- A process kill mid-write leaves an intact database with only whole committed transactions (tested).

## Capabilities

### New Capabilities

- `exchange-facts-store`: ABI-internal SQLite store of Bybit exchange facts and orderId → trade cycle links, one database per Bybit environment.

### Modified Capabilities

- `abi-operational-observability`: `service_starting` reports the facts store; a failure to open it is an explicit error event.

## Impact

`package.json` / `package-lock.json` (`better-sqlite3` exact `12.9.0`, `@types/better-sqlite3`), new `src/exchangeFacts/*`, `src/config/config.ts`, `src/app/server.ts` (open when enabled, close on shutdown), `src/app/serviceStartingEvent.ts`, `.env.example`, `docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`, tests. Dockerfile unchanged unless the build proves a prebuilt binary is missing (then the change stops and reports, see design D2).
