## MODIFIED Requirements

### Requirement: Successful response is a closed object with a mandatory cross-field invariant
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly:

- `position_open`: boolean;
- `first_fill_at_ms`: JSON integer or `null`;
- `average_entry_price`: exact-decimal JSON string or `null`;
- `closure`: JSON object or `null`;
- `entry_order_link_id`: non-empty JSON string or `null`;
- `entry_order_id`: non-empty JSON string or `null`.

When `position_open` is `true`, both `first_fill_at_ms` and `average_entry_price` SHALL be non-null, `closure` SHALL be `null`, `entry_order_link_id` SHALL be non-null, and `entry_order_id` SHALL be a string or `null`. When `position_open` is `false`, both facts and both entry order identifiers SHALL be `null`; `closure` SHALL be `null` when this cycle's own entry never filled under the current binding, and SHALL be an object only when ABI has proven this cycle's completion (`open-position-resolution`). No other combination SHALL be returned.

Both facts reflect this specific trade cycle's own execution evidence, never an aggregate physical position shared with any other trade cycle (`open-position-resolution` capability): `first_fill_at_ms` is this cycle's own raw attributable first-fill timestamp — the earliest of this cycle's own entry order's own executions — never a value normalized to any strategy timeframe or bar boundary; `average_entry_price` is this cycle's own cumulative average execution price.

#### Scenario: Open position response includes both facts
- **WHEN** ABI determines the current position is open
- **THEN** ABI returns HTTP `200`
- **AND** `position_open` is `true`
- **AND** `first_fill_at_ms` and `average_entry_price` are both non-null
- **AND** `closure` is `null`
- **AND** `entry_order_link_id` is non-null

#### Scenario: Closed position response nulls both facts
- **WHEN** ABI determines the current position is closed or was never opened under the current binding
- **THEN** ABI returns HTTP `200`
- **AND** `position_open` is `false`
- **AND** `first_fill_at_ms` and `average_entry_price` are both `null`
- **AND** `entry_order_link_id` and `entry_order_id` are both `null`

#### Scenario: Never-filled entry nulls both facts and closure
- **WHEN** this cycle's own entry order has no fill under the current binding
- **THEN** ABI returns HTTP `200` with `position_open: false`, both facts `null`, `closure: null`, and both entry order identifiers `null`

#### Scenario: Proven completion carries the closure
- **WHEN** ABI has proven this cycle's completion
- **THEN** ABI returns HTTP `200` with `position_open: false`, both facts `null`, a non-null `closure`, and both entry order identifiers `null`

#### Scenario: Response object is closed
- **WHEN** a success response is serialized
- **THEN** it contains exactly `position_open`, `first_fill_at_ms`, `average_entry_price`, `closure`, `entry_order_link_id`, and `entry_order_id`, with no additional fields

## ADDED Requirements

### Requirement: An open response identifies the entry order whose fill ABI proved
When `position_open` is `true`, `entry_order_link_id` SHALL be the `orderLinkId` by which ABI queried this cycle's own entry order and its executions to prove this fill, and `entry_order_id` SHALL be the Bybit `orderId` from the order row matched by that `orderLinkId` as part of the same proof, or `null` when that row carried no `orderId` (`open-position-resolution`). ABI SHALL NOT fill either identifier from any other source, SHALL NOT issue an additional exchange request to obtain them, and the presence or absence of `entry_order_id` SHALL NOT change any other field of the response.

#### Scenario: Open response names the proven order
- **WHEN** ABI returns `position_open: true` from a fresh read of this cycle's own entry order
- **THEN** `entry_order_link_id` equals that read's `orderLinkId` and `entry_order_id` equals that row's `orderId`

#### Scenario: Bybit row without an order id
- **WHEN** the proving row has no usable `orderId`
- **THEN** `entry_order_id` is `null`
- **AND** `position_open`, `first_fill_at_ms` and `average_entry_price` are the same as they would be without the identifiers
