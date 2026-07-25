## 1. Transport DTOs and schemas

- [x] 1.1 Define closed DTOs for path values, request body, DesiredEntry, applied success, absent success, and the public error envelope.
- [x] 1.2 Define request schemas for required fields, nullability, `long | short`, JSON integer timestamp type, exact-decimal text, positive initial take, and positive risk multiplier.
- [x] 1.3 Validate `strategy_instance_id`, `trade_cycle_id`, and ticker only as non-empty strings and preserve them unchanged.
- [x] 1.4 Ensure transport schemas add no regex, length, normalization, price-order, timestamp-range, or extra positivity rules to Runtime-owned values.

## 2. HTTP boundary

- [x] 2.1 Add matching for `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`.
- [x] 2.2 Implement JSON content-type handling, parsing, path/body validation, and construction of the validated transport command.
- [x] 2.3 Keep the route boundary independent of executor, sizing, risk, exchange, journal, signal, and intent workflows.

## 3. Response and error serialization

- [x] 3.1 Serialize the exact applied and absent HTTP `200` DTOs without exchange references, execution status, or additional fields.
- [x] 3.2 Enforce that applied success is available only for the complete `entry + initial stop + initial take` package and that a partial result cannot produce any `2xx`.
- [x] 3.3 Serialize `malformed_json`, `unsupported_media_type`, `validation_failed`, and safe `internal_error` using the single public error DTO.
- [x] 3.4 Include field details only for validation failures and never expose internal exceptions or workflow details.

## 4. OpenAPI

- [x] 4.1 Add an OpenAPI 3.1 operation for the exact method and route.
- [x] 4.2 Describe the closed request union, Runtime-owned opaque strings, DesiredEntry source invariants, exact-decimal fields, success DTOs, error DTO, and four HTTP mappings.
- [x] 4.3 Add valid package, valid absence, applied, absent, validation-error, and internal-error examples.
- [x] 4.4 Validate that OpenAPI introduces no internal ABI types or extra Runtime-value constraints.

## 5. Contract-level tests

- [x] 5.1 Test method/path, JSON content type, malformed JSON, request structure, required fields, unknown fields, and nullability combinations.
- [x] 5.2 Test opaque non-empty identifiers and ticker, including exact preservation of `BTCUSDT.P`.
- [x] 5.3 Test DesiredEntry field types, side enum, exact-decimal strings, positive initial take, and positive risk multiplier without testing invented ABI constraints.
- [x] 5.4 Test exact applied and absent response shapes, including the already-absent case, and decimal/string preservation.
- [x] 5.5 Test that partial package application returns non-`2xx` and never a success acknowledgement.
- [x] 5.6 Test each public error mapping and safe unknown-failure handling.

## 6. Verification

- [x] 6.1 Run OpenAPI and entry-package contract validation.
- [x] 6.2 Run `npm test`.
- [x] 6.3 Run `npm run typecheck`.
- [x] 6.4 Run `npm run build`.
- [x] 6.5 Review the diff for internal application architecture, executor workflow, exchange details, or additional Runtime-value validation.
