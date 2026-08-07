# close-execution Specification

## Purpose
Define how ABI executes a validated `DELETE .../open-position` command for one Runtime-owned
`(strategy_instance_id, trade_cycle_id)` pair: proving its current entry order can no longer add
exposure, closing whatever live position remainder actually exists, and durably terminalizing the
trade cycle as `terminal_closed` — whether or not it ever actually held exposure — releasing its
physical scope only as a consequence of that durable write, before reporting success.

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
its ownership of the scope its own record names independently reconfirmed via the current
scope-ownership state `position-scope-exclusivity` maintains; any outcome other than this exact pair
owning that scope returns `internal_error`. A resolved scope outside this capability's supported
exchange category returns `unsupported_exchange_scope` before any further step.

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

#### Scenario: Confirmed self-ownership proceeds
- **WHEN** a pair whose record is none of `absent`, `terminal_unfilled`, or `terminal_closed`
  currently owns the scope its own record names
- **THEN** ABI proceeds to neutralize its current entry order

#### Scenario: An ownership mismatch fails closed
- **WHEN** the scope named by such a pair's record is owned by a different pair, or by no pair
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

### Requirement: Closing acts on the exact live remainder, or sends no write when none exists
When the live position size is zero, ABI SHALL NOT send any close order. When it is greater than
zero, ABI SHALL close exactly that live size, on that live side, as a reduce-only order against the
pair's owned scope, never a size or side sourced from the trade cycle's originally intended entry or
from any quantity ABI itself calculated at entry time.

#### Scenario: An already-zero position sends no close order
- **WHEN** the live position size is zero
- **THEN** ABI sends no close order and proceeds directly to final verification

#### Scenario: A live remainder is closed at its actual size and side
- **WHEN** the live position size is greater than zero
- **THEN** ABI sends a reduce-only close order for exactly that live size and that live side, even
  when it differs from the trade cycle's originally intended entry or calculated quantity

### Requirement: No write in this pipeline is acknowledged without passing the live-execution guard
ABI SHALL NOT report `trade_cycle_closed` when the cancel of the current entry order, or the close
order, was skipped by the existing live-execution guard rather than actually sent to the exchange.

#### Scenario: A skipped write fails the entire close closed
- **WHEN** the live-execution guard reports that a cancel or close write was skipped rather than sent
- **THEN** ABI returns `internal_error` and does not return `trade_cycle_closed`

### Requirement: The durable terminal write is gated on freshly confirmed postconditions and precedes physical scope release
Immediately before durably recording a pair reached through the full pipeline as `terminal_closed`,
ABI SHALL confirm — over a bounded number of fresh attempts, never by resending the close order —
both that the live position size is zero and that the pair's current entry order has no live
remainder, confirmed at this point in the pipeline rather than assumed from an earlier step alone.
Exhausting the bounded attempts without confirming either fails the entire close closed. The pair's
physical scope SHALL be released only as a consequence of the terminal write completing — for this
path or the `absent`/`terminal_unfilled` promotion alike — never before it; a crash or failure at any
point before it completes SHALL leave the scope held by the same pair, exactly as if the close request
had not been attempted.

#### Scenario: A close order that only takes effect on a later bounded attempt still succeeds
- **WHEN** a bounded verification attempt after the last one finds the position at zero, though an
  earlier attempt did not
- **THEN** ABI proceeds to the terminal write once that later attempt confirms zero

#### Scenario: Exhausting the bounded attempts without confirming zero fails closed
- **WHEN** every bounded verification attempt fails to confirm the position at zero, or the
  verification query itself fails
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

#### Scenario: Scope release never precedes the terminal write
- **WHEN** both postconditions are confirmed but the durable terminal write has not yet completed
- **THEN** the pair's physical scope is still held by that pair; once the write completes, the scope
  becomes available to a different pair

#### Scenario: A crash before the durable write leaves the trade cycle re-closeable
- **WHEN** ABI fails or restarts after confirming both postconditions but before the durable terminal
  write completes
- **THEN** the pair's physical scope remains held by that pair, and a later `DELETE` for the same pair
  can still proceed

### Requirement: A repeated close request is safely re-drivable without duplicating exchange effect
ABI SHALL re-derive every fact this pipeline needs from durable state and live queries on every close
request, rather than presuming a fact already established by an earlier attempt.

#### Scenario: Repeating after a completed close performs no exchange write
- **WHEN** a `DELETE` request is repeated for a pair already `terminal_closed`, whether reached via
  the full pipeline, the `absent` promotion, or the `terminal_unfilled` promotion
- **THEN** ABI returns `trade_cycle_closed` without sending any cancel or close order, and without
  writing anything further

#### Scenario: Repeating mid-close does not repeat an already-confirmed step
- **WHEN** a `DELETE` request is repeated after the current entry order was already confirmed to have
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
