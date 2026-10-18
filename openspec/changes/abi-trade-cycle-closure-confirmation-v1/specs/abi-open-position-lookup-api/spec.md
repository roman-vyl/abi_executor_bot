## MODIFIED Requirements

### Requirement: Successful response is a closed object with a mandatory cross-field invariant
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly:

- `position_open`: boolean;
- `first_fill_at_ms`: JSON integer or `null`;
- `average_entry_price`: exact-decimal JSON string or `null`;
- `closure`: JSON object or `null`.

When `position_open` is `true`, both `first_fill_at_ms` and `average_entry_price` SHALL be non-null and `closure` SHALL be `null`. When `position_open` is `false`, both facts SHALL be `null`; `closure` SHALL be `null` when this cycle's own entry never filled under the current binding, and SHALL be an object only when ABI has proven this cycle's completion (`open-position-resolution`). No other combination SHALL be returned.

Both facts reflect this specific trade cycle's own execution evidence, never an aggregate physical position shared with any other trade cycle (`open-position-resolution` capability): `first_fill_at_ms` is this cycle's own raw attributable first-fill timestamp — the earliest of this cycle's own entry order's own executions — never a value normalized to any strategy timeframe or bar boundary; `average_entry_price` is this cycle's own cumulative average execution price.

#### Scenario: Open position response includes both facts
- **WHEN** ABI determines the current position is open
- **THEN** ABI returns HTTP `200`
- **AND** `position_open` is `true`
- **AND** `first_fill_at_ms` and `average_entry_price` are both non-null
- **AND** `closure` is `null`

#### Scenario: Never-filled entry nulls both facts and closure
- **WHEN** this cycle's own entry order has no fill under the current binding
- **THEN** ABI returns HTTP `200` with `position_open: false`, both facts `null`, and `closure: null`

#### Scenario: Proven completion carries the closure
- **WHEN** ABI has proven this cycle's completion
- **THEN** ABI returns HTTP `200` with `position_open: false`, both facts `null`, and a non-null `closure`

#### Scenario: Response object is closed
- **WHEN** a success response is serialized
- **THEN** it contains exactly `position_open`, `first_fill_at_ms`, `average_entry_price`, and `closure`, with no additional fields

## ADDED Requirements

### Requirement: The closure object identifies the cycle, the reason, and the closing order
A non-null `closure` SHALL be a closed JSON object with exactly `strategy_instance_id`, `trade_cycle_id`, `reason`, `order_id`, `order_link_id`, and `parent_order_link_id`. `strategy_instance_id` and `trade_cycle_id` SHALL equal the request's path values. `reason` SHALL be one of `stop_loss`, `take_profit`, `runtime_signal`. `order_id` SHALL be the non-empty Bybit `orderId` of the order whose full execution proved completion. For `runtime_signal`, `order_link_id` SHALL be this cycle's own close `orderLinkId` and `parent_order_link_id` SHALL be `null`. For `stop_loss` and `take_profit`, `order_link_id` SHALL be `null` and `parent_order_link_id` SHALL be this cycle's own entry `orderLinkId`. Execution price and time SHALL NOT be part of the object.

#### Scenario: Stop-loss closure
- **WHEN** completion was proven by this cycle's own native stop
- **THEN** `reason` is `stop_loss`, `order_id` is that stop's `orderId`, `order_link_id` is `null`, and `parent_order_link_id` is the entry `orderLinkId`

#### Scenario: Runtime-signal closure
- **WHEN** completion was proven by this cycle's own close order
- **THEN** `reason` is `runtime_signal`, `order_link_id` and `order_id` identify that close order, and `parent_order_link_id` is `null`

### Requirement: A filled cycle without proven completion is an error, never a closed answer
When this cycle's own entry has a fill and ABI cannot prove completion, ABI SHALL return `internal_error` and SHALL NOT return `position_open: false`.

#### Scenario: Flat scope without proof
- **WHEN** the entry filled, the scope holds no position, and no own order proves completion
- **THEN** ABI returns `internal_error`
