## 1. Transport DTOs and schemas

- [ ] 1.1 Define closed DTOs for the protection request, protection success, close success, and the
      shared public error envelope (reusing `EntryPackageValidationDetail`'s `{ path, message }`
      shape).
- [ ] 1.2 Define request schema for `stop_price` (required exact-decimal text) and `take_price`
      (exact-decimal text or `null`).
- [ ] 1.3 Define `PositionManagementErrorCode = "malformed_json" | "unsupported_media_type" |
      "validation_failed" | "unknown_trade_cycle_binding" | "internal_error"`, reusing the existing
      codes rather than redefining them.

## 2. HTTP boundary

- [ ] 2.1 Add matching for `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`.
- [ ] 2.2 Add matching for `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`, requiring no body.
- [ ] 2.3 Implement path decoding for both routes reusing the existing opaque-segment
      decode-and-empty-check approach.
- [ ] 2.4 Keep both route boundaries independent of exchange/execution wiring — they construct a
      validated transport command only.

## 3. Response and error serialization

- [ ] 3.1 Serialize the exact `protection_applied` and `trade_cycle_closed` HTTP `200` DTOs with no
      additional fields.
- [ ] 3.2 Enforce that neither success DTO is reachable except through a verified-outcome path (no
      route in the boundary layer can emit `2xx` from a bare "accepted" result).
- [ ] 3.3 Serialize `malformed_json`, `unsupported_media_type`, `validation_failed`,
      `unknown_trade_cycle_binding`, and safe `internal_error` using the shared error DTO.

## 4. OpenAPI

- [ ] 4.1 Add OpenAPI 3.1 operations for both routes to the existing document.
- [ ] 4.2 Describe request/response DTOs, nullability, and the five-entry HTTP mapping table.
- [ ] 4.3 Add applied/closed, validation-error, unknown-binding, and internal-error examples for
      each operation.
- [ ] 4.4 Validate that OpenAPI introduces no internal ABI types, order-attribution mechanics, or
      exchange adapter shapes.

## 5. Contract-level tests

- [ ] 5.1 Test method/path matching, JSON content type, and body validation for the protection
      endpoint (missing/malformed `stop_price`, malformed non-null `take_price`, valid null
      `take_price`).
- [ ] 5.2 Test that the close endpoint accepts no body and exposes no quantity/percentage/fraction
      field.
- [ ] 5.3 Test that neither endpoint's success DTO is emitted from an "accepted but unverified"
      outcome (using a stub verification result the boundary layer treats as inconclusive).
- [ ] 5.4 Test `unknown_trade_cycle_binding` and `internal_error` mapping for both endpoints.
- [ ] 5.5 Test exact success DTO shapes for both endpoints, including `take_price: null`.

## 6. Verification

- [ ] 6.1 Run OpenAPI validation for the updated document.
- [ ] 6.2 Run `npm test`.
- [ ] 6.3 Run `npm run typecheck`.
- [ ] 6.4 Run `npm run build`.
- [ ] 6.5 Review the diff for internal application architecture, exchange details, or order-attribution mechanics leaking into the public contract.
