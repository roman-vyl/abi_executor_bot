## ADDED Requirements

### Requirement: Aggregate position is a non-attributable close sanity signal only
After neutralizing the requested cycle's entry remainder, ABI SHALL query and validate the aggregate
physical position only as a sanity and feasibility signal. A flat aggregate and a clean aggregate on
the requested cycle's side are compatible with continuing; an opposite-side aggregate, malformed
response, failed query, or aggregate size smaller than the cycle's own resolved exposure SHALL fail
closed. ABI SHALL NOT use aggregate size as ownership proof or as the requested cycle's close quantity.

#### Scenario: Same-side sibling aggregate does not prevent own close
- **WHEN** the aggregate position is on the requested cycle's side and includes same-side sibling
  exposure
- **THEN** ABI may continue using only the requested cycle's own resolved exposure as close quantity

#### Scenario: Opposite-side or insufficient aggregate fails closed
- **WHEN** the aggregate position is opposite to the requested cycle, or its size is smaller than the
  cycle's resolved own exposure
- **THEN** ABI sends no close order and returns a safe failure

#### Scenario: Aggregate size never becomes own quantity
- **WHEN** the aggregate position is larger than the requested cycle's own resolved exposure
- **THEN** ABI does not include the excess sibling exposure in the close quantity

### Requirement: Close deactivates only the requested cycle's attributable native Partial children
Before reporting the requested cycle terminally closed, ABI SHALL freshly resolve its native Partial
children through their exact parent linkage and ensure each own active child is inactive or terminal.
ABI SHALL cancel only exact child order identities returned by a clean own attribution result and SHALL
fail closed on ambiguous attribution or unconfirmed cancellation. It SHALL NOT use account-wide or
symbol-wide cancellation and SHALL NOT mutate a sibling cycle's children.

#### Scenario: Own children are cleaned after own exposure closes
- **WHEN** the requested cycle's own close execution is confirmed and its attributed native Partial
  children remain active
- **THEN** ABI cancels only those exact own child identities and verifies they are inactive or terminal
  before returning success

#### Scenario: Ambiguous attribution blocks terminal success
- **WHEN** attached-protection attribution is ambiguous before cleanup or after a cancel acknowledgment
- **THEN** ABI does not write `terminal_closed` and does not report success

#### Scenario: Sibling children remain active and unchanged
- **WHEN** a sibling cycle shares the same symbol and has its own attributable protection pair
- **THEN** closing the requested cycle neither cancels nor amends the sibling's children

## MODIFIED Requirements

### Requirement: Closing acts on the requested cycle's resolved exposure, or sends no write when none exists
For every requested cycle, regardless of active owner count, ABI SHALL resolve that cycle's own
exposure from its exact entry-order fill evidence and dispatch a reduce-only close order for exactly
that quantity under its stable attributable identity. ABI SHALL never infer own exposure from the raw
aggregate position size, and SHALL send no close order when clean own evidence proves zero exposure.

#### Scenario: A sole owner closes its own fill-derived exposure
- **WHEN** the requested cycle is the scope's only active owner and has positive own attributable fill
- **THEN** ABI closes exactly that fill-derived exposure under the cycle's own close identity
- **AND** it does not substitute the aggregate position size

#### Scenario: A shared-scope owner closes only its own exposure
- **WHEN** the requested cycle shares its scope with one or more same-side active siblings
- **THEN** ABI closes exactly the requested cycle's own resolved exposure, never a sibling share

#### Scenario: A cycle with zero own exposure sends no close order
- **WHEN** clean exact-own entry evidence proves the requested cycle has zero filled exposure
- **THEN** ABI sends no close order, records no close-order identity, and continues only with own-order
  cleanup and terminal verification

#### Scenario: Missing or ambiguous own fill evidence fails closed
- **WHEN** ABI cannot cleanly resolve the requested cycle's own entry executions
- **THEN** ABI sends no close order and does not infer a quantity from the aggregate position

### Requirement: A close order is dispatched under a stable, attributable identity, durably recorded before the exchange call
Before ABI sends any close order for a requested cycle with positive own resolved exposure, regardless
of owner count, it SHALL compute a deterministic close-order identity from the pair identity, fixed
`"close"` role, and current entry-package generation, and SHALL durably record that identity before
the exchange call. A thrown exception or live-execution-guard skip SHALL NOT revert it.

#### Scenario: Every dispatched close identity is durable first
- **WHEN** ABI dispatches a close order for either a sole owner or a shared-scope owner
- **THEN** the pair's own record already durably carries the close identity used by that call

#### Scenario: A failed or skipped dispatch leaves identity intact
- **WHEN** the exchange call throws or is skipped by the live-execution guard
- **THEN** the recorded close identity remains and ABI returns `internal_error`

### Requirement: ABI never dispatches a second close order for a cycle while a previously dispatched one's fate is unconfirmed
Before dispatching any close order, regardless of owner count, ABI SHALL check for a close identity
already recorded for the current generation and resolve that exact order through fresh bounded reads.
ABI SHALL send no second order while its fate is live or ambiguous. It SHALL reuse the same identity
only when the bounded evidence cleanly proves it was never created.

#### Scenario: Confirmed execution prevents duplicate dispatch
- **WHEN** the recorded close identity is confirmed to have executed the full resolved own quantity
- **THEN** ABI sends no new close order and proceeds to remaining terminal postconditions

#### Scenario: Live or ambiguous prior identity fails closed
- **WHEN** the recorded close order remains live or cannot be cleanly resolved
- **THEN** ABI sends no new close order and does not terminalize the cycle

#### Scenario: Clean never-created evidence permits same-identity resend
- **WHEN** the full bounded exact-identity observation cleanly proves the recorded close order was never
  created
- **THEN** ABI may resend the close using that same identity and never computes another identity

### Requirement: The requested cycle's own close order is the exclusive proof that its exposure was closed
For every cycle with positive own resolved exposure, regardless of owner count, ABI SHALL use the
confirmed executed quantity of that cycle's exact own close order as the sole proof of exposure
closure. `terminal_closed` SHALL require exact equality with the own quantity resolved and submitted;
aggregate position movement SHALL NOT prove this cycle's result.

#### Scenario: Exact own close execution gates success
- **WHEN** the requested cycle's close order confirms executed quantity equal to its submitted own
  exposure
- **THEN** ABI may proceed to protection-child cleanup and terminal verification

#### Scenario: Partial or zero execution fails closed
- **WHEN** the exact close order terminates with executed quantity below the submitted own exposure
- **THEN** ABI returns `close_execution_incomplete`, does not terminalize the cycle, and does not send
  another close under a new identity

#### Scenario: Aggregate movement cannot substitute for close evidence
- **WHEN** aggregate position size falls by the expected quantity but the requested cycle's own close
  execution is absent or ambiguous
- **THEN** ABI does not report the cycle closed

### Requirement: The durable terminal write is gated on freshly confirmed postconditions and precedes physical scope release
Immediately before writing `terminal_closed`, ABI SHALL freshly confirm over bounded attempts that the
entry order has no live remainder, any positive own exposure was exactly executed by the cycle's own
close order, and no attributable native Partial child remains active. Zero own exposure requires no
close order but still requires exact entry neutralization and own-child cleanup. Aggregate flatness is
not a terminal precondition when a same-side sibling remains. Exhaustion, query failure, ambiguity, or
contradiction SHALL fail closed. Scope membership is released only by the durable terminal write.

#### Scenario: Same-side sibling exposure can remain after terminalization
- **WHEN** all requested-cycle postconditions are confirmed but a sibling keeps the aggregate position
  positive on the same side
- **THEN** ABI may write the requested cycle `terminal_closed` while the sibling remains active

#### Scenario: Active own child blocks terminalization
- **WHEN** the requested cycle's exposure is closed but an attributable own Partial child remains active
- **THEN** ABI does not write `terminal_closed` or return `trade_cycle_closed`

#### Scenario: Exhausted confirmation fails closed
- **WHEN** bounded verification cannot confirm every requested-cycle postcondition
- **THEN** ABI returns no `2xx` and keeps the cycle active

#### Scenario: Scope release never precedes the terminal write
- **WHEN** postconditions are confirmed but the durable terminal write has not completed
- **THEN** the requested cycle remains an active member of the scope

## REMOVED Requirements

### Requirement: The live position is read directly against the pair's owned scope, without a side-match restriction
**Reason**: Closing an arbitrary aggregate position by raw side and size is incompatible with
cycle-owned exposure and could close sibling or opposite-side exposure.

**Migration**: Use aggregate position only under the added sanity/veto requirement and derive every
close quantity and completion proof from exact cycle-owned entry and close evidence.
