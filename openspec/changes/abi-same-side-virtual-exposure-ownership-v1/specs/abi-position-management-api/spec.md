## MODIFIED Requirements

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
