## ADDED Requirements

### Requirement: Every received entry-package PUT leaves a durable trace for its pair
For a non-null PUT on a pair with no correlation record, ABI SHALL durably write an
admission intent record (`status: admission_pending`, no order identity, no exchange
scope) as its first action, before any step that can end in `internal_error`. Such a
record SHALL NOT claim or block any physical position scope.

#### Scenario: Intent record precedes quantity calculation
- **WHEN** a non-null PUT arrives for a pair with no correlation record
- **THEN** ABI durably writes `status: admission_pending` before calculating the quantity
- **AND** the record has `order_link_id: null` and an empty exchange category

#### Scenario: Intent record never holds a scope
- **WHEN** another pair checks scope admission for the same instrument while an
  `admission_pending` record exists
- **THEN** the `admission_pending` record is not counted as an active scope owner

#### Scenario: Intent write fails
- **WHEN** the durable `admission_pending` write fails
- **THEN** ABI returns `500 internal_error` and contacts no exchange

### Requirement: A failure before the exchange boundary is durably closed as absent
The exchange boundary is the durable provisional `pending_create` write. When a PUT fails
before it, by returned `internal_error` or by exception, ABI SHALL durably move the pair's
`admission_pending` record to `absent` (no desired entry, no order identity) before
responding `500 internal_error`. A record at `pending_create` or later SHALL NOT be moved
by this rule.

#### Scenario: Durable state, not a local flag, proves no exchange call
- **WHEN** ABI decides to persist `absent` after a pre-boundary failure
- **THEN** the write is applied only if the pair's current record, re-read under the pair
  lock, is still `admission_pending`
- **AND** an in-process flag alone never causes `absent` or a terminal recovery answer

#### Scenario: Provisional write fails
- **WHEN** the durable `pending_create` write fails or its outcome is ambiguous
- **THEN** ABI does not persist `absent` in this invocation and responds
  `500 internal_error`

#### Scenario: Quantity calculation fails
- **WHEN** quantity calculation fails for a new pair
- **THEN** the pair's record is durably `absent`
- **AND** ABI sent no exchange request for the pair
- **AND** the response is `500 internal_error`

#### Scenario: Scope conflict
- **WHEN** scope admission returns a conflict for a new pair
- **THEN** the pair's record is durably `absent` and no exchange request was sent

#### Scenario: Unexpected exception before the boundary
- **WHEN** an exception escapes processing while the pair's record is still
  `admission_pending`
- **THEN** ABI, still under the pair lock, durably transitions it to `absent` before
  responding `500 internal_error`

#### Scenario: Failure after the boundary is unchanged
- **WHEN** the exchange call throws after the provisional `pending_create` save
- **THEN** ABI keeps the existing behavior (`status: unknown`, `500 internal_error`) and
  does not write `absent`

#### Scenario: The absent write itself fails
- **WHEN** the durable transition to `absent` fails
- **THEN** the record stays `admission_pending` and ABI responds `500 internal_error`

### Requirement: Leftover admission intents are closed at startup
During startup correlation recovery and before reporting readiness, ABI SHALL durably
transition every `admission_pending` record to `absent`. A failed transition SHALL fail
readiness. This relies on the existing precondition that exactly one live ABI process
writes a correlation store.

#### Scenario: Process died during admission
- **WHEN** ABI starts and the store contains an `admission_pending` record
- **THEN** ABI durably writes `absent` for that pair before readiness
- **AND** a later recovery-state query for the pair resolves `terminal_without_fill`
