## 1. Transport DTOs and schemas

- [ ] 1.1 Define closed DTOs for path values, request body, DesiredEntry, applied success, absent success, and the public error envelope.
- [ ] 1.2 Define request schemas for required fields, nullability, `long | short`, JSON integer timestamp type, exact-decimal text, positive initial take, and positive risk multiplier.
- [ ] 1.3 Validate `strategy_instance_id`, `trade_cycle_id`, and ticker only as non-empty strings and preserve them unchanged.
- [ ] 1.4 Ensure transport schemas add no regex, length, normalization, price-order, timestamp-range, or extra positivity rules to Runtime-owned values.

## 2. HTTP boundary

- [ ] 2.1 Add matching for `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`.
- [ ] 2.2 Implement JSON content-type handling, parsing, path/body validation, and construction of the validated transport command.
- [ ] 2.3 Keep the route boundary independent of executor, sizing, risk, exchange, journal, signal, and intent workflows.

## 3. Response and error serialization

- [ ] 3.1 Serialize the exact applied and absent HTTP `200` DTOs without exchange references, execution status, or additional fields.
- [ ] 3.2 Enforce that applied success is available only for the complete `entry + initial stop + initial take` package and that a partial result cannot produce any `2xx`.
- [ ] 3.3 Serialize `malformed_json`, `unsupported_media_type`, `validation_failed`, and safe `internal_error` using the single public error DTO.
- [ ] 3.4 Include field details only for validation failures and never expose internal exceptions or workflow details.

## 4. OpenAPI

- [ ] 4.1 Add an OpenAPI 3.1 operation for the exact method and route.
- [ ] 4.2 Describe the closed request union, Runtime-owned opaque strings, DesiredEntry source invariants, exact-decimal fields, success DTOs, error DTO, and four HTTP mappings.
- [ ] 4.3 Add valid package, valid absence, applied, absent, validation-error, and internal-error examples.
- [ ] 4.4 Validate that OpenAPI introduces no internal ABI types or extra Runtime-value constraints.

## 5. Contract-level tests

- [ ] 5.1 Test method/path, JSON content type, malformed JSON, request structure, required fields, unknown fields, and nullability combinations.
- [ ] 5.2 Test opaque non-empty identifiers and ticker, including exact preservation of `BTCUSDT.P`.
- [ ] 5.3 Test DesiredEntry field types, side enum, exact-decimal strings, positive initial take, and positive risk multiplier without testing invented ABI constraints.
- [ ] 5.4 Test exact applied and absent response shapes, including the already-absent case, and decimal/string preservation.
- [ ] 5.5 Test that partial package application returns non-`2xx` and never a success acknowledgement.
- [ ] 5.6 Test each public error mapping and safe unknown-failure handling.

## 6. Verification

- [ ] 6.1 Run OpenAPI and entry-package contract validation.
- [ ] 6.2 Run `npm test`.
- [ ] 6.3 Run `npm run typecheck`.
- [ ] 6.4 Run `npm run build`.
- [ ] 6.5 Review the diff for internal application architecture, executor workflow, exchange details, or additional Runtime-value validation.
