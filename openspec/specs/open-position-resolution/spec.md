# open-position-resolution Specification

## Purpose
Define how ABI resolves a truthful, current open-position answer for one Runtime-owned `(strategy_instance_id, trade_cycle_id)` pair, sourced from this cycle's own attributable entry-order fill facts (durably tracked on its correlation record) — never from the aggregate physical position, which cannot distinguish this cycle's exposure from any other trade cycle sharing the same exchange scope. The aggregate physical position query is retained only as weak existence/side sanity and to supply `PUT .../protection`'s confirmed stop-loss/take-profit values.

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
- Live-query-admissible (`applied`, `pending_replace`, `pending_cancel`): resolution requires at least a fresh check of this cycle's own attributable fill facts, and (when they show a nonzero fill) the aggregate physical position as a weak sanity check.
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

### Requirement: This cycle's own attributable fill facts are the source of position_open and average_entry_price
For a live-query-admissible record, ABI SHALL determine `position_open` and, when open,
`average_entry_price`, from this cycle's own attributable entry-order fill facts —
`early_execution_observation`'s `cumulative_filled_qty` and `avg_execution_price` — never from the
aggregate physical position's `size` or `avgPrice`. When the stored observation is already final (its
`order_status` is terminal), ABI SHALL reuse the stored observation without an exchange call, regardless
of whether `first_fill_at_ms` has been captured yet (a separate concern — see the `first_fill_at_ms`
requirements below). Otherwise ABI SHALL perform one fresh, read-only query of this cycle's own entry
order (the same primitive used to resolve close quantity) before answering. `average_entry_price` SHALL
be reported only from this cycle's own resolved `avg_execution_price`; if this cycle's own evidence
proves a fill (`cumulative_filled_qty` greater than zero) but carries no usable `avg_execution_price`,
ABI SHALL NOT fabricate, estimate, or substitute a value and SHALL fail closed.

#### Scenario: A final observation needs no exchange call to resolve position_open/average_entry_price
- **WHEN** this cycle's stored `early_execution_observation` is already final
- **THEN** ABI answers `position_open` and `average_entry_price` from the stored observation, with no
  fresh query of the entry order, regardless of whether `first_fill_at_ms` has been captured yet

#### Scenario: A live or not-yet-final observation is freshly refreshed
- **WHEN** this cycle's stored `early_execution_observation` is `null` or not yet final
- **THEN** ABI performs one fresh, read-only query of this cycle's own entry order before answering, and
  does not answer from a stale stored value

#### Scenario: A fill with no usable average price fails closed
- **WHEN** this cycle's own resolved evidence shows `cumulative_filled_qty` greater than zero but no
  usable `avg_execution_price`
- **THEN** ABI does not return `position_open: true` with a fabricated or omitted `average_entry_price`
- **AND** ABI returns `internal_error`

#### Scenario: The aggregate position's own size and average price are never read for these facts
- **WHEN** ABI answers `position_open` or `average_entry_price` for any live-query-admissible record
- **THEN** neither value is ever sourced from the aggregate physical position query's `size` or `avgPrice`
  fields

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

#### Scenario: Matching side satisfies the aggregate sanity check
- **WHEN** the structurally valid position row's side matches `record.desired_entry.side`
- **THEN** ABI treats the aggregate sanity check as satisfied and proceeds to report the position as open
  using this cycle's own attributable fill facts, not this row's

### Requirement: Any own attributable partial fill counts as an open position, even while the entry order remains live
ABI SHALL report `position_open: true` whenever this cycle's own attributable cumulative entry-order fill
is greater than zero, regardless of how small the filled quantity is relative to the intended order
quantity, and regardless of whether the entry order has yet reached a terminal status. A live
`PartiallyFilled` entry order with nonzero cumulative fill SHALL be reported as an open position; ABI
SHALL NOT wait for the entry order to reach a terminal status before doing so, and SHALL NOT require the
aggregate physical position query to independently confirm this before reporting `position_open: true`.

#### Scenario: A live partial fill is reported as open from this cycle's own evidence
- **WHEN** this cycle's own entry order is `PartiallyFilled` with a cumulative fill greater than zero
- **THEN** ABI returns `position_open: true`, sourced from this cycle's own evidence, without requiring
  the entry order to be terminal first

#### Scenario: A full fill is reported as open
- **WHEN** this cycle's own entry order's cumulative fill reflects the fully executed order quantity
- **THEN** ABI returns `position_open: true`

#### Scenario: Zero own fill is reported as closed without consulting the aggregate
- **WHEN** this cycle's own resolved cumulative fill is exactly zero
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the aggregate physical position for this determination

### Requirement: first_fill_at_ms is the earliest of this cycle's own entry order's own executions, never a canonical strategy-bar value
When reporting an open position, `first_fill_at_ms` SHALL be the earliest execution timestamp among this
cycle's own entry order's own individually-timestamped executions — never a value ABI has normalized,
rounded, or otherwise mapped to any strategy timeframe, interval, candle grid, or bar boundary, and never
derived from any field describing an order's current or most-recently-observed state (such value cannot be
trusted to represent the *first* fill once more than one execution has occurred). ABI SHALL NOT introduce,
read, derive, or depend on any strategy timeframe/interval/grid concept to produce this value. ABI SHALL
capture this value durably exactly once per trade cycle, the first time this cycle's own evidence proves a
fill occurred and no value is captured yet, by querying every one of this order's own executions and
taking the minimum of their own timestamps — never by inspecting only the first-returned or
most-recently-observed execution. Once captured, `first_fill_at_ms` SHALL be immutable: no later
observation, however different, SHALL overwrite an already-captured value.

#### Scenario: The value is captured once, as the true minimum across this order's own executions
- **WHEN** ABI observes, for the first time, that this cycle's own entry order has a nonzero cumulative
  fill and no `first_fill_at_ms` is captured yet
- **THEN** ABI durably captures `first_fill_at_ms` as the minimum execution timestamp among every one of
  this order's own executions it can find
- **AND** this value is never derived from, or normalized against, any strategy timeframe or bar boundary

#### Scenario: An order with more than one execution before its first observation still resolves to the true first fill
- **WHEN** this cycle's own entry order has already accumulated more than one execution by the time ABI
  first observes it, and those executions have different timestamps
- **THEN** ABI captures `first_fill_at_ms` as the earliest of those timestamps, not the timestamp of
  whichever execution ABI's own observation happened to see most recently

#### Scenario: The captured value is stable across repeated requests
- **WHEN** `GET .../open-position` is called again for a pair whose `first_fill_at_ms` is already captured,
  and this cycle's own entry order has since accumulated further executions
- **THEN** ABI returns the originally captured value unchanged, not a value reflecting the more recent
  executions

#### Scenario: A pre-existing durable record without a captured value is backfilled once
- **WHEN** a durable record already shows a final, nonzero own-cycle fill but has never captured
  `first_fill_at_ms`
- **THEN** ABI performs one fresh query of this order's own executions to capture the value, even though
  the stored fill facts themselves need no refresh

### Requirement: The aggregate physical position query serves only weak sanity and PUT .../protection's existing needs
When this cycle's own evidence already proves a nonzero fill, ABI SHALL query the aggregate physical
position only to confirm a matching-side row exists (the same plausibility-only check this capability has
always documented, not proof of attribution) and to supply the confirmed stop-loss/take-profit values
`PUT .../protection` already reads from this determination. ABI SHALL NOT compare the aggregate's size
against this cycle's own resolved quantity, with or without a tolerance, and SHALL NOT source
`position_open`, `average_entry_price`, or `first_fill_at_ms` from the aggregate query under any
circumstance.

#### Scenario: The aggregate query never gates or sources a per-cycle fact once this cycle's own evidence exists
- **WHEN** this cycle's own evidence already proves a nonzero fill
- **THEN** the subsequent aggregate query is used only to confirm existence/side and to read
  stop-loss/take-profit values, never to source or override `position_open`, `average_entry_price`, or
  `first_fill_at_ms`

#### Scenario: No quantity comparison is performed against the aggregate
- **WHEN** ABI resolves an open position for any live-query-admissible record
- **THEN** ABI never compares the aggregate physical position's size against this cycle's own resolved
  quantity, with or without a tolerance

### Requirement: A disagreement between this cycle's own fill evidence and the aggregate sanity check fails closed
When this cycle's own evidence proves a nonzero fill, ABI SHALL require the aggregate physical position
query to return a row that exists and whose side matches `record.desired_entry.side`. ABI SHALL treat a
missing aggregate row, or one on the wrong side, as a contradiction and SHALL fail closed rather than
report `position_open: true` from own evidence alone in that case.

#### Scenario: Own evidence with no matching aggregate row fails closed
- **WHEN** this cycle's own evidence proves a nonzero fill but the aggregate physical position query
  returns no row, or a row whose side does not match `record.desired_entry.side`
- **THEN** ABI does not return `position_open: true`
- **AND** ABI returns `internal_error`

### Requirement: first_fill_at_ms's durable capture is serialized against every other durable write for the same pair
ABI SHALL perform `first_fill_at_ms`'s durable capture only while holding the same pair-level
serialization every other durable write for that `(strategy_instance_id, trade_cycle_id)` pair already
uses, re-reading the record fresh once that serialization is held, so a concurrent write for the same pair
(an entry-package revalidation, a close, a protection update) can never be silently lost or reverted by
this capture.

#### Scenario: A concurrent write for the same pair is never lost to a first-fill capture
- **WHEN** `GET .../open-position` is capturing `first_fill_at_ms` for a pair at the same time another
  request durably writes that pair's record
- **THEN** neither write is lost — the capture and the other write are serialized, not interleaved

#### Scenario: A capture attempt observes a concurrent durable closure and does not resurrect the record
- **WHEN** the pair's record is durably closed by a concurrent request between this capability's initial,
  unserialized read and its serialized capture attempt
- **THEN** ABI re-reads the record's current status once serialization is held and reports the now-closed
  outcome instead of attempting a stale capture

### Requirement: first_fill_at_ms's capture accumulates every page of this order's own executions before computing a value, never assuming their returned order
When capturing `first_fill_at_ms`, ABI SHALL retrieve every available page of this cycle's own entry
order's own executions before computing the minimum timestamp, following the exchange's own pagination
cursor to completion, and SHALL NOT assume executions are returned in any particular chronological order.
ABI SHALL NOT compute or accept a candidate value derived from an incomplete set of pages.

#### Scenario: A later page containing the true earliest execution is still found
- **WHEN** this order's own executions span more than one page, and the earliest execution by timestamp is
  not on the first page returned
- **THEN** ABI's captured `first_fill_at_ms` reflects that earliest execution regardless of which page it
  was returned on

#### Scenario: An unbounded or excessive page count fails closed rather than using a partial result
- **WHEN** this order's own executions span more pages than ABI's bounded pagination allows
- **THEN** ABI does not compute `first_fill_at_ms` from the pages it did retrieve
- **AND** ABI returns `internal_error` without a durable write

### Requirement: A first-fill capture that finds no executions for an order already proven filled fails closed
Since `first_fill_at_ms` capture is only ever attempted after this cycle's own evidence already proves a
nonzero fill, ABI SHALL treat a capture query that finds no executions for this order as a contradiction —
never as proof the order has no fill, and never as grounds to silently omit or fabricate
`first_fill_at_ms`. ABI SHALL fail closed in this case without a durable write.

#### Scenario: An empty execution result for an order with proven fill facts fails closed
- **WHEN** this cycle's own fill facts already show a nonzero cumulative fill, but a capture query finds no
  executions at all for this order's own identity
- **THEN** ABI does not report `position_open: true` with a fabricated or omitted `first_fill_at_ms`
- **AND** ABI returns `internal_error` without durably writing `first_fill_at_ms`

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
