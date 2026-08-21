## MODIFIED Requirements

### Requirement: Recovery resolution classifies the trade cycle into exactly one of five states, or fails safe on contradictory or incomplete evidence
Given an existing correlation record whose `status` is not already one of the three
durably closed statuses resolved directly, ABI SHALL resolve exactly one of:
`entry_order_live`, `entry_order_not_found`, `position_open`,
`terminal_without_fill`, or `terminal_after_fill` — or fail safe when the bounded
evidence is contradictory or incomplete.

Every state SHALL be resolved primarily from this specific trade cycle's own durable/
order/execution evidence — its own entry order (identified by its own `order_link_id`)
and, when that order proves a fill, its own close order (identified by its own
`close_order_link_id`, when one has been durably recorded) — never from the aggregate
physical position query as a required, co-equal signal. The aggregate physical position
query SHALL be retained only as a narrow, state-appropriate sanity check that can block a
resolution this cycle's own positive evidence would otherwise support. It SHALL NEVER be
required to positively confirm `entry_order_live` or `terminal_without_fill`, and SHALL
NEVER be consulted when resolving `terminal_after_fill`. The fifth state is the sole
exception: its conservative non-positive observation requires a clean flat aggregate
result on every attempt so a physical contradiction cannot be converted into actionable
absence.

`entry_order_not_found` is the sole non-positive observation in the union and SHALL be
eligible only for an ambiguous CREATE record with `status` `pending_create` or `unknown`,
`pending_action` exactly `create`, non-null `desired_entry`, a non-empty exact
`order_link_id`, valid `current_binding_started_at`, and no durable
`early_execution_observation`, `first_fill_at_ms`, or close-order identity. Every other
record shape SHALL retain the existing four-state/fail-safe behavior.

For an eligible record ABI SHALL preserve the existing three-attempt/300-ms recovery
budget and SHALL NOT resolve on the first clean absence. All three attempts SHALL each
produce: clean exact-own realtime/history `not_found`, complete paginated exact-own
execution evidence containing no execution, and a clean flat aggregate position result.
Any failed, malformed, mismatched, incomplete, or contradictory result taints the
absence candidate for the rest of that request. A later positive order or fill finding
SHALL supersede any earlier clean absence and follow the existing positive-state rules.

After the full clean budget, ABI SHALL validate Bybit server time and require
`0 <= serverNowMs - current_binding_started_at < 604800000`. The seven-day bound is the
documented default window of the order-history and execution-list queries used here and
the documented Demo order-retention duration. At or beyond the boundary, or when either
timestamp is invalid/unavailable, ABI SHALL fail safe and SHALL NOT resolve the fifth
state.

The outcome states only that this fresh ambiguous CREATE identity remained absent from
the complete trustworthy bounded evidence. It SHALL NOT be represented as a terminal
fact or proof that CREATE never existed or reached Bybit.

`entry_order_live` and `terminal_without_fill` each resolve from a positive own-order
finding (live and unfilled, or terminal with zero cumulative fill). Each fails safe if
the aggregate physical position query positively confirms an open position on the side
opposite `desired_entry.side`. A same-side aggregate position, no aggregate position, or
an inconclusive/failed aggregate query remains compatible with resolving either state
from own evidence alone.

`position_open` and `terminal_after_fill` are resolved once the own-order query
positively observes a fill. Which resolves SHALL be determined by this cycle's own
`close_order_link_id`:

- If no close identity is durably recorded, ABI SHALL resolve `position_open`, sourcing
  `average_entry_price` from the own order response and `first_fill_at_ms` from the
  existing durable immutable capture-once mechanism, never from the aggregate row. The
  aggregate query must positively confirm a matching-side position as an existence-only
  sanity check.
- If a close identity is recorded, ABI SHALL classify that exact own close using the
  existing exact-quantity-matching strictness. An exact confirmed close fill resolves
  `terminal_after_fill` with no aggregate consultation. A terminal zero-fill close
  resolves `position_open` with the same own-evidence sourcing and aggregate sanity as
  above. A partial non-matching close fill, a live/not-found close, or an inconclusive
  close SHALL fail safe rather than resolve either state.

A fill signal on the entry order without a positive determination of a durably recorded
close order's fate is never sufficient to resolve `position_open` or
`terminal_after_fill`.

#### Scenario: A live unfilled order resolves entry_order_live despite a same-side sibling
- **WHEN** the own-order query positively finds this cycle's entry live and unfilled, no
  close is recorded, and aggregate position shows a matching-side sibling exposure
- **THEN** ABI resolves `entry_order_live`
- **AND** the sibling does not block, delay, or alter the resolution

#### Scenario: Clean exact-own-order absence resolves to entry_order_not_found
- **WHEN** an eligible ambiguous CREATE record remains cleanly order-absent,
  execution-absent, and aggregate-flat across all three attempts, and its validated Bybit
  server-time age at completion is non-negative and strictly below seven days
- **THEN** ABI resolves `entry_order_not_found`
- **AND** ABI makes no claim that the order never existed, never reached Bybit, or never
  filled

#### Scenario: A later attempt supersedes earlier clean absence
- **WHEN** an earlier attempt is cleanly absent but a later attempt positively finds the
  exact order live, terminal, or filled, or finds an attributable execution
- **THEN** ABI does not resolve `entry_order_not_found`
- **AND** follows the existing positive-state rules where sufficient evidence exists,
  otherwise failing closed

#### Scenario: One tainted attempt prevents actionable absence
- **WHEN** any attempt contains a failed/malformed query, identity/category/symbol
  mismatch, incomplete execution pagination, ambiguous execution result, or non-flat
  aggregate position, and no later positive evidence resolves another state
- **THEN** ABI returns the existing safe error after the bounded budget
- **AND** later clean-empty attempts in the same request do not erase the taint

#### Scenario: Attributable execution blocks entry_order_not_found
- **WHEN** order reads are empty but the exact-own execution query finds at least one
  attributable Trade execution
- **THEN** ABI never resolves `entry_order_not_found`
- **AND** resolves from positive evidence only if all required facts exist, otherwise
  failing closed

#### Scenario: A terminal zero-fill order resolves despite a same-side sibling
- **WHEN** the own-order query positively finds this cycle's entry terminal with zero
  cumulative fill, no close is recorded, and aggregate position shows a matching-side
  sibling exposure
- **THEN** ABI resolves `terminal_without_fill`
- **AND** the sibling does not block, delay, or alter the resolution

#### Scenario: Opposite-side aggregate evidence blocks live or terminal-zero-fill states
- **WHEN** the own-order evidence supports `entry_order_live` or
  `terminal_without_fill` but aggregate position positively reports the opposite side
- **THEN** ABI resolves neither state and fails safe as a structural contradiction

#### Scenario: A fill with no close resolves position_open from own evidence
- **WHEN** the own entry positively proves a full or partial fill, no close is recorded,
  and aggregate position positively confirms a matching-side exposure
- **THEN** ABI resolves `position_open`
- **AND** average price comes from the own order and first-fill time from this cycle's
  durable capture, never from aggregate fields
- **AND** same-side sibling exposure does not change the result

#### Scenario: A fill with no close fails safe without matching aggregate sanity
- **WHEN** the own entry proves a fill, no close is recorded, and aggregate position is
  absent, failed, or opposite-side
- **THEN** ABI does not resolve `position_open` and fails safe

#### Scenario: Exact own close quantity resolves terminal_after_fill without aggregate
- **WHEN** the own entry proves a fill and the durably recorded exact own close proves a
  terminal cumulative fill exactly equal to the entry cumulative fill
- **THEN** ABI resolves `terminal_after_fill` without using aggregate position evidence
- **AND** same-side sibling exposure cannot change the result

#### Scenario: Terminal zero-fill own close resolves position_open
- **WHEN** the own entry proves a fill and its recorded close positively proves terminal
  zero fill
- **THEN** ABI resolves `position_open` using own entry facts and matching-side aggregate
  existence sanity

#### Scenario: Partial own close fails safe
- **WHEN** the own entry proves a fill but its recorded close proves a terminal non-zero
  cumulative fill that does not exactly match the entry cumulative fill
- **THEN** ABI resolves neither `position_open` nor `terminal_after_fill`
- **AND** fails safe regardless of aggregate position

#### Scenario: Unresolved own close fate fails safe
- **WHEN** the own entry proves a fill but its recorded close is live, not found, or
  otherwise inconclusive
- **THEN** ABI resolves neither `position_open` nor `terminal_after_fill`
- **AND** fails safe regardless of aggregate position

#### Scenario: Fill with no usable average price fails safe
- **WHEN** ABI would otherwise resolve `position_open` but the own order has no usable
  average execution price
- **THEN** ABI does not fabricate, estimate, or source average price from aggregate state
- **AND** fails safe

#### Scenario: Unresolvable first-fill capture fails safe
- **WHEN** ABI would otherwise resolve `position_open`, no durable first-fill timestamp
  exists, and exact own executions cannot establish it
- **THEN** ABI does not fabricate, omit, or aggregate-source `first_fill_at_ms`
- **AND** fails safe

#### Scenario: Failed malformed or contradictory evidence remains inconclusive
- **WHEN** either exact-order query fails, times out, is malformed, returns a mismatched
  identity, or the evidence is otherwise contradictory or insufficient for a state
- **THEN** ABI does not resolve `entry_order_not_found` or any other recovery state
- **AND** ABI fails safe

### Requirement: Only fresh full-budget ambiguous-CREATE absence is an actionable observation
ABI SHALL continue to treat arbitrary clean-empty evidence as inconclusive. It SHALL
distinguish `entry_order_not_found` from query failure and `terminal_without_fill` only
for the structurally eligible ambiguous CREATE record, only after the full clean bounded
order/execution/position observation, and only while the entire completed decision is
strictly inside the documented seven-day evidence window. The observation exists only so
the caller can explicitly invoke the revalidating neutralization contract; GET SHALL NOT
infer or persist a terminal state.

#### Scenario: Fresh full-budget ambiguous CREATE produces the observation
- **WHEN** the record meets every ambiguous-CREATE structural condition, all three
  attempts are clean order/execution absence with clean flat aggregate results, and the
  post-observation Bybit-time age is strictly below seven days
- **THEN** ABI resolves `entry_order_not_found`
- **AND** does not resolve `terminal_without_fill`

#### Scenario: One failed required query is not clean absence
- **WHEN** any required order, execution, position, or server-time query fails, times out,
  is malformed, or cannot be completely paged
- **THEN** ABI does not resolve `entry_order_not_found`
- **AND** fails safe so the caller retries later

#### Scenario: An identity mismatch is not clean absence
- **WHEN** a query returns an order row that cannot be strictly attributed to the expected
  category, symbol, and `order_link_id`
- **THEN** ABI treats the read as inconclusive rather than cleanly absent
- **AND** does not resolve `entry_order_not_found`

#### Scenario: Aged-out evidence preserves the canonical fail-safe
- **WHEN** the post-observation binding age is negative, exactly seven days, or older than
  seven days, or either timestamp cannot be strictly decoded
- **THEN** ABI does not resolve `entry_order_not_found` or
  `terminal_without_fill` from clean-empty reads
- **AND** returns the existing safe error without changing durable state

#### Scenario: Other record shapes never receive the fifth state
- **WHEN** a record is applied, pending-cancel, create-failed, durably terminal, carries a
  legacy pending action, has no exact identity, or contains a durable observation/fill/
  close identity
- **THEN** clean-empty exchange reads do not resolve `entry_order_not_found`
- **AND** existing recovery semantics remain unchanged

#### Scenario: A later positive finding supersedes an earlier absence observation
- **WHEN** a later recovery query positively finds the same exact order live, terminal,
  or filled
- **THEN** ABI resolves only the state supported by that fresh positive evidence
- **AND** an earlier `entry_order_not_found` response is not treated as durable terminal
  truth

### Requirement: The applied entry package is included only for the two live-truth states
For `entry_order_live` and `position_open`, ABI SHALL include the correlation record's
`desired_entry` and `calculated_quantity` as the resolved `AppliedEntryPackage`. For
`entry_order_not_found`, `terminal_without_fill`, and `terminal_after_fill`, ABI SHALL
NOT include an `AppliedEntryPackage`.

#### Scenario: Live states include the applied entry package
- **WHEN** ABI resolves `entry_order_live` or `position_open`
- **THEN** the response includes `applied_desired_entry` and `calculated_quantity` from
  the correlation record

#### Scenario: Absence observation and terminal states omit the applied entry package
- **WHEN** ABI resolves `entry_order_not_found`, `terminal_without_fill`, or
  `terminal_after_fill`
- **THEN** the response does not include an `AppliedEntryPackage`

### Requirement: Recovery resolution never causes an exchange side effect
Resolving recovery state SHALL be read-only with respect to the exchange. ABI SHALL NOT
cancel, amend, or create any order as part of resolving any of the five recovery states,
including `entry_order_not_found`.

#### Scenario: Resolution issues no exchange write
- **WHEN** ABI resolves any recovery state or fails safe
- **THEN** ABI SHALL NOT send any create, amend, or cancel request to the exchange as
  part of that resolution

#### Scenario: entry_order_not_found does not neutralize automatically
- **WHEN** ABI resolves `entry_order_not_found`
- **THEN** the GET operation returns the observation without mutating the correlation
  record or issuing an exchange write
- **AND** any neutralization is a separate explicit entry-package CANCEL request

#### Scenario: Read-only exchange queries and ABI local first-fill capture are not exchange side effects
- **WHEN** resolution queries order, position, close-order, or execution evidence, or
  durably captures an attributable first-fill timestamp under the existing rules
- **THEN** those reads and the local durable capture do not violate this requirement

## RENAMED Requirements

- FROM: `### Requirement: Recovery resolution classifies the trade cycle into exactly one of four states, or fails safe on contradictory or incomplete evidence`
- TO: `### Requirement: Recovery resolution classifies the trade cycle into exactly one of five states, or fails safe on contradictory or incomplete evidence`
- FROM: `### Requirement: Absence of evidence is never treated as evidence of absence`
- TO: `### Requirement: Only fresh full-budget ambiguous-CREATE absence is an actionable observation`
