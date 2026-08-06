## 1. Transport DTOs and schemas

- [x] 1.1 Define DTOs for the protection request/success, close success, and shared error envelope,
      plus `PositionManagementErrorCode` including `position_not_open` and reused
      `unsupported_exchange_scope`/`unknown_trade_cycle_binding`.
- [x] 1.2 Define exact-decimal numeric equality as a total function over the full grammar
      `isExactDecimalText` accepts (`decimalEquals` in `exactDecimal.ts`, used from
      `positionManagementApi.ts`'s `isNumericallyEqualExactDecimal`) — no new transport limit, no
      `Number`/float, no materialized `10^exponent`. Response types carry back the accepted request
      strings unchanged, never a canonicalized or exchange-reported value.

## 2. HTTP boundary

- [x] 2.1 Add route matching for both endpoints using the same `decodeOpaquePathValue` opaque-path
      decode-and-empty-check for both, and a hard empty-body check on `DELETE` that rejects any
      non-empty body (including quantity/percentage/close_fraction fields) as `validation_failed`
      with `error.details` pointing at path `/`, without parsing it as a size input.
- [x] 2.2 Build a validated `ProtectionCommand`/`CloseCommand` on the transport boundary for both
      endpoints; keep both independent of exchange/execution wiring — a transport-valid command
      still fails safe to `internal_error` rather than fabricating success.

## 3. Response and error serialization

- [x] 3.1 Make the success serializers fail-closed by terminal confirmation, not structural
      validity alone: `serializeProtectionApplied` requires `verificationSucceeded` plus numeric
      equality of accepted vs. confirmed stop/take (including null/non-null agreement on take) and
      returns the accepted request strings, never the confirmed/exchange ones;
      `serializeTradeCycleClosed` requires `positionZeroVerified`,
      `noAttributedActiveOrdersVerified`, and `correlationCompleteAndConsistent` all `true`. Neither
      is reachable from either route in this change — no verification path exists yet to reach them
      from.
- [x] 3.2 Serialize `unsupported_exchange_scope`, `position_not_open`, and `internal_error` builders
      per the spec's mapping table.
- [x] 3.3 Serialize `unknown_trade_cycle_binding`, `validation_failed`, and safe `internal_error`
      builders per the spec's mapping table.

## 4. OpenAPI

- [x] 4.1 Add OpenAPI 3.1 operations for both routes, covering the full error-code table and one
      example per code.

## 5. Contract-level tests

- [x] 5.1 Test that the success serializers refuse `2xx` on any single unverified or mismatched
      input: protection (`verificationSucceeded: false`, a genuine stop/take numeric mismatch, a
      null-vs-non-null take disagreement, malformed decimal text, empty identifiers) and close (each
      of the three postconditions `false` individually, empty identifiers).
- [x] 5.2 Test the numeric-equality primitive: formatting-only equivalence (trailing zeros, leading
      `+`, equivalent exponent forms), exponents far beyond `compareDecimal`'s `MAX_ABS_EXPONENT`
      bound (`1e101==10e100`, `1e1000==10e999`, `1e1000!=2e1000`), genuine value differences, and
      total (non-throwing) handling of malformed input.
- [x] 5.3 Test protection/close transport validation (body shape, empty-body gate at `/`, opaque
      path decoding used identically by both routes) and that `ProtectionCommand`/`CloseCommand` are
      built once transport validation passes, while neither route calls a success serializer or
      otherwise fabricates a `2xx`.
- [x] 5.4 Test shared error-builder mapping (`unknown_trade_cycle_binding`, `internal_error`) for
      both endpoints.

## 6. Verification

- [x] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`. OpenAPI validation is covered by
      `test/unit/positionManagementOpenApi.test.ts` (no standalone script, matching
      `abi-open-position-lookup-api`'s precedent).
- [x] 6.2 Review the diff for internal application architecture, exchange details, or
      order-attribution mechanics leaking into the public contract.

## Deferred follow-up (not this change's scope)

Requires the execution wiring this change's proposal.md non-goal explicitly excludes; belongs to a
future change, mirroring `entry-package-execution`'s relationship to `abi-entry-package-api`. No
checkbox — listed here only so it isn't mistaken for done:

- Scope resolution (account/category/symbol/position slot) and the ambiguous-ownership gate for
  both endpoints.
- The actual exchange protection write and its confirmation query.
- The actual position close and attributed-order cleanup.
- Correlation-record lookup, completeness, and consistency checking.
