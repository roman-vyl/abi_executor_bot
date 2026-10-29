## 0. Demo facts

- [ ] 0.1 On Bybit Demo (Mac, read-only GET): does `/v5/order/history` and `/v5/execution/list` with `category=linear` and no `symbol` answer? How far back does history go? Does REST order history of a Partial SL/TP child carry `parentOrderLinkId`? Record in design D1.

## 1. Store

- [ ] 1.1 Schema version 3: `rest_sync_windows`, migration from v1 and v2 in one transaction.
- [ ] 1.2 Write a window's last page and its coverage row in one transaction; read coverage per endpoint.

## 2. Reconciler

- [ ] 2.1 Adapter: `getOrderHistoryWindow`, `getExecutionWindow` on `signedGet` (D1).
- [ ] 2.2 Queue, merge, pace 500 ms, quiet 30 s after 5-minute boundaries, backoff without deadline (D3).
- [ ] 2.3 Triggers: startup backfill newest first, reconnect window from the connection log, 600 s sweep (D3).
- [ ] 2.4 Facts with `source` `rest` (D4); counters.
- [ ] 2.5 Wire in `startServer`: create only with store `enabled` and keys; start after the correlation replay; stop before the store closes.

## 3. Linker and completeness

- [ ] 3.1 Linker: unlabeled REST `order_state` does not decide an order (D5).
- [ ] 3.2 Completeness check after each sweep (D6), event `exchange_completeness_checked`.
- [ ] 3.3 `/health.exchangeRest` and `/health.exchangeCompleteness` (D7).

## 4. Tests

- [ ] 4.1 Fake Bybit REST: backfill windows, pagination, coverage rows, restart fetches only uncovered.
- [ ] 4.2 Entry before journal: REST entry links, waiting WS children link next tick.
- [ ] 4.3 WS/REST duplicates (order state and execution) give one row.
- [ ] 4.4 Reconnect window, sweep, merge, quiet period, pacing (fake clock).
- [ ] 4.5 Failure half way: stored pages kept, no coverage row, retried; health and events; trading route tests green.
- [ ] 4.6 Completeness counts on prepared stores (each of the four).
- [ ] 4.7 `npm run typecheck`, `npm test`, `npm run validate:openapi`, `openspec validate --all --strict`.

## 5. Docs and rollout

- [ ] 5.1 RUNBOOK: what REST fetches and when, load, coverage, how to read `exchangeRest` and `exchangeCompleteness`.
- [ ] 5.2 PR, merge and deploy only on the owner's word.
