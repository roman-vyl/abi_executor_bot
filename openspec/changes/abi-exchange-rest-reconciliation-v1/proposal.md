## Why

Stage 4 of the ABI exchange facts journal. The private WS stream (stage 2) is fast but has holes:
- Bybit does not replay what it sent while the connection was down. On the Mac demo the stream dropped 4 times between 03:10 and 04:52 UTC on 2026-10-29, reconnecting after 2-6 s each time.
- Nothing is stored from before the journal started. On 2026-10-29 the stop loss of cycle f49b06d0 was recorded at 01:48 UTC, but its entry was placed before the journal existed. Its two children wait as `parent_not_found` and stay unlinked until the entry order is in the store.

Owner decisions:
- 2026-10-28 04:40, target integrity model: WS gives speed. REST gives completeness: a fetch after each reconnect plus a periodic sweep. The linker only links and does not care about the source. A completeness check gives visibility.
- 2026-10-29 06:37: discuss REST at a high level.
- 2026-10-29 07:51: at start read the whole REST history.
- 2026-10-29 07:55 «Давай»: load as proposed (about 210 requests once at the first start, a sweep every 10 minutes over the last hour, no REST in the first 30 s after a 5-minute bar close).

What already exists:
- `BybitAdapter.getOrderHistoryForSymbol` (startTime/endTime/cursor) and `getExecutionList`.
- Signed GETs with a 1.5 s timeout and one retry (`bybit-request-timeouts`).
- The store accepts `source: "rest"` facts. Dedup is built so that the same state from WS and from REST gives one key (`ORDER_STATE_FINGERPRINT_FIELDS`, `exec:<execId>`).
- The connection log records each `disconnected` and `subscribed` with its time.

## What Changes

- New ABI component, the exchange REST reconciler, in `src/exchangeFacts/`. It runs only when the store is `enabled` and API keys are present. It reads `/v5/order/history` and `/v5/execution/list` (category `linear`) and stores every record as a fact with `source` `rest`.
- Three triggers, one serial queue:
  1. **Startup backfill.** Every interval of the last 730 days (Bybit's history limit) not yet covered is fetched in 7-day windows. The first start reads all history. Later starts read only what is not covered yet.
  2. **After a reconnect.** The window from the `disconnected` time minus 2 minutes up to now.
  3. **Sweep.** Every 10 minutes, the last 60 minutes.
- Pace: one request at a time, at least 500 ms apart (≤ 2 req/s). No request in the first 30 s after a 5-minute bar boundary. Only reads, never order create, amend or cancel.
- Coverage is stored. New table `rest_sync_windows` (schema version 3) holds each completed window per endpoint. A failed window is not marked and is fetched again on the next pass.
- Linker change, small: an `order_state` fact from REST without any label does not make its order `no_label`. Bybit REST order history carries no `parentOrderLinkId` (stage 0), so such a fact must not block a later WS record from linking the child.
- Completeness check after every sweep, counts only, no automatic fix:
  - terminal orders whose stored `Trade` executions do not sum to `cumExecQty`;
  - stream gaps (from `disconnected` to the next `subscribed`) not inside a completed window of both endpoints;
  - durably closed trade cycles without any linked order with a `Trade` execution;
  - orders seen only by REST without a label.
- `/health` gets additive objects `exchangeRest` and `exchangeCompleteness`. `ok` and the HTTP status do not depend on them.

## Non-goals

- No REST for positions, wallet or closed PnL (the stream gives snapshots; not needed for trades).
- No read API (stage 5), no Central Journal (stage 6).
- No change to order execution, correlation writes, labels, Runtime ↔ ABI contract or `bbb_stack`.
- No repair of mismatches found by the completeness check; they are reported only.

## Trading safety

- The reconciler only reads Bybit history and writes facts and coverage rows. Every failure is caught inside it, emitted as an event and shown in `/health`. It never throws into the server and never stops the process.
- It never runs in parallel with itself and keeps far below Bybit's per-endpoint read limit (about 50 req/s). It stays quiet around bar closes, when Runtime's trading requests arrive.
- With the store disabled or unavailable, nothing starts; trading is unchanged.
