## ADDED Requirements

### Requirement: ABI exposes a read-only exchange journal API
ABI SHALL expose these endpoints, each answering only `GET` with `application/json; charset=utf-8` for success and error responses:

- `GET /v1/exchange-journal/facts`
- `GET /v1/exchange-journal/order-links`
- `GET /v1/exchange-journal/orders/{order_id}`
- `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/exchange-journal`
- `GET /v1/exchange-journal/status`

The endpoints SHALL only read the exchange facts store. They SHALL NOT write, update or delete any store row, call Bybit, or change any trading state. A request body SHALL be ignored.

#### Scenario: Read does not change the store
- **WHEN** a client calls any of the endpoints
- **THEN** the number of rows in every store table is the same before and after the call

#### Scenario: Other methods are not matched
- **WHEN** a client sends `POST`, `PUT` or `DELETE` to one of these paths
- **THEN** these routes do not handle the request

### Requirement: Events and links have one closed shape
Every event SHALL be returned with exactly the fields `event_seq`, `fact_kind`, `source`, `source_endpoint`, `symbol`, `order_id`, `order_link_id`, `parent_order_link_id`, `exec_id`, `exec_type`, `order_status`, `exchange_time_ms`, `received_at_ms`, `raw`, plus `link` where this spec says so. `raw` SHALL be the stored Bybit record parsed from JSON, unchanged, with decimal values as the strings Bybit sent. The internal dedup key SHALL NOT be returned.

Every link SHALL be returned with exactly the fields `link_seq`, `order_id`, `strategy_instance_id`, `trade_cycle_id`, `role`, `generation`, `order_link_id`, `parent_order_link_id`, `evidence`, `established_at_ms`.

#### Scenario: Raw record is returned unchanged
- **WHEN** a stored execution has `execQty` `"0.010"` in its raw record
- **THEN** the event's `raw.execQty` is the string `"0.010"`

### Requirement: Feeds are read by cursor
`/v1/exchange-journal/facts` and `/v1/exchange-journal/order-links` SHALL accept `after_seq` (integer ≥ 0, default `0`) and `limit` (integer 1..1000, default `500`). They SHALL return `items` ordered by sequence ascending with every sequence greater than `after_seq`, at most `limit` items, `next_after_seq` equal to the last returned sequence or to `after_seq` when `items` is empty, and `has_more` `true` exactly when at least one more matching row exists after `next_after_seq`.

#### Scenario: Following the feed misses nothing
- **WHEN** a client reads the events feed page by page, passing each `next_after_seq` as the next `after_seq`, while new events are being written
- **THEN** every stored event is returned exactly once

#### Scenario: Empty page
- **WHEN** no event has a sequence greater than `after_seq`
- **THEN** ABI returns `200` with `items: []`, `next_after_seq` equal to `after_seq` and `has_more: false`

### Requirement: The events feed can be filtered
The events feed SHALL accept optional `symbol`, `strategy_instance_id`, `from_ms` and `to_ms`, combined with AND. `symbol` SHALL match exactly. `strategy_instance_id` SHALL return only events of orders whose link has that instance. `from_ms` and `to_ms` SHALL select events with `exchange_time_ms` in `[from_ms, to_ms)` and exclude events without exchange time. Each event in this feed SHALL carry `link`: the order's link at read time, or `null`.

#### Scenario: Strategy filter
- **WHEN** a client asks for `strategy_instance_id=S`
- **THEN** every returned event belongs to an order linked to instance `S`
- **AND** each event's `link.strategy_instance_id` is `S`

#### Scenario: Unlinked event without filter
- **WHEN** an event's order has no link and no strategy filter is given
- **THEN** the event is returned with `link: null`

#### Scenario: Period filter
- **WHEN** a client asks for `from_ms=A&to_ms=B`
- **THEN** every returned event has `A <= exchange_time_ms < B`

### Requirement: One order can be read with all its events
`/v1/exchange-journal/orders/{order_id}` SHALL return `order_id`, `link` (or `null`), `events` (all events with this `order_id`, by `event_seq` ascending, at most 1000) and `truncated` (`true` when more than 1000 exist). An `order_id` with no event and no link SHALL return `404` with `error.code` `order_not_found`.

#### Scenario: Order from placement to fill
- **WHEN** an order has a `New` state, a `Filled` state and two `Trade` executions in the store
- **THEN** all four are returned in `event_seq` order with the order's link

### Requirement: One trade cycle can be read with all its orders
`/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/exchange-journal` SHALL return `strategy_instance_id`, `trade_cycle_id`, `orders` and `truncated`. `orders` SHALL hold every order linked to this instance and cycle, by `link_seq` ascending, at most 200, each as `{ link, events, truncated }` with at most 1000 events. A cycle with no linked order SHALL return `200` with `orders: []`. Path values SHALL be opaque non-empty strings after percent-decoding; an empty or undecodable value SHALL return `422 validation_failed`.

#### Scenario: Cycle with entry, stop loss, take profit and close
- **WHEN** a cycle has linked entry, stop loss, take profit and close orders
- **THEN** all four orders are returned, each with its role and its events

#### Scenario: Cycle not in the journal
- **WHEN** no order is linked to the requested pair
- **THEN** ABI returns `200` with `orders: []`

### Requirement: The journal reports its own state
`/v1/exchange-journal/status` SHALL return `200` with `store` (`enabled`, `disabled` or `unavailable`), `store_reason` only when unavailable, `schema_version`, `last_event_seq` and `last_link_seq` (`null` unless the store is enabled), and `stream`, `linker`, `rest`, `completeness` equal to `/health` `exchangeStream`, `exchangeLinker`, `exchangeRest`, `exchangeCompleteness`.

#### Scenario: Store disabled
- **WHEN** the store is disabled
- **THEN** status returns `200` with `store: "disabled"` and `last_event_seq: null`

### Requirement: Errors are explicit and never affect trading
When the store is not `enabled`, every endpoint except status SHALL return `503` with `error.code` `exchange_journal_unavailable`. A query parameter that is unknown, empty, not an integer where one is required, out of range, or `from_ms >= to_ms` SHALL return `422` with `error.code` `validation_failed` and `error.details` naming the parameter. A store read that throws SHALL return `500` with `error.code` `internal_error` and emit `exchange_journal_read_failed` with `endpoint` and `errorCode` only. A read failure SHALL NOT change the store, the recorder, the linker, the reconciler, the trading routes or `/health.ok`.

#### Scenario: Bad limit
- **WHEN** a client sends `limit=5000`
- **THEN** ABI returns `422` with `error.code` `validation_failed` naming `limit`

#### Scenario: Store failure during read
- **WHEN** a store query throws during a journal read
- **THEN** that request gets `500 internal_error`
- **AND** the next entry-package request is handled as usual
