## Context

The exchange facts store (`exchange-facts-store`) holds `exchange_facts` (one row per distinct order state or execution, `event_seq` ascending), `order_links` (one row per linked order, `link_seq` ascending), and coverage and log tables. The linker writes a link once per order and never changes it. Facts are append-only. Both sequences only grow, so a cursor on them is stable.

Consumers:
- Central Journal (stage 6): follows the whole journal incrementally and never misses a row.
- The front and people: look at one order, one cycle, or a period of one coin or strategy.

## Goals / Non-Goals

Goal: a small, stable, read-only contract over the store that serves both incremental following and lookups, without exposing tables. Non-goals: see proposal.

## Decisions

### D1. One event shape for all endpoints

Every event (fact) is returned as:

```
{
  "event_seq": 1234,
  "fact_kind": "order_state" | "execution",
  "source": "ws" | "rest",
  "source_endpoint": "ws:order" | "ws:execution" | "rest:/v5/order/history" | "rest:/v5/execution/list" | ...,
  "symbol": "BTCUSDT",
  "order_id": "..." | null,
  "order_link_id": "..." | null,
  "parent_order_link_id": "..." | null,
  "exec_id": "..." | null,
  "exec_type": "Trade" | ... | null,
  "order_status": "Filled" | ... | null,
  "exchange_time_ms": 1790000000000 | null,
  "received_at_ms": 1790000000123,
  "raw": { ...the Bybit record exactly as stored... }
}
```

`raw` is the stored `raw_json` parsed, unchanged: prices and quantities stay the decimal strings Bybit sent. `dedup_key` is internal and not returned.

A link is returned as:

```
{
  "link_seq": 17,
  "order_id": "...",
  "strategy_instance_id": "...",
  "trade_cycle_id": "...",
  "role": "entry" | "close" | "stop_loss" | "take_profit",
  "generation": 1,
  "order_link_id": "..." | null,
  "parent_order_link_id": "..." | null,
  "evidence": "create_response" | "own_order_link_id_lookup" | "parent_order_link_id",
  "established_at_ms": 1790000000456
}
```

### D2. Feeds by cursor, not by offset

`/v1/exchange-journal/facts` and `/v1/exchange-journal/order-links` take `after_seq` (integer ≥ 0, default 0) and `limit` (1..1000, default 500) and return:

```
{ "items": [...], "next_after_seq": <last returned seq, or after_seq when empty>, "has_more": true | false }
```

Items are ordered by sequence ascending. `has_more` is `true` when at least one more matching row exists after `next_after_seq` (read `limit + 1` rows). A consumer stores `next_after_seq` and asks again; rows written later always get a larger sequence, so nothing is skipped and nothing is repeated.

### D3. Filters on the events feed

Optional, combined with AND:
- `symbol`: exact match.
- `strategy_instance_id`: events of orders whose link has this instance. Events of unlinked orders are not returned by this filter; they appear once the order is linked only if the consumer reads them again (by order or by cycle), because the feed never goes back. Without this filter, unlinked events are returned with `link: null`.
- `from_ms`, `to_ms`: `exchange_time_ms` in `[from_ms, to_ms)`. Events without exchange time are excluded when either bound is given. `from_ms < to_ms` when both are given.

Each event item in this feed has an extra field `link`: the order's link object (D1) at read time, or `null`.

### D4. Lookups

- `/v1/exchange-journal/orders/{order_id}` returns `{ "order_id", "link": <link or null>, "events": [...], "truncated": bool }`, events by `event_seq` ascending, at most 1000. Unknown `order_id` (no event and no link) → `404 order_not_found`.
- `/v1/strategy-instances/{sid}/trade-cycles/{cid}/exchange-journal` returns `{ "strategy_instance_id", "trade_cycle_id", "orders": [ { "link": {...}, "events": [...], "truncated": bool } ], "truncated": bool }`. Orders by `link_seq` ascending, at most 200; events per order at most 1000. A cycle with no linked order returns `200` with `orders: []`: the cycle may exist in Runtime with no exchange order yet. Path values are opaque, as in the other cycle routes (non-empty after percent-decoding, else `422`).

### D5. Status

`/v1/exchange-journal/status` returns:

```
{
  "store": "enabled" | "disabled" | "unavailable",
  "store_reason": "..." (only when unavailable),
  "schema_version": 3,
  "last_event_seq": <max event_seq or 0>,
  "last_link_seq": <max link_seq or 0>,
  "stream": <same object as /health.exchangeStream>,
  "linker": <same object as /health.exchangeLinker>,
  "rest": <same object as /health.exchangeRest>,
  "completeness": <same object as /health.exchangeCompleteness>
}
```

It answers `200` also when the store is disabled or unavailable (then the sequence fields are `null`), because its job is to say so.

### D6. Errors and safety

- Store `disabled` or `unavailable` → `503`, `error.code` `exchange_journal_unavailable` (all endpoints except status).
- Bad query value (not an integer, out of range, `from_ms >= to_ms`, empty value, unknown parameter) → `422 validation_failed`, `error.details` names the parameter.
- A store read throwing → `500 internal_error`, event `exchange_journal_read_failed {endpoint, errorCode}`; no secret or raw record in the event.
- Error body shape is the one of the existing v1 routes (`{ "error": { "code", "message", "details"? } }`).
- Reads use the store's existing connection (WAL; writers are not blocked by readers). Every query uses an existing index or the primary key and is bounded by `LIMIT`. No new index, no schema change.
- Only `GET` is matched; any other method on these paths is not handled by these routes.

## Risks / Trade-offs

- better-sqlite3 is synchronous: a read runs on the event loop. Bounds in D2 and D4 keep one read in the low milliseconds on the current size (hundreds of rows). If the journal grows to millions of rows the `strategy_instance_id` and time filters may need an index; that would be a separate change.
- `raw` returns everything Bybit sent for our own account. It contains no keys or signatures (the recorder never stores them), but it is account data: the API stays on the internal network, as all ABI routes.
