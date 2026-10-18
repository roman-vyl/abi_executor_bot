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

### Requirement: Own protection is classified into exactly one state class
For a cycle whose own entry is terminal with cumulative filled quantity `Q`, ABI SHALL classify the result of resolving own attached protection (attribution by `parentOrderLinkId` equal to the entry `orderLinkId`, role by `stopOrderType`) into exactly one class:

- active: an attributed pair, both legs with zero executed quantity, at least one leg live;
- neutralized: an attributed pair, both legs with zero executed quantity and terminal without fill; or no candidates when `Q` is zero;
- completed: an attributed pair where one leg is `Filled` with `leavesQty` zero and `cumExecQty` equal to `Q`, the other leg is terminal without fill with zero executed quantity, and the filled leg's `Trade` executions sum to exactly `Q`;
- partial or contradictory: an attributed pair with any other executed quantity on either leg;
- unknown: no candidates while `Q` is positive, or any ambiguous result (`partial_pair`, `query_failed`, `inconsistent_duplicate`, `duplicate_role`, `extra_candidates`, `unclassified_role`).

No candidates and `partial_pair` SHALL NOT be treated as proof that protection did not execute.

#### Scenario: Demo stop exit
- **WHEN** the stop child is `Filled` with `cumExecQty` equal to `Q` and `leavesQty` zero, the take child is `Deactivated`, and the stop's `Trade` executions sum to `Q`
- **THEN** the class is completed with role stop

#### Scenario: Partially executed leg
- **WHEN** a leg is `PartiallyFilled`, or filled for a quantity other than `Q`
- **THEN** the class is partial or contradictory

#### Scenario: Children not visible
- **WHEN** `Q` is positive and no own child is found
- **THEN** the class is unknown

### Requirement: Completion is proven only by full execution of the pair's own order
ABI SHALL prove completion only as `runtime_signal`, when the pair's own close order is fully executed for exactly `Q`, or as `stop_loss` / `take_profit`, when the protection class is completed. A protection execution of any size together with an executed own close order, or a protection class of partial or contradictory, SHALL be contradictory. The aggregate position, its size, a received Close command and an accepted cancel SHALL NOT be proof. Contradictory or unproven evidence SHALL yield `internal_error` with no durable write.

#### Scenario: History not yet propagated
- **WHEN** the scope is flat but neither protection nor an own close order shows an execution yet
- **THEN** ABI returns `internal_error` and writes nothing

### Requirement: The lookup runs the proof whenever the pair's own orders may have ended the cycle
For a live-query-admissible record with `Q` positive, ABI SHALL run the completion proof when the pair has a close order identity, independently of the aggregate position; when the aggregate query reports no position; or when the protection class is completed or partial or contradictory. Otherwise the existing open answer SHALL be kept.

#### Scenario: Own close executed while a sibling keeps the slot open
- **WHEN** the pair's own close order executed for `Q` and a same-side sibling still holds a position in the slot
- **THEN** ABI returns the `runtime_signal` closure, not `position_open: true`

#### Scenario: Sibling position does not hide an own stop exit
- **WHEN** a same-side sibling keeps a position and this cycle's protection class is completed
- **THEN** ABI returns the `stop_loss` closure

#### Scenario: Active protection on an open position
- **WHEN** protection is active, the pair has no close order and the aggregate shows a same-side position
- **THEN** ABI returns `position_open: true` as today

### Requirement: A proven completion is recorded durably before it is reported and is never re-derived
On a proven completion ABI SHALL, under the pair's mutex, save `status: "terminal_closed"` together with the closure reason and identifiers in one record write before answering. The closure fields SHALL exist only on `terminal_closed` records and SHALL NOT change afterwards. Leaving the active statuses releases the physical scope, so the scope SHALL be released only after proof. A failed write SHALL yield `internal_error`. Later lookups SHALL answer from the record without exchange calls.

#### Scenario: Repeated lookup after proof
- **WHEN** completion was proven and recorded on an earlier lookup
- **THEN** a later lookup returns the same closure without any exchange call
