## Why

Runtime waits at most 5 s for ABI `GET .../open-position`; one open-position lookup makes 4–7 Bybit read requests in a row, each with a 10 s timeout. ABI timing diagnostics (`ABI_DIAGNOSTICS_PATH`, 2026-10-26 18:05 – 2026-10-27 05:20 UTC, 677 lookups, 3 156 Bybit requests, report `/mnt/project-files/abi_runtime_timeout/diag_20261027/REPORT.md`) show:

- A normal Bybit Demo read answers in 0.23 s (p99 of successful reads 1.3 s, max 5.0 s).
- 77 reads (2.4%) never answered and were aborted at exactly 10 s. The same read issued right after in the same lookup answered in 0.2–0.4 s.
- 64 lookups (9.5%) took longer than 5 s, and Runtime skipped 65 bars because of ABI timeouts or 500s in that window.
- All 10 `internal_error` answers came from such hung reads (7: both entry-order reads hung → `entry confirmation ambiguous`; 3: position query hung → `transport_error`).

A hung read is a stuck request, not a slow exchange. Cutting it early and asking again recovers almost all of them. Replayed on the same data: read timeout 1.5 s with one retry → lookups over 5 s drop from 64 to 13.

Owner decision 2026-10-27 10:19: change ABI only, Runtime untouched; GET timeout 1.5 s; on timeout one immediate retry with the same timeout; if the retry fails, the error goes through the existing path; POST, trading logic and state handling unchanged; no queues, durable memory, time budgets or new mechanisms. Runtime keeps 5 s, so a lookup with several hung reads may still time out in Runtime; accepted.

## What Changes

- Every Bybit GET request made by `RestBybitAdapter` (signed reads such as `/v5/order/realtime`, `/v5/order/history`, `/v5/position/list`, `/v5/execution/list`, wallet/account reads, and public reads `/v5/market/time`, `/v5/market/instruments-info`, `/v5/market/price-limit`) uses a read timeout `ABI_BYBIT_READ_TIMEOUT_MS`, default `1500`.
- When such a GET ends with a timeout, the adapter repeats it once immediately with the same timeout (a signed GET is signed again with a fresh timestamp). Any other error is not retried. If the repeat also fails, its error propagates exactly as a failed read does today.
- POST requests (order create, cancel, amend, cancel-all) keep `ABI_BYBIT_REQUEST_TIMEOUT_MS` (default `10000`) and are never retried.
- README lists the new variable.

## Non-goals

- No change to Runtime, to `bbb_stack` timeouts, or to any Runtime ↔ ABI HTTP contract, status code or error code.
- No retry of POST requests and no retry of non-timeout failures (HTTP 403, retCode errors, TLS/network errors).
- No overall time budget per operation, no queue, no durable state, no change to the correlation store, mutex, live guard or service logic.
- No change to the diagnostics file format (each attempt is already recorded as its own Bybit request).

## Trading safety, idempotency, recovery

- Only read-only GET requests are repeated; a repeated read has no exchange side effect. Order writes are untouched, so no duplicate orders are possible from this change.
- Dry-run, demo/testnet live execution and the mainnet guard are unchanged.
- A read that fails twice reaches the callers through the same error path as today, so every existing fail-closed rule (for example an exchange timeout never reported as `position_open: false`) still holds.
- Worst case for one read grows from 10 s to 2 × 1.5 s = 3 s; reads that genuinely need more than 1.5 s now fail instead of succeeding late. In the measured window successful reads above 1.5 s were 26 of 3 060 (0.8%) and the slowest successful read was 5.0 s.
