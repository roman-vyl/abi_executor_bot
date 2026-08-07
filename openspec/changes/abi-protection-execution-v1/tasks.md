## 1. Shared query and adapter surface

- [ ] 1.1 Extend `ValidatedOpenPositionRow` and `evaluatePositionQueryResponse`
      (`src/exchange/bybitAdapter.ts`) with `stopLoss`/`takeProfit` (raw exact-decimal strings, `""`
      meaning "not set"), validated the same way `avgPrice` is today when `size > 0`. No behavior
      change for existing callers that ignore the new fields.
- [ ] 1.2 Replace `SetTradingStopInput`/`BybitAdapter.setTradingStop` with a correctly-shaped method for
      `POST /v5/position/trading-stop` (`category`, `symbol`, `positionIdx=0`, `tpslMode=Full`,
      `stopLoss`, `takeProfit`, trigger fields from `config.bybitTriggerBy`). Confirm the old stub
      (`placeMarketOrder`/`setTradingStop`) has zero callers before changing its shape (design.md
      Decision 4) and update `test/fakes/fakeBybitAdapter.ts` to match.
- [ ] 1.3 Add `executeProtectionUpdate` to `src/execution/execution.ts`, mirroring
      `executeEntryOrder`'s live-guard gating (`skipped_live_execution` on `!canExecuteLive`,
      design.md Decision 5).

## 2. Reuse the live-position gate

- [ ] 2.1 Split `OpenPositionResolutionService.resolve()` (design.md Decision 3) into its existing
      HTTP-shaping wrapper plus a new internal method returning a discriminated result (`open` /
      `closed` / `unsupported_scope` / `error`). Run `test/unit/openPositionResolutionService.test.ts`
      unchanged to confirm no behavior change on the GET endpoint.

## 3. `ProtectionApplicationService`

- [ ] 3.1 Add `src/services/protection/protectionApplicationService.ts`: looks up the record
      (`unknown_trade_cycle_binding` if missing), re-verifies scope ownership via
      `correlationRepository.findOwnerByScope` (design.md Decision 2), calls the shared live-position
      gate from 2.1, sends the write via `executeProtectionUpdate`, then performs the read-back query
      and exact-decimal comparison via `isNumericallyEqualExactDecimal`, and builds a
      `ProtectionConfirmation` for `serializeProtectionApplied` (`positionManagementApi.ts`) or an
      appropriate error result. No correlation-store write.
- [ ] 3.2 Wrap the whole operation in `mutex.withKeyLock(correlationRecordKey(...), ...)`, reusing the
      same `KeyedMutex` instance passed to `EntryPackageApplicationService` (design.md Decision 7).
      `scopeMutex` is not used here.
- [ ] 3.3 Gate on the existing entry-package readiness signal (design.md Decision 8), matching how
      `openPositionRoutes.ts` already gates on `isReady()`.

## 4. Wiring

- [ ] 4.1 In `app/server.ts`, construct `ProtectionApplicationService` with `correlationRepository`,
      `bybit`, `mutex`, `config`, and pass it (plus `isReady`) into `handlePositionManagementRoutes`.
- [ ] 4.2 Update `handleProtection` (`src/routes/positionManagementRoutes.ts`) to call the service
      instead of unconditionally returning `internalErrorResult()`.

## 5. Tests

- [ ] 5.1 Unit tests for `ProtectionApplicationService`: unknown pair, scope-ownership mismatch
      (constructed via a fake repository), non-`linear` scope, no live position, live position with
      successful write + matching read-back (`protection_applied`), read-back numeric mismatch,
      read-back query failure, live-execution-guard-disabled, `take_price: null` clearing the
      take-profit leg.
- [ ] 5.2 Update `test/unit/positionManagementRoutes.test.ts`'s "a transport-valid protection request
      fails safe without a fabricated success" test: it now exercises a real (fake-backed) service
      path rather than asserting the old unconditional stub.
- [ ] 5.3 Concurrency test: a protection command and a concurrent entry-package REPLACE for the same
      pair never interleave (design.md Decision 7 / spec's serialization requirement).
- [ ] 5.4 Confirm `test/unit/openPositionResolutionService.test.ts` and
      `test/unit/positionManagementApi.test.ts` pass unchanged.

## 6. Verification

- [ ] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 6.2 Review the diff: no new public DTO, route, or error code; no new
      `EntryPackageExecutionRecord` field or correlation write from protection execution; `DELETE
      .../open-position` untouched.

## Deferred follow-up (not this change's scope)

- Releasing a pair's physical scope after a fill-then-close — the next close-execution change.
- Wiring `DELETE .../open-position` — remains a transport-only stub.
- Any shared/virtual scope ownership (GitHub Issue #3).
