## Purpose

Define the public V1 Runtime → ABI HTTP contract for applying protection to, and fully closing, an
already-open, Runtime-owned trade cycle position, addressed by the existing
`strategy_instance_id` + `trade_cycle_id` ownership pair.

## ADDED Requirements

### Requirement: ABI exposes a protection endpoint
ABI SHALL expose `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, accepting `application/json` and returning `application/json; charset=utf-8`. The body SHALL be a closed JSON object with exactly:

- `stop_price`: required, non-null, exact-decimal text;
- `take_price`: exact-decimal text or `null`.

#### Scenario: Valid protection request is accepted
- **WHEN** `stop_price` is exact-decimal text and `take_price` is exact-decimal text or `null`
- **THEN** ABI processes the request through the protection HTTP boundary

#### Scenario: Missing or malformed stop_price is rejected
- **WHEN** `stop_price` is missing, null, not a string, or not valid exact-decimal text
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies `/stop_price`

#### Scenario: Malformed non-null take_price is rejected
- **WHEN** `take_price` is present, non-null, and not valid exact-decimal text
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `validation_failed`
- **AND** `error.details` identifies `/take_price`

### Requirement: Protection success means verified, not merely accepted
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, `status: "protection_applied"`, `stop_price`, and `take_price` (`take_price` `null` when no take-profit protection is requested). `protection_applied` SHALL be returned only once ABI has verified that `stop_price`/`take_price` are the position's actual current protection. An exchange acknowledgement that the write was accepted, submitted, or queued SHALL NOT by itself produce this status or any other `2xx`.

#### Scenario: Verified protection is acknowledged
- **WHEN** ABI has verified the requested stop/take state is the position's actual current protection
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the verified `stop_price`/`take_price`

#### Scenario: Accepted-but-unverified write is not acknowledged
- **WHEN** the exchange has accepted, submitted, or queued the protection write but ABI has not verified it took effect
- **THEN** ABI does not return `protection_applied` or any other `2xx`

### Requirement: ABI exposes a close endpoint
ABI SHALL expose `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`. ABI SHALL NOT require or parse a request body for this endpoint, and SHALL provide no request field for quantity, percentage, or close fraction.

#### Scenario: Close request carries no size input
- **WHEN** a client sends `DELETE` to the route
- **THEN** ABI accepts the request based solely on the two path identifiers
- **AND** no field of any kind conveys a quantity, percentage, or fraction to close

### Requirement: Close means the full current remainder, determined by ABI
A close request SHALL mean closing 100% of the pair's actual current open position size, as ABI determines it from the exchange at the time of the request — never a caller-supplied quantity.

#### Scenario: ABI determines the size to close
- **WHEN** ABI processes a close request for a pair with an open position
- **THEN** ABI determines the position's current size itself and closes all of it
- **AND** no partial-close outcome is possible through this endpoint

### Requirement: Close removes every order ABI can attribute to the pair, and only those
ABI SHALL cancel every active exchange order it can attribute to the requested `strategy_instance_id` + `trade_cycle_id` pair — including protective, limit, conditional, and residual entry orders for that pair — and SHALL NOT cancel any order it cannot attribute to that exact pair, regardless of shared symbol or account.

#### Scenario: Only pair-owned orders are cancelled
- **WHEN** ABI processes a close request
- **THEN** every order ABI attributes to the requested pair is cancelled
- **AND** no order ABI cannot attribute to that pair is cancelled, even if it shares the same symbol or account

### Requirement: Close success means both postconditions are verified
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, and `status: "trade_cycle_closed"`. `trade_cycle_closed` SHALL be returned only once ABI has verified both: the pair's open position size is zero, and no order ABI attributes to the pair remains active. Accepting the close/cancel requests SHALL NOT by itself produce this status or any other `2xx`.

#### Scenario: Verified full close is acknowledged
- **WHEN** ABI has verified the pair's open position size is zero and no attributable order remains active
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"`

#### Scenario: Accepted-but-unverified cancel/close is not acknowledged
- **WHEN** cancel or close requests have been sent to the exchange but ABI has not verified both postconditions
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

### Requirement: Close still runs and verifies cleanup when no position is open
When the pair's open position is already zero at the start of a close request, ABI SHALL still perform and verify order cleanup for that pair before returning success, rather than treating absence of a position as sufficient by itself.

#### Scenario: Already-closed position still verifies leftover orders
- **WHEN** a close request is received for a pair whose open position is already zero
- **THEN** ABI still checks for and cancels any order it attributes to that pair
- **AND** ABI returns `trade_cycle_closed` only after verifying none remain active

### Requirement: Both endpoints reuse the existing pair-scoped error vocabulary
Both endpoints SHALL use the closed error envelope `{ error: { code, message, details? } }` already defined by `abi-entry-package-api`, with the same `{ path, message }` shape for `details`. Both endpoints SHALL reuse `unknown_trade_cycle_binding` (`abi-open-position-lookup-api`) when the requested pair has no known binding at all. The V1 mapping SHALL be exactly:

| HTTP | Public error code | Endpoint |
|---:|---|---|
| 400 | `malformed_json` | protection |
| 415 | `unsupported_media_type` | protection |
| 422 | `validation_failed` | both |
| 422 | `unknown_trade_cycle_binding` | both |
| 500 | `internal_error` | both |

No response from either endpoint SHALL include internal exception, stack, or raw exchange details, and no failure SHALL be serialized as success.

#### Scenario: Unknown pair is rejected on either endpoint
- **WHEN** the requested pair has no known binding
- **THEN** ABI returns HTTP `422`
- **AND** `error.code` is `unknown_trade_cycle_binding`

#### Scenario: Unresolvable failure maps to internal_error
- **WHEN** an exchange query or write fails, or its outcome cannot be safely verified
- **THEN** ABI returns HTTP `500`
- **AND** `error.code` is `internal_error`
- **AND** ABI does not return a success acknowledgement

### Requirement: OpenAPI describes only the external contract
ABI SHALL provide an OpenAPI 3.1 operation for each endpoint, matching the method, route, request/response DTOs, nullability, and HTTP mappings in this capability. It SHALL NOT define internal application interfaces, order-attribution mechanics, or exchange adapter shapes.

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI operations and contract-level tests are validated
- **THEN** request and response schemas match this capability
- **AND** no internal ABI workflow or exchange detail appears in the public contract
