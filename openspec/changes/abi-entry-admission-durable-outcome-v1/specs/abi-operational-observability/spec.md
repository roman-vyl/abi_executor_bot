## ADDED Requirements

### Requirement: Entry-package failures name their stage and cause
Every `entry_package` `operation_failed` event SHALL include `failure_stage` (one of
`admission_write`, `instrument_resolution`, `quantity_calculation`, `binding_mode`,
`scope_admission`, `provisional_write`, `exchange_create`, `confirmation`, `unexpected`)
taken from the typed internal result, and `error_cause`: exception class and message
truncated to 300 characters, or a fixed reason such as `scope_conflict`.

#### Scenario: Quantity calculation throws
- **WHEN** an entry-package PUT fails because quantity calculation threw
- **THEN** `operation_failed` carries `failure_stage: "quantity_calculation"` and the
  exception class and message in `error_cause`

#### Scenario: Scope conflict is named
- **WHEN** an entry-package PUT fails on scope admission without an exception
- **THEN** `operation_failed` carries `failure_stage: "scope_admission"` and
  `error_cause: "scope_conflict"`

#### Scenario: No secrets or payloads
- **WHEN** any `operation_failed` event for `entry_package` is emitted
- **THEN** `error_cause` contains no raw exchange payload and no credentials

### Requirement: Pre-exchange rejection emits one event
When ABI durably persists `absent` for a pair because its PUT failed before the exchange
boundary or because startup closed a leftover `admission_pending` record, it SHALL emit
exactly one `entry_admission_rejected` event at `level: "warn"` with
`strategy_instance_id`, `trade_cycle_id` and `failure_stage` (`startup_recovery` for the
startup case).

#### Scenario: Scope conflict rejection
- **WHEN** a new pair is rejected by scope admission and its record becomes `absent`
- **THEN** one `entry_admission_rejected` event with `failure_stage: "scope_admission"` is
  emitted
