## Context

Stages 1-3 are merged and deployed on the Mac demo: the store (`exchange-facts-store`), the WS recorder (`exchange-stream-recorder`) and the linker (`exchange-order-linker`). Stage 0 facts (Demo, 2026-10-27): `parentOrderLinkId` is present only on WS order records; REST execType `Funding` exists, WS does not push it.

## D1. Endpoints and requests

- `/v5/order/history` and `/v5/execution/list`, `category=linear`, `startTime`/`endTime` window of at most 7 days, `limit` 50 / 100, `nextPageCursor` until empty.
- Without `symbol`; order history is scoped by `settleCoin` (the configured settle coin), which Bybit accepts for `linear` on every account type. If Bybit still refuses a request without symbol (`retCode 10001`), the reconciler switches that endpoint to per-symbol requests for the rest of the run: every symbol in correlation records plus every symbol already in the store (event `exchange_rest_symbol_required`). Demo (2026-10-29): requests without symbol are accepted.
- New adapter methods `getOrderHistoryWindow` and `getExecutionWindow` reuse `signedGet`, so the existing GET timeout and retry apply. No new HTTP client.
- REST order history returns the latest state of each order only. Intermediate states during a gap are not recoverable; executions are complete.

## D2. Coverage

- Schema version 3 adds `rest_sync_windows(window_seq, endpoint, start_ms, end_ms, completed_at_ms, records, new_records)`.
- A window row is written in the same transaction as its last page of facts. A window that failed half way keeps its stored facts (dedup makes a refetch harmless) and has no row.
- Covered time = union of rows per endpoint. Backfill fills `[now − 30 d, now]` minus the union, newest window first, so recent cycles link early.

## D3. Triggers and queue

- One queue, one worker, FIFO with merge of overlapping windows.
- Startup: enqueue the backfill once the store is open and correlation is replayed.
- Reconnect: the reconciler reads new rows of `stream_connection_log` from the store every second (no call from the recorder); for each `subscribed` after a `disconnected` it enqueues `[disconnected_at − 120 s, now]`.
- Sweep: timer every 600 s, window `[now − 3600 s, now]`.
- Pace: 500 ms minimum between requests; before each request, if the time within the 5-minute UTC boundary is < 30 s, wait until 30 s.
- A failed request: event `exchange_rest_request_failed {endpoint, errorCode}` (only when the code changes), backoff 5 s, 30 s, 60 s, then 60 s, window stays in the queue. No deadline.

## D4. Writing facts

- Each record → `FactInput {kind, source: "rest", sourceEndpoint: "rest:/v5/order/history" | "rest:/v5/execution/list", rawJson, receivedAtMs}` through `writeFacts`. Duplicates of WS records are counted as duplicates.
- `exec_type` `Funding` and other non-trade executions are stored like on WS; the linker leaves them unlinked.

## D5. Linker rule for REST records

- The linker classifies an order from its first fact that decides it. An `order_state` fact with `source` `rest`, empty `orderLinkId` and empty `parentOrderLinkId` does not decide: the order stays unclassified until a deciding fact arrives. Such orders are counted in `exchangeCompleteness.unlabeledRestOrders`, not as `no_label`.
- REST facts with an ABI label link as usual (own entry/close). This is how the entry of a cycle that began before the journal gets linked, and its waiting children follow in the next tick.

## D6. Completeness check

Runs when the queue drains after the backfill or a sweep, on the store only, in a bounded read. `coveredFromMs` is the start of the coverage that reaches the latest completed window, on both endpoints:
- `execMismatchOrders`: orders created since `coveredFromMs` whose latest stored state is terminal (`Filled`, `Cancelled`, `PartiallyFilledCanceled`, `Deactivated`, `Rejected`) and whose stored `Trade` executions do not sum to that state's `cumExecQty`.
- `uncoveredGaps`: stream gaps from the connection log not inside completed windows of both endpoints.
- `closedCyclesWithoutCloseFill`: correlation records `terminal_closed` with `first_fill_at_ms` since `coveredFromMs` (a cycle that never filled needs no close) whose cycle has no linked `close` / `stop_loss` / `take_profit` order with a `Trade` execution.
- `unlabeledRestOrders` (D5).
Each count with up to 20 ids in the event `exchange_completeness_checked`; no secrets, no payloads.

## D7. Health

- `exchangeRest`: `{state: disabled|backfilling|idle|fetching|stopped, reason?, coveredFromMs?, backfillDone, queueWindows, requests, recordsFetched, recordsNew, lastSweepAtMs?, lastError?}`.
- `exchangeCompleteness`: `{checkedAtMs?, execMismatchOrders, uncoveredGaps, closedCyclesWithoutCloseFill, unlabeledRestOrders}`.

## D8. Fixed numbers

History 30 days (owner 2026-10-29 10:04), window 7 days, sweep 600 s over 3600 s, reconnect margin 120 s, pace 500 ms, quiet 30 s after each 5-minute boundary. Constants in code, not config: the owner tunes them through a change, not a file.

## Risks

- Older trades (more than 30 days before the first start) stay outside the journal; their late children wait as `parent_not_found`. First start costs about 10 requests (5 windows per endpoint).
- If Bybit needs `symbol` (D1), backfill costs about 10 × symbols requests at 2 req/s; with 10 symbols under a minute once.

## D9. Place in the architecture

- Inside ABI, module `src/exchangeFacts/`, next to the recorder and the linker. ABI is the only service with Bybit keys and the only owner of the facts database (one process per data directory), so REST reading cannot live in Runtime, Journal or a separate service.
- Three independent loops started by `startServer` after the store is open and correlation is replayed: recorder (WS → store), linker (store → links), reconciler (REST → store, then completeness check). None calls another; they meet only in the store. The reconciler learns about reconnects from `stream_connection_log`, not from the recorder.
- Shared with trading only: the Bybit adapter's signed GET and the account's rate limits. Trading never calls the reconciler and never waits for it.
