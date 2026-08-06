## 1. Transport DTOs and schemas

- [ ] 1.1 Define DTOs for the protection request/success, close success, and shared error envelope,
      plus `PositionManagementErrorCode` including `position_not_open` and reused
      `unsupported_exchange_scope`/`unknown_trade_cycle_binding`.
- [ ] 1.2 Define exact-decimal numeric-equality comparison for protection confirmation, distinct
      from string comparison, and ensure responses echo canonical requested values.

## 2. HTTP boundary

- [ ] 2.1 Add route matching for both endpoints, including a hard empty-body check on `DELETE` that
      rejects any non-empty body (including quantity/percentage/close_fraction fields) as
      `validation_failed` without parsing it as a size input.
- [ ] 2.2 Keep both boundaries independent of exchange/execution wiring — validated transport
      commands only.

## 3. Response and error serialization

- [ ] 3.1 Serialize `protection_applied` and `trade_cycle_closed` reachable only from a
      verified-outcome path (zero, not-accepted-alone), never a bare "accepted" result.
- [ ] 3.2 Serialize `position_not_open`, `unsupported_exchange_scope`, `unknown_trade_cycle_binding`,
      `validation_failed`, and safe `internal_error` per the spec's mapping table, including the
      unambiguous-ownership and complete-correlation gates for close.

## 4. OpenAPI

- [ ] 4.1 Add OpenAPI 3.1 operations for both routes, covering the full error-code table and one
      example per code.

## 5. Contract-level tests

- [ ] 5.1 Test protection: body validation, numeric-equality confirmation (matching, formatting-only
      difference, genuine mismatch), and `position_not_open`.
- [ ] 5.2 Test close: empty-body acceptance, rejection of any non-empty body, unsupported-scope and
      ambiguous-ownership fail-closed paths, incomplete/contradictory correlation, and already-closed
      cleanup verification.
- [ ] 5.3 Test shared error mapping (`unknown_trade_cycle_binding`, `internal_error`) for both
      endpoints.

## 6. Verification

- [ ] 6.1 Run OpenAPI validation, `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 6.2 Review the diff for internal application architecture, exchange details, or
      order-attribution mechanics leaking into the public contract.
