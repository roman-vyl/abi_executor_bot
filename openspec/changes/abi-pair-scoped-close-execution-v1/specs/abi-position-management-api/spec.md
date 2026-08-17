## RENAMED Requirements
- FROM: `### Requirement: ABI exposes a close endpoint accepting only an empty body`
- TO: `### Requirement: ABI exposes a close endpoint accepting a canonical exposure_fraction`
- FROM: `### Requirement: Close means the full current remainder, determined by ABI`
- TO: `### Requirement: Close means the requested cycle's full resolved exposure, determined by ABI`

## MODIFIED Requirements

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

### Requirement: Close success means both postconditions are verified under complete pair correlation
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly
`strategy_instance_id`, `trade_cycle_id`, and `status: "trade_cycle_closed"`. `trade_cycle_closed`
SHALL be returned only once ABI has verified both: the requested cycle's own resolved exposure has
been removed from the pair's scope (the scope's aggregate live position is zero, or has decreased by
exactly the quantity ABI resolved and closed for this cycle), and no order ABI attributes to the pair
remains active — and only when the pair's stored correlation is complete and non-contradictory.
Incomplete or contradictory correlation, or accepting the close request alone, SHALL NOT produce this
status or any other `2xx`.

#### Scenario: Verified full close is acknowledged
- **WHEN** ABI has verified the requested cycle's resolved exposure removed from the scope and no
  attributable active order remains, under complete pair correlation
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"`

#### Scenario: Incomplete or contradictory correlation blocks success
- **WHEN** the pair's stored correlation data is incomplete or internally contradictory
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`

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
| 422 | `position_exposure_drift` | close only |
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
