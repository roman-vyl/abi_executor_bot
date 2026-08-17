# close-execution Specification

## Purpose
Define how ABI executes a validated `POST .../close` command (`exposure_fraction`, canonical value
`"1"` in V1) for one Runtime-owned `(strategy_instance_id, trade_cycle_id)` pair: proving its current
entry order can no longer add exposure, resolving and closing exactly that cycle's own exposure — the
live aggregate remainder when it is the scope's only active record, or a dedicated reduce-only order
dispatched under its own attributable identity when the scope has more than one — and durably
terminalizing the trade cycle as `terminal_closed` — whether or not it ever actually held exposure —
releasing its physical scope only as a consequence of that durable write, before reporting success.

## Requirements

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

### Requirement: The pair's current entry order must be proven unable to increase the position before ABI measures or closes it
For a pair that reaches this step, ABI SHALL treat a missing current entry order identity as
contradictory correlation and fail the entire close request closed, since every record reaching this
step is expected to carry one. When the current entry order is already known terminal or fully
filled, ABI proceeds without sending a cancel. When it is live, unfilled, or partially filled, ABI
SHALL send a cancel and then confirm, over a bounded number of fresh attempts, that no live remainder
exists. That determination SHALL be made from the order's own terminal-or-live status, never from
whether any quantity had filled before it reached that status — an order that reaches a terminal
status with a nonzero executed quantity has no live remainder, exactly like one that reaches the same
terminal status with none. ABI SHALL NOT proceed to read or close the position while this remains
unconfirmed, and any query failure or unresolved outcome within the bounded attempts fails the entire
close request closed. ABI SHALL NOT cancel, query, or otherwise act on any order it cannot attribute
to the requested pair's own current entry order, and SHALL NOT use an account-wide or symbol-wide
cancel operation to establish this.

#### Scenario: A missing current entry order identity is contradictory correlation
- **WHEN** a pair reaches this step with no current entry order recorded
- **THEN** ABI returns `internal_error` and does not read or close the live position

#### Scenario: An already terminal or fully filled entry order needs no cancel
- **WHEN** the current entry order is already known terminal or fully filled
- **THEN** ABI proceeds to reading the live position without sending a cancel

#### Scenario: A live or partially filled entry order is neutralized before ABI proceeds
- **WHEN** the current entry order is live, unfilled, or partially filled
- **THEN** ABI sends a cancel and confirms, before proceeding, that the order has reached a terminal
  status with no live remainder

#### Scenario: A terminal status with executed quantity still counts as neutralized
- **WHEN** the current entry order's confirmed status is terminal but its executed quantity is
  nonzero
- **THEN** ABI treats it as having no live remainder, the same as a terminal status with no executed
  quantity, and proceeds

#### Scenario: Ambiguous neutralization blocks the entire close
- **WHEN** ABI cannot confirm, within its bounded attempts, that the current entry order has reached
  a terminal status
- **THEN** ABI returns `internal_error` and does not read or close the live position

#### Scenario: Close never affects another pair's order
- **WHEN** ABI neutralizes the requested pair's current entry order
- **THEN** ABI does not cancel, query, or otherwise act on any order it cannot attribute to that exact
  pair, even one sharing the same symbol or account, and does not use an account-wide or symbol-wide
  cancel operation

### Requirement: The live position is read directly against the pair's owned scope, without a side-match restriction
Once the current entry order is proven unable to increase the position, ABI SHALL determine the live
position for the pair's owned scope using the same live-query response validation
`open-position-resolution` already defines for envelope structure, category, position slot, and size —
but SHALL NOT apply `open-position-resolution`'s side-match restriction. A structurally valid open
position on the pair's owned scope is in scope for closing regardless of its side.

#### Scenario: A malformed or invalid live-query response fails closed
- **WHEN** the live position query's response fails the existing structural or field validation
- **THEN** ABI returns `internal_error` and sends no close order

#### Scenario: A position on an unexpected side is still eligible for closing
- **WHEN** the live position's side does not match the trade cycle's originally intended side
- **THEN** ABI still proceeds to close that position, rather than refusing to touch it

### Requirement: Closing acts on the requested cycle's resolved exposure, or sends no write when none exists
When the requested pair's scope has exactly one active record — today's only production-reachable
state — ABI SHALL close exactly the live position's current size, on its live side, as a reduce-only
order, unchanged from this capability's original behavior: never a size or side sourced from the
trade cycle's originally intended entry or from any quantity ABI calculated at entry time. When the
scope has more than one active record, ABI SHALL instead resolve the requested cycle's own exposure
from its own entry order's fill facts and dispatch a reduce-only close order for exactly that
quantity under a stable, attributable identity (per the requirements below), and SHALL send no close
order when that resolved exposure is zero.

#### Scenario: An already-zero position sends no close order (single active record)
- **WHEN** the scope has exactly one active record and the live position size is zero
- **THEN** ABI sends no close order and proceeds directly to final verification

#### Scenario: A live remainder is closed at its actual size and side (single active record)
- **WHEN** the scope has exactly one active record and the live position size is greater than zero
- **THEN** ABI sends a reduce-only close order for exactly that live size and that live side, even
  when it differs from the trade cycle's originally intended entry or calculated quantity

#### Scenario: A resolved exposure is closed under its own identity, never the raw aggregate (more than one active record)
- **WHEN** the scope has more than one active record
- **THEN** ABI dispatches a reduce-only close order, under this cycle's own attributable identity,
  for the requested cycle's own resolved exposure — never a sibling record's resolved exposure, and
  never inferred from the live aggregate size alone

#### Scenario: A cycle with zero resolved exposure sends no close order even while a sibling keeps the aggregate positive
- **WHEN** the scope has more than one active record and the requested cycle's own resolved exposure
  is zero (its entry order reached a terminal status with no fill)
- **THEN** ABI sends no close order for the requested cycle, writes no close-order identity for it,
  and still proceeds to durably terminalize it, leaving the sibling record and the live aggregate
  untouched

### Requirement: A close order is dispatched under a stable, attributable identity, durably recorded before the exchange call
For a scope with more than one active record, before ABI sends any close order for the requested
cycle, it SHALL compute a deterministic close-order identity from the pair's identity, a fixed
`"close"` role, and the cycle's current entry-package generation, and SHALL durably record that
identity on the pair's own record before making the exchange call that uses it. A thrown exception or
a live-execution-guard skip from that exchange call SHALL NOT revert the already-durably-recorded
identity.

#### Scenario: The close identity is durable before the exchange call, not after
- **WHEN** ABI dispatches a close order for a cycle whose scope has more than one active record
- **THEN** the pair's own record durably carries that close order's identity before the exchange call
  that uses it is made, not only after a response is received

#### Scenario: A failed or skipped dispatch leaves the durable identity intact
- **WHEN** the exchange call carrying a newly computed close-order identity throws, or is skipped by
  the live-execution guard
- **THEN** the identity ABI already durably recorded for this attempt remains recorded, and ABI
  returns `internal_error` without reverting it

### Requirement: ABI never dispatches a second close order for a cycle while a previously dispatched one's fate is unconfirmed
Before dispatching any close order for a cycle whose scope has more than one active record, ABI SHALL
first check whether a close-order identity is already durably recorded for that cycle's current
generation. If one is, ABI SHALL resolve that prior close order's own fate — via a fresh,
bounded query of its own identity — before taking any further action, and SHALL NOT dispatch a new
close order while that prior order's fate remains live or ambiguous. ABI SHALL dispatch a further
close order reusing the same previously recorded identity only when that fresh query proves,
cleanly and within its bounded attempts, that the exchange has no record of that identity ever
having been created.

#### Scenario: A retry finds no prior close order recorded and proceeds to dispatch
- **WHEN** ABI processes a close request for a cycle whose scope has more than one active record and
  no close-order identity is yet durably recorded for its current generation
- **THEN** ABI proceeds to resolve the cycle's exposure and dispatch a close order under a freshly
  computed identity

#### Scenario: A previously dispatched close order that already fully executed blocks any new dispatch
- **WHEN** a close-order identity is already durably recorded for the requested cycle's current
  generation, and a fresh query of that identity confirms it executed the full quantity ABI
  originally resolved for this cycle
- **THEN** ABI sends no new close order and proceeds directly to durable termination from that
  recovered evidence

#### Scenario: A previously dispatched close order whose fate is still live or ambiguous blocks any new dispatch
- **WHEN** a close-order identity is already durably recorded for the requested cycle's current
  generation, and a fresh, bounded query of that identity does not cleanly resolve to a terminal
  outcome within its bounded attempts
- **THEN** ABI sends no new close order, does not durably terminalize the pair, and returns
  `internal_error`

#### Scenario: A previously dispatched close order genuinely never created is safe to resend under the same identity
- **WHEN** a close-order identity is already durably recorded for the requested cycle's current
  generation, and a fresh, bounded query of that identity finds no record of it anywhere, every query
  in the bounded window answering cleanly
- **THEN** ABI dispatches a close order for that same generation reusing the same identity, never
  computing a new one

#### Scenario: A successful dispatch resolves its own fate within the same request, without requiring a second close request
- **WHEN** ABI dispatches a close order for a cycle under a newly computed identity within a single
  close request, and the exchange settles that order (to any terminal outcome, or to a confirmed full
  execution) within the bounded confirmation window this same request already performs
- **THEN** that same request completes the requested cycle's postcondition check and, on success, its
  durable termination — without requiring Runtime to send a second close request purely to obtain
  confirmation of what the first request already dispatched

### Requirement: A durably unresolved close identity is protected from a conflicting entry-package mutation for the same pair
While a close-order identity is durably recorded for a cycle's current generation and that cycle's
record status is not `terminal_closed`, ABI SHALL NOT transition that record to `absent` (and
therefore SHALL NOT begin a new entry-package generation for that pair, which would compute a
different close-order identity) as a result of any entry-package request for the same pair, for as
long as that cycle's entry order retains any recorded execution — which it always does once a
close-order identity has been durably recorded for it, since a close is never dispatched for a cycle
with zero resolved exposure (per the requirement above). This protection is provided entirely by
entry-package execution's own existing fill-evidence check, not by any new guard this pipeline
introduces.

#### Scenario: A cancel-intent request during an unresolved close does not transition the pair to absent
- **WHEN** a null-desired-entry request arrives for a pair whose close-order identity is durably
  recorded and unresolved
- **THEN** ABI does not transition that pair's record to `absent`, does not clear its close-order
  identity, and does not permit a new entry-package generation to begin for that pair

#### Scenario: A new non-null entry-package request during an unresolved close does not corrupt the close identity
- **WHEN** a non-null-desired-entry request that differs from the pair's currently stored desired
  entry arrives for a pair whose close-order identity is durably recorded and unresolved
- **THEN** ABI's own recorded execution evidence for that pair's entry order prevents that request
  from succeeding as a fresh binding, and the pair's close-order identity remains exactly as it was

### Requirement: The requested cycle's own close order is the exclusive proof that its exposure was closed
For a scope with more than one active record, ABI SHALL treat the requested cycle's own close
order's confirmed executed quantity — read from that order's own execution report, keyed by its own
identity — as the sole proof of whether, and how much of, the requested cycle's resolved exposure was
actually closed. ABI SHALL NOT infer this from a comparison of the live aggregate position size
before and after the close order, since that comparison cannot distinguish this request's own effect
from a sibling record's concurrent activity. `terminal_closed` for this cycle SHALL require that
confirmed executed quantity to exactly equal the quantity ABI resolved and submitted for it; ABI
SHALL NOT accept a lesser confirmed quantity, whether the close order is still executing or has
already reached a terminal outcome, as sufficient for success.

#### Scenario: An exact match between confirmed execution and resolved exposure gates success
- **WHEN** the requested cycle's own close order, confirmed via its own identity, shows a confirmed
  executed quantity exactly equal to the quantity ABI resolved and submitted for this cycle
- **THEN** ABI proceeds to durably terminalize the cycle

#### Scenario: A confirmed partial execution fails closed rather than being accepted as success
- **WHEN** the requested cycle's own close order is confirmed terminal, but its confirmed executed
  quantity is less than the quantity ABI resolved and submitted for this cycle
- **THEN** ABI returns `close_execution_incomplete`, does not durably terminalize the cycle, and does
  not dispatch a further close order under a new identity

#### Scenario: A definitive zero-execution outcome fails closed the same way a partial one does
- **WHEN** the requested cycle's own close order is confirmed terminal with zero executed quantity
  (rejected or cancelled before any fill)
- **THEN** ABI returns `close_execution_incomplete`, does not durably terminalize the cycle, and does
  not dispatch a further close order under a new or reused identity for this generation

### Requirement: No write in this pipeline is acknowledged without passing the live-execution guard
ABI SHALL NOT report `trade_cycle_closed` when the cancel of the current entry order, or the close
order, was skipped by the existing live-execution guard rather than actually sent to the exchange.

#### Scenario: A skipped write fails the entire close closed
- **WHEN** the live-execution guard reports that a cancel or close write was skipped rather than sent
- **THEN** ABI returns `internal_error` and does not return `trade_cycle_closed`

### Requirement: The durable terminal write is gated on freshly confirmed postconditions and precedes physical scope release
Immediately before durably recording a pair reached through the full pipeline as `terminal_closed`,
ABI SHALL confirm — over a bounded number of fresh attempts, never by resending the close order —
both that the pair's current entry order has no live remainder, and that the requested cycle's own
exposure has actually been closed. For a scope with exactly one active record, the latter means the
live aggregate position size is zero, unchanged from this capability's original behavior. For a scope
with more than one active record, the latter means the requested cycle's own close order (per the
requirements above) is confirmed to have executed exactly the quantity ABI resolved and submitted for
it — never an aggregate-position comparison, which cannot distinguish this request's own effect from
a sibling's concurrent activity. Exhausting the bounded attempts without confirming either fails the
entire close closed. The pair's physical scope SHALL be released only as a consequence of the
terminal write completing — for this path or the `absent`/`terminal_unfilled` promotion alike — never
before it; a crash or failure at any point before it completes SHALL leave the scope held by the same
pair, exactly as if the close request had not been attempted.

#### Scenario: A close order that only takes effect on a later bounded attempt still succeeds
- **WHEN** a bounded verification attempt after the last one finds the expected postcondition
  confirmed, though an earlier attempt did not
- **THEN** ABI proceeds to the terminal write once that later attempt confirms it

#### Scenario: Exhausting the bounded attempts without confirming the expected postcondition fails closed
- **WHEN** every bounded verification attempt fails to confirm the expected postcondition, or the
  verification query itself fails
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

### Requirement: A repeated close request is safely re-drivable without duplicating exchange effect
ABI SHALL re-derive every fact this pipeline needs from durable state and live queries on every close
request, rather than presuming a fact already established by an earlier attempt.

#### Scenario: Repeating after a completed close performs no exchange write
- **WHEN** a close request is repeated for a pair already `terminal_closed`, whether reached via
  the full pipeline, the `absent` promotion, or the `terminal_unfilled` promotion
- **THEN** ABI returns `trade_cycle_closed` without sending any cancel or close order, and without
  writing anything further

#### Scenario: Repeating mid-close does not repeat an already-confirmed step
- **WHEN** a close request is repeated after the current entry order was already confirmed to have
  no live remainder, or after the live position was already confirmed zero
- **THEN** ABI does not resend the corresponding cancel or close order for that already-confirmed fact

#### Scenario: Genuine ambiguity on a repeat still fails closed
- **WHEN** a repeated request cannot confirm a required fact within its bounded attempts
- **THEN** ABI returns `internal_error` rather than presuming a prior attempt succeeded

### Requirement: Close introduces no new cross-pair serialization
ABI SHALL NOT introduce any new lock or queue that serializes a close command for one pair against a
command for a different pair. The existing per-pair lock this capability reuses (see the entry-package
and protection commands it also serializes against) SHALL only ever hold across commands for the same
pair. This does not override any unrelated, pre-existing serialization — such as the correlation
store's own single-writer append ordering — that applies regardless of pair.

#### Scenario: Same-pair commands never interleave
- **WHEN** a close command and an entry-package or protection command for the same pair are submitted
  concurrently
- **THEN** ABI processes them one at a time for that pair

#### Scenario: A different pair is not held by this capability's own locking
- **WHEN** close commands for two pairs whose scopes differ are submitted concurrently
- **THEN** neither pair's processing is made to wait on the other's by any lock this capability
  introduces or reuses for per-pair serialization

### Requirement: Close never affects a sibling cycle sharing the same physical scope
When a scope has more than one active record, closing one of them SHALL NOT durably or observably
change any other active record for that scope: no other record's status, close-order identity,
recorded fill facts, or membership among the scope's active records SHALL change as a result.

#### Scenario: A sibling's record is untouched by closing another cycle
- **WHEN** ABI closes one active record for a scope that has more than one
- **THEN** every other active record for that scope keeps its existing status, close-order identity
  (if any), recorded fill facts, and continued membership among the scope's active records, exactly
  as before the close request

### Requirement: This pipeline reads the requested cycle's entry-order fill facts but never durably rewrites them
Any fresh, read-only query of the requested cycle's own entry order this pipeline performs to resolve
its exposure (for a scope with more than one active record) SHALL be used only in memory for the
current close request. ABI SHALL NOT write its result to the record's `early_execution_observation`
or any other stored field, and SHALL NOT treat this pipeline as one of `virtual-exposure-state`'s
existing durable observation-writing points. This is distinct from, and SHALL NOT be read as
prohibiting, this pipeline's own durable recording of its own close order's identity, which is not a
fact about the entry order at all.

#### Scenario: A multi-owner exposure-resolution query leaves the entry order's durable record unchanged
- **WHEN** ABI resolves a requested cycle's own exposure via a fresh query of its entry order as part
  of closing it
- **THEN** the record's durably stored `early_execution_observation` (and therefore its
  `avg_execution_price`) is bit-for-bit identical before and after the close request completes
