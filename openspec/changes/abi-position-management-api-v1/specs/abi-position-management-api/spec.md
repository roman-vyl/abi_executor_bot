## Purpose

Define the public V1 Runtime → ABI HTTP contract for applying protection to, and fully closing, an
already-open, Runtime-owned trade cycle position, addressed by the existing
`strategy_instance_id` + `trade_cycle_id` ownership pair.

## ADDED Requirements

### Requirement: ABI exposes a protection endpoint
ABI SHALL expose `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, accepting `application/json` and returning `application/json; charset=utf-8`. The body SHALL be a closed JSON object with exactly `stop_price` (required, non-null, exact-decimal text) and `take_price` (exact-decimal text or `null`).

#### Scenario: Valid protection request is accepted
- **WHEN** `stop_price` is exact-decimal text and `take_price` is exact-decimal text or `null`
- **THEN** ABI processes the request through the protection HTTP boundary

#### Scenario: Missing or malformed price field is rejected
- **WHEN** `stop_price` is missing, null, or not valid exact-decimal text, or `take_price` is present, non-null, and not valid exact-decimal text
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed` identifying the offending field

### Requirement: Protection confirmation requires exact numeric equality, not exchange acceptance
`protection_applied` SHALL be returned only once ABI has verified, via exact-decimal numeric comparison, that the exchange's confirmed protection equals the requested `stop_price`/`take_price` — string formatting differences (e.g. trailing zeros) SHALL NOT block confirmation, but any genuine numeric difference SHALL. An exchange acknowledgement that a write was accepted, submitted, or queued SHALL NOT by itself satisfy this requirement. The response SHALL echo the canonical requested values, never an exchange-normalized representation.

#### Scenario: Verified protection is acknowledged with canonical values
- **WHEN** the exchange's confirmed stop/take are numerically equal to the requested values
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the requested `stop_price`/`take_price` as submitted

#### Scenario: Exchange-normalized value blocks success
- **WHEN** the exchange's confirmed stop or take is numerically different from the requested value (e.g. adjusted to a tick size)
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: Accepted-but-unverified write is not acknowledged
- **WHEN** the exchange has accepted, submitted, or queued the write but ABI has not verified it
- **THEN** ABI does not return `protection_applied` or any other `2xx`

### Requirement: Protection fails closed when the pair has no live position to protect
When a known binding exists for the pair but ABI verifies no live open position exists, ABI SHALL return HTTP `422` with `error.code` `position_not_open`, not `internal_error`.

#### Scenario: Protection is rejected for a closed position
- **WHEN** the requested pair has a known binding but its live position size is verified zero
- **THEN** ABI returns HTTP `422` with `error.code` `position_not_open`

### Requirement: ABI exposes a close endpoint accepting only an empty body
ABI SHALL expose `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`, defining no field of any kind for quantity, percentage, or close fraction. The request body SHALL be absent or zero-length. Any non-empty body SHALL be rejected as `validation_failed`, never silently ignored.

#### Scenario: Empty-body request is accepted
- **WHEN** a client sends `DELETE` to the route with no body
- **THEN** ABI accepts the request based solely on the two path identifiers

#### Scenario: Non-empty body is rejected
- **WHEN** a `DELETE` request carries any non-empty body, including one that would set a quantity, percentage, or close fraction
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed`
- **AND** ABI does not act on any content of that body

### Requirement: Close means the full current remainder, determined by ABI
A close request SHALL mean closing 100% of the pair's actual current open position size, as ABI determines it from the exchange at the time of the request — never a caller-supplied quantity.

#### Scenario: ABI determines the size to close
- **WHEN** ABI processes a close request for a pair with an open position
- **THEN** ABI determines the position's current size itself and closes all of it
- **AND** no partial-close outcome is possible through this endpoint

### Requirement: Close proceeds only under unambiguous pair ownership within the supported V1 exchange scope
ABI SHALL close a position, and cancel orders for it, only when it can resolve the requested pair to exactly one unambiguous exchange position within the supported V1 exchange scope. ABI SHALL fail closed — never proceed, never return `2xx` — when the resolved position's exchange category is outside the supported V1 scope (`unsupported_exchange_scope`), or when exposure on the resolved symbol, account, or position slot is ambiguous or overlapping such that it cannot be uniquely attributed to the pair (`internal_error`). ABI SHALL NOT cancel any order it cannot attribute to the exact requested pair, regardless of shared symbol or account.

#### Scenario: Unsupported exchange scope is rejected before any close action
- **WHEN** the resolved position's exchange category is outside this capability's supported V1 scope
- **THEN** ABI returns HTTP `422` with `error.code` `unsupported_exchange_scope`
- **AND** ABI takes no cancel or close action

#### Scenario: Ambiguous ownership is not closed
- **WHEN** exposure on the resolved symbol, account, or position slot cannot be uniquely attributed to the requested pair, including an unsupported or unexpected position-slot signal
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`
- **AND** ABI does not cancel or close any position or order on that ambiguous basis

#### Scenario: Only pair-owned orders are cancelled
- **WHEN** ABI closes a position for a pair
- **THEN** every order ABI attributes to that pair — protective, limit, conditional, and residual entry — is cancelled
- **AND** no order ABI cannot attribute to that pair is cancelled, even on the same symbol or account

### Requirement: Close success means both postconditions are verified under complete pair correlation
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, and `status: "trade_cycle_closed"`. `trade_cycle_closed` SHALL be returned only once ABI has verified both: the pair's open position size is zero, and no order ABI attributes to the pair remains active — and only when the pair's stored correlation is complete and non-contradictory. Incomplete or contradictory correlation, or accepting the close/cancel requests alone, SHALL NOT produce this status or any other `2xx`.

#### Scenario: Verified full close is acknowledged
- **WHEN** ABI has verified zero open size and no attributable active order remains, under complete pair correlation
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"`

#### Scenario: Incomplete or contradictory correlation blocks success
- **WHEN** the pair's stored correlation data is incomplete or internally contradictory
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

### Requirement: Close still runs and verifies cleanup when no position is open
When the pair's open position is already zero at the start of a close request, ABI SHALL still perform and verify order cleanup for that pair before returning success.

#### Scenario: Already-closed position still verifies leftover orders
- **WHEN** a close request is received for a pair whose open position is already zero
- **THEN** ABI still checks for and cancels any order it attributes to that pair
- **AND** ABI returns `trade_cycle_closed` only after verifying none remain active

### Requirement: Both endpoints reuse a shared, closed error vocabulary
Both endpoints SHALL use the closed error envelope `{ error: { code, message, details? } }` already defined by `abi-entry-package-api`, and SHALL reuse `unknown_trade_cycle_binding` and `unsupported_exchange_scope` from `abi-open-position-lookup-api` rather than redefining them. The V1 mapping SHALL be exactly:

| HTTP | Public error code | Endpoint |
|---:|---|---|
| 400 | `malformed_json` | protection |
| 415 | `unsupported_media_type` | protection |
| 422 | `validation_failed` | both |
| 422 | `unknown_trade_cycle_binding` | both |
| 422 | `unsupported_exchange_scope` | both |
| 422 | `position_not_open` | protection only |
| 500 | `internal_error` | both |

No response SHALL include internal exception, stack, or raw exchange details, and no failure SHALL be serialized as success.

#### Scenario: Unknown pair is rejected on either endpoint
- **WHEN** the requested pair has no known binding
- **THEN** ABI returns HTTP `422` with `error.code` `unknown_trade_cycle_binding`

### Requirement: OpenAPI describes only the external contract
ABI SHALL provide an OpenAPI 3.1 operation for each endpoint, matching the method, route, request/response DTOs, nullability, and HTTP mappings in this capability. It SHALL NOT define internal application interfaces, order-attribution mechanics, or exchange adapter shapes.

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI operations and contract-level tests are validated
- **THEN** request and response schemas match this capability, and no internal ABI workflow or exchange detail appears in the public contract
