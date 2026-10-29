## 1. abi_executor_bot

- [x] 1.1 Dependency `undici` pinned to the version bundled with the image's Node 20 (`process.versions.undici`); lockfile.
- [x] 1.2 Config `ABI_BYBIT_KEEPALIVE_TIMEOUT_MS` (positive integer, default `200000`) and `ABI_BYBIT_HEARTBEAT_INTERVAL_MS` (non-negative integer, default `60000`, `0` = off); invalid values fail startup; test fixture; README rows.
- [x] 1.3 `RestBybitAdapter`: one `undici.Agent` (`keepAliveTimeout` = `keepAliveMaxTimeout` = config) passed as `dispatcher` to every GET and POST `fetch`; `close()`; connection counters via `diagnostics_channel` filtered to the adapter's origin.
- [x] 1.4 `readWithRetry`: second attempt also on `cause.code` `UND_ERR_SOCKET` / `ECONNRESET` / `EPIPE`; still at most two attempts; retry reason counted. `signedPost` unchanged.
- [x] 1.5 `BybitConnectionHeartbeat`: immediate tick, interval with `unref`, no overlap, failures emitted and swallowed, `stop()`, counters; created and started in `startServer`; stopped and pool closed in `onServerClosed`.
- [x] 1.6 `bybit_heartbeat_failed` and 10-minute `bybit_connection_summary` events; `/health` `bybitConnection` block outside readiness.
- [x] 1.7 Tests:
  - every GET and POST carries the same dispatcher;
  - GET retried once on `UND_ERR_SOCKET` / `ECONNRESET` / `EPIPE`; not retried on `ENOTFOUND`, `ECONNREFUSED`, a plain `fetch failed`, HTTP 403 or a `retCode` error; timeout then connection break = two attempts and the second error is thrown;
  - POST failing with a connection break or a timeout is sent exactly once;
  - real local HTTP server: two requests within the idle limit use one connection; after the server closes the idle socket the next request succeeds on a new connection; a server that drops the reused socket on receipt → GET succeeds on the retry, POST fails once;
  - heartbeat: first tick at start, then on the interval, no overlap, failure emits a warning and the next tick runs, `0` = never started, `stop()` ends ticks;
  - shutdown stops the heartbeat and closes the pool (`stop()` tested; the `onServerClosed` wiring in `startServer` checked by review);
  - config defaults, overrides, invalid values.
- [x] 1.8 `npm test`, `npm run typecheck`, `openspec validate --all --strict`.

## 2. Rollout (on owner's word only)

- [ ] 2.1 PR, review, merge on the owner's word.
- [ ] 2.2 `bbb_stack` pin and ABI-only deploy on the owner's word (defaults need no new env).
- [ ] 2.3 After some hours on demo: `bybit_connection_summary` (new connections, heartbeat failures, retries) and share of GETs cut at 1.5 s vs the 2026-10-29 baseline (9 of 199).
