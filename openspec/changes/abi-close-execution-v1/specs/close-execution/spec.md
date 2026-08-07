# close-execution Specification

## Purpose
Define how ABI executes a validated `DELETE .../open-position` command for one Runtime-owned
`(strategy_instance_id, trade_cycle_id)` pair: proving its current entry order can no longer add
exposure, closing whatever live position remainder actually exists, and durably terminalizing the
trade cycle — releasing its physical scope only as a consequence of that durable write — before
reporting success.

## ADDED Requirements

### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`; a pair whose record is already durably closed — the same durably-closed
condition `position-scope-exclusivity` uses to release a scope — returns `trade_cycle_closed` directly,
with no exchange call and no ownership check. Every other pair SHALL have its ownership of the scope
its own record names independently reconfirmed via the current scope-ownership state
`position-scope-exclusivity` maintains; any outcome other than this exact pair owning that scope
returns `internal_error`. A resolved scope outside this capability's supported exchange category
returns `unsupported_exchange_scope` before any further step.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: A trade cycle that never held exposure is acknowledged without any exchange call
- **WHEN** the requested pair's record durably proves no position was ever established
- **THEN** ABI returns `trade_cycle_closed` without querying or writing to the exchange

#### Scenario: An already terminally closed trade cycle is acknowledged idempotently
- **WHEN** the requested pair's record is already durably terminally closed by a previous successful
  close
- **THEN** ABI returns `trade_cycle_closed` without querying or writing to the exchange

#### Scenario: Confirmed self-ownership proceeds
- **WHEN** a non-durably-closed pair currently owns the scope its own record names
- **THEN** ABI proceeds to neutralize its current entry order

#### Scenario: An ownership mismatch fails closed
- **WHEN** the scope named by a non-durably-closed pair's record is owned by a different pair, or by
  no pair
- **THEN** ABI returns `internal_error`

### Requirement: The pair's current entry order must be proven unable to increase the position before ABI measures or closes it
Before reading or closing the live position, ABI SHALL establish that the pair's current entry
order — if one is recorded — can no longer add to that position. When no current entry order is
recorded, or it is already known terminal or fully filled, this is established without sending a
cancel. When it is live, unfilled, or partially filled, ABI SHALL send a cancel and then confirm, over
a bounded number of fresh attempts, that no live remainder of that order exists; a fill observed
during that confirmation is not itself a failure. ABI SHALL NOT proceed to read or close the position
while this remains unconfirmed, and any query failure or unresolved outcome within the bounded
attempts fails the entire close request closed. ABI SHALL NOT cancel, query, or otherwise act on any
order it cannot attribute to the requested pair's own current entry order, and SHALL NOT use an
account-wide or symbol-wide cancel operation to establish this.

#### Scenario: No current entry order needs no cancel
- **WHEN** the requested pair's record has no current entry order
- **THEN** ABI proceeds directly to reading the live position

#### Scenario: An already terminal or fully filled entry order needs no cancel
- **WHEN** the current entry order is already known terminal or fully filled
- **THEN** ABI proceeds to reading the live position without sending a cancel

#### Scenario: A live or partially filled entry order is neutralized before ABI proceeds
- **WHEN** the current entry order is live, unfilled, or partially filled
- **THEN** ABI sends a cancel and confirms, before proceeding, that no live remainder of that order
  exists

#### Scenario: A fill observed during the cancel race does not block proceeding
- **WHEN** the current entry order fills, fully or partially, while ABI is confirming its
  cancellation
- **THEN** ABI treats this as a fact to account for when it later reads the live position, not as a
  failure of neutralization by itself

#### Scenario: Ambiguous neutralization blocks the entire close
- **WHEN** ABI cannot confirm, within its bounded attempts, that the current entry order has no live
  remainder
- **THEN** ABI returns `internal_error` and does not read or close the live position

#### Scenario: Close never affects another pair's order
- **WHEN** ABI neutralizes the requested pair's current entry order
- **THEN** ABI does not cancel, query, or otherwise act on any order it cannot attribute to that exact
  pair, even one sharing the same symbol or account

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
pair's owned scope. ABI SHALL NOT source the close quantity or side from the trade cycle's originally
intended entry or from any quantity ABI itself calculated at entry time.

#### Scenario: An already-zero position sends no close order
- **WHEN** the live position size is zero
- **THEN** ABI sends no close order and proceeds directly to final verification

#### Scenario: A live remainder is closed at its actual size and side
- **WHEN** the live position size is greater than zero
- **THEN** ABI sends a reduce-only close order for exactly that live size and that live side

#### Scenario: The recorded intent never governs what is closed
- **WHEN** the live position's size or side differs from the trade cycle's originally intended entry
  or its calculated quantity
- **THEN** ABI still closes exactly the live size and side, never the originally intended values

### Requirement: No write in this pipeline is acknowledged without passing the live-execution guard
ABI SHALL NOT report `trade_cycle_closed` when the cancel of the current entry order, or the close
order, was skipped by the existing live-execution guard rather than actually sent to the exchange.

#### Scenario: A skipped write fails the entire close closed
- **WHEN** the live-execution guard reports that a cancel or close write was skipped rather than sent
- **THEN** ABI returns `internal_error` and does not return `trade_cycle_closed`

### Requirement: Success requires both postconditions freshly confirmed immediately before the terminal write
ABI SHALL NOT perform the durable terminal write, and SHALL NOT report `trade_cycle_closed`, until it
has confirmed — over a bounded number of fresh attempts, never by resending the close order — both
that the live position size is zero and that the pair's current entry order has no live remainder,
confirmed at this point in the pipeline rather than assumed from an earlier step alone. Exhausting the
bounded attempts without confirming either fact fails the entire close closed.

#### Scenario: A close order that only takes effect on a later bounded attempt still succeeds
- **WHEN** a bounded verification attempt after the last one finds the position at zero, though an
  earlier attempt did not
- **THEN** ABI proceeds to the terminal write once that later attempt confirms zero

#### Scenario: Exhausting the bounded attempts without confirming zero fails closed
- **WHEN** every bounded verification attempt fails to confirm the position at zero, or the
  verification query itself fails
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

#### Scenario: Bare order acceptance is not proof of the resulting position
- **WHEN** the exchange has accepted the close order but ABI has not yet verified the resulting
  position size
- **THEN** ABI does not return `trade_cycle_closed`

### Requirement: The durable terminal write precedes and gates physical scope release
ABI SHALL durably record the trade cycle as terminally closed only after both postconditions in the
preceding requirement are confirmed. The pair's physical scope SHALL be released only as a
consequence of that durable write completing, never before it. A crash or failure at any point before
that durable write completes SHALL leave the scope held by the same pair, exactly as if the close
request had not been attempted.

#### Scenario: Scope is not released before the durable write
- **WHEN** both postconditions are confirmed but the durable terminal write has not yet completed
- **THEN** the pair's physical scope is still held by that pair

#### Scenario: Scope is released once the durable write completes
- **WHEN** the durable terminal write completes
- **THEN** the pair's physical scope becomes available to a different pair

#### Scenario: A crash before the durable write leaves the trade cycle re-closeable
- **WHEN** ABI fails or restarts after confirming both postconditions but before the durable terminal
  write completes
- **THEN** the pair's physical scope remains held by that pair, and a later `DELETE` for the same pair
  can still proceed

### Requirement: A repeated close request is safely re-drivable without duplicating exchange effect
ABI SHALL re-derive every fact this pipeline needs from durable state and live queries on every close
request, rather than presuming a fact already established by an earlier attempt. A repeated request
for a pair already terminally closed returns `trade_cycle_closed` from durable state alone; a repeated
request for a pair still mid-close does not resend a cancel or a close order once the corresponding
fact is already confirmed true, and fails closed rather than presuming success on genuine ambiguity.

#### Scenario: Repeating after a completed close performs no exchange write
- **WHEN** a `DELETE` request is repeated for a pair already terminally closed
- **THEN** ABI returns `trade_cycle_closed` without sending any cancel or close order

#### Scenario: Repeating after a confirmed cancel does not cancel again
- **WHEN** a `DELETE` request is repeated after the current entry order was already confirmed to have
  no live remainder
- **THEN** ABI does not send another cancel for that order

#### Scenario: Repeating after a confirmed zero position does not send another close order
- **WHEN** a `DELETE` request is repeated after the live position was already confirmed zero
- **THEN** ABI does not send another close order

#### Scenario: Genuine ambiguity on a repeat still fails closed
- **WHEN** a repeated request cannot confirm a required fact within its bounded attempts
- **THEN** ABI returns `internal_error` rather than presuming a prior attempt succeeded

### Requirement: Same-pair commands are serialized; different pairs remain independent
ABI SHALL serialize a close command against any concurrent entry-package or protection command for the
same pair, so none observes another's partial state. Close commands for different pairs SHALL NOT be
serialized against each other.

#### Scenario: Same-pair commands never interleave
- **WHEN** a close command and an entry-package or protection command for the same pair are submitted
  concurrently
- **THEN** ABI processes them one at a time for that pair

#### Scenario: Different pairs proceed independently
- **WHEN** close commands for two pairs whose scopes differ are submitted concurrently
- **THEN** neither pair's processing is made to wait on the other's by this capability
