## MODIFIED Requirements

### Requirement: Errors use one public DTO and transport-only code set
Every error SHALL use a closed JSON object with required `error.code` and safe non-empty `error.message`. `error.details` SHALL be a non-empty array of objects containing exactly `path` and `message` for `validation_failed`, SHALL be omitted for other codes, and SHALL never be null.

The V1 mapping SHALL be exactly:

| HTTP | Public error code |
|---:|---|
| 400 | `malformed_json` |
| 415 | `unsupported_media_type` |
| 422 | `validation_failed` |
| 500 | `internal_error` |
| 503 | `execution_not_ready` |

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

#### Scenario: Execution is unavailable before admission
- **WHEN** a valid request reaches the execution boundary while ABI is not ready
- **THEN** ABI returns HTTP `503` with `error.code` `execution_not_ready` and a safe non-empty `error.message`
- **AND** the request causes no exchange operation, execution record, or deferred trading command
- **AND** this response is forbidden after admission, even if readiness subsequently changes
