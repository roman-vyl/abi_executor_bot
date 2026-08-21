## MODIFIED Requirements

### Requirement: Successful response is a closed object reporting one of five recovery states
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly:

- `recovery_state`: one of `"entry_order_live"`, `"entry_order_not_found"`,
  `"position_open"`, `"terminal_without_fill"`, or `"terminal_after_fill"`;
- `applied_entry_package`: an object with `applied_desired_entry` and
  `calculated_quantity`, or `null`;
- `first_fill_at_ms`: JSON integer or `null`;
- `average_entry_price`: exact-decimal JSON string or `null`.

`applied_entry_package` SHALL be non-null if and only if `recovery_state` is
`entry_order_live` or `position_open`. `first_fill_at_ms` and
`average_entry_price` SHALL both be non-null if and only if `recovery_state` is
`position_open`; for every other state both SHALL be `null`.

`entry_order_not_found` SHALL mean only that an eligible ambiguous CREATE record remained
cleanly absent across the complete three-attempt exact-own order and execution
observation, every aggregate sanity read was clean and flat, and validated Bybit server
time proved the completed observation strictly inside the documented seven-day evidence
window. It SHALL NOT be documented or encoded as a terminal state or as proof that the
original CREATE never existed or never reached the exchange.

#### Scenario: entry_order_live response includes the applied entry package but no fill facts
- **WHEN** ABI resolves `entry_order_live`
- **THEN** ABI returns HTTP `200` with a non-null `applied_entry_package` and both fill
  facts `null`

#### Scenario: position_open response includes the applied entry package and fill facts
- **WHEN** ABI resolves `position_open`
- **THEN** ABI returns HTTP `200` with a non-null `applied_entry_package` and both fill
  facts non-null

#### Scenario: entry_order_not_found response carries no package or fill facts
- **WHEN** ABI completes the narrow fresh full-budget ambiguous-CREATE rule
- **THEN** ABI returns HTTP `200` with `recovery_state:"entry_order_not_found"`
- **AND** `applied_entry_package`, `first_fill_at_ms`, and `average_entry_price` are all
  `null`

#### Scenario: Terminal responses omit the applied entry package and fill facts
- **WHEN** ABI resolves `terminal_without_fill` or `terminal_after_fill`
- **THEN** ABI returns HTTP `200` with the matching state and all three conditional fields
  `null`

### Requirement: An inconclusive resolution returns a safe error, never a fabricated state
When recovery resolution cannot establish one of the five states within its bounded
query budget because a query failed, timed out, was malformed, returned an identity
mismatch, or produced contradictory/incomplete evidence, ABI SHALL return `500
internal_error` and no `recovery_state`.

A single-pass clean exact-own-order absence and arbitrary aged clean-empty evidence remain
part of this error class. Only the structurally eligible ambiguous CREATE that completes
all three clean order/no-execution/flat attempts and passes the post-observation strict
seven-day Bybit-time gate SHALL return `entry_order_not_found`.

#### Scenario: Query failure returns a safe error
- **WHEN** an underlying required query fails, times out, or is structurally malformed
- **THEN** ABI returns HTTP `500` with `error.code:"internal_error"`
- **AND** returns no `recovery_state`

#### Scenario: Fresh full-budget ambiguous-CREATE absence returns a distinct success
- **WHEN** all structural, full-budget order/execution/position, and freshness conditions
  for `entry_order_not_found` are satisfied
- **THEN** ABI returns HTTP `200` with `recovery_state:"entry_order_not_found"`
- **AND** does not collapse the observation into `500 internal_error`

#### Scenario: First-pass or aged-out clean absence remains a safe error
- **WHEN** only one attempt is cleanly absent, the full budget contains any tainted
  attempt, the record is not the ambiguous-CREATE shape, or completed binding age is at
  least seven days
- **THEN** ABI returns HTTP `500` with `error.code:"internal_error"`
- **AND** returns no `recovery_state`

#### Scenario: entry_order_not_found is not terminal_without_fill
- **WHEN** ABI reports `entry_order_not_found`
- **THEN** the response does not claim `terminal_without_fill`
- **AND** clients are required to use a separate explicit neutralization operation before
  treating the entry package as durably absent

### Requirement: The endpoint never causes an exchange side effect
This endpoint SHALL remain read-only with respect to the exchange for every response it
can return, including `entry_order_live` and `entry_order_not_found`.

#### Scenario: No corrective action is taken by this endpoint itself
- **WHEN** ABI resolves `entry_order_live` or `entry_order_not_found` for a trade cycle
  whose caller intends to neutralize
- **THEN** ABI SHALL NOT cancel, amend, or create an order while serving the GET
- **AND** any corrective cancellation is a separate subsequent write explicitly initiated
  by the caller

## RENAMED Requirements

- FROM: `### Requirement: Successful response is a closed object reporting one of four recovery states`
- TO: `### Requirement: Successful response is a closed object reporting one of five recovery states`
