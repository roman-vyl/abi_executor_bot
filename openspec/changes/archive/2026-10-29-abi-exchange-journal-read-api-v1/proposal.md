## Why

Stage 5 of the ABI exchange facts journal. Stages 1 to 4 are merged and deployed on demo: ABI stores every private-stream record from Bybit (orders, executions, SL/TP triggers, cancels), fills gaps from REST, and links each order to its strategy instance and trade cycle. The store is ABI-internal: today the only way to look into it is a copy of the SQLite file on the Mac.

Stage 6 (Central Journal) and the front need a way to read the journal without touching the file. The store schema says so already: the read-only HTTP API is the only contract, the tables are not.

Owner decisions:
- 2026-10-29 12:17: plain-language plan of the stage: read all exchange events for a period, by coin or by strategy; the history of one order; all orders and fills of one trade cycle (entry, SL, TP, close together); the journal's health. Read only, no trading change.
- 2026-10-29 12:18 «Пиши спек».

What already exists:
- Store reads by sequence: `readFactsAfter`, `readLinksAfter` (`exchangeFactsStore.ts`).
- Indexes on `order_id`, `order_link_id`, `parent_order_link_id` and on `(strategy_instance_id, trade_cycle_id)` in `order_links`.
- `/health` objects `exchangeFactsStore`, `exchangeStream`, `exchangeLinker`, `exchangeRest`, `exchangeCompleteness`.

## What Changes

New read-only HTTP endpoints in ABI, all `GET`, JSON:

1. `GET /v1/exchange-journal/facts`: the exchange events feed, oldest first, by cursor (`after_seq`, `limit`), with optional filters `symbol`, `strategy_instance_id`, `from_ms`, `to_ms`. Each event carries its order's current strategy link, or `null`.
2. `GET /v1/exchange-journal/order-links`: the feed of strategy links, by cursor. A link can appear later than the order's events (the linker converges), so a consumer that follows the events feed also follows this one.
3. `GET /v1/exchange-journal/orders/{order_id}`: one order: its link and all its events, from placement to fill or cancel.
4. `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/exchange-journal`: one trade cycle: all linked orders (entry, close, stop loss, take profit) with their events.
5. `GET /v1/exchange-journal/status`: the journal's health in one object: store state, last sequence numbers, REST coverage start, completeness counts, linker waiting counts. The same values `/health` shows, so a consumer can check before reading.

OpenAPI document `docs/openapi/abi-exchange-journal-api-v1.json`, checked by `npm run validate:openapi`.

## Non-goals

- No writes, no deletes, no repair through the API.
- No account snapshots (positions, wallet) and no connection log in the API; can be added later if a consumer needs them.
- No Central Journal change (stage 6), no Runtime change, no `bbb_stack` change, no front change.
- No change to the store schema, the recorder, the linker or the reconciler.
- No authentication change: the API is served like the existing ABI routes, on the internal stack network.

## Trading safety

- Only `SELECT` on the store; every request is bounded (at most 1000 events per page, at most 1000 events per order, at most 200 orders per cycle), so one read stays short and cannot hold up trading requests.
- A read error returns an HTTP error to the caller only. It never changes store state, never stops the recorder, linker or reconciler, and never affects trading routes or `/health.ok`.
- With the store disabled or unavailable, the endpoints answer `503`; trading is unchanged.
