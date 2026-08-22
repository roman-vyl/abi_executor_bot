## ADDED Requirements

### Requirement: Recovery Convergence is a separate, pure decision from Recovery Resolution
Once Recovery Resolution has already positively resolved one of the five recovery outcomes
(`entry_order_live`, `position_open`, `terminal_without_fill`, `terminal_after_fill`,
`entry_order_not_found`) for a given `(strategy_instance_id, trade_cycle_id)` pair, ABI
SHALL evaluate a separate, pure Recovery Convergence decision — given only the resolved
outcome and the current correlation record — that determines whether the durable
correlation record's `status` (and, where specified, `pending_action` and related fields)
SHALL converge toward that proven outcome, or SHALL remain unchanged (`no_change`). The
Convergence decision function itself SHALL NOT query the exchange, SHALL NOT acquire the
per-pair mutex, and SHALL NOT write to the correlation repository directly — those remain
the responsibility of the existing application-layer call site, exactly as they are today
for the existing `first_fill_at_ms` capture.

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

### Requirement: A proven live-truth outcome converges an eligible non-durably-closed record to applied
When Recovery Resolution positively resolves `entry_order_live` or `position_open` for a
correlation record whose `status` is not durably closed, and whose `pending_action` is
`null` or `"create"`, ABI SHALL durably converge `status` to `"applied"`. If
`pending_action` was `"create"`, ABI SHALL also clear it to `null` in the same write. For
`entry_order_live` specifically, this convergence SHALL apply only when the record's
`order_id` is already non-null; a record whose `order_id` is still `null` (i.e.
`pending_create`) SHALL NOT converge from this outcome. For `position_open`, ABI SHALL
continue to capture `first_fill_at_ms` exactly as it already does today (capture-once,
immutable), in the same locked write as the `status` convergence when both apply.

#### Scenario: An unknown-status record with a proven fill converges to applied
- **WHEN** a correlation record's `status` is `unknown`, `pending_action` is `null`, and
  Recovery Resolution positively resolves `position_open`
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

#### Scenario: A pending-create ambiguity with no confirmed order_id does not converge from entry_order_live
- **WHEN** a correlation record's `status` is `pending_create`, `order_id` is `null`, and
  Recovery Resolution positively resolves `entry_order_live`
- **THEN** ABI does NOT converge `status` — the record remains unchanged
- **AND** this is a deliberate, deferred boundary, not a failure

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
