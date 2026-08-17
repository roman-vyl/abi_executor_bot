## MODIFIED Requirements

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

When ABI resolves `position_open`, `first_fill_at_ms` and `average_entry_price` SHALL be
sourced from this trade cycle's own attributable execution evidence — never from the
aggregate physical position's `openTime` or `avgPrice` — following the same
attributable-evidence-primary, aggregate-weak-sanity pattern `open-position-resolution`
already establishes for the same two facts. `average_entry_price` SHALL be read from the
same own-order query response (filtered to this record's own `order_link_id`) already
used to positively observe the fill; if that response carries no usable average price,
ABI SHALL NOT fabricate, estimate, or substitute a value and SHALL fail safe instead.
`first_fill_at_ms` SHALL reuse `open-position-resolution`'s own durable, immutable
capture-once value and mechanism for this cycle's own entry order — reusing the record's
already-captured value with no exchange call when present, or performing the same
one-time capture `open-position-resolution` performs when absent, under the same
pair-level serialization — never a second, independent computation of this value. If
that capture cannot positively establish a value, ABI SHALL fail safe rather than resolve
`position_open` with a fabricated, omitted, or aggregate-sourced value for either field.

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
- **AND** `average_entry_price` is read from this cycle's own order query response, never
  from the position query's aggregate row
- **AND** `first_fill_at_ms` is this cycle's own durably captured value (reused if
  already present, captured once if not), never the position query's aggregate `openTime`

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

#### Scenario: A fill-carrying order query response with no usable average price fails safe
- **WHEN** the order query positively observes a fill, but that response carries no
  usable average execution price
- **THEN** ABI does NOT resolve `position_open` with a fabricated, estimated, or
  aggregate-sourced `average_entry_price`
- **AND** ABI fails safe instead

#### Scenario: An unresolvable first-fill capture fails safe rather than resolving position_open
- **WHEN** the order and position queries otherwise positively agree on `position_open`,
  this cycle's own `first_fill_at_ms` is not yet durably captured, and the one-time
  capture this cycle's own entry order's own executions cannot positively establish a
  value
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
- **WHEN** resolving `position_open` requires querying this cycle's own entry order's
  own executions (to capture `first_fill_at_ms` for the first time) and durably saving
  the captured value to ABI's own correlation record
- **THEN** neither the read-only execution-history query nor ABI's own local durable
  write is a violation of this requirement — "exchange side effect" in this requirement
  refers exclusively to a create, amend, or cancel request sent to the exchange, exactly
  as this requirement's own text and the preceding scenario already state
