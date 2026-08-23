## ADDED Requirements

### Requirement: Aggregate position is a non-attributable close sanity signal only
Only after neutralizing the requested cycle's entry remainder, resolving its final own exposure, and
confirming its own attributable native Partial protection inactive/terminal or safely absent under the
existing attribution/lifecycle rules, ABI SHALL query and validate the aggregate physical position as a
sanity and feasibility signal. ABI SHALL apply exactly this truth table:

| Own resolved exposure | Aggregate observation | Outcome |
|---|---|---|
| zero | flat | compatible; no close write |
| zero | same-side positive | compatible sibling exposure; no close write |
| zero | opposite-side | fail closed |
| zero | failed or malformed | fail closed |
| positive | flat | contradiction; fail closed |
| positive | same-side size greater than or equal to own exposure | compatible; close may proceed for exact own exposure |
| positive | same-side size smaller than own exposure | fail closed |
| positive | opposite-side | fail closed |
| positive | failed or malformed | fail closed |

Aggregate size SHALL never supply the requested cycle's own quantity and aggregate movement SHALL never
prove close success.

#### Scenario: Zero own exposure is compatible with flat or same-side sibling exposure
- **WHEN** clean exact-own evidence resolves zero exposure and the aggregate is either flat or same-side
  positive
- **THEN** ABI sends no close order and may proceed to terminal postcondition verification

#### Scenario: Positive own exposure requires sufficient same-side aggregate
- **WHEN** own exposure is positive and the aggregate is same-side with size greater than or equal to
  own exposure
- **THEN** ABI may continue using exactly the own exposure as close quantity

#### Scenario: Flat aggregate contradicts positive own exposure
- **WHEN** own exposure is positive but the aggregate is flat
- **THEN** ABI sends no close order and returns a safe failure

#### Scenario: Opposite-side insufficient or invalid aggregate fails closed
- **WHEN** the aggregate is opposite-side, failed, malformed, or same-side but smaller than positive own
  exposure
- **THEN** ABI sends no close order and returns a safe failure

### Requirement: Close deactivates only the requested cycle's attributable native Partial children
After exact own entry neutralization and final own-exposure resolution, but before aggregate sanity or any
market-close dispatch/resend, ABI SHALL freshly resolve the requested cycle's native Partial children
through exact parent linkage and neutralize every own active leg. ABI SHALL cancel only an exact child
`orderId` returned by a clean own attribution result, re-resolve the complete pair after every accepted
cancel because pair cancellation is coupled, and require both own legs inactive/terminal or safely absent
under the existing attribution/lifecycle rules. Ambiguous attribution, a failed cancel, identity drift,
or unconfirmed inactivity SHALL fail the close closed with no close-order write. ABI SHALL NOT use
account-wide or symbol-wide cancellation and SHALL NOT mutate sibling children.

#### Scenario: Own protection is neutralized before positive exposure close
- **WHEN** final own exposure is positive and fresh attribution finds an active own Partial child
- **THEN** ABI cancels only a freshly attributed exact own child identity and re-resolves the pair
- **AND** ABI sends no market-close order until both own legs are confirmed inactive/terminal or safely
  absent

#### Scenario: Zero own exposure still requires protection cleanup
- **WHEN** final own exposure is zero but own attributable protection remains active
- **THEN** ABI neutralizes and confirms that protection before terminalization
- **AND** ABI creates no close identity and sends no market-close order

#### Scenario: Ambiguous or failed cleanup blocks close dispatch
- **WHEN** attribution is ambiguous, a cancel fails, or fresh read-back does not confirm own protection
  inactive/terminal or safely absent
- **THEN** ABI sends no market-close order, does not write `terminal_closed`, and does not report success

#### Scenario: Sibling children remain active and unchanged
- **WHEN** a sibling cycle shares the same symbol and has its own attributable protection pair
- **THEN** closing the requested cycle neither cancels nor amends the sibling's children

## MODIFIED Requirements

### Requirement: Closing acts on the requested cycle's resolved exposure, or sends no write when none exists
For every requested cycle, regardless of active owner count, ABI SHALL resolve that cycle's own
exposure from its exact entry-order fill evidence and dispatch a reduce-only close order for exactly
that quantity under its stable attributable identity only after own protection neutralization and the
aggregate sanity gate both pass. ABI SHALL never infer own exposure from raw aggregate position size,
and SHALL send no close order when clean own evidence proves zero exposure.

#### Scenario: A sole owner closes its own fill-derived exposure
- **WHEN** the requested cycle is the scope's only active owner, has positive own attributable fill,
  and its own protection and aggregate preconditions pass
- **THEN** ABI closes exactly that fill-derived exposure under the cycle's own close identity
- **AND** it does not substitute the aggregate position size

#### Scenario: A shared-scope owner closes only its own exposure
- **WHEN** the requested cycle shares its scope with same-side siblings and its own protection and
  aggregate preconditions pass
- **THEN** ABI closes exactly the requested cycle's own resolved exposure, never a sibling share

#### Scenario: A cycle with zero own exposure sends no close order
- **WHEN** clean exact-own entry evidence proves the requested cycle has zero filled exposure
- **THEN** ABI sends no close order, records no close-order identity, and continues only with own-order
  protection cleanup and terminal verification

#### Scenario: Missing or ambiguous own fill evidence fails closed
- **WHEN** ABI cannot cleanly resolve the requested cycle's own entry executions
- **THEN** ABI sends no close order and does not infer a quantity from the aggregate position

### Requirement: A close order is dispatched under a stable, attributable identity, durably recorded before the exchange call
Before ABI sends any close order for a requested cycle with positive own resolved exposure, regardless
of owner count, it SHALL compute a deterministic close-order identity from the pair identity, fixed
`"close"` role, and current entry-package generation, and SHALL durably record that identity before
the exchange call. This dispatch/resend stage SHALL be unreachable until own protection neutralization
and aggregate sanity have passed. A thrown exception or live-execution-guard skip SHALL NOT revert it.

#### Scenario: Every dispatched close identity is durable first
- **WHEN** ABI dispatches a close order for either a sole owner or a shared-scope owner
- **THEN** the pair's own record already durably carries the close identity used by that call
- **AND** the requested cycle's own protection was freshly confirmed inactive/terminal or safely absent

#### Scenario: A failed or skipped dispatch leaves identity intact
- **WHEN** the exchange call throws or is skipped by the live-execution guard
- **THEN** the recorded close identity remains and ABI returns `internal_error`

### Requirement: ABI never dispatches a second close order for a cycle while a previously dispatched one's fate is unconfirmed
Before dispatching any close order, regardless of owner count, ABI SHALL check for a close identity
already recorded for the current generation and resolve that exact order through fresh bounded reads.
ABI SHALL send no second order while its fate is live or ambiguous. It SHALL reuse the same identity
only when the bounded evidence cleanly proves it was never created. Any resend SHALL still occur only
after the current request has freshly passed own-protection neutralization and aggregate sanity.

#### Scenario: Confirmed execution prevents duplicate dispatch
- **WHEN** the recorded close identity is confirmed to have executed the full resolved own quantity
- **THEN** ABI sends no new close order and proceeds to remaining terminal postconditions

#### Scenario: Live or ambiguous prior identity fails closed
- **WHEN** the recorded close order remains live or cannot be cleanly resolved
- **THEN** ABI sends no new close order and does not terminalize the cycle

#### Scenario: Clean never-created evidence permits same-identity resend
- **WHEN** the full bounded exact-identity observation cleanly proves the recorded close order was never
  created and the current pre-close protection and aggregate gates have passed
- **THEN** ABI may resend the close using that same identity and never computes another identity

### Requirement: The requested cycle's own close order is the exclusive proof that its exposure was closed
For every cycle with positive own resolved exposure, regardless of owner count, ABI SHALL use the
confirmed executed quantity of that cycle's exact own close order as the sole proof of exposure
closure. `terminal_closed` SHALL require exact equality with the own quantity resolved and submitted;
aggregate position movement SHALL NOT prove this cycle's result.

#### Scenario: Exact own close execution gates success
- **WHEN** the requested cycle's close order confirms executed quantity equal to its submitted own
  exposure
- **THEN** ABI may proceed to fresh terminal postcondition verification without any post-close cleanup
  being needed to make sibling exposure safe

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
close order, and the native Partial protection neutralized before close remains inactive/terminal or
safely absent. Zero own exposure requires no close order but still requires exact entry neutralization
and pre-terminal own-protection cleanup. Aggregate flatness is not a terminal precondition when a same-side
sibling remains. Exhaustion, query failure, ambiguity, contradiction, or reappearing active own protection
SHALL fail closed. Scope membership is released only by the durable terminal write.

#### Scenario: Same-side sibling exposure can remain after terminalization
- **WHEN** all requested-cycle postconditions are confirmed but a sibling keeps the aggregate position
  positive on the same side
- **THEN** ABI may write the requested cycle `terminal_closed` while the sibling remains active

#### Scenario: Reappearing or still-active own child blocks terminalization
- **WHEN** final read-back after close finds an attributable own Partial child active or cannot cleanly
  reconfirm the pre-close neutralized state
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
