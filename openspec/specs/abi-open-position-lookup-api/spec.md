# abi-open-position-lookup-api Specification

## Purpose
Define the public V1 Runtime → ABI HTTP contract for reading the current, live-truth open-position state of one specific Runtime-owned trade cycle.

## Requirements
### Requirement: ABI exposes one versioned open-position lookup endpoint
ABI SHALL expose `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`. The endpoint SHALL return `application/json; charset=utf-8` for both success and error responses.

#### Scenario: Valid method and route are accepted
- **WHEN** a client sends `GET` to the exact route with valid opaque path values
- **THEN** ABI processes the request through the open-position HTTP boundary

#### Scenario: Non-GET method is not matched by this route
- **WHEN** a request targets the same two-path-segment shape with a method other than `GET`
- **THEN** ABI does not treat it as a match for this endpoint

### Requirement: Runtime ownership values remain opaque path parameters
After URL percent-decoding, `strategy_instance_id` and `trade_cycle_id` SHALL each be a non-empty string. ABI SHALL impose no regex, length limit, canonicalization, case conversion, UUID shape, or derivation rule on these Runtime-owned values, and SHALL pass them onward unchanged, consistent with the existing entry-package route's treatment of the same two identifiers.

#### Scenario: Opaque path values are preserved
- **WHEN** both path identifiers are non-empty strings after percent-decoding
- **THEN** ABI accepts their transport form
- **AND** ABI preserves the exact decoded identifiers when echoing or using them downstream

#### Scenario: Empty opaque path value is rejected
- **WHEN** either path identifier is an empty string after percent-decoding
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the empty path value

#### Scenario: Malformed percent-encoding is rejected
- **WHEN** either path segment contains percent-encoding that cannot be decoded
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the invalid path segment

### Requirement: The request carries no body
ABI SHALL NOT require or parse a request body for this endpoint. ABI SHALL NOT apply the entry-package route's content-type or JSON-body validation to this endpoint.

#### Scenario: Request with no body is processed
- **WHEN** a `GET` request with no body is sent to the route
- **THEN** ABI processes the request based solely on the two path identifiers

### Requirement: Successful response is a closed object with a mandatory cross-field invariant
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly:

- `position_open`: boolean;
- `first_fill_at_ms`: JSON integer or `null`;
- `average_entry_price`: exact-decimal JSON string or `null`.

When `position_open` is `true`, both `first_fill_at_ms` and `average_entry_price` SHALL be non-null. When `position_open` is `false`, both SHALL be `null`. No other combination SHALL be returned.

#### Scenario: Open position response includes both facts
- **WHEN** ABI determines the current position is open
- **THEN** ABI returns HTTP `200`
- **AND** `position_open` is `true`
- **AND** `first_fill_at_ms` and `average_entry_price` are both non-null

#### Scenario: Closed position response nulls both facts
- **WHEN** ABI determines the current position is closed or was never opened under the current binding
- **THEN** ABI returns HTTP `200`
- **AND** `position_open` is `false`
- **AND** `first_fill_at_ms` and `average_entry_price` are both `null`

#### Scenario: Response object is closed
- **WHEN** a success response is serialized
- **THEN** it contains exactly `position_open`, `first_fill_at_ms`, and `average_entry_price`, with no additional fields

### Requirement: average_entry_price is exact-decimal text, never a binary float
`average_entry_price`, when non-null, SHALL be a JSON string representing a finite positive decimal value, validated using the same exact-decimal discipline as the entry-package contract, without conversion through binary floating point.

#### Scenario: Average entry price is returned as a JSON string
- **WHEN** the position is open
- **THEN** `average_entry_price` is encoded as a JSON string, never a JSON number
- **AND** its value is preserved exactly as sourced, with no floating-point rounding

### Requirement: A confirmed closed position is always reported as 200, never as 404
ABI SHALL NOT use HTTP `404` to mean a closed or absent position. A confirmed closed position under an existing, resolvable binding SHALL always be reported as HTTP `200` with `position_open: false`.

#### Scenario: Closed position returns 200, not 404
- **WHEN** ABI has resolved a definite closed-position answer for the requested pair
- **THEN** ABI returns HTTP `200`
- **AND** ABI does not return HTTP `404` for this outcome

### Requirement: Errors use the existing public error envelope with a scoped code set
Every error response SHALL use the closed JSON envelope `{ error: { code, message, details? } }`, with the same `EntryPackageValidationDetail`-shaped `details` array (`path`, `message`) used by the entry-package contract when present. `details` SHALL be omitted for codes other than `validation_failed` and SHALL never be `null`.

The V1 mapping for this endpoint SHALL be exactly:

| HTTP | Public error code |
|---:|---|
| 422 | `validation_failed` |
| 422 | `unknown_trade_cycle_binding` |
| 422 | `unsupported_exchange_scope` |
| 500 | `internal_error` |

No failure SHALL be suppressed or serialized as a success response.

#### Scenario: Validation failure is mapped
- **WHEN** a path parameter fails transport validation
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` is non-empty

#### Scenario: Unknown trade-cycle binding is mapped
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `unknown_trade_cycle_binding`

#### Scenario: Unsupported exchange scope is mapped
- **WHEN** the resolved record's exchange category is outside this capability's supported scope
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `unsupported_exchange_scope`

#### Scenario: Unclassifiable or exchange-derived failure maps to internal_error
- **WHEN** the record's state cannot be safely resolved, or the live exchange query fails, is malformed, or is ambiguous
- **THEN** ABI returns HTTP `500`
- **AND** `error.code` is `internal_error`
- **AND** the response omits internal exception, stack, and raw exchange response details

#### Scenario: No failure path returns a fabricated success
- **WHEN** any step of resolving the position fails, times out, or cannot be classified
- **THEN** ABI returns one of the documented error responses
- **AND** ABI does not return a success DTO

### Requirement: OpenAPI describes only the external contract
ABI SHALL provide an OpenAPI 3.1 operation matching the method, route, path parameters, success DTO, error DTO, nullability, and HTTP mappings in this capability. It SHALL NOT define internal application interfaces, record-state classification, exchange adapter shapes, or Runtime lifecycle fields (such as `entry_bar_open_time_ms`).

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI operation and contract-level tests are validated
- **THEN** request and response schemas match this capability
- **AND** no undocumented internal ABI workflow or exchange detail appears in the public contract
