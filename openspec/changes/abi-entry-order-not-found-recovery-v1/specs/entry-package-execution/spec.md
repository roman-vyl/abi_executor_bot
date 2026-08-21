## MODIFIED Requirements

### Requirement: ABI cancels or confirms absence of a desired entry package
When the desired entry is null, ABI SHALL cancel any positively found live order for that
trade cycle and acknowledge absence only after cancellation is durably confirmed, or
confirm absence directly from an already durable absent/terminal fact or trustworthy
current evidence.

For a record with the ambiguous-CREATE shape used by `entry_order_not_found` — status
`pending_create` or `unknown`, pending action exactly `create`, non-null desired entry,
non-empty exact order identity, valid binding start, and no durable observation/fill/close
identity — clean order absence SHALL NOT directly confirm absence. Before persisting
`status:absent` or returning `EntryPackageAbsent`, the CANCEL request itself SHALL repeat
the complete three-attempt exact-own order/no-execution/clean-flat observation and SHALL
validate at completion that Bybit server-time binding age is non-negative and strictly
below seven days. Any aged-out, failed, malformed, mismatched, incomplete, ambiguous, or
contradictory evidence SHALL fail closed without persisting absence.

This additional gate applies only when absence would be inferred from clean-empty reads
for the ambiguous-CREATE shape. Positive live, terminal, or fill evidence and every other
record shape retain their existing behavior.

#### Scenario: Cancel a positively found live order
- **WHEN** `desired_entry` is null and the exact live order exists for the trade cycle
- **THEN** ABI SHALL cancel that order and return `entry_package_absent` only after the
  cancellation is durably confirmed

#### Scenario: Confirm already-durable absent state
- **WHEN** `desired_entry` is null and ABI already holds a canonical durable absent or
  terminal-without-fill fact for the trade cycle
- **THEN** ABI SHALL return `entry_package_absent` without asserting that a cancellation
  action occurred and without requiring the ambiguous-CREATE empty-read rule

#### Scenario: Fresh full-budget ambiguous-CREATE absence can be confirmed
- **WHEN** `desired_entry` is null for the ambiguous-CREATE shape, all three CANCEL-side
  attempts are cleanly exact-order absent, exact-execution absent, and aggregate flat,
  and validated Bybit server time proves completed binding age strictly below seven days
- **THEN** ABI MAY durably persist `status:absent` and return exact
  `EntryPackageAbsent`
- **AND** this confirmation does not assert that the original CREATE never existed or
  never reached Bybit

#### Scenario: Aged-out clean-empty evidence never confirms absence
- **WHEN** `desired_entry` is null for the ambiguous-CREATE shape and completed binding
  age is negative, exactly seven days, older than seven days, or cannot be validated
- **THEN** ABI SHALL NOT persist `status:absent`
- **AND** SHALL NOT return `EntryPackageAbsent`
- **AND** SHALL return the existing safe error so Runtime retains its marker

#### Scenario: Execution evidence prevents ambiguous-CREATE absence
- **WHEN** order rows are absent but the exact-own execution query finds an attributable
  execution during corrective CANCEL
- **THEN** ABI SHALL NOT persist or return absence
- **AND** SHALL honor existing fill handling when sufficient, otherwise fail closed

#### Scenario: A query failure while confirming a cancellation never confirms absence
- **WHEN** any required order, execution, position, or server-time query fails or times
  out
- **THEN** ABI SHALL NOT return `entry_package_absent` and SHALL treat cancellation or
  absence as unconfirmed

#### Scenario: A structurally malformed response while confirming a cancellation never confirms absence
- **WHEN** any required confirmation response is structurally malformed, identity-
  mismatched, cursor-incomplete, or otherwise ambiguous
- **THEN** ABI SHALL NOT return `entry_package_absent` and SHALL treat the outcome as
  unconfirmed

#### Scenario: An unrecognized realtime order status while confirming a cancellation never confirms absence
- **WHEN** realtime returns the correctly identified order with an unrecognized status
- **THEN** ABI SHALL NOT return `entry_package_absent` even if a later history read is
  empty

#### Scenario: A cancel transport failure is durably recorded as unknown, not silently left pending
- **WHEN** ABI dispatches a cancel command and the exchange call throws or times out
  before ABI can classify the outcome
- **THEN** ABI SHALL durably record `status:unknown` before returning a safe error
- **AND** `pending_action` SHALL remain `cancel` so a later request can revalidate

#### Scenario: A repeat cancel-intent PUT revalidates before resending
- **WHEN** a null-desired-entry request targets a record not already durably absent or
  terminal-unfilled
- **THEN** ABI SHALL query the exact current order before resending cancel
- **AND** SHALL resend only when the exact order is positively live
- **AND** SHALL honor a positively terminal/fill result through existing behavior
- **AND** SHALL record `unknown` and fail safe when evidence is inconclusive

#### Scenario: Other record shapes retain existing cancellation semantics
- **WHEN** the target does not have the ambiguous-CREATE structural shape
- **THEN** this change adds no freshness-based inference or new cancellation behavior
- **AND** the pre-existing positive confirmation and fail-safe rules continue to apply
