## 1. Public contract tightening

- [ ] 1.1 In `validateProtectionCommand` (`positionManagementApi.ts`), replace `isExactDecimalText`
      with `isPositiveExactDecimalText` for `stop_price` and for a non-null `take_price` (Decision
      5's "0"-collision note). Change `docs/openapi/abi-position-management-api-v1.json`'s
      `stop_price`/`take_price` schemas from `format: "exact-decimal"` to `format:
      "positive-exact-decimal"`, matching the convention already used by
      `abi-entry-package-api-v1.json`/`abi-open-position-lookup-api-v1.json`. Add rejection tests for
      `stop_price: "0"` and negative values to `positionManagementApi.test.ts`.

## 2. Adapter surface

- [ ] 2.1 Add `stopLoss`/`takeProfit` to `ValidatedOpenPositionRow` as raw, optional exact-decimal
      strings (Decision 6). No change to `evaluatePositionQueryResponse`'s existing outcomes.
- [ ] 2.2 Replace `SetTradingStopInput`/`BybitAdapter.setTradingStop` with a correctly-shaped
      `POST /v5/position/trading-stop` call (Decision 5: `category`, `symbol`, `positionIdx=0`,
      `tpslMode=Full`, `stopLoss`, `takeProfit`, `config.bybitTriggerBy`; `take_price: null` →
      `takeProfit: "0"`). Confirm the old stub has zero real callers; update
      `test/fakes/fakeBybitAdapter.ts`.
- [ ] 2.3 Add `executeProtectionUpdate` to `src/execution/execution.ts`, mirroring
      `executeEntryOrder`'s live-guard gating.

## 3. Reuse the live-position gate

- [ ] 3.1 Split `OpenPositionResolutionService.resolve()` into its HTTP-shaping wrapper plus an
      internal method returning `open` / `closed` / `unsupported_scope` / `error` (Decision 4).
      Confirm `test/unit/openPositionResolutionService.test.ts` passes unchanged.

## 4. `ProtectionApplicationService`

- [ ] 4.1 Add `src/services/protection/protectionApplicationService.ts`: durable-absence shortcut →
      ownership re-check → live-position gate (3.1) → write (2.2/2.3) → bounded read-back (Decisions
      2, 3, 6). No correlation-store write.
- [ ] 4.2 Reuse the existing `KeyedMutex` instance and `correlationRecordKey`; do not use
      `scopeMutex` (Decision 7).
- [ ] 4.3 Gate on the existing entry-package readiness signal.

## 5. Wiring

- [ ] 5.1 Construct `ProtectionApplicationService` in `app/server.ts` and pass it into
      `handlePositionManagementRoutes`.
- [ ] 5.2 Update `handleProtection` to call the service instead of unconditionally returning
      `internal_error`.

## 6. Tests

- [ ] 6.1 `ProtectionApplicationService` unit tests: unknown pair; durably-absent pair (no exchange
      call); ownership mismatch; unsupported category; no live position; live-execution-guard
      disabled; write with immediate matching read-back; read-back matching only on a later bounded
      attempt; read-back exhausted without matching; `take_price: null` clearing take-profit, with
      read-back reporting numeric zero rather than an exact string match.
- [ ] 6.2 Update `positionManagementRoutes.test.ts`'s stub-behavior test to exercise the real
      (fake-backed) service path.
- [ ] 6.3 Concurrency test: protection vs. concurrent entry-package replace for the same pair never
      interleave; different pairs proceed independently.
- [ ] 6.4 Confirm `openPositionResolutionService.test.ts` and `positionManagementApi.test.ts` pass
      unchanged (other than the 1.1 rejection additions).

## 7. Verification

- [ ] 7.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 7.2 Review the diff: no new public DTO, route, or error code beyond the tightened price
      validation; no new `EntryPackageExecutionRecord` field or correlation write; `DELETE
      .../open-position` untouched.

## Deferred follow-up (not this change's scope)

- Releasing a pair's physical scope after a fill-then-close — the next close-execution change.
- Wiring `DELETE .../open-position` — remains a transport-only stub.
- Any shared/virtual scope ownership (GitHub Issue #3).
