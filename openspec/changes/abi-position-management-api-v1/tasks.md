## 1. Transport DTOs and schemas

- [x] 1.1 Define DTOs for the protection request/success, close success, and shared error envelope,
      plus `PositionManagementErrorCode` including `position_not_open` and reused
      `unsupported_exchange_scope`/`unknown_trade_cycle_binding`.
- [x] 1.2 Define exact-decimal numeric-equality comparison for protection confirmation, distinct
      from string comparison (reuses `exactDecimal.ts`'s `compareDecimal`); ensure the response type
      carries back the accepted request strings unchanged rather than any canonicalized or
      exchange-reported value.

## 2. HTTP boundary

- [x] 2.1 Add route matching for both endpoints, including a hard empty-body check on `DELETE` that
      rejects any non-empty body (including quantity/percentage/close_fraction fields) as
      `validation_failed` with `error.details` pointing at path `/`, without parsing it as a size
      input.
- [x] 2.2 Keep both boundaries independent of exchange/execution wiring — validated transport
      commands only; a transport-valid command fails safe to `internal_error` rather than
      fabricating success (mirrors `abi-entry-package-api`'s pre-`entry-package-execution` shape).

## 3. Response and error serialization

- [x] 3.1 Serialize `protection_applied` and `trade_cycle_closed`, gated so a structurally invalid
      input can never produce them; unreachable from either route in this change by construction
      (no verification path exists yet to reach them from).
- [x] 3.2 Serialize `unsupported_exchange_scope`, `position_not_open`, and `internal_error` builders
      per the spec's mapping table.
- [x] 3.3 Serialize `unknown_trade_cycle_binding`, `validation_failed`, and safe `internal_error`
      builders per the spec's mapping table.

## 4. OpenAPI

- [x] 4.1 Add OpenAPI 3.1 operations for both routes, covering the full error-code table and one
      example per code.

## 5. Contract-level tests

- [ ] 5.1 Test the shared scope-resolution gate on both endpoints: unsupported category, ambiguous
      ownership, and a zero-size-but-unambiguous scope proceeding to each endpoint's own check.
      **Deferred**: requires the scope-resolution execution wiring this change explicitly excludes
      (proposal.md non-goal); belongs to a future execution change, mirroring
      `entry-package-execution`'s relationship to `abi-entry-package-api`.
- [x] 5.2 Test protection: body validation, the numeric-equality comparison primitive (matching,
      formatting-only difference, genuine mismatch, malformed-input totality), accepted-string echo,
      and the `position_not_open` error builder.
- [x] 5.3 Test close: empty-body acceptance, rejection of any non-empty body (`error.details` at
      `/`). **Deferred** (same reason as 5.1): incomplete/contradictory-correlation and
      already-closed cleanup-verification behavior requires execution wiring not present here.
- [x] 5.4 Test shared error-builder mapping (`unknown_trade_cycle_binding`, `internal_error`) for
      both endpoints.

## 6. Verification

- [x] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`. OpenAPI validation is covered by
      `test/unit/positionManagementOpenApi.test.ts` (no standalone script, matching
      `abi-open-position-lookup-api`'s precedent).
- [x] 6.2 Review the diff for internal application architecture, exchange details, or
      order-attribution mechanics leaking into the public contract.
