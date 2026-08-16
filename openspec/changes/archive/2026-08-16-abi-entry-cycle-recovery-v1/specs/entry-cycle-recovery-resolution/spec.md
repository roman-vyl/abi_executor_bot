## ADDED Requirements

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
evidence, ABI SHALL fail safe rather than resolve anything. Resolution SHALL combine a
bounded order query (realtime and history, using the same fill-priority classification
already used to confirm package application) with a bounded position query, following
the same dual-query, bounded-retry pattern `close-execution` already uses to verify both
postconditions of a close. This dual-query, bounded-retry resolution path is required
only when resolving from current exchange observations, as in this Requirement — it is
not required, and not performed, when the record's own durably closed status already
resolves the state directly (the prior Requirement). No state is resolved from the order
query alone or the position query alone — both signals SHALL be positively established
and SHALL agree before ABI resolves `position_open`, `terminal_after_fill`, or
`terminal_without_fill`; a
fill signal on its own (including an order found `PartiallyFilled`), or a terminal-order
signal on its own, is never sufficient by itself. In particular, `terminal_without_fill`
requires the position query to positively confirm no open position — a position query
that fails, times out, or is otherwise inconclusive does NOT satisfy this, even though it
also does not "contradict" the order-side finding; absence of contradiction is not the
same as a positive confirmation, and only the latter is sufficient. A positively-found
position confirms `position_open` only when its side plausibly matches the correlation
record's own `desired_entry.side` (`Buy` with `long`, `Sell` with `short`) — the same
plausibility rule `open-position-resolution` already applies. A found position on the
opposite side is contradictory evidence (some other exposure on the same exchange
symbol, not this binding's own fill) and ABI SHALL fail safe rather than resolve
`position_open` from it.

#### Scenario: A live, unfilled order resolves to entry_order_live
- **WHEN** the order query positively finds the entry order in a live, unfilled state, and
  the position query positively finds no open position
- **THEN** ABI resolves `entry_order_live`

#### Scenario: A fill confirmed by an open position resolves to position_open
- **WHEN** the order query positively observes a fill (fully or partially filled), and the
  position query positively confirms an open position
- **THEN** ABI resolves `position_open`
- **AND** this holds regardless of whether the order itself is `Filled` or
  `PartiallyFilled` — the position query's confirmation is what makes `position_open`
  safe to resolve, not the order status alone

#### Scenario: A fill confirmed flat, with the order positively terminal, resolves to terminal_after_fill
- **WHEN** the order query positively observes a fill (fully or partially filled) AND
  positively establishes the order has no live remainder (a terminal status, or a fully
  filled order with zero remaining quantity), and the position query positively confirms
  no open position
- **THEN** ABI resolves `terminal_after_fill`, distinct from `terminal_without_fill`

#### Scenario: A found position on the opposite side is contradictory, not position_open
- **WHEN** the order query positively observes a fill (fully or partially filled), and the
  position query positively finds an open position whose side does not plausibly match
  the correlation record's `desired_entry.side` (e.g. a `long` record with a found `Sell`
  position, or a `short` record with a found `Buy` position)
- **THEN** ABI does NOT resolve `position_open` from this — the opposite-side position is
  contradictory evidence, not confirmation of this binding's own fill
- **AND** ABI fails safe instead of resolving any state from this contradictory evidence

#### Scenario: A fill observed with a flat position but a still-live order fails safe
- **WHEN** the order query positively observes a fill but the order is still live (e.g.
  `PartiallyFilled` with a live remainder, or any other non-terminal status), and the
  position query positively confirms no open position
- **THEN** ABI does NOT resolve `position_open` (the position query contradicts it) and
  does NOT resolve `terminal_after_fill` (the order is not yet terminal)
- **AND** ABI fails safe instead — this combination is contradictory, not resolvable

#### Scenario: A terminal order that never filled resolves to terminal_without_fill only when the position query positively confirms flat
- **WHEN** the order query positively finds the entry order in a terminal state
  (rejected, cancelled, or deactivated) with zero cumulative filled quantity, AND the
  position query positively confirms no open position
- **THEN** ABI resolves `terminal_without_fill`

#### Scenario: A zero-fill terminal order contradicted by an open position fails safe
- **WHEN** the order query positively finds the entry order terminal with zero cumulative
  filled quantity, but the position query positively confirms an open position
- **THEN** ABI does NOT resolve `terminal_without_fill` — the two signals contradict each
  other
- **AND** ABI fails safe instead of resolving any state from this contradictory evidence

#### Scenario: A zero-fill terminal order with an inconclusive position query fails safe
- **WHEN** the order query positively finds the entry order terminal with zero cumulative
  filled quantity, but the position query fails, times out, or is otherwise inconclusive
- **THEN** ABI does NOT resolve `terminal_without_fill` — a position query that merely
  fails to contradict the order-side finding is not a positive confirmation of flat
- **AND** ABI fails safe, exactly as it would for any other inconclusive query
- **AND** ABI fails safe instead of resolving any state from this contradictory evidence

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
