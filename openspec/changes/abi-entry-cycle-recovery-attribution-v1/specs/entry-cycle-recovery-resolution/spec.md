## MODIFIED Requirements

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
- If `close_order_link_id` is durably recorded for this cycle, ABI SHALL query that
  order's own current state using the same own-order-query mechanism already used for the
  entry order, and resolve from its own positive finding: a positively confirmed fill on
  this cycle's own close order resolves `terminal_after_fill`, with no fill facts in the
  response and with no aggregate physical position query consulted at all for this
  determination — this cycle's own two-order evidence chain (its entry order's own fill,
  its close order's own fill) is sufficient by itself and is never overridden or
  reinterpreted by a same-side sibling's own aggregate contribution. A positively
  confirmed terminal state with zero fill on this cycle's own close order (the close
  attempt was rejected or otherwise never executed) resolves `position_open` instead,
  using the same sourcing and the same aggregate existence-only sanity check as the
  no-close-attempted case above. Any other finding for this cycle's own close order (still
  live, not found, or inconclusive) SHALL NOT resolve either state — ABI fails safe,
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

#### Scenario: A fill with the cycle's own close order confirmed filled resolves to terminal_after_fill, with no aggregate consultation, regardless of a same-side sibling's own open position
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and querying that close order's own current state positively
  confirms it filled
- **THEN** ABI resolves `terminal_after_fill`
- **AND** ABI does not query, or use in any way, the aggregate physical position query to
  reach this determination
- **AND** this holds even when the aggregate physical position query would positively
  report an open position on the matching side belonging to a same-side sibling cycle —
  the sibling's own open position never causes this cycle to be mis-resolved as
  `position_open`

#### Scenario: A fill with the cycle's own close order confirmed rejected resolves to position_open
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and querying that close order's own current state positively
  confirms it is terminal with zero fill (the close attempt was rejected or otherwise
  never executed)
- **THEN** ABI resolves `position_open`, sourced and sanity-checked exactly as the
  no-close-attempted case above (this cycle's own order-query response for
  `average_entry_price`, this cycle's own durable capture for `first_fill_at_ms`,
  aggregate existence-only sanity on the matching side)

#### Scenario: A fill with the cycle's own close order not yet positively resolved fails safe
- **WHEN** the own-order query positively observes a fill, a close order is durably
  recorded for this cycle, and querying that close order's own current state does not
  positively confirm either a fill or a zero-fill terminal state (it is still live, not
  found, or the query is inconclusive)
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
