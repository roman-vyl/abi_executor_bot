## RENAMED Requirements
- FROM: `### Requirement: Stored command and observation state are never treated as current position truth`
- TO: `### Requirement: This cycle's own attributable fill facts are the source of position_open and average_entry_price`
- FROM: `### Requirement: Any partial fill counts as an open position`
- TO: `### Requirement: Any own attributable partial fill counts as an open position, even while the entry order remains live`
- FROM: `### Requirement: Open-position facts are sourced directly from the validated live query`
- TO: `### Requirement: first_fill_at_ms is this cycle's own durable, immutable raw first-fill timestamp, never a canonical strategy-bar value`

## MODIFIED Requirements

### Requirement: This cycle's own attributable fill facts are the source of position_open and average_entry_price
For a live-query-admissible record, ABI SHALL determine `position_open` and, when open,
`average_entry_price`, from this cycle's own attributable entry-order fill facts —
`early_execution_observation`'s `cumulative_filled_qty` and `avg_execution_price` — never from the
aggregate physical position's `size` or `avgPrice`. When the stored observation is already final (its
`order_status` is terminal) and this cycle's `first_fill_at_ms` is already captured, ABI SHALL reuse the
stored observation without an exchange call. Otherwise ABI SHALL perform one fresh, read-only query of
this cycle's own entry order (the same primitive used to resolve close quantity) before answering.
`average_entry_price` SHALL be reported only from this cycle's own resolved `avg_execution_price`; if
this cycle's own evidence proves a fill (`cumulative_filled_qty` greater than zero) but carries no usable
`avg_execution_price`, ABI SHALL NOT fabricate, estimate, or substitute a value and SHALL fail closed.

#### Scenario: A final, already-captured observation needs no exchange call
- **WHEN** this cycle's stored `early_execution_observation` is already final and its `first_fill_at_ms`
  is already captured
- **THEN** ABI answers `position_open` and `average_entry_price` from the stored observation, with no
  fresh query of the entry order

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

## ADDED Requirements

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
