## ADDED Requirements

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

### Requirement: Successful response is a closed object reporting one of four recovery states
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly:

- `recovery_state`: one of `"entry_order_live"`, `"position_open"`,
  `"terminal_without_fill"`, `"terminal_after_fill"`;
- `applied_entry_package`: an object with `applied_desired_entry` and
  `calculated_quantity`, or `null`;
- `first_fill_at_ms`: JSON integer or `null`;
- `average_entry_price`: exact-decimal JSON string or `null`.

There is no fifth, time-based `recovery_state` value. When ABI cannot positively
establish one of the four states — including when every query it consults comes back
clean but empty — it does not return HTTP `200` at all (see "An inconclusive resolution
returns a safe error, never a fabricated state").

`applied_entry_package` SHALL be non-null if and only if `recovery_state` is
`"entry_order_live"` or `"position_open"`. `first_fill_at_ms` and
`average_entry_price` SHALL both be non-null if and only if `recovery_state` is
`"position_open"`; for every other `recovery_state`, both SHALL be `null`.

#### Scenario: entry_order_live response includes the applied entry package but no fill facts
- **WHEN** ABI resolves `entry_order_live`
- **THEN** ABI returns HTTP `200` with `recovery_state: "entry_order_live"`,
  a non-null `applied_entry_package`, and `first_fill_at_ms`/`average_entry_price` both
  `null`

#### Scenario: position_open response includes the applied entry package and fill facts
- **WHEN** ABI resolves `position_open`
- **THEN** ABI returns HTTP `200` with `recovery_state: "position_open"`, a non-null
  `applied_entry_package`, and `first_fill_at_ms`/`average_entry_price` both non-null

#### Scenario: Terminal responses omit the applied entry package and fill facts
- **WHEN** ABI resolves `terminal_without_fill` or `terminal_after_fill`
- **THEN** ABI returns HTTP `200` with the matching `recovery_state`, `applied_entry_package`
  `null`, and `first_fill_at_ms`/`average_entry_price` both `null`

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
When recovery resolution cannot positively establish one of the four states within its
bounded query budget — whether because a query failed or was malformed, or because every
query it consults completed cleanly but found nothing — ABI SHALL return the same safe
`500 internal_error` response and SHALL NOT return HTTP `200` with any `recovery_state`.
This single response shape covers both causes; the caller has no way to distinguish
"ABI's query failed" from "ABI found no positive evidence," and does not need to — both
mean the same thing: retry later, no state is resolved yet.

#### Scenario: Query failure returns a safe error
- **WHEN** the underlying order or position query fails, times out, or is structurally
  malformed within the bounded confirmation budget
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`
- **AND** ABI does not return any `recovery_state`

#### Scenario: A clean-but-empty result everywhere returns the same safe error
- **WHEN** the realtime order query, the history order query, and the position query all
  complete cleanly and each finds nothing
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`, identical to the
  query-failure response
- **AND** ABI does not return `terminal_without_fill` or any other `recovery_state` on
  the basis of that absence

### Requirement: The endpoint never causes an exchange side effect
This endpoint SHALL be read-only with respect to the exchange for every response it can
return, including `entry_order_live`.

#### Scenario: No corrective action is taken by this endpoint itself
- **WHEN** ABI resolves `entry_order_live` for a trade cycle whose caller's last known
  intent was its removal
- **THEN** ABI SHALL NOT cancel the order as part of serving this request; any corrective
  cancellation is a separate, subsequent write the caller explicitly initiates
