# entry-cycle-recovery-resolution Specification

## Purpose

TBD - Update Purpose after archive: domain logic that resolves one Runtime-owned trade
cycle's exchange ground truth (order + position) for recovery purposes, returning a
terminal outcome only on positive evidence. Distinct from, and never a substitute for,
`open-position-resolution`'s live-truth answer on the normal path.

## Requirements

### Requirement: Recovery resolution starts from the same composite correlation lookup as open-position resolution
ABI SHALL resolve the requested `(strategy_instance_id, trade_cycle_id)` pair using the
existing `EntryPackageCorrelationRepository.get(strategy_instance_id, trade_cycle_id)`
composite-key lookup and no other lookup mechanism.

#### Scenario: Existing record is used for resolution
- **WHEN** a correlation record exists for the requested pair
- **THEN** ABI uses that exact record, and no other, to resolve recovery state

#### Scenario: A missing record fails closed as an ownership mismatch, not as recovery evidence
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI classifies this as an ownership/invariant mismatch and returns
  `unknown_trade_cycle_binding`
- **AND** ABI does NOT resolve any of the four `recovery_state` values from this
- **AND** this response carries no recommendation, documented or implied, that a caller
  may treat it as equivalent to `terminal_without_fill` or any other resolved state — a
  missing record proves only that ABI has no record of this pair, not that no exchange
  side effect could have occurred for it

### Requirement: A durably closed correlation status resolves the matching terminal recovery state directly, with no exchange query
When the correlation record's own `status` is already one of ABI's canonical durably
closed statuses — `absent`, `terminal_unfilled`, or `terminal_closed`, exactly the set
`isDurablyClosedEntryPackageStatus` defines — ABI SHALL resolve the corresponding
terminal recovery state directly from that status, before checking `order_link_id` and
without querying the exchange at all. `absent` and `terminal_unfilled` both resolve
`terminal_without_fill`; `terminal_closed` resolves `terminal_after_fill`. This is
positive evidence, not an inference from absence: each of these statuses is written only
by a previously completed, positively confirmed ABI operation (e.g. a confirmed CANCEL
durably persists `status: "absent"`) — a fact ABI already durably holds about its own
prior write, not a conclusion drawn from an empty or missing exchange query result. Using
it does not weaken the "absence of evidence is never treated as evidence of absence" rule
below; it is the positive-durable-fact case that rule's own reasoning already carves out.
This is the only condition under which recovery resolution requires no exchange query;
every other status proceeds to the order_link_id and dual-query resolution below,
including the case where `order_link_id` is null for a status that is not one of these
three (e.g. `unknown`), which continues to fail safe rather than being inferred terminal.

#### Scenario: A durably absent record resolves terminal_without_fill without any exchange query
- **WHEN** the correlation record's `status` is `absent`
- **THEN** ABI resolves `terminal_without_fill`
- **AND** ABI issues no order query and no position query to resolve it

#### Scenario: A durably terminal-unfilled record resolves terminal_without_fill without any exchange query
- **WHEN** the correlation record's `status` is `terminal_unfilled`
- **THEN** ABI resolves `terminal_without_fill`
- **AND** ABI issues no order query and no position query to resolve it

#### Scenario: A durably terminal-closed record resolves terminal_after_fill without any exchange query
- **WHEN** the correlation record's `status` is `terminal_closed`
- **THEN** ABI resolves `terminal_after_fill`
- **AND** ABI issues no order query and no position query to resolve it

#### Scenario: A lost success response remains recoverable through the record ABI already durably wrote
- **WHEN** a CANCEL (or any other operation) is positively confirmed and durably
  persisted by ABI as one of the three durably closed statuses, but the caller never
  receives that HTTP response (e.g. it is lost in transit)
- **THEN** a later recovery-state query for the same pair still resolves the matching
  terminal state directly from the durable record
- **AND** this holds even though the same write already cleared `order_link_id` to
  `null` — a later recovery-state query is not required to positively re-establish
  through the exchange a fact ABI already durably confirmed itself

#### Scenario: A null order_link_id on a status that is not durably closed still fails safe
- **WHEN** the correlation record's `order_link_id` is `null` but its `status` is not
  `absent`, `terminal_unfilled`, or `terminal_closed` (e.g. `unknown`)
- **THEN** ABI does NOT resolve any terminal state from this alone
- **AND** ABI fails safe, exactly as it would for any other inconclusive attempt — a
  null `order_link_id` alone, without one of the three durably closed statuses, is never
  broadly interpreted as terminal

### Requirement: Recovery resolution classifies the trade cycle into exactly one of four states, or fails safe on contradictory or incomplete evidence
Given an existing correlation record whose `status` is not already one of the three
durably closed statuses resolved directly above, ABI SHALL resolve exactly one of:
`entry_order_live`, `position_open`, `terminal_without_fill`, or `terminal_after_fill` —
or, when it cannot positively establish one of those four from non-contradictory
evidence, ABI SHALL fail safe rather than resolve anything.

Every state SHALL be resolved primarily from this specific trade cycle's own durable/
order/execution evidence — its own entry order (identified by its own `order_link_id`)
and, when that order proves a fill, its own close order (identified by its own
`close_order_link_id`, when one has been durably recorded) — never from the aggregate
physical position query as a required, co-equal signal. The aggregate physical position
query SHALL be retained only as a narrow, state-appropriate sanity check that can block a
resolution this cycle's own evidence would otherwise positively support, and SHALL NEVER
be required to positively confirm a specific state (existence, flatness, or side) as a
precondition for `entry_order_live` or `terminal_without_fill`, and SHALL NEVER be
consulted at all when resolving `terminal_after_fill`. This reflects that a physical
scope may be shared by more than one same-side trade cycle: a sibling cycle's own
activity is visible in the same aggregate query and SHALL NOT prevent, delay, or alter
this cycle's own resolution.

`entry_order_live` and `terminal_without_fill` each resolve directly from a positive
own-order-query finding (a live, unfilled order; or a terminal order with zero
cumulative fill, respectively). Each fails safe if the aggregate physical position query
positively confirms an open position on the side opposite this record's own
`desired_entry.side` — a genuine structural invariant violation (same-side-only sharing),
never a normal condition of a same-side sibling sharing the scope. A same-side aggregate
position, no aggregate position at all, or an inconclusive/failed aggregate query are all
compatible with resolving either state from own evidence alone.

`position_open` and `terminal_after_fill` are resolved once the own-order query
positively observes a fill (fully or partially filled). Which of the two resolves SHALL
be determined by this cycle's own `close_order_link_id`:
- If `close_order_link_id` is not durably recorded for this cycle, ABI SHALL resolve
  `position_open`, sourcing `average_entry_price` from this cycle's own order-query
  response and `first_fill_at_ms` from this cycle's own durable first-fill capture (the
  same durable, immutable, capture-once value and mechanism `open-position-resolution`
  establishes for the identical field) — never from the aggregate position row. This
  resolution fails safe unless the aggregate physical position query positively confirms
  an existing position on the matching side (existence-only sanity, mirroring
  `open-position-resolution`'s own aggregate-sanity check for the identical purpose — not
  proof this cycle exclusively owns that position, only that a matching-side exposure
  genuinely exists).
- If `close_order_link_id` is durably recorded for this cycle, ABI SHALL classify that
  order's own current state using the same exact-quantity-matching strictness
  `close-execution` already uses to confirm its own dispatch fully succeeded (terminality,
  then this cycle's own close order's confirmed cumulative fill compared exactly against
  this cycle's own entry order's confirmed cumulative fill) — never the coarser "any fill
  occurred" check this capability uses to classify the entry order itself, and never the
  aggregate. A positively confirmed **exact** quantity match on this cycle's own close
  order resolves `terminal_after_fill`, with no fill facts in the response and with no
  aggregate physical position query consulted at all for this determination — this
  cycle's own two-order evidence chain (its entry order's own confirmed fill, its close
  order's own confirmed matching fill) is sufficient by itself and is never overridden or
  reinterpreted by a same-side sibling's own aggregate contribution. A positively
  confirmed terminal state with zero fill on this cycle's own close order (the close
  attempt was rejected or otherwise never executed) resolves `position_open` instead,
  using the same sourcing and the same aggregate existence-only sanity check as the
  no-close-attempted case above. A positively confirmed terminal state with a fill that
  does **not** exactly match this cycle's own expected close quantity (a genuine, unresolved
  partial close) SHALL NOT resolve either `position_open` or `terminal_after_fill` — ABI
  fails safe, since neither state correctly describes an exposure that was only partially
  reduced by an unconfirmed amount. Any other finding for this cycle's own close order
  (still live, not found, or inconclusive) SHALL NOT resolve either state — ABI fails safe,
  exactly as it would for any other not-yet-established evidence.

A fill signal on the entry order's own query without a positive determination of the
close order's own fate (when one is durably recorded) is never sufficient by itself to
resolve `position_open` or `terminal_after_fill`.

#### Scenario: A live, unfilled order resolves to entry_order_live regardless of a same-side sibling's own open position
- **WHEN** the own-order query positively finds this cycle's own entry order in a live,
  unfilled state, no close order is durably recorded for this cycle, and the aggregate
  physical position query positively confirms an open position on the matching side
  (belonging to a same-side sibling cycle sharing the same physical scope)
- **THEN** ABI resolves `entry_order_live`
- **AND** the sibling's own open position does not block, delay, or alter this resolution

#### Scenario: A terminal order with zero fill resolves to terminal_without_fill regardless of a same-side sibling's own open position
- **WHEN** the own-order query positively finds this cycle's own entry order terminal with
  zero cumulative fill, no close order is durably recorded for this cycle, and the
  aggregate physical position query positively confirms an open position on the matching
  side (a same-side sibling's own exposure)
- **THEN** ABI resolves `terminal_without_fill`
- **AND** the sibling's own open position does not block, delay, or alter this resolution

#### Scenario: An opposite-side aggregate finding fails safe for entry_order_live or terminal_without_fill
- **WHEN** the own-order query positively supports `entry_order_live` or
  `terminal_without_fill`, and the aggregate physical position query positively confirms
  an open position on the side opposite this record's own `desired_entry.side`
- **THEN** ABI does NOT resolve either state — this is a genuine invariant violation, not
  a normal shared-scope condition
- **AND** ABI fails safe instead

#### Scenario: A fill with no close attempted resolves to position_open, sourced from this cycle's own evidence
- **WHEN** the own-order query positively observes a fill (fully or partially filled), no
  close order is durably recorded for this cycle (`close_order_link_id` is absent), and
  the aggregate physical position query positively confirms an existing position on the
  matching side
- **THEN** ABI resolves `position_open`
- **AND** `average_entry_price` is read from this cycle's own order-query response, never
  from the aggregate row
- **AND** `first_fill_at_ms` is this cycle's own durably captured value (reused if already
  present, captured once via the same mechanism `open-position-resolution` establishes if
  not), never the aggregate row's own time field
- **AND** this holds regardless of whether any other same-side cycle also has a position
  on the same matching side

#### Scenario: A fill with no close attempted fails safe when the aggregate cannot confirm a matching position
- **WHEN** the own-order query positively observes a fill, no close order is durably
  recorded for this cycle, and the aggregate physical position query does not positively
  confirm an existing position on the matching side (no position at all, a query failure,
  or a wrong-side position)
- **THEN** ABI does NOT resolve `position_open` from this cycle's own fill evidence alone
- **AND** ABI fails safe instead — this is a genuine contradiction between this cycle's
  own evidence and physical reality, not a normal shared-scope condition

#### Scenario: A fill with the cycle's own close order confirmed an exact quantity match resolves to terminal_after_fill, with no aggregate consultation, regardless of a same-side sibling's own open position
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and classifying that close order's own current state (using the
  same exact-quantity-matching strictness `close-execution` already uses) positively
  confirms its own confirmed cumulative fill exactly matches this cycle's own entry
  order's confirmed cumulative fill
- **THEN** ABI resolves `terminal_after_fill`
- **AND** ABI does not query, or use in any way, the aggregate physical position query to
  reach this determination
- **AND** this holds even when the aggregate physical position query would positively
  report an open position on the matching side belonging to a same-side sibling cycle —
  the sibling's own open position never causes this cycle to be mis-resolved as
  `position_open`

#### Scenario: A fill with the cycle's own close order confirmed rejected (zero fill) resolves to position_open
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and classifying that close order's own current state positively
  confirms it is terminal with zero fill (the close attempt was rejected or otherwise
  never executed)
- **THEN** ABI resolves `position_open`, sourced and sanity-checked exactly as the
  no-close-attempted case above (this cycle's own order-query response for
  `average_entry_price`, this cycle's own durable capture for `first_fill_at_ms`,
  aggregate existence-only sanity on the matching side)

#### Scenario: A partial fill on the cycle's own close order fails safe rather than resolving either state
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and classifying that close order's own current state positively
  confirms it is terminal with a fill that does NOT exactly match this cycle's own entry
  order's confirmed cumulative fill
- **THEN** ABI does NOT resolve `position_open` (some of this cycle's own exposure was
  reduced, so reporting it as still fully open would be wrong) and does NOT resolve
  `terminal_after_fill` (the reduction is not confirmed complete)
- **AND** ABI fails safe instead, regardless of what the aggregate physical position query
  reports

#### Scenario: A fill with the cycle's own close order not yet positively resolved fails safe
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and classifying that close order's own current state does not
  positively confirm any of: an exact quantity match, a zero-fill terminal state, or a
  partial (non-matching) fill — it is still live, genuinely not found, or the
  classification is otherwise inconclusive
- **THEN** ABI does NOT resolve `position_open` or `terminal_after_fill` from this attempt
- **AND** ABI fails safe instead, regardless of what the aggregate physical position query
  reports

#### Scenario: A fill-carrying order response with no usable average price fails safe
- **WHEN** the own-order query positively observes a fill, and would otherwise resolve
  `position_open`, but that response carries no usable average execution price
- **THEN** ABI does NOT resolve `position_open` with a fabricated, estimated, or
  aggregate-sourced `average_entry_price`
- **AND** ABI fails safe instead

#### Scenario: An unresolvable first-fill capture fails safe rather than resolving position_open
- **WHEN** ABI would otherwise resolve `position_open`, this cycle's own `first_fill_at_ms`
  is not yet durably captured, and the one-time capture of this cycle's own entry order's
  own executions cannot positively establish a value
- **THEN** ABI does NOT resolve `position_open` with a fabricated, omitted, or
  aggregate-sourced `first_fill_at_ms`
- **AND** ABI fails safe instead

### Requirement: Absence of evidence is never treated as evidence of absence
ABI SHALL NOT resolve `terminal_without_fill` or any other state from an empty,
unavailable, or inconclusive query. Specifically: if the realtime order query, the
history order query, and the position query all complete cleanly but find nothing (no
live order, no history match, no open position), that combination is not evidence that
the order never filled — it is indistinguishable from evidence that has simply aged out
of what a current query can still see. ABI SHALL treat this identically to a genuine
query failure: it fails safe, using the same response shape already used when a query
fails or returns a malformed result, and resolves none of the four states. This rule has
no time component — there is no elapsed-time threshold past which a clean-but-empty
result becomes acceptable evidence; it is never acceptable evidence, at any age.

#### Scenario: A clean-but-empty result everywhere is never terminal_without_fill
- **WHEN** the realtime order query, the history order query, and the position query all
  complete cleanly and each finds nothing
- **THEN** ABI fails safe, using the same response as a query failure
- **AND** ABI does NOT resolve `terminal_without_fill`

#### Scenario: A query failure or malformed response never resolves any state
- **WHEN** the order query or the position query fails, times out, or returns a
  structurally malformed response
- **THEN** ABI SHALL NOT resolve any of the four states from that attempt
- **AND** ABI fails safe, and the caller retries later

#### Scenario: A positive finding is always honored, regardless of how long the binding has existed
- **WHEN** the order or position query positively finds the order still live, filled, or
  the position open — no matter how long ago `current_binding_started_at` was
- **THEN** ABI resolves the state that finding supports
- **AND** no elapsed-time check ever suppresses or overrides a positive finding

### Requirement: The applied entry package is included only for the two live-truth states
For `entry_order_live` and `position_open`, ABI SHALL include the correlation record's
`desired_entry` and `calculated_quantity`, already durably stored, as the resolved
`AppliedEntryPackage`. For `terminal_without_fill` and `terminal_after_fill`, ABI SHALL
NOT include an `AppliedEntryPackage`.

#### Scenario: Live states include the applied entry package
- **WHEN** ABI resolves `entry_order_live` or `position_open`
- **THEN** the response includes `applied_desired_entry` and `calculated_quantity` from
  the correlation record, without requiring the caller to have remembered them

#### Scenario: Terminal states omit the applied entry package
- **WHEN** ABI resolves `terminal_without_fill` or `terminal_after_fill`
- **THEN** the response does not include an `AppliedEntryPackage`

### Requirement: A binding left mid-amend by a legacy pending_action never resolves a live-truth state
A durable store may still contain a binding written by a pre-`abi-entry-cycle-recovery-v1`
version of this service with `pending_action` `"amend"` or `"cancel_and_create"` (see
`entry-package-execution`'s `LegacyEntryPackagePendingAction`). The old in-place-amend
write path durably persisted the record's new `desired_entry` *before* sending the amend,
while reusing the same `order_link_id` the prior `desired_entry` was already bound to — so
for such a record, a live order found under that `order_link_id` may still physically be
the pre-amend entry, not the stored `desired_entry`. ABI SHALL NOT resolve
`entry_order_live` or `position_open` — the two states that include `AppliedEntryPackage`
— for a record whose `pending_action` is `"amend"` or `"cancel_and_create"`, since doing so
could report a replacement entry the exchange may never have actually applied. ABI SHALL
fail safe (the same response already used for any other unresolvable attempt) instead.
This limitation applies only to the two `AppliedEntryPackage`-carrying states: a legacy
`pending_action` does NOT prevent `terminal_without_fill` or `terminal_after_fill` from
resolving, since neither carries `AppliedEntryPackage` and both already require positive
evidence via this capability's existing rules. No separate legacy recovery state machine
is introduced to disambiguate the pre-amend and post-amend entries.

#### Scenario: A legacy amend-pending binding with a live order and no position fails safe rather than reporting entry_order_live
- **WHEN** a correlation record's `pending_action` is `"amend"` (or `"cancel_and_create"`),
  the order query positively finds the order live and unfilled, and the position query
  positively finds no open position
- **THEN** ABI does NOT resolve `entry_order_live`, and does NOT include the record's
  `desired_entry` as `AppliedEntryPackage`
- **AND** ABI fails safe instead

#### Scenario: A legacy amend-pending binding with a fill confirmed by an open position fails safe rather than reporting position_open
- **WHEN** a correlation record's `pending_action` is `"amend"` (or `"cancel_and_create"`),
  the order query positively observes a fill, and the position query positively confirms
  an open position on the matching side
- **THEN** ABI does NOT resolve `position_open`, and does NOT include the record's
  `desired_entry` as `AppliedEntryPackage`
- **AND** ABI fails safe instead

#### Scenario: A legacy amend-pending binding still resolves a positively-proven terminal state
- **WHEN** a correlation record's `pending_action` is `"amend"` (or `"cancel_and_create"`),
  and the order and position queries otherwise positively agree on
  `terminal_without_fill` or `terminal_after_fill` per this capability's existing rules
- **THEN** ABI resolves that terminal state normally — neither terminal state includes
  `AppliedEntryPackage`, so the legacy-amend ambiguity does not apply to them

### Requirement: Recovery resolution never causes an exchange side effect
Resolving recovery state SHALL be read-only with respect to the exchange. ABI SHALL NOT
cancel, amend, or create any order as part of resolving recovery state.

#### Scenario: Resolution issues no exchange write
- **WHEN** ABI resolves any of the four recovery states, or fails safe
- **THEN** ABI SHALL NOT send any create, amend, or cancel request to the exchange as
  part of that resolution

#### Scenario: Read-only exchange queries and ABI's own local durable write are not exchange side effects
- **WHEN** resolving a trade cycle's state requires querying this cycle's own close
  order's current state, or querying this cycle's own entry order's own executions (to
  capture `first_fill_at_ms` for the first time) and durably saving the captured value to
  ABI's own correlation record
- **THEN** none of these — the close-order query, the execution-history query, or ABI's
  own local durable write — is a violation of this requirement — "exchange side effect"
  in this requirement refers exclusively to a create, amend, or cancel request sent to the
  exchange, exactly as this requirement's own text and the preceding scenario already
  state

### Requirement: Recovery Convergence is a separate, pure decision from Recovery Resolution
Once Recovery Resolution has already positively resolved one of the five recovery outcomes
(`entry_order_live`, `position_open`, `terminal_without_fill`, `terminal_after_fill`,
`entry_order_not_found`) for a given `(strategy_instance_id, trade_cycle_id)` pair, ABI
SHALL evaluate a separate, pure Recovery Convergence decision — given only the resolved
outcome, the current correlation record, and a caller-supplied timestamp — that determines
whether the durable correlation record's `status` (and, where specified, `pending_action`
and related fields) SHALL converge toward that proven outcome, or SHALL remain unchanged
(`no_change`). The Convergence decision function itself SHALL NOT query the exchange, SHALL
NOT acquire the per-pair mutex, SHALL NOT write to the correlation repository directly, and
SHALL NOT read the system clock itself — those remain the responsibility of the existing
application-layer call site, exactly as they are today for the existing `first_fill_at_ms`
capture.

#### Scenario: Convergence never runs for a durably-closed record
- **WHEN** the correlation record's `status` is already `absent`, `terminal_unfilled`, or
  `terminal_closed`
- **THEN** Recovery Resolution answers directly from that status, as it already does today
- **AND** Recovery Convergence is never evaluated and no durable write beyond what already
  happens today occurs

#### Scenario: Convergence never runs when Resolution fails safe
- **WHEN** Recovery Resolution cannot positively establish one of the five outcomes
- **THEN** Recovery Convergence is never invoked
- **AND** the correlation record's `status` remains exactly as it was

### Requirement: A resolved outcome converges only the exact binding it was resolved against
Recovery Resolution's bounded exchange queries take place against a specific record
snapshot read before the pair mutex is acquired (Resolution's own existing, unmodified
behavior). Between that read and the mutex being acquired for convergence, the same
`(strategy_instance_id, trade_cycle_id)` pair's binding MAY have durably changed — including
to a new generation with a new `order_link_id` — through the entry-package execution path's
own existing lifecycle (e.g. the prior binding reaching `absent` and a subsequent PUT
establishing a new one). A resolved outcome describes only the exact binding it was proven
against, never the pair in the abstract. Before evaluating the convergence decision against
the fresh, under-lock record, ABI SHALL verify that the fresh record's `generation` and
`order_link_id` are identical to the record's `generation` and `order_link_id` at the time
Resolution resolved the outcome. If either has changed, ABI SHALL NOT evaluate or apply any
convergence for that outcome — it SHALL return the existing fail-safe `internal_error`
response, and the fresh record (the new binding) SHALL be left entirely untouched. This
guard applies to all five outcomes uniformly, including `entry_order_not_found`, whose own
upstream eligibility gate is evaluated against the pre-lock record and therefore does not,
by itself, prove anything about a binding that has since changed.

#### Scenario: A generation change between resolution and the lock prevents convergence
- **WHEN** Recovery Resolution resolves an outcome against a record at `generation` N with
  `order_link_id` A, and by the time the pair mutex is acquired the fresh record is at
  `generation` N+1 with a different `order_link_id` B (e.g. the prior binding reached
  `absent` and a new PUT established a new binding in the interim)
- **THEN** ABI does NOT evaluate or apply any convergence decision
- **AND** ABI returns the existing fail-safe `internal_error` response
- **AND** the fresh record (generation N+1 / `order_link_id` B) remains entirely unchanged
  by this recovery attempt
- **AND** a subsequent recovery call resolves fresh evidence against the new binding on its
  own terms

#### Scenario: An unchanged binding proceeds to convergence normally
- **WHEN** the fresh, under-lock record's `generation` and `order_link_id` are identical to
  those of the record the outcome was resolved against
- **THEN** ABI proceeds to evaluate the convergence decision against the fresh record,
  exactly as already specified elsewhere in this capability

### Requirement: A proven live-truth outcome converges an eligible non-durably-closed record to applied
When Recovery Resolution positively resolves `entry_order_live` or `position_open` for a
correlation record whose `status` is not durably closed, and whose `pending_action` is
`null` or `"create"`, ABI SHALL durably converge `status` to `"applied"`. If
`pending_action` was `"create"`, ABI SHALL also clear it to `null` in the same write. **This
convergence SHALL apply only when the record's `order_id` is already non-null in the fresh,
under-lock-read record — for BOTH `entry_order_live` and `position_open` alike, not
`entry_order_live` alone.** A record whose `order_id` is still `null` (i.e. `pending_create`)
SHALL NOT converge from either outcome. This durable write SHALL be evaluated against the
correlation record re-read fresh under the pair mutex, after acquiring the lock and before
evaluating the convergence decision — not against the outer, unlocked snapshot the outcome
was originally resolved against. For `position_open`, ABI SHALL continue to capture
`first_fill_at_ms` exactly as it already does today (capture-once, immutable), in the same
locked write as the `status` convergence when both apply. **If the durable write changes
`status` and/or `pending_action` and fails, ABI SHALL return the existing fail-safe
`internal_error` response instead of the positive resolved outcome, and the record SHALL
remain unconverged for the next recovery attempt.**

#### Scenario: An unknown-status record with a proven fill converges to applied
- **WHEN** a correlation record's `status` is `unknown`, `pending_action` is `null`,
  `order_id` is non-null, and Recovery Resolution positively resolves `position_open`
- **THEN** ABI durably converges `status` to `"applied"` in the same write that captures
  `first_fill_at_ms`
- **AND** a subsequent `GET .../open-position` for the same pair no longer fails solely
  because of the previously stale `unknown` status

#### Scenario: An unknown-status record with a proven live unfilled order converges to applied
- **WHEN** a correlation record's `status` is `unknown`, `pending_action` is `null`,
  `order_id` is non-null, and Recovery Resolution positively resolves `entry_order_live`
- **THEN** ABI durably converges `status` to `"applied"`

#### Scenario: A pending-create ambiguity proven to have landed converges to applied and clears the pending create
- **WHEN** a correlation record's `pending_action` is `"create"`, `order_id` is non-null,
  and Recovery Resolution positively resolves `entry_order_live` or `position_open`
- **THEN** ABI durably converges `status` to `"applied"` and `pending_action` to `null`

#### Scenario: A pending-create ambiguity with no confirmed order_id does not converge from either live-truth outcome
- **WHEN** a correlation record's `status` is `pending_create`, `order_id` is `null`, and
  Recovery Resolution positively resolves `entry_order_live` OR `position_open`
- **THEN** ABI does NOT converge `status` for either outcome — the record remains unchanged
- **AND** this is a deliberate, deferred boundary, applied symmetrically to both outcomes,
  not a failure or an oversight

#### Scenario: A failed durable write during status convergence never returns the positive outcome
- **WHEN** Recovery Resolution positively resolves `entry_order_live` or `position_open`,
  Recovery Convergence decides to converge `status` (and/or `pending_action`), and the
  durable write fails
- **THEN** ABI returns the existing fail-safe `internal_error` response, NOT
  `entry_order_live`/`position_open`
- **AND** the correlation record's `status`/`pending_action` remain exactly as they were
  before the attempt, so the next recovery call retries convergence from the same starting
  point

#### Scenario: A race between the outer resolution read and the lock is resolved by re-evaluating against the fresh record
- **WHEN** the correlation record's `pending_action` or `order_id` changes between
  Recovery Resolution's own outer, unlocked read and the pair mutex being acquired for the
  convergence write
- **THEN** ABI evaluates the convergence decision against the record re-read fresh under
  the lock, not against the outer snapshot the outcome was originally resolved against
- **AND** a guard that would exclude convergence under the fresh record (e.g. a
  `pending_action` that became `"cancel"` in the interim) is honored, even though the outer
  snapshot would have permitted convergence

#### Scenario: An in-flight cancel intent is never silently overridden by a live-truth outcome
- **WHEN** a correlation record's `pending_action` is `"cancel"`, and Recovery Resolution
  positively resolves `entry_order_live` or `position_open`
- **THEN** ABI does NOT converge `status`
- **AND** `pending_action` remains `"cancel"`, unchanged

#### Scenario: A legacy pending_action never reaches convergence for a live-truth outcome
- **WHEN** a correlation record's `pending_action` is `"amend"` or `"cancel_and_create"`
- **THEN** Recovery Resolution does not resolve `entry_order_live` or `position_open` for
  it (existing, unmodified behavior)
- **AND** Recovery Convergence is correspondingly never invoked for either outcome on this
  record

### Requirement: A proven terminal-without-fill outcome converges an eligible record to terminal_unfilled
When Recovery Resolution positively resolves `terminal_without_fill` for a correlation
record whose `status` is not durably closed and whose `pending_action` is `null` or
`"create"`, ABI SHALL durably converge `status` to `"terminal_unfilled"`, clear
`pending_action` to `null` if it was `"create"`, and append a `binding_history` closing
entry using the same `closeBindingFrom(record, "exchange_terminal", now)` construction
`entry-package-execution`'s own existing `terminal_without_fill` write already uses for its
own call site — never a second, divergent construction.

#### Scenario: An unknown-status record proven terminal without fill converges to terminal_unfilled
- **WHEN** a correlation record's `status` is `unknown`, `pending_action` is `null`, and
  Recovery Resolution positively resolves `terminal_without_fill`
- **THEN** ABI durably converges `status` to `"terminal_unfilled"`
- **AND** ABI appends a `binding_history` entry via the existing `closeBindingFrom` helper,
  matching the shape `entry-package-execution`'s own equivalent write already produces

#### Scenario: An in-flight cancel intent is left to its own dedicated confirmation path
- **WHEN** a correlation record's `pending_action` is `"cancel"`, and Recovery Resolution
  positively resolves `terminal_without_fill`
- **THEN** ABI does NOT converge `status` via this mechanism
- **AND** the existing dedicated cancel-confirmation path remains the sole writer for this
  transition on this record

### Requirement: A proven terminal-after-fill outcome converges an eligible record to terminal_closed
When Recovery Resolution positively resolves `terminal_after_fill` for a correlation record
whose `status` is not durably closed and whose `pending_action` is `null`, ABI SHALL
durably converge `status` to `"terminal_closed"`, reusing exactly the same durable write
shape `close-execution`'s own existing terminal-closed confirmation already produces —
never a second, divergent construction — and SHALL capture `first_fill_at_ms` if not
already durably set, using the same existing capture-once mechanism.

#### Scenario: An unknown-status record proven terminal after fill converges to terminal_closed
- **WHEN** a correlation record's `status` is `unknown`, `pending_action` is `null`, a
  `close_order_link_id` is durably recorded, and Recovery Resolution positively resolves
  `terminal_after_fill`
- **THEN** ABI durably converges `status` to `"terminal_closed"`, matching the exact write
  shape `close-execution` already uses for its own confirmed-close write

#### Scenario: Any non-null pending_action prevents this convergence
- **WHEN** a correlation record's `pending_action` is non-null and Recovery Resolution
  positively resolves `terminal_after_fill`
- **THEN** ABI does NOT converge `status`

### Requirement: A proven entry-order-not-found outcome converges the eligible ambiguous-CREATE record to absent
When Recovery Resolution positively resolves `entry_order_not_found` — an outcome whose own
eligibility is already fully gated by the existing ambiguous-CREATE predicate (`status` in
`{pending_create, unknown}`, `pending_action` exactly `"create"`, no durable fill, close
identity, or observation) — ABI SHALL durably converge `status` to `"absent"` and clear
`order_link_id`, `order_id`, and `pending_action` to `null`, reusing exactly the same
durable write shape ABI's existing successful-CANCEL confirmation already produces for
`status:"absent"` — never a second, divergent construction. ABI SHALL NOT extend this
convergence, or any equivalent inference, to a record with a durably recorded fill, close
identity, or a `pending_action` other than `"create"` — that topology is entirely excluded
by the outcome's own existing upstream eligibility gate and remains untouched by this
convergence.

#### Scenario: An ambiguous-CREATE record proven absent converges to absent
- **WHEN** Recovery Resolution positively resolves `entry_order_not_found` for an eligible
  record
- **THEN** ABI durably converges `status` to `"absent"`, `order_link_id` to `null`,
  `order_id` to `null`, and `pending_action` to `null`
- **AND** this write shape is identical to the existing successful-CANCEL confirmation's
  own `status:"absent"` write

### Requirement: A failed status-changing durable write never yields a positive response, for every convergence outcome
For every convergence transition defined in this capability (`entry_order_live`/
`position_open` → `applied`, `terminal_without_fill` → `terminal_unfilled`,
`terminal_after_fill` → `terminal_closed`, `entry_order_not_found` → `absent`), ABI SHALL
evaluate the Recovery Convergence decision against the correlation record re-read fresh
under the pair mutex — acquired after Recovery Resolution's own outcome is resolved and
before the convergence decision is evaluated, not merely before its write is applied. When
the resulting decision durably changes `status` and/or `pending_action` and the underlying
repository write fails, ABI SHALL return the existing fail-safe `internal_error` response
instead of the outcome that would otherwise have been positive, and the correlation
record SHALL remain unconverged, exactly as it was, for the next recovery attempt to retry.
This rule applies uniformly to all five outcomes' convergence transitions; it does not
apply to the pre-existing, unmodified `first_fill_at_ms`-only capture that occurs when
`status` is already `"applied"` and no lifecycle field is changing — a failure of that
narrower, pre-existing capture continues to return the already-true resolved outcome
unchanged, exactly as it does today.

#### Scenario: A failed terminal-status write never returns the positive terminal outcome
- **WHEN** Recovery Resolution positively resolves `terminal_without_fill`,
  `terminal_after_fill`, or `entry_order_not_found`, Recovery Convergence decides to
  converge `status` accordingly, and the durable write fails
- **THEN** ABI returns the existing fail-safe `internal_error` response, not the resolved
  terminal outcome
- **AND** the correlation record's `status` remains exactly as it was before the attempt

#### Scenario: A pre-existing field-only capture failure is unaffected by this rule
- **WHEN** a correlation record's `status` is already `"applied"`, Recovery Resolution
  positively resolves `position_open`, and only the pre-existing `first_fill_at_ms` capture
  (no `status`/`pending_action` change) fails to durably write
- **THEN** ABI still returns `position_open`, exactly as this pre-existing capture behavior
  already does today

### Requirement: Convergence is idempotent under repeated recovery
Recovery Convergence SHALL be a pure function of the currently-resolved outcome and the
current correlation record. Recovering the same `(strategy_instance_id, trade_cycle_id)`
pair any number of times, with no change in underlying exchange evidence, SHALL produce
`no_change` on every call after the first successful convergence, and SHALL produce
`no_change` (never a partial or duplicate write) on every call while evidence remains
insufficient.

#### Scenario: Repeated recovery while evidence is insufficient causes no writes
- **WHEN** the same unresolved pair is recovered multiple times in a row and Recovery
  Resolution fails safe every time
- **THEN** no durable write occurs on any of those calls

#### Scenario: Repeated recovery after convergence is a no-op
- **WHEN** a pair has already converged (e.g. `status` is now `applied`,
  `pending_action` is `null`) and is recovered again with the same outcome resolving
  positively
- **THEN** Recovery Convergence decides `no_change`
- **AND** no further durable write occurs

### Requirement: Convergence never uses the aggregate physical position as ownership proof
Recovery Convergence SHALL base every durable transition exclusively on the outcome
Recovery Resolution already derived from this cycle's own pair-scoped order, close-order,
and execution evidence. Recovery Convergence SHALL NOT itself query, or otherwise use, the
aggregate physical position as a basis for any durable transition; any aggregate-position
consultation remains exclusively Recovery Resolution's own existing narrow veto, applied
before Recovery Convergence is ever invoked.

#### Scenario: A same-side sibling's own aggregate exposure never causes or blocks a convergence decision
- **WHEN** Recovery Resolution has already positively resolved an outcome for this cycle's
  own pair-scoped evidence, regardless of what a same-side sibling cycle's own activity
  shows in the aggregate physical position
- **THEN** Recovery Convergence's decision depends only on that already-resolved outcome
  and the current correlation record, never on a fresh or cached aggregate-position read
