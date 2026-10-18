## MODIFIED Requirements

### Requirement: Record status is classified into durably-closed, live-query-admissible, and unresolved buckets
ABI SHALL classify a found record's `status` into exactly one of three buckets before taking any further action:

- Durably closed (`absent`, `terminal_unfilled`, `terminal_closed`): no live exchange query is made; the response is `position_open: false` directly, with `closure` taken from the record as specified below.
- Live-query-admissible (`applied`, `pending_replace`, `pending_cancel`): resolution requires at least a fresh check of this cycle's own attributable fill facts, and (when they show a nonzero fill) own protection and the aggregate physical position.
- Unresolved (`pending_create`, `create_failed`, `unknown`): ABI fails closed without attempting a live query.

For a durably closed record, `closure` SHALL be the record's stored closure when present; for a `terminal_closed` record without a stored closure but with both `close_order_link_id` and `close_order_id`, a `runtime_signal` closure built from those two values; otherwise `null`.

#### Scenario: Absent record durably proves no exposure
- **WHEN** the record's status is `absent`
- **THEN** ABI returns `position_open: false` with both facts `null` and `closure: null`
- **AND** ABI does not query the exchange

#### Scenario: Terminal-without-fill durably proves no exposure
- **WHEN** the record's status is `terminal_unfilled`
- **THEN** ABI returns `position_open: false` with both facts `null` and `closure: null`
- **AND** ABI does not query the exchange

#### Scenario: Terminally-closed record answers from its stored closure
- **WHEN** the record's status is `terminal_closed` with a stored closure
- **THEN** ABI returns `position_open: false` with both facts `null` and that closure
- **AND** ABI does not query the exchange

#### Scenario: Legacy terminally-closed record closed by Runtime
- **WHEN** the record's status is `terminal_closed` without a stored closure but with `close_order_link_id` and `close_order_id`
- **THEN** `closure` is `runtime_signal` with those identifiers

#### Scenario: Applied status requires a live query
- **WHEN** the record's status is `applied`
- **THEN** ABI proceeds to the live Bybit query rather than inferring fill state from the status alone

#### Scenario: Pending replace requires a live query
- **WHEN** the record's status is `pending_replace`
- **THEN** ABI proceeds to the live Bybit query using the record's existing `exchange_category`/`exchange_symbol`

#### Scenario: Pending cancel requires a live query
- **WHEN** the record's status is `pending_cancel`
- **THEN** ABI proceeds to the live Bybit query rather than assuming the cancel has already taken effect

#### Scenario: Unresolved status fails closed without querying
- **WHEN** the record's status is `pending_create`, `create_failed`, or `unknown`
- **THEN** ABI does not query the exchange
- **AND** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

## ADDED Requirements

### Requirement: Completion of a filled cycle is proven only from this cycle's own orders
For a live-query-admissible record whose own entry order is terminal with cumulative filled quantity `Q > 0`, ABI SHALL prove completion only as follows, and SHALL NOT use the aggregate position as proof:

- `runtime_signal`: this cycle's own close order is classified as fully executed for exactly `Q`;
- `stop_loss` / `take_profit`: own protection resolves as an attributed pair by `parentOrderLinkId` equal to the entry `orderLinkId`; exactly one leg has `orderStatus` `Filled`, `leavesQty` `0` and `cumExecQty` equal to `Q`; the other leg is terminal without fill; and the `Trade` executions of the filled leg's `orderId` sum to exactly `Q`. The leg's role SHALL come from `stopOrderType`.

Both legs filled, any partial fill of a leg, a leg fill that differs from `Q`, an execution sum that differs from `Q`, or a protection fill together with an executed own close order SHALL be contradictory. Missing or lagging evidence SHALL be unproven. Contradictory or unproven evidence SHALL yield `internal_error` with no durable write.

#### Scenario: Stop child fully filled
- **WHEN** the entry filled `0.001`, the own stop child is `Filled` with `cumExecQty` `0.001` and `leavesQty` `0`, the take child is `Deactivated`, and the stop's `Trade` executions sum to `0.001`
- **THEN** completion is proven with reason `stop_loss`

#### Scenario: History not yet propagated
- **WHEN** the scope is flat but neither protection leg nor an own close order shows a fill yet
- **THEN** ABI returns `internal_error` and writes nothing

#### Scenario: Partial protection fill
- **WHEN** a protection leg is `PartiallyFilled` or filled for less than `Q`
- **THEN** ABI returns `internal_error` and writes nothing

#### Scenario: Sibling position does not hide an own exit
- **WHEN** a same-side sibling keeps a position in the scope and this cycle's own stop is proven fully filled
- **THEN** ABI returns the `stop_loss` closure, not `position_open: true`

### Requirement: A proven completion is recorded durably before it is reported
On a proven completion ABI SHALL, under the pair's mutex, write `status: "terminal_closed"` with the closure reason and identifiers on the correlation record, and release the physical scope as the existing terminal write does, before returning the closure. A failed write SHALL yield `internal_error`.

#### Scenario: Repeated lookup after proof
- **WHEN** completion was proven and recorded on an earlier lookup
- **THEN** a later lookup returns the same closure without any exchange call
