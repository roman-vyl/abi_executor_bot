## Why

The owner wants ABI to keep a detailed journal of what happens on Bybit: every order state, every fill (price, quantity, fee, time, `execId`), every cancel, so that any fact can be pulled later by `orderLinkId` / `orderId`. Today ABI keeps none of it: the execution decoder reads only `execTime` and `execQty`, child SL/TP `orderId`s live only in memory, and the correlation JSONL holds one state snapshot per trade cycle (audit 2026-10-25, `/mnt/project-files/abi-facts-journal/`).

Decisions taken by the owner on 2026-10-25 (17:24, 17:49):

- ABI alone writes exchange facts into its own SQLite; the Central Journal later reads them only through a read-only ABI API (option C). Shared reading of one SQLite file across containers is rejected: on Docker Desktop for macOS a bind mount has no working `fcntl` locks and readers saw malformed and torn snapshots (option A). A Docker named volume (option B) stays a reserve.
- The file lives physically in `BBB_data/abi` (the folder ABI already mounts as `/app/var`), like the MDS database.
- Driver `better-sqlite3` pinned exactly to `12.9.0` with the lockfile; Node stays 20. Installing the driver must not touch order execution.
- Two tables: exchange facts (raw Bybit JSON, type, times, identifiers) and links (proven order → trade cycle relations). `orderLinkId` is not a unique key (ABI reuses it on retry within a generation); fills are keyed by `execId`, orders by `orderId`. A fact whose cycle is unknown is stored without attribution. Aggregated positions are never used for attribution.
- The read cursor is a monotonic internal `event_seq`, not a Bybit time, so a fill found late by REST is still read after the last seen number.
- Verified on demo (trade 6072511f): `order/history` rows carry `parentOrderLinkId` = entry `orderLinkId` for the Partial SL/TP children, whose own `orderLinkId` is empty; `execution/list` rows carry only `orderId`.

This change is step 1 of several: **SQLite Foundation** only.

## What Changes

- New module `src/exchangeFacts/` with a store over `better-sqlite3@12.9.0`: opens or creates the database, applies the versioned schema, writes facts and links in transactions with deduplication, and reads facts after a given `event_seq` (internal function for tests and the later API).
- Schema v1, published contract: `exchange_facts_v1`, `order_links_v1`, plus `schema_meta`.
- New config `ABI_EXCHANGE_FACTS_ENABLED` (default `false`) and `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts.sqlite3`). When enabled, the service opens the store at startup and reports it in `service_starting`; when disabled nothing is opened and the service behaves exactly as today.
- Exact dependency pin and lockfile; Docker image builds without a compiler.

## Non-goals

- No WebSocket subscription and no REST collection of facts (later changes).
- No writes from the entry, protection, close or recovery paths. Nothing in order execution calls the store.
- No change to the Runtime ↔ ABI HTTP contracts, the correlation JSONL, the mutex or the live guard.
- No read API for the Central Journal and no Central Journal change (later change).
- No Node upgrade, no `bbb_stack` change. Turning the store on for the Mac demo is a separate step on the owner's word.

## Trading safety, idempotency, recovery

- Default off: dry-run, demo/testnet live execution and the mainnet guard are unchanged.
- When enabled and the database cannot be opened, migrated or is from a newer schema, startup fails with an explicit error (no silent degrade). The owner decides when to enable it.
- Deduplication is enforced by the database (unique keys), so the same fact delivered twice (later: WebSocket then REST) is stored once.
- Single writer: only the ABI process opens the file, in exclusive locking mode, because file locks on the macOS bind mount do not protect against a second process.

## Capabilities

### New Capabilities

- `exchange-facts-store`: local SQLite store of Bybit exchange facts and order→cycle links, schema contract v1.

### Modified Capabilities

- `abi-operational-observability`: `service_starting` reports the facts store state (only the delta needed; see spec).

## Impact

`package.json` / `package-lock.json` (`better-sqlite3` exact `12.9.0`, `@types/better-sqlite3`), new `src/exchangeFacts/*`, `src/config/config.ts`, `src/app/server.ts` (open when enabled, close on shutdown), `src/app/serviceStartingEvent.ts`, `.env.example`, `docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`, tests. Dockerfile unchanged unless the build proves a prebuilt binary is missing (then the change stops and reports, see design D2).
