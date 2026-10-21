# abi-entry-cycle-recovery-api Specification

## Purpose

Define the public V1 Runtime → ABI HTTP contract for the read-only recovery-state lookup used to
resolve one Runtime-owned trade cycle after uncertain exchange outcomes.
## Requirements
### Requirement: ABI exposes one versioned recovery-state lookup endpoint
ABI SHALL expose `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/recovery-state`.
The endpoint SHALL return `application/json; charset=utf-8` for both success and error
responses.

#### Scenario: Valid method and route are accepted
- **WHEN** a client sends `GET` to the exact route with valid opaque path values
- **THEN** ABI processes the request through the recovery-state HTTP boundary

#### Scenario: Non-GET method is not matched by this route
- **WHEN** a request targets the same two-path-segment shape with a method other than `GET`
- **THEN** ABI does not treat it as a match for this endpoint

### Requirement: Runtime ownership values remain opaque path parameters
After URL percent-decoding, `strategy_instance_id` and `trade_cycle_id` SHALL each be a
non-empty string. ABI SHALL impose no regex, length limit, canonicalization, case
conversion, UUID shape, or derivation rule on these values, consistent with the existing
open-position lookup endpoint's treatment of the same two identifiers.

#### Scenario: Opaque path values are preserved
- **WHEN** both path identifiers are non-empty strings after percent-decoding
- **THEN** ABI accepts their transport form and preserves them unchanged when using them
  downstream

#### Scenario: Empty opaque path value is rejected
- **WHEN** either path identifier is an empty string after percent-decoding
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`

#### Scenario: Malformed percent-encoding is rejected
- **WHEN** either path segment contains percent-encoding that cannot be decoded
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`

### Requirement: The request carries no body
ABI SHALL NOT require or parse a request body for this endpoint.

#### Scenario: Request with no body is processed
- **WHEN** a `GET` request with no body is sent to the route
- **THEN** ABI processes the request based solely on the two path identifiers

### Requirement: An unknown trade cycle binding fails closed with the existing ownership-mismatch contract
When no correlation record exists for the requested pair, ABI SHALL return the same
`422 unknown_trade_cycle_binding` response the open-position lookup endpoint already
returns for this case, rather than a `200` response with any `recovery_state`.

#### Scenario: Missing binding returns unknown_trade_cycle_binding
- **WHEN** no correlation record exists for the requested `(strategy_instance_id,
  trade_cycle_id)` pair
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `unknown_trade_cycle_binding`

### Requirement: An inconclusive resolution returns a safe error, never a fabricated state
When recovery resolution cannot establish one of the five states within its bounded
query budget because a query failed, timed out, was malformed, returned an identity
mismatch, or produced contradictory/incomplete evidence, ABI SHALL return `500
internal_error` and no `recovery_state`.

A single-pass clean exact-own-order absence and arbitrary aged clean-empty evidence remain
part of this error class. Only the structurally eligible ambiguous CREATE that completes
all three clean order/no-execution attempts with flat or same-side aggregate results and
passes the post-observation strict seven-day Bybit-time gate SHALL return
`entry_order_not_found`. A failed/malformed aggregate query or clean opposite-side
position remains contradictory and part of the safe-error class.

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

#### Scenario: A clean-but-empty result everywhere returns the same safe error
- **WHEN** the realtime order query, the history order query, and the position query all
  complete cleanly and each finds nothing, and the record is not the eligible
  ambiguous-CREATE shape completing the full fresh budget
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`, identical to the
  query-failure response
- **AND** ABI does not return `terminal_without_fill` or any other `recovery_state` on
  the basis of that absence

### Requirement: The endpoint never causes an exchange side effect
This endpoint SHALL remain read-only with respect to the exchange for every response it
can return, including `entry_order_live` and `entry_order_not_found`.

#### Scenario: No corrective action is taken by this endpoint itself
- **WHEN** ABI resolves `entry_order_live` or `entry_order_not_found` for a trade cycle
  whose caller intends to neutralize
- **THEN** ABI SHALL NOT cancel, amend, or create an order while serving the GET
- **AND** any corrective cancellation is a separate subsequent write explicitly initiated
  by the caller

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
observation, every aggregate sanity read was clean and either flat or same-side, and
validated Bybit server time proved the completed observation strictly inside the
documented seven-day evidence window. Same-side aggregate exposure is non-attributable
and may belong to a sibling cycle. The outcome SHALL NOT be documented or encoded as a
terminal state or as proof that the original CREATE never existed or never reached the
exchange.

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

### Requirement: A position_open recovery response identifies the entry order whose fill ABI proved
The recovery-state success object SHALL additionally contain exactly two keys, `entry_order_link_id` and `entry_order_id`, each a non-empty JSON string or `null`. For `position_open`, `entry_order_link_id` SHALL be the current binding's `orderLinkId` that the recovery resolution queried, and `entry_order_id` SHALL be the `orderId` of the order row matched by that `orderLinkId` behind the resolved fill signal, or `null` when that row had no usable `orderId`. For every other `recovery_state`, both keys SHALL be `null`. Carrying the identifiers SHALL NOT add an exchange request, change the resolved state, or change convergence; convergence SHALL NOT write the row's `orderId` into the correlation record.

#### Scenario: position_open recovery names the proven order
- **WHEN** ABI resolves `position_open` from a row of this cycle's own entry order showing a fill
- **THEN** the response carries `entry_order_link_id` equal to the queried `orderLinkId` and `entry_order_id` equal to that row's `orderId`

#### Scenario: Recovery row without an order id
- **WHEN** ABI resolves `position_open` and the row has no usable `orderId`
- **THEN** `entry_order_id` is `null` and the rest of the response is unchanged

#### Scenario: Other recovery states
- **WHEN** ABI resolves `entry_order_live`, `entry_order_not_found`, `terminal_without_fill` or `terminal_after_fill`
- **THEN** both `entry_order_link_id` and `entry_order_id` are `null`

