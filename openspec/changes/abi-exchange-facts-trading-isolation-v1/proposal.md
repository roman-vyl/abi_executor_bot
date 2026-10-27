## Why

The exchange facts store (`abi-exchange-facts-sqlite-foundation-v1`, merged as e3d598e, deployed disabled) is the base for recording Bybit's private WebSocket stream inside ABI. That recorder will live in the ABI process but outside order execution: Runtime → ABI requests never read or write the store.

Today the store can still stop trading:

1. When `ABI_EXCHANGE_FACTS_ENABLED=true` and the database cannot be opened or checked, ABI emits `exchange_facts_store_failed` and exits with code 1 before listening. A broken journal file takes the whole execution service down.
2. `better-sqlite3` is a native module imported statically through `src/app/exchangeFactsStartup.ts` → `src/exchangeFacts/exchangeFactsStore.ts`. If its binary fails to load on some image or architecture, ABI fails at module load, even with the store disabled.

Owner decision 2026-10-27 (stage 1 of the exchange facts journal): the journal must never break Runtime ↔ ABI trading. When the journal is unavailable, ABI keeps trading and says the journal is unavailable.

## What Changes

- An enabled store that cannot open or check no longer stops startup. ABI emits `exchange_facts_store_failed` (level `error`, same closed `reason` values), continues startup without a store, and listens as usual.
- `better-sqlite3` is loaded only when the store is enabled, at store opening. A load failure is handled as an open failure with the new reason `exchange_facts_driver_unavailable`. With the store disabled the native module is never loaded.
- ABI reports the store state in three values: `disabled`, `enabled`, `unavailable`. `service_starting.exchangeFactsStore` is computed after the open attempt; `GET /health` gets an additive field `exchangeFactsStore` (plus `exchangeFactsStoreReason` when `unavailable`). The store state never changes `/health` `ok` or its HTTP status.
- Shutdown is unchanged: closing the store already runs inside a try/catch in `installShutdownHandlers` and only changes the exit code after the HTTP server has closed.

## Non-goals

- No WebSocket subscription, no writes of facts or links, no REST recovery, no read API (later stages).
- No change to the storage schema, dedup rules, store file location or env variable names.
- No retry of opening the store while ABI runs; a restart is the only way to recover an `unavailable` store.
- No change to Runtime, to the Runtime ↔ ABI contract, to `bbb_stack`, or to any trading path.

## Trading safety, idempotency, recovery

- Trading paths do not use the store, so a missing store changes nothing in entry, protection, close, open-position or recovery behaviour. This change only removes the two ways the store could stop the process.
- Correlation store, mutex, live guard, dry-run, demo/testnet execution and the mainnet guard are untouched.
- Trade-off accepted by the owner: ABI may now run without its journal. The gap is visible (`exchange_facts_store_failed` at startup and `exchangeFactsStore: "unavailable"` in `/health`) instead of silent.
- Production keeps `ABI_EXCHANGE_FACTS_ENABLED` unset (disabled); this change has no effect there except that the native module is no longer loaded.

## Archive order

The MODIFIED requirement lives in the not yet archived `abi-exchange-facts-sqlite-foundation-v1`. Archive the foundation change first, then this one.
