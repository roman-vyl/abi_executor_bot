## ADDED Requirements

### Requirement: An admission intent never resolves a recovery state
A correlation record with `status: admission_pending` SHALL resolve as an inconclusive
attempt (safe `500 internal_error`), never as any of the recovery states and never as
`unknown_trade_cycle_binding`. Recovery convergence SHALL NOT write or change an
`admission_pending` record. A pair closed as `absent` by a pre-exchange failure SHALL
resolve `terminal_without_fill` through the existing durably-closed rule, with no
exchange query.

#### Scenario: PUT still in flight
- **WHEN** recovery-state is queried while the pair's record is `admission_pending`
- **THEN** ABI returns `500 internal_error` and queries no exchange

#### Scenario: Pre-exchange failure became absent
- **WHEN** recovery-state is queried for a pair whose PUT failed before the exchange
  boundary
- **THEN** ABI returns `200` with `recovery_state: terminal_without_fill`
- **AND** issues no order, execution or position query

#### Scenario: Open-position lookup on an admission intent
- **WHEN** open-position lookup is queried for a pair whose record is `admission_pending`
- **THEN** ABI fails safe with `500 internal_error`, never reports an open position and
  never reports a scope binding
