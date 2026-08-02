## Purpose

Define how ABI resolves a truthful, live current open-position answer for one Runtime-owned
`(strategy_instance_id, trade_cycle_id)` pair, using the existing correlation record only to
identify which exchange binding to ask about, never as the position truth itself.

## ADDED Requirements

### Requirement: Position resolution starts from a direct composite correlation lookup
ABI SHALL resolve the requested pair using the existing `EntryPackageCorrelationRepository.get(strategy_instance_id, trade_cycle_id)` composite-key lookup and no other lookup mechanism. ABI SHALL NOT introduce an index or lookup keyed on `strategy_instance_id` alone, and SHALL NOT apply any record-selection or cardinality-handling logic, since the pair is a single-record key by construction.

#### Scenario: Existing record is used for resolution
- **WHEN** a correlation record exists for the requested pair
- **THEN** ABI uses that exact record, and no other, to resolve the position

#### Scenario: Missing record fails closed as an ownership mismatch
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI classifies this as an ownership/invariant mismatch
- **AND** ABI does not return `position_open: false`
- **AND** ABI returns `unknown_trade_cycle_binding`

### Requirement: Record status is classified into durably-closed, live-query-admissible, and unresolved buckets
ABI SHALL classify a found record's `status` into exactly one of three buckets before taking any further action:

- Durably closed (`absent`, `terminal_unfilled`): no live exchange query is made; the response is `position_open: false` directly.
- Live-query-admissible (`applied`, `pending_replace`, `pending_cancel`): a live Bybit query is required.
- Unresolved (`pending_create`, `create_failed`, `unknown`): ABI fails closed without attempting a live query.

#### Scenario: Absent record durably proves no exposure
- **WHEN** the record's status is `absent`
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the exchange

#### Scenario: Terminal-without-fill durably proves no exposure
- **WHEN** the record's status is `terminal_unfilled`
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the exchange

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

### Requirement: Stored command and observation state are never treated as current position truth
Neither `EntryPackageExecutionRecord.status` nor `early_execution_observation` SHALL be treated as evidence of the current live position. `status` SHALL be used only to select which of the three buckets above applies; `early_execution_observation` SHALL NOT be read by this resolution flow at all.

#### Scenario: Stored early execution observation does not substitute for a live query
- **WHEN** a record has a stored `early_execution_observation` from a prior PUT confirmation
- **THEN** ABI does not use that stored observation to answer `position_open`, `first_fill_at_ms`, or `average_entry_price`
- **AND** ABI relies only on a live exchange query (or the durably-closed bucket) for those facts

### Requirement: V1 live queries are scoped to Bybit linear category before any exchange call
For a live-query-admissible record, ABI SHALL require `record.exchange_category` to equal `linear` before issuing any exchange query. Any other value SHALL fail closed without querying the exchange.

#### Scenario: Unsupported category fails closed
- **WHEN** a live-query-admissible record's `exchange_category` is not `linear`
- **THEN** ABI does not query the exchange
- **AND** ABI does not return `position_open: false`
- **AND** ABI returns `unsupported_exchange_scope`

#### Scenario: Linear category proceeds to the live query
- **WHEN** a live-query-admissible record's `exchange_category` is `linear`
- **THEN** ABI proceeds to query Bybit for the current position

### Requirement: The live Bybit query uses the record's own category and symbol, never a global default
ABI SHALL query Bybit's position endpoint using the explicit `category` and `symbol` stored on the resolved record. ABI SHALL NOT use the deployment's globally configured category for this query.

#### Scenario: Query uses the record's stored category and symbol
- **WHEN** ABI queries Bybit for a live-query-admissible, linear-scoped record
- **THEN** the query is sent with `category` equal to `record.exchange_category` and `symbol` equal to `record.exchange_symbol`
- **AND** the deployment's globally configured category is not used for this query

### Requirement: The raw Bybit position response is strictly validated before being trusted
ABI SHALL treat the following conditions as query failures, mapped to `internal_error`, and SHALL NOT derive `position_open: false` from any of them:

- the response is not a list, or a list item is not an object;
- a considered row is missing `symbol`, `side`, `size`, `positionIdx`, `avgPrice`, or `openTime`;
- `avgPrice` is not valid exact-decimal text, or is zero or negative on a row with `size > 0`;
- `openTime` is not a positive integer timestamp;
- more than one row has `size > 0`;
- a `size > 0` row has a non-zero `positionIdx` (hedge-mode/unexpected row) and no valid `positionIdx == 0` row exists;
- the underlying request times out or fails at the transport level.

A row with `size == 0` (or absent/zero after parsing) is excluded from consideration and is not, by itself, a failure.

#### Scenario: Exchange timeout fails closed
- **WHEN** the Bybit position query times out or fails at the transport level
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: Malformed response fails closed
- **WHEN** the Bybit response is not a well-formed list of position rows, or a considered row is missing a required field or has an invalid decimal or timestamp value
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: Ambiguous multiple rows fail closed
- **WHEN** more than one row for the queried symbol has `size > 0`
- **THEN** ABI does not select either row as authoritative
- **AND** ABI returns `internal_error`

#### Scenario: Hedge-mode or unexpected positionIdx fails closed
- **WHEN** the only row with `size > 0` has a non-zero `positionIdx`
- **THEN** ABI does not treat it as a valid one-way position
- **AND** ABI returns `internal_error`

### Requirement: Live position side must match the record's desired entry side
For a structurally valid position row, ABI SHALL require the row's `side` to match `record.desired_entry.side` (`Buy` ↔ `long`, `Sell` ↔ `short`) before reporting an open position.

#### Scenario: Wrong side fails closed
- **WHEN** the structurally valid position row's side does not match `record.desired_entry.side`
- **THEN** ABI does not report `position_open: true` for that row
- **AND** ABI returns `internal_error`

#### Scenario: Matching side confirms an open position
- **WHEN** the structurally valid position row's side matches `record.desired_entry.side`
- **THEN** ABI proceeds to report the position as open using that row's facts

### Requirement: Any partial fill counts as an open position
ABI SHALL report `position_open: true` for any structurally valid, side-matching row with `size > 0`, regardless of how small the filled quantity is relative to the intended order quantity. ABI SHALL NOT wait for full execution before reporting a position as open.

#### Scenario: Partial fill is reported as open
- **WHEN** the live query returns a side-matching row whose `size` is greater than zero but less than the originally intended order quantity
- **THEN** ABI returns `position_open: true` with that row's `openTime` and `avgPrice`

#### Scenario: Full fill is reported as open
- **WHEN** the live query returns a side-matching row whose `size` reflects the fully executed order quantity
- **THEN** ABI returns `position_open: true` with that row's `openTime` and `avgPrice`

#### Scenario: No live position is reported as closed
- **WHEN** the live query finds no row with `size > 0` for the queried symbol
- **THEN** ABI returns `position_open: false` with both facts `null`

### Requirement: Open-position facts are sourced directly from the validated live query
When reporting an open position, `first_fill_at_ms` SHALL equal the validated row's `openTime`, and `average_entry_price` SHALL equal the validated row's `avgPrice`, passed through as exact-decimal text. ABI SHALL NOT compute, estimate, or substitute either value from any other source, including `desired_entry.source_plan_bar_open_time_ms` or `desired_entry.planned_entry_price`.

#### Scenario: Facts are mapped directly from the live query
- **WHEN** ABI reports an open position
- **THEN** `first_fill_at_ms` equals the live query row's `openTime`
- **AND** `average_entry_price` equals the live query row's `avgPrice`, unmodified

### Requirement: Resolution depends on existing entry-package readiness
ABI SHALL NOT resolve open-position requests until the existing entry-package readiness signal reports ready, since resolution reads the same recovered correlation store used by the entry-package PUT route.

#### Scenario: Not-ready readiness fails closed
- **WHEN** ABI's entry-package readiness has not yet succeeded
- **THEN** ABI does not attempt correlation lookup or any exchange query
- **AND** ABI returns `internal_error`

#### Scenario: Ready readiness serves normally
- **WHEN** ABI's entry-package readiness has succeeded
- **THEN** ABI proceeds with composite lookup and resolution as normal

### Requirement: V1 resolution scope is limited to Bybit one-way linear positions
This capability's side/category/positionIdx handling SHALL be documented as scoped to Bybit linear-category, one-way-mode (`positionIdx == 0`) positions, and SHALL NOT be asserted as a general rule for `spot` category or hedge-mode accounts.

#### Scenario: Unsupported scope is not silently claimed as supported
- **WHEN** this capability's behavior is documented
- **THEN** the documentation SHALL state that `spot` category and hedge-mode position rows are out of scope and fail closed, not silently resolved
