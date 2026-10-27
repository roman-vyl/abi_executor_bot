## Context

`startServer` calls `openExchangeFactsStoreOrExit(config)` before anything listens (src/app/server.ts:33). The result is used only by the shutdown handler. `ExchangeFactsStore.open` throws `ExchangeFactsOpenError` with a closed reason; the startup wrapper turns it into exit 1. The static `import Database from "better-sqlite3"` at the top of `exchangeFactsStore.ts` loads the native addon whenever `server.ts` is loaded.

## Decisions

### D1. Open failure degrades, never exits
`openExchangeFactsStoreOrExit` becomes `openExchangeFactsStore` returning a result: `{ state: "disabled" }`, `{ state: "enabled", store }` or `{ state: "unavailable", reason }`. On failure it emits `exchange_facts_store_failed` exactly as today and returns `unavailable`. It never calls `process.exit`. A partially opened handle is already closed by `ExchangeFactsStore.open` before it throws.

### D2. Native driver loaded lazily
`exchangeFactsStore.ts` no longer imports `better-sqlite3` at module level. `ExchangeFactsStore.open` loads it with `createRequire(import.meta.url)("better-sqlite3")` (synchronous, so startup order stays the same). A throw while loading becomes `ExchangeFactsOpenError("exchange_facts_driver_unavailable")`. Type-only imports stay for typing. With the store disabled `open` is never called, so the addon is never loaded.

### D3. One store state, reported in two places
The state from D1 is computed once at startup and passed to `serviceStartingFields` and `handleSystemRoutes`. `/health` adds `exchangeFactsStore` and, for `unavailable`, `exchangeFactsStoreReason`. `ok` and the HTTP status keep depending only on `entryPackageReady`, so Docker health checks and Runtime see no change in status. The field is additive JSON.

### D4. Shutdown untouched
`installShutdownHandlers` already wraps `onServerClosed` in try/catch, emits `shutdown_failed` and exits after the HTTP server closed. No change; `onServerClosed` closes the store only when the state is `enabled`.

## Risks

- A consumer that decodes ABI `/health` with an exact field list would reject the new field. Task 1.1 checks Runtime and `bbb_stack` before code; if such a consumer exists, the `/health` part is dropped and the state is reported only in events.
- Running without the journal for a long time loses facts. Accepted: the later REST recovery stage fills gaps; the failure is visible at startup and in `/health`.
