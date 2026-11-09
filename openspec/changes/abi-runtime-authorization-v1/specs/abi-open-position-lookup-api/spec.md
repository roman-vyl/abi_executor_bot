## MODIFIED Requirements

### Requirement: Errors use the existing public error envelope with a scoped code set
Every error response SHALL use the closed JSON envelope `{ error: { code, message, details? } }`, with the same `EntryPackageValidationDetail`-shaped `details` array (`path`, `message`) used by the entry-package contract when present. `details` SHALL be omitted for codes other than `validation_failed` and SHALL never be `null`.

The V1 mapping for this endpoint SHALL be exactly:

| HTTP | Public error code |
|---:|---|
| 422 | `validation_failed` |
| 422 | `unknown_trade_cycle_binding` |
| 422 | `unsupported_exchange_scope` |
| 500 | `internal_error` |
| 503 | `execution_not_ready` |

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

#### Scenario: Execution is unavailable before admission
- **WHEN** a valid request reaches the execution boundary while ABI is not ready
- **THEN** ABI returns HTTP `503` with `error.code` `execution_not_ready` and a safe non-empty `error.message`
- **AND** the request causes no exchange operation, execution record, or deferred trading command
- **AND** this response is forbidden after admission, even if readiness subsequently changes
