# abi-position-management-api Specification

## Purpose
Define the public V1 Runtime → ABI HTTP contract for applying protection to, and closing (`exposure_fraction`, canonical value `"1"` in V1) an already-open, Runtime-owned trade cycle position, addressed by the existing `strategy_instance_id` + `trade_cycle_id` ownership pair.
## Requirements
### Requirement: ABI exposes a protection endpoint
ABI SHALL expose `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, accepting `application/json` and returning `application/json; charset=utf-8`. The body SHALL be a closed JSON object with exactly `stop_price` (required, non-null, strictly positive exact-decimal text) and `take_price` (strictly positive exact-decimal text, or `null`). Zero and negative values SHALL be rejected for both fields: Bybit's own protection-clearing command reserves the numeric value zero to mean "remove this leg," so accepting zero as a real price at this public boundary would let a caller silently strip protection while ABI still reports `protection_applied`.

#### Scenario: Valid protection request is accepted
- **WHEN** `stop_price` is strictly positive exact-decimal text and `take_price` is strictly positive exact-decimal text or `null`
- **THEN** ABI processes the request through the protection HTTP boundary

#### Scenario: Missing or malformed price field is rejected
- **WHEN** `stop_price` is missing, null, not valid exact-decimal text, or not strictly positive, or `take_price` is present, non-null, and either not valid exact-decimal text or not strictly positive
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed` identifying the offending field

#### Scenario: Zero is rejected as a real price
- **WHEN** `stop_price` or a non-null `take_price` is exactly zero
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed`, the same as any other malformed price

### Requirement: ABI exposes a close endpoint accepting a canonical exposure_fraction
ABI SHALL expose `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close`,
accepting `application/json` and returning `application/json; charset=utf-8`. The body SHALL be a
closed JSON object with exactly one field, `exposure_fraction` (required, non-null, exact-decimal
text). V1 SHALL accept only a value numerically equal to `1` — the canonical value meaning "close this
trade cycle's entire resolved exposure" — regardless of its exact-decimal formatting (`"1"` and
`"1.0"` are both accepted, since they are the same number). Any other exact-decimal value (`"0.5"`,
`"0"`, `"2"`, a negative value), any string that is not valid exact-decimal text, a missing or null
`exposure_fraction`, or any additional field in the body SHALL be rejected as `validation_failed`,
with `error.details` identifying the offending field (`/exposure_fraction`, or `/` for an unrecognized
field), before any exchange call and before any durable write. This replaces the endpoint's prior
`DELETE .../open-position` empty-body form: that route no longer exists once this requirement is in
effect — a request to it SHALL receive ABI's generic not-found response, not a business error from
this capability.

#### Scenario: Canonical request is accepted
- **WHEN** a client sends `POST .../close` with body `{"exposure_fraction": "1"}` (or any exact-decimal
  text numerically equal to `1`, such as `"1.0"`)
- **THEN** ABI processes the request through the close HTTP boundary

#### Scenario: A non-canonical fraction is rejected
- **WHEN** `exposure_fraction` is present but not numerically equal to `1` (for example `"0.5"`,
  `"0"`, `"2"`, or a negative value)
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed`, and does not act on any
  content of that body

#### Scenario: A missing, malformed, or extra field is rejected
- **WHEN** `exposure_fraction` is missing, `null`, not valid exact-decimal text, or the body contains
  any field other than `exposure_fraction`
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed` identifying the offending field

#### Scenario: The retired DELETE route no longer resolves to this capability
- **WHEN** a client sends `DELETE` to the pair's `open-position` path
- **THEN** ABI does not process it through this capability's close boundary at all

### Requirement: Both write operations require unambiguous, in-scope position-scope resolution before any exchange write
Before performing any exchange write, ABI SHALL resolve the requested pair to exactly one unambiguous, supported exchange position scope — the combination of account, category, symbol, and position slot — for both `PUT .../protection` and `POST .../close`. This scope MAY currently hold a positive or zero size; resolving it does not by itself imply a live position exists. ABI SHALL fail closed — perform no exchange write, return no `2xx` — when the resolved scope's exchange category is outside the supported V1 scope (`unsupported_exchange_scope`), or when exposure on the resolved account, category, symbol, or position slot is ambiguous or overlapping such that it cannot be uniquely attributed to the pair (`internal_error`). Each endpoint's own size-dependent check (`position_not_open` for protection; cleanup verification for close) SHALL be evaluated only after this resolution succeeds.

#### Scenario: Unsupported exchange scope blocks both operations
- **WHEN** the resolved scope's exchange category is outside this capability's supported V1 scope
- **THEN** ABI returns HTTP `422` with `error.code` `unsupported_exchange_scope`
- **AND** ABI performs no exchange write

#### Scenario: Ambiguous ownership blocks both operations
- **WHEN** exposure on the resolved account, category, symbol, or position slot cannot be uniquely attributed to the requested pair, including an unsupported or unexpected position-slot signal
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`
- **AND** ABI performs no exchange write

#### Scenario: A zero-size scope still resolves unambiguously
- **WHEN** the requested pair's position scope is otherwise unambiguous and supported but its current size is zero
- **THEN** scope resolution succeeds
- **AND** ABI proceeds to the endpoint's own size-dependent check rather than failing on scope alone

### Requirement: Protection success is a closed object, confirmed by exact numeric equality
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, `status: "protection_applied"`, `stop_price`, and `take_price` (`take_price` `null` when the request's `take_price` was `null`). `protection_applied` SHALL be returned only once ABI has verified, via exact-decimal numeric comparison, that the exchange's confirmed protection equals the requested `stop_price`/`take_price` — string formatting differences (e.g. trailing zeros) SHALL NOT block confirmation, but any genuine numeric difference SHALL. An exchange acknowledgement that a write was accepted, submitted, or queued SHALL NOT by itself satisfy this requirement. ABI SHALL NOT canonicalize, reformat, or otherwise alter the accepted request values: the response SHALL return the exact `stop_price`/`take_price` strings ABI accepted in the request, unchanged. When the exchange's confirmed protection already numerically equals the requested values before any write, ABI SHALL return `protection_applied` without sending an exchange write.

#### Scenario: Verified protection returns the accepted request strings unchanged
- **WHEN** the exchange's confirmed stop/take are numerically equal to the requested values
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the exact `stop_price`/`take_price` strings it accepted in the request

#### Scenario: Response object is closed, with take_price nulled through
- **WHEN** ABI returns `protection_applied`
- **THEN** the response contains exactly `strategy_instance_id`, `trade_cycle_id`, `status`, `stop_price`, and `take_price`, with no additional fields
- **AND** `take_price` is `null` when the request's `take_price` was `null`

#### Scenario: Exchange-normalized value blocks success
- **WHEN** the exchange's confirmed stop or take is numerically different from the requested value (e.g. adjusted to a tick size)
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: Accepted-but-unverified write is not acknowledged
- **WHEN** the exchange has accepted, submitted, or queued the write but ABI has not verified it
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: Already-matching confirmed protection may return protection_applied without exchange mutation
- **WHEN** the exchange's confirmed stop/take already numerically equal the requested values before ABI sends any write
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the exact `stop_price`/`take_price` strings it accepted in the request, having sent no exchange write

### Requirement: Protection fails closed when the resolved scope has no live position to protect
After ABI has resolved a single unambiguous, supported position scope for the pair (per the shared resolution requirement above), if the verified live position size at that scope is zero, ABI SHALL return HTTP `422` with `error.code` `position_not_open`, not `internal_error`.

#### Scenario: Protection is rejected for a resolved but zero-size position
- **WHEN** the requested pair's position scope resolves unambiguously but its live position size is verified zero
- **THEN** ABI returns HTTP `422` with `error.code` `position_not_open`

### Requirement: Close means the requested cycle's full resolved exposure, determined by ABI
A close request SHALL mean closing the canonical `exposure_fraction = 1` of the requested trade
cycle's own resolved exposure, as ABI determines it — never a caller-supplied quantity. Until
same-side ownership activation (a later capability) allows more than one trade cycle to share a
physical position scope, the requested cycle's resolved exposure and the pair's aggregate live
position size are always the same value, so this endpoint's observable result is unchanged from
before this capability's `exposure_fraction` contract existed. Once a scope can have more than one
active trade cycle, "closing 100%" means 100% of the requested cycle's own share, never a sibling
cycle's share and never necessarily the scope's entire aggregate position.

#### Scenario: ABI determines the size to close
- **WHEN** ABI processes a close request for a pair with an open position
- **THEN** ABI determines the requested cycle's own resolved exposure itself and closes all of it
- **AND** no partial-close outcome is possible through this endpoint

#### Scenario: A sibling cycle's exposure is never included
- **WHEN** the requested pair's scope has more than one active trade cycle
- **THEN** the close request closes only the requested cycle's own resolved exposure, never a sibling
  cycle's share of the same physical scope

### Requirement: Close cancels only orders it attributes to the pair
ABI SHALL cancel every order it attributes to the requested pair — protective, limit, conditional, and residual entry — and SHALL NOT cancel any order it cannot attribute to the exact requested pair, regardless of shared symbol or account.

#### Scenario: Only pair-owned orders are cancelled
- **WHEN** ABI closes a position for a pair
- **THEN** every order ABI attributes to that pair is cancelled
- **AND** no order ABI cannot attribute to that pair is cancelled, even on the same symbol or account

### Requirement: Close success means both postconditions are verified under complete pair correlation
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly
`strategy_instance_id`, `trade_cycle_id`, and `status: "trade_cycle_closed"`. `trade_cycle_closed`
SHALL be returned only once ABI has verified both: the requested cycle's own resolved exposure has
actually been closed, and no order ABI attributes to the pair remains active — and only when the
pair's stored correlation is complete and non-contradictory. ABI's proof that the requested cycle's
own exposure was closed SHALL be attributable to that cycle's own close activity specifically, not
inferred solely from a before/after change in the scope's aggregate live position size, since that
aggregate can also move because of a sibling trade cycle sharing the same physical scope. Incomplete
or contradictory correlation, or accepting the close request alone, SHALL NOT produce this status or
any other `2xx`.

#### Scenario: Verified full close is acknowledged
- **WHEN** ABI has verified, attributably to the requested cycle's own close activity, that its
  resolved exposure is closed, and no attributable active order remains, under complete pair
  correlation
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"`

#### Scenario: Incomplete or contradictory correlation blocks success
- **WHEN** the pair's stored correlation data is incomplete or internally contradictory
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

### Requirement: Close still runs and verifies cleanup when no position is open
When the pair's resolved position scope already holds zero size at the start of a close request, ABI SHALL still perform and verify order cleanup for that pair before returning success.

#### Scenario: Already-closed position still verifies leftover orders
- **WHEN** a close request is received for a pair whose resolved position scope already holds zero size
- **THEN** ABI still checks for and cancels any order it attributes to that pair
- **AND** ABI returns `trade_cycle_closed` only after verifying none remain active

### Requirement: Both endpoints reuse a shared, closed error vocabulary
Both endpoints SHALL use the closed error envelope `{ error: { code, message, details? } }` already defined by `abi-entry-package-api`, and SHALL reuse `unknown_trade_cycle_binding` and `unsupported_exchange_scope` from `abi-open-position-lookup-api` rather than redefining them. The V1 mapping SHALL be exactly:

| HTTP | Public error code | Endpoint |
|---:|---|---|
| 400 | `malformed_json` | both |
| 415 | `unsupported_media_type` | both |
| 422 | `validation_failed` | both |
| 422 | `unknown_trade_cycle_binding` | both |
| 422 | `unsupported_exchange_scope` | both |
| 422 | `position_not_open` | protection only |
| 422 | `close_execution_incomplete` | close only |
| 422 | `shared_scope_protection_unsupported` | protection only |
| 500 | `internal_error` | both |

No response SHALL include internal exception, stack, or raw exchange details, and no failure SHALL be serialized as success.

#### Scenario: Unknown pair is rejected on either endpoint
- **WHEN** the requested pair has no known binding
- **THEN** ABI returns HTTP `422` with `error.code` `unknown_trade_cycle_binding`

#### Scenario: A malformed close body is rejected the same way a malformed protection body is
- **WHEN** a `POST .../close` request carries a body that is not valid JSON, or a
  `Content-Type` other than `application/json`
- **THEN** ABI returns `malformed_json` or `unsupported_media_type` respectively, the same as
  `PUT .../protection` already does for the same conditions

#### Scenario: A shared-scope protection request is rejected with its own distinct code
- **WHEN** `PUT .../protection` is requested for a pair that actively and legitimately owns its
  scope, but that scope currently has more than one active owner
- **THEN** ABI returns HTTP `422` with `error.code` `shared_scope_protection_unsupported`
- **AND** this code is never returned by `POST .../close`

### Requirement: OpenAPI describes only the external contract
ABI SHALL provide an OpenAPI 3.1 operation for each endpoint, matching the method, route, request/response DTOs, nullability, and HTTP mappings in this capability. It SHALL NOT define internal application interfaces, order-attribution mechanics, or exchange adapter shapes.

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI operations and contract-level tests are validated
- **THEN** request and response schemas match this capability, and no internal ABI workflow or exchange detail appears in the public contract
