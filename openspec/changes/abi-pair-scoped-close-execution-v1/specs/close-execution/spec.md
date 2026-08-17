## MODIFIED Requirements

### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`. A pair whose record status is already `terminal_closed` returns
`trade_cycle_closed` directly, with no exchange call and no further durable write — it already
durably proves this capability's postconditions and already durably records that Runtime asked to
end it. A pair whose record status is `absent` or `terminal_unfilled` also already durably proves
both postconditions, but has not itself been committed as a terminally closed trade cycle; ABI SHALL
durably commit it as `terminal_closed` — no exchange call is needed to do so — before returning
`trade_cycle_closed`, so the same pair cannot later be resurrected by a new entry-package request.
`terminal_closed` is the only status this requirement treats as a pure shortcut requiring no further
write: every other durably-closed status still requires this promotion. Every other pair SHALL have
its membership among the scope its own record names currently active records independently
reconfirmed — the set of that scope's non-durably-closed records, as `virtual-exposure-state`'s
`findActiveRecordsForScope` query enumerates them; any outcome where the requested pair's own record
is not found among that scope's active records returns `internal_error`. When that scope's active
records number more than one, every active record's own side (derived from its `desired_entry.side`)
SHALL also agree; disagreement returns `internal_error`. A resolved scope outside this capability's
supported exchange category returns `unsupported_exchange_scope` before any further step.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: An already terminally closed trade cycle is acknowledged idempotently
- **WHEN** the requested pair's record status is already `terminal_closed`
- **THEN** ABI returns `trade_cycle_closed` without querying the exchange or writing anything further

#### Scenario: A trade cycle that never held exposure, or ended without a fill, is durably terminalized, not merely acknowledged
- **WHEN** the requested pair's record status is `absent` or `terminal_unfilled`
- **THEN** ABI durably commits that record as `terminal_closed` without any exchange call, and only
  then returns `trade_cycle_closed`

#### Scenario: Confirmed active membership proceeds
- **WHEN** a pair whose record is none of `absent`, `terminal_unfilled`, or `terminal_closed` is
  found among its scope's currently active records
- **THEN** ABI proceeds to neutralize its current entry order, having also counted the scope's total
  active records to determine which quantity-resolution path applies

#### Scenario: A missing active-record membership fails closed
- **WHEN** the requested pair's own record is not found among the active records for the scope its
  own record names — a contradictory-correlation condition unreachable in production while
  `EntryPackageApplicationService`'s claim policy remains single-owner
- **THEN** ABI returns `internal_error`

#### Scenario: Disagreeing sides among a scope's active records fails closed
- **WHEN** a scope has more than one active record and their derived sides do not all agree — a
  condition unreachable in production while `EntryPackageApplicationService`'s claim policy remains
  single-owner
- **THEN** ABI returns `internal_error`

### Requirement: Closing acts on the requested cycle's resolved exposure, or sends no write when none exists
When the requested pair's scope has exactly one active record — today's only production-reachable
state — ABI SHALL close exactly the live position's current size, on its live side, as a reduce-only
order, unchanged from this capability's original behavior: never a size or side sourced from the
trade cycle's originally intended entry or from any quantity ABI calculated at entry time. When the
scope has more than one active record, ABI SHALL instead close the requested cycle's own resolved
exposure (resolved per the requirement below), clamped to the live aggregate size when a small
configured drift tolerance is not exceeded, and SHALL send no close order when that resolved exposure
is zero.

#### Scenario: An already-zero position sends no close order (single active record)
- **WHEN** the scope has exactly one active record and the live position size is zero
- **THEN** ABI sends no close order and proceeds directly to final verification

#### Scenario: A live remainder is closed at its actual size and side (single active record)
- **WHEN** the scope has exactly one active record and the live position size is greater than zero
- **THEN** ABI sends a reduce-only close order for exactly that live size and that live side, even
  when it differs from the trade cycle's originally intended entry or calculated quantity

#### Scenario: A resolved exposure is closed, not the raw aggregate (more than one active record)
- **WHEN** the scope has more than one active record
- **THEN** ABI sends a reduce-only close order for the requested cycle's own resolved exposure
  (clamped to the live aggregate size within tolerance), never the live aggregate size directly and
  never a sibling record's resolved exposure

#### Scenario: A cycle with zero resolved exposure sends no close order even while a sibling keeps the aggregate positive
- **WHEN** the scope has more than one active record and the requested cycle's own resolved exposure
  is zero (its entry order reached a terminal status with no fill)
- **THEN** ABI sends no close order for the requested cycle, and still proceeds to durably terminalize
  it, leaving the sibling record and the live aggregate untouched

### Requirement: The durable terminal write is gated on freshly confirmed postconditions and precedes physical scope release
Immediately before durably recording a pair reached through the full pipeline as `terminal_closed`,
ABI SHALL confirm — over a bounded number of fresh attempts, never by resending the close order —
both that the requested cycle's own resolved exposure has been removed from the scope's live
aggregate position, and that the pair's current entry order has no live remainder, confirmed at this
point in the pipeline rather than assumed from an earlier step alone. For a scope with exactly one
active record, "removed from the aggregate" means the live aggregate position size is zero,
unchanged from this capability's original behavior. For a scope with more than one active record, it
means the live aggregate position size equals what it was immediately before this close's own order
was sent, minus exactly the quantity this close sent (zero minus zero, i.e. still `no_position` or
unchanged, when no close order was sent at all). Exhausting the bounded attempts without confirming
either fails the entire close closed. The pair's physical scope SHALL be released only as a
consequence of the terminal write completing — for this path or the `absent`/`terminal_unfilled`
promotion alike — never before it; a crash or failure at any point before it completes SHALL leave
the scope held by the same pair, exactly as if the close request had not been attempted.

#### Scenario: A close order that only takes effect on a later bounded attempt still succeeds
- **WHEN** a bounded verification attempt after the last one finds the position at the expected
  post-close value, though an earlier attempt did not
- **THEN** ABI proceeds to the terminal write once that later attempt confirms it

#### Scenario: Exhausting the bounded attempts without confirming the expected post-close value fails closed
- **WHEN** every bounded verification attempt fails to confirm the expected post-close aggregate
  value, or the verification query itself fails
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

#### Scenario: Scope release never precedes the terminal write
- **WHEN** both postconditions are confirmed but the durable terminal write has not yet completed
- **THEN** the pair's physical scope is still held by that pair; once the write completes, the scope
  becomes available to a different pair (or, for a scope with a remaining active sibling, remains
  held by that sibling)

#### Scenario: A crash before the durable write leaves the trade cycle re-closeable
- **WHEN** ABI fails or restarts after confirming both postconditions but before the durable terminal
  write completes
- **THEN** the pair's physical scope remains held by that pair, and a later close request for the
  same pair can still proceed

## ADDED Requirements

### Requirement: A resolved exposure that materially exceeds the live aggregate fails closed
For a scope with more than one active record, when the requested cycle's own resolved exposure
exceeds the live aggregate position size by more than a configured, non-negative drift-tolerance
quantity, ABI SHALL send no close order and SHALL return a dedicated business error
(`position_exposure_drift`) rather than `internal_error`, since this is a detectable operational
discrepancy between ABI's own recorded fill facts and the exchange's current state, not an
unrecoverable internal fault. Within that tolerance, ABI SHALL close the live aggregate size rather
than the resolved exposure, since no more than the live aggregate can exist to close.

#### Scenario: Drift beyond tolerance fails closed with a specific code
- **WHEN** the requested cycle's own resolved exposure exceeds the live aggregate position size by
  more than the configured drift tolerance
- **THEN** ABI sends no close order, does not durably terminalize the pair, and returns
  `position_exposure_drift`

#### Scenario: Drift within tolerance clamps the sent quantity
- **WHEN** the requested cycle's own resolved exposure exceeds the live aggregate position size by no
  more than the configured drift tolerance
- **THEN** ABI sends a reduce-only close order for the live aggregate size, not the (larger) resolved
  exposure

### Requirement: Close never affects a sibling cycle sharing the same physical scope
When a scope has more than one active record, closing one of them SHALL NOT durably or observably
change any other active record for that scope: no other record's status, recorded fill facts, or
membership among the scope's active records SHALL change as a result.

#### Scenario: A sibling's record is untouched by closing another cycle
- **WHEN** ABI closes one active record for a scope that has more than one
- **THEN** every other active record for that scope keeps its existing status, recorded fill facts,
  and continued membership among the scope's active records, exactly as before the close request

### Requirement: This pipeline reads but never durably rewrites the requested cycle's recorded fill facts
Any fresh, read-only query of the requested cycle's own entry order this pipeline performs to resolve
its exposure (for a scope with more than one active record) SHALL be used only in memory for the
current close request. ABI SHALL NOT write its result to the record's `early_execution_observation`
or any other stored field, and SHALL NOT treat this pipeline as one of `virtual-exposure-state`'s
existing durable observation-writing points.

#### Scenario: A multi-owner resolution query leaves the durable record unchanged
- **WHEN** ABI resolves a requested cycle's own exposure via a fresh query of its entry order as part
  of closing it
- **THEN** the record's durably stored `early_execution_observation` (and therefore its
  `avg_execution_price`) is bit-for-bit identical before and after the close request completes
