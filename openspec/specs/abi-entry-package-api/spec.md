# abi-entry-package-api Specification

## Purpose
Define the public V1 Runtime → ABI HTTP contract for conveying and acknowledging a desired entry package or its absence.

## Requirements
### Requirement: ABI exposes one versioned entry-package endpoint
ABI SHALL expose `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`. The endpoint SHALL accept `application/json` with an optional UTF-8 charset parameter and SHALL return `application/json; charset=utf-8`.

#### Scenario: Valid method and route are accepted
- **WHEN** a client sends `PUT` to the exact route with a supported JSON content type
- **THEN** ABI processes the request through the entry-package HTTP boundary

#### Scenario: Unsupported content type is rejected
- **WHEN** the request content type is unsupported
- **THEN** ABI returns HTTP `415`
- **AND** `error.code` is `unsupported_media_type`

### Requirement: Request body is a closed nullable union
The body SHALL be a closed JSON object with exactly three required fields:

- `ticker`: string;
- `desired_entry`: `DesiredEntry` object or null;
- `risk_multiplier`: exact-decimal string or null.

The only valid combinations SHALL be a non-null `desired_entry` with a non-null `risk_multiplier`, or null for both fields. Omitted and unknown fields SHALL be invalid.

#### Scenario: Valid package request is accepted
- **WHEN** the request contains non-null `desired_entry` and non-null `risk_multiplier`
- **AND** every field satisfies its source-contract type and invariant
- **THEN** the HTTP boundary accepts the request

#### Scenario: Valid absence request is accepted
- **WHEN** the request contains `desired_entry: null` and `risk_multiplier: null`
- **THEN** the HTTP boundary accepts the request as desired package absence

#### Scenario: Nullability invariant is violated
- **WHEN** exactly one of `desired_entry` and `risk_multiplier` is null
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the invariant violation

#### Scenario: Request structure is invalid
- **WHEN** the body is not an object, a required field is omitted, or an unknown field is supplied
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the invalid field or object

### Requirement: Runtime ownership and market values remain opaque
After URL percent-decoding, `strategy_instance_id` and `trade_cycle_id` SHALL each be a non-empty string. `ticker` SHALL be a non-empty string. ABI SHALL impose no regex, length limit, canonicalization, case conversion, UUID shape, or derivation rule on these Runtime-owned values and SHALL pass them onward unchanged.

#### Scenario: Opaque values are preserved
- **WHEN** both path identifiers and ticker are non-empty strings
- **THEN** ABI accepts their transport form
- **AND** ABI preserves the exact decoded identifiers and exact ticker string

#### Scenario: Empty opaque value is rejected
- **WHEN** either path identifier or ticker is an empty string
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the empty value

#### Scenario: Canonical Runtime ticker with suffix is accepted
- **WHEN** ticker is `BTCUSDT.P`
- **THEN** ABI accepts and preserves `BTCUSDT.P`

### Requirement: DesiredEntry preserves the Runtime contract
A non-null `desired_entry` SHALL be a closed JSON object with exactly these required, non-null fields:

- `side`: string enum `long | short`;
- `source_plan_bar_open_time_ms`: JSON integer;
- `planned_entry_price`: exact-decimal text;
- `initial_stop_price`: exact-decimal text;
- `initial_take_price`: positive exact-decimal text;
- `locked_exit_profile`: string.

ABI SHALL NOT add a timestamp range, profile length/format rule, price-order rule, or positivity rule for `planned_entry_price` or `initial_stop_price`.

#### Scenario: Complete DesiredEntry is accepted
- **WHEN** all six fields are present, non-null, and have their declared types
- **AND** `side` is `long` or `short`
- **AND** the three price fields are exact-decimal text
- **AND** `initial_take_price` is positive
- **THEN** ABI accepts and preserves the DesiredEntry

#### Scenario: DesiredEntry field type is invalid
- **WHEN** any DesiredEntry field has a type different from its declared type
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies the field

#### Scenario: Side enum is invalid
- **WHEN** `side` is not exactly `long` or `short`
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies `/desired_entry/side`

#### Scenario: Initial take is absent or not positive exact-decimal text
- **WHEN** `initial_take_price` is missing, null, not exact-decimal text, zero, or negative
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies `/desired_entry/initial_take_price`

#### Scenario: ABI does not add DesiredEntry semantics
- **WHEN** a DesiredEntry satisfies the source-contract invariants above
- **THEN** ABI transport validation does not reject it based on timestamp magnitude, profile length/content, price ordering, or entry/stop positivity

### Requirement: Exact-decimal text is preserved
Price fields and non-null `risk_multiplier` SHALL be JSON strings representing finite decimal values and SHALL be validated without binary floating-point conversion. `initial_take_price` and `risk_multiplier` SHALL represent values greater than zero. ABI SHALL apply no decimal regex, text-length limit, or normalization and SHALL preserve accepted strings unchanged.

#### Scenario: Exact-decimal strings are accepted unchanged
- **WHEN** price and multiplier fields are valid exact-decimal strings
- **AND** `initial_take_price` and `risk_multiplier` are positive
- **THEN** ABI accepts and preserves their string values

#### Scenario: Decimal JSON number is rejected
- **WHEN** a price or multiplier is supplied as a JSON number instead of a string
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`

#### Scenario: Risk multiplier is invalid
- **WHEN** non-null `risk_multiplier` is not exact-decimal text, zero, or negative
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies `/risk_multiplier`

### Requirement: Applied success acknowledges the complete package
Successful application or replacement SHALL return HTTP `200` with a closed JSON object containing exactly:

- `strategy_instance_id`: exact decoded path value;
- `trade_cycle_id`: exact decoded path value;
- `status`: literal `entry_package_applied`;
- `applied_desired_entry`: the complete accepted DesiredEntry;
- `accepted_risk_multiplier`: the accepted positive exact-decimal string;
- `calculated_quantity`: exact-decimal string.

`entry_package_applied` SHALL mean that the indivisible package `entry + initial stop + initial take` was applied and is now the acknowledged ABI state. Partial application SHALL NOT return this DTO or any other `2xx`.

#### Scenario: Complete package is acknowledged
- **WHEN** the complete entry, initial stop, and initial take package has been applied
- **THEN** ABI returns HTTP `200`
- **AND** `status` is `entry_package_applied`
- **AND** the response matches the exact applied-success DTO

#### Scenario: Partial package is not acknowledged
- **WHEN** entry, initial stop, and initial take were not all applied
- **THEN** ABI returns a non-`2xx` public error response
- **AND** ABI does not return `entry_package_applied`
- **AND** ABI does not return any other success acknowledgement

### Requirement: Absent success acknowledges desired package absence
Confirmed desired-state absence SHALL return HTTP `200` with a closed JSON object containing exactly:

- `strategy_instance_id`: exact decoded path value;
- `trade_cycle_id`: exact decoded path value;
- `status`: literal `entry_package_absent`.

#### Scenario: Package absence is acknowledged
- **WHEN** absence of the desired entry package is confirmed
- **AND** the package was removed during this request or was already absent
- **THEN** ABI returns HTTP `200`
- **AND** `status` is `entry_package_absent`
- **AND** the response confirms state without asserting that a cancellation action occurred
- **AND** the response matches the exact absent-success DTO

### Requirement: Errors use one public DTO and transport-only code set
Every error SHALL use a closed JSON object with required `error.code` and safe non-empty `error.message`. `error.details` SHALL be a non-empty array of objects containing exactly `path` and `message` for `validation_failed`, SHALL be omitted for other codes, and SHALL never be null.

The V1 mapping SHALL be exactly:

| HTTP | Public error code |
|---:|---|
| 400 | `malformed_json` |
| 415 | `unsupported_media_type` |
| 422 | `validation_failed` |
| 500 | `internal_error` |

No failure SHALL be suppressed or serialized as success.

#### Scenario: Malformed JSON is mapped
- **WHEN** the body is absent or syntactically invalid JSON
- **THEN** ABI returns HTTP `400`
- **AND** `error.code` is `malformed_json`

#### Scenario: Validation failure is mapped
- **WHEN** transport validation fails
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` is non-empty

#### Scenario: Unknown failure is safe
- **WHEN** the HTTP boundary receives an unknown failure or any non-success not covered by transport validation
- **THEN** ABI returns HTTP `500`
- **AND** `error.code` is `internal_error`
- **AND** the response omits internal exception, stack, exchange, and workflow details
- **AND** ABI returns no success acknowledgement

### Requirement: OpenAPI describes only the external contract
ABI SHALL provide an OpenAPI 3.1 operation matching the method, route, request union, success DTOs, error DTO, nullability, source-contract validation, and HTTP mappings in this capability. It SHALL NOT define internal application interfaces, lifecycle result types, exchange references, or legacy endpoint fields.

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI operation and contract-level tests are validated
- **THEN** request and response schemas match this capability
- **AND** no undocumented Runtime-value restriction or internal ABI workflow appears in the public contract
