## 1. Adapter surface

- [ ] 1.1 Add `stopLoss`/`takeProfit` to `ValidatedOpenPositionRow` as raw, optional exact-decimal
      strings (Decision 6). No change to `evaluatePositionQueryResponse`'s existing outcomes.
- [ ] 1.2 Replace `SetTradingStopInput`/`BybitAdapter.setTradingStop` with a correctly-shaped
      `POST /v5/position/trading-stop` call (Decision 5: `category`, `symbol`, `positionIdx=0`,
      `tpslMode=Full`, `stopLoss`, `takeProfit`, `config.bybitTriggerBy`; `take_price: null` →
      `takeProfit: "0"`). Confirm the old stub has zero real callers; update
      `test/fakes/fakeBybitAdapter.ts`.
- [ ] 1.3 Add `executeProtectionUpdate` to `src/execution/execution.ts`, mirroring
      `executeEntryOrder`'s live-guard gating.

## 2. Reuse the live-position gate

- [ ] 2.1 Split `OpenPositionResolutionService.resolve()` into its HTTP-shaping wrapper plus an
      internal method returning `open` / `closed` / `unsupported_scope` / `error` (Decision 4).
      Confirm `test/unit/openPositionResolutionService.test.ts` passes unchanged.

## 3. `ProtectionApplicationService`

- [ ] 3.1 Add `src/services/protection/protectionApplicationService.ts`: durable-absence shortcut →
      ownership re-check → live-position gate (2.1) → write (1.2/1.3) → bounded read-back (Decisions
      2, 3, 6). No correlation-store write.
- [ ] 3.2 Reuse the existing `KeyedMutex` instance and `correlationRecordKey`; do not use
      `scopeMutex` (Decision 7).
- [ ] 3.3 Gate on the existing entry-package readiness signal.

## 4. Wiring

- [ ] 4.1 Construct `ProtectionApplicationService` in `app/server.ts` and pass it into
      `handlePositionManagementRoutes`.
- [ ] 4.2 Update `handleProtection` to call the service instead of unconditionally returning
      `internal_error`.

## 5. Tests

- [ ] 5.1 `ProtectionApplicationService` unit tests: unknown pair; durably-absent pair (no exchange
      call); ownership mismatch; unsupported category; no live position; live-execution-guard
      disabled; write with immediate matching read-back; read-back matching only on a later bounded
      attempt; read-back exhausted without matching; `take_price: null` clearing take-profit, with
      read-back reporting numeric zero rather than an exact string match.
- [ ] 5.2 Update `positionManagementRoutes.test.ts`'s stub-behavior test to exercise the real
      (fake-backed) service path.
- [ ] 5.3 Concurrency test: protection vs. concurrent entry-package replace for the same pair never
      interleave; different pairs proceed independently.
- [ ] 5.4 Confirm `openPositionResolutionService.test.ts` and `positionManagementApi.test.ts` pass
      unchanged.

## 6. Verification

- [ ] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 6.2 Review the diff: no new public DTO, route, or error code; no new
      `EntryPackageExecutionRecord` field or correlation write; `DELETE .../open-position` untouched.

## Deferred follow-up (not this change's scope)

- Releasing a pair's physical scope after a fill-then-close — the next close-execution change.
- Wiring `DELETE .../open-position` — remains a transport-only stub.
- Any shared/virtual scope ownership (GitHub Issue #3).
