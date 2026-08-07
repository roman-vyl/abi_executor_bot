# open-position-resolution Specification

## Purpose
Define how ABI resolves a truthful, live current open-position answer for one Runtime-owned `(strategy_instance_id, trade_cycle_id)` pair, using the existing correlation record only to identify which exchange binding to ask about, never as the position truth itself.

## Requirements
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

- Durably closed (`absent`, `terminal_unfilled`, `terminal_closed`): no live exchange query is made; the response is `position_open: false` directly.
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

#### Scenario: Terminally-closed durably proves no exposure
- **WHEN** the record's status is `terminal_closed`
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
ABI SHALL validate Bybit's documented response envelope — `result` as an object containing `category` as a string and `list` as an array — not a bare top-level list. ABI SHALL treat the following conditions as query failures, mapped to `internal_error`, and SHALL NOT derive `position_open: false` from any of them:

- `result` is missing or not an object, or `result.list` is missing or not an array;
- `result.category` is missing, is not a string, or does not equal the exact category the query was issued for;
- `result.list` does not contain exactly one item — a symbol-scoped, one-way-mode V1 query is expected to return exactly one row for the queried instrument (Bybit's flat-position placeholder row when there is no exposure, or the single live row when there is); an **empty list is not evidence of a closed position** and more than one item is never resolved by filtering, so both cardinalities fail closed before any per-item field is read;
- the single item is not an object;
- the item's `symbol` is missing, is not a string, or does not equal the exact symbol the query was issued for;
- the item's `positionIdx` is missing, is not an integer, or is not exactly `0` — checked **regardless of `size`**, since `positionIdx` is Bybit's position-mode discriminator (one-way vs. hedge mode), not a size-dependent fact: a hedge-mode account reports non-zero `positionIdx` even on a flat, zero-size row;
- the item's `size` is missing, is not valid exact-decimal text, is non-finite, or parses to a negative value;
- for an item whose `size` parses to a value greater than zero: `side` is not exactly `Buy` or `Sell`, `avgPrice` is missing, is not valid exact-decimal text, or is zero or negative, or `openTime` is missing or is not a positive integer;
- the underlying request times out or fails at the transport level.

An item whose `size` parses to exactly zero, and whose `positionIdx` has already been confirmed present, an integer, and exactly `0`, is excluded from consideration as an open position and is not, by itself, a failure. ABI SHALL NOT require `side`, `avgPrice`, or `openTime` to be present or valid on such an item — Bybit's documented flat-position row carries empty or default values (`side` as an empty string, default/empty price fields, `openTime` as `0`) for a genuinely closed symbol, and those defaults SHALL NOT be treated as a validation failure. `positionIdx` is never exempted by a zero `size`.

ABI's sign/zero classification of `size` SHALL be total: it SHALL NOT throw for any input, including exact-decimal text with an exponent magnitude larger than any arithmetic bound ABI applies elsewhere. A typed adapter boundary that could throw on an adversarial or malformed field value would defeat the purpose of returning a discriminated result.

#### Scenario: Exchange timeout fails closed
- **WHEN** the Bybit position query times out or fails at the transport level
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: Envelope without a valid result.list fails closed
- **WHEN** the Bybit response has no `result` object, or `result.list` is missing or not an array
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: A mismatched result.category fails closed
- **WHEN** `result.category` is missing, is not a string, or does not equal the exact category the query was issued for
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: An empty list is never trusted as a closed position
- **WHEN** `result.list` contains zero items
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: More than one row fails closed regardless of size
- **WHEN** `result.list` contains more than one item, whether or not any of them has `size` greater than zero
- **THEN** ABI does not select any item as authoritative
- **AND** ABI returns `internal_error`

#### Scenario: Malformed response fails closed
- **WHEN** the single list item is not an object, or it has `size` parsing greater than zero and is missing a required field or has an invalid decimal or timestamp value
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: Symbol mismatch fails closed
- **WHEN** the single list item's `symbol` is missing, is not a string, or does not match the exact symbol the query was issued for
- **THEN** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`

#### Scenario: Missing or invalid size fails closed
- **WHEN** the single list item's `size` field is missing, is not valid exact-decimal text, or parses to a negative value
- **THEN** ABI does not treat the item as evidence of a closed position
- **AND** ABI returns `internal_error`

#### Scenario: A valid zero-size row is not a failure
- **WHEN** `result.list` contains exactly one item whose `size` parses to exactly zero, whose `positionIdx` is present, an integer, and exactly `0`, and which carries an empty or default `side`, `avgPrice`, or `openTime`
- **THEN** ABI excludes that item from consideration without requiring those latter three fields to be valid
- **AND** ABI does not return `internal_error` on account of that item

#### Scenario: Hedge-mode or unexpected positionIdx fails closed
- **WHEN** the single list item has a `positionIdx` that is missing, is not an integer, or is not exactly `0`, regardless of its `size`
- **THEN** ABI does not treat it as a valid one-way position
- **AND** ABI returns `internal_error`

#### Scenario: Zero-size row with a non-zero positionIdx fails closed
- **WHEN** the single list item's `size` parses to exactly zero but its `positionIdx` is missing, is not an integer, or is not exactly `0`
- **THEN** ABI does not exclude that item as a harmless zero-size row
- **AND** ABI returns `internal_error`

#### Scenario: Extreme exponents never raise an exception
- **WHEN** the single list item's `size` is valid exact-decimal text with an exponent magnitude beyond any arithmetic bound ABI applies elsewhere
- **THEN** ABI classifies its sign and zero-ness without throwing
- **AND** ABI resolves the request to one of the documented responses, never an unhandled exception

### Requirement: Live position side must match the record's desired entry side
For a structurally valid position row, ABI SHALL require the row's `side` to match `record.desired_entry.side` (`Buy` ↔ `long`, `Sell` ↔ `short`) before reporting an open position. This check validates the resolved record's own declared intent against the live row; it is not, and cannot be, a cross-check against any Bybit order or execution identity, since Bybit's position response carries none (see "V1 position attribution" below).

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

### Requirement: V1 position attribution rests on a documented operating precondition, not proof of order-level ownership
Bybit's position query is scoped to `category`+`symbol` under the configured API credentials and carries no Runtime or ABI order-binding identity. The symbol query plus side-match check therefore attributes a live position to the resolved record only as a plausibility check against that record's own declared intent, not as positive proof that the reported exposure was caused specifically by this record's own order. This capability's correct attribution for V1 depends on an external operating precondition: no manual or other-strategy-owned exposure may exist concurrently on the same `exchange_symbol` under the same API credentials. ABI SHALL NOT attempt to detect, enforce, or verify this precondition within this capability, and SHALL NOT introduce an `account_id`, subaccount model, or any cross-record/cross-instance resolution to do so.

#### Scenario: Attribution precondition is documented, not enforced
- **WHEN** this capability's behavior is documented
- **THEN** the documentation SHALL state that correct attribution depends on no overlapping manual or other-strategy-owned exposure existing on the same symbol under the configured credentials, regardless of whether that other exposure was itself placed through ABI or outside ABI
- **AND** the documentation SHALL NOT claim that the symbol query or side match alone proves the position was caused by this record's own order
- **AND** ABI SHALL NOT implement any account, subaccount, or cross-record mechanism in this capability to detect or enforce that precondition
