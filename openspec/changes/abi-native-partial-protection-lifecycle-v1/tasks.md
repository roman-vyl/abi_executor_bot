## 1. `floorToStep` (exact-decimal primitive)

- [ ] 1.1 Add `floorToStep(valueText: string, stepText: string): string` to `src/domain/exactDecimal.ts`,
      alongside the existing `ceilToStep` (design.md Decision 3) — same shape, rounds toward zero along
      the step grid instead of away from it.
- [ ] 1.2 Unit tests: exact-multiple-of-step input is unchanged; a value strictly between two step
      boundaries rounds down to the lower one; symmetry/asymmetry with `ceilToStep` on the same inputs is
      explicitly asserted (they must differ whenever the input is not already an exact multiple).

## 2. `tickSize` on `InstrumentTradingRules`

- [ ] 2.1 Add `tickSize: string` to `InstrumentTradingRules`
      (`src/exchange/instrumentTradingRulesResponseDecoder.ts`), decoded from the same response's
      `priceFilter.tickSize` (design.md Decision 3). Add `missing_price_filter`/`invalid_tick_size`
      failure reasons mirroring the existing `missing_lot_size_filter`/`invalid_qty_step` pattern.
- [ ] 2.2 `BybitInstrumentTradingRulesProvider` — no code change expected (it already returns whatever
      `decodeInstrumentTradingRulesResponse` produces); confirm via test that the cached value now
      includes `tickSize`.
- [ ] 2.3 Tests: valid `priceFilter.tickSize` decodes; missing `priceFilter` → `missing_price_filter`;
      malformed/negative/zero `tickSize` → `invalid_tick_size`. Full regression of existing
      `instrumentTradingRulesResponseDecoder.test.ts` — unchanged assertions for `minOrderQty`/`qtyStep`/
      `minNotionalValue` still pass.

## 3. Adapter primitive: `amendOrder`

- [ ] 3.1 Add `BybitAmendOrderPayload` to `src/exchange/bybitOrderMapper.ts` and `amendOrder()` to the
      `BybitAdapter` interface, `RestBybitAdapter` (`signedPost("/v5/order/amend", payload)` — design.md
      Decision 2), `StubBybitAdapter`, and `FakeBybitAdapter` (test fake, tracking calls the same way
      every other adapter method does).
- [ ] 3.2 Do not modify `setTradingStop`, `SetTradingStopInput`, or any existing caller.

## 4. Surrogate TAKE price computation

- [ ] 4.1 New pure function (co-located with the reconciliation primitive or its own small module):
      `computeSurrogateTakePrice(input: { averageEntryPrice: string; side: "long" | "short"; tickSize:
      string }): string` — design.md Decision 5's formula, `SURROGATE_TAKE_DISTANCE_RATIO = 0.5` as a
      named, documented constant (not a magic number inline).
- [ ] 4.2 **Verification task, gates using this constant past synthetic tests:** before this change is
      considered ready for `abi-native-partial-protection-cutover-v1` to build on, verify against Bybit
      (Demo) that a conditional/TP-SL order at `average_entry_price * 1.5` (long) /
      `average_entry_price * 0.5` (short) is actually accepted by `/v5/order/amend` for at least one
      representative instrument — not rejected by a max-price-deviation guard. If rejected, revise
      `SURROGATE_TAKE_DISTANCE_RATIO` down and re-verify; do not lower it below what keeps it clearly
      outside this system's normal stop/take distance range (single-digit-to-low-teens percent,
      design.md Decision 5). Record the outcome in design.md Decision 5 before implementation proceeds
      past this task — this is a bounded confirmation, not a new open-ended spike.
- [ ] 4.3 Tests: deterministic (same inputs → same output across calls); idempotent under repeated calls
      with unchanged inputs; long produces a price strictly above `averageEntryPrice`, short strictly
      below; result is tick-aligned per the provided `tickSize`; long rounds away from reference (up),
      short rounds away from reference (down) — assert the two directions are not accidentally symmetric
      in rounding behavior.

## 5. Desired-state resolution

- [ ] 5.1 New function resolving a `ProtectionCommand` + a record's `early_execution_observation` into a
      `DesiredProtectionState` (design.md Decision 4): `qty` from `cumulative_filled_qty` (requires
      `isFillFactFinal` — caller's own precondition, not checked inside this function); `take.triggerPrice`
      from `command.takePrice` when non-null, else `computeSurrogateTakePrice(...)` (task 4.1) using
      `avg_execution_price`; both legs always carry the same `qty`.
- [ ] 5.2 Tests: non-null `take_price` passes through unchanged; `take_price: null` invokes surrogate
      computation with this cycle's own `average_entry_price` and `side`; both legs' `qty` always equal
      regardless of which take path is taken.

## 6. Reconciliation primitive

- [ ] 6.1 New file `src/services/protection/nativeProtectionReconciliation.ts`:
      `DesiredProtectionState`/`DesiredProtectionLeg`, `ReconciliationOutcome`/
      `ReconciliationFailureReason`, `reconcileNativePartialProtection()` (design.md Decisions 1, 6, 7,
      9) — calls `resolveOwnAttachedProtection()` (Change 6, unmodified), computes the minimal
      `amendOrder` write-plan (Decision 6: at most two calls, `qty`-only case always targets the STOP
      leg's `orderId`), sends it, then re-verifies with an independent fresh
      `resolveOwnAttachedProtection()` call (Decision 7 step 3).
- [ ] 6.2 Already-satisfied short-circuit (design.md Decision 9): fresh attribution already matching
      `desired` on both legs' `triggerPrice`/`qty` → `{ kind: "already_satisfied" }`, zero `amendOrder`
      calls.
- [ ] 6.3 Fail-closed paths (design.md Decision 7): non-`attributed` initial classification →
      `attribution_lost`/`ambiguous_attribution`; any `amendOrder` call returning non-zero `retCode` or
      throwing → `amend_rejected`, whole attempt fails, no partial success reported; post-amend read-back
      not matching `desired` → `read_back_mismatch` or `amend_race` per Decision 7 step 4's distinction.
- [ ] 6.4 No internal retry loop, no caching, no durable read/write — one reconciliation attempt per call,
      caller (task 7) owns retry/error-mapping policy, mirroring `resolveOwnAttachedProtection()`'s own
      shape.

## 7. `ProtectionApplicationService` integration (non-production)

- [ ] 7.1 New public method `reconcileNativePartial(command: ProtectionCommand):
      Promise<ReconciliationOutcome>` on `ProtectionApplicationService` (design.md Decision 11) — reuses
      the existing `mutex.withKeyLock` pattern `apply()` already uses; refreshes own cumulative fill
      facts; checks `isFillFactFinal` (fail closed if not final — new reason or reuse `attribution_lost`,
      decide in implementation); resolves desired state (task 5.1); calls
      `reconcileNativePartialProtection()` (task 6.1).
- [ ] 7.2 Do **not** modify `process()`/`apply()` — the existing production-decision path, including the
      `shared_scope_protection_unsupported` guard and the `setTradingStop`/`tpslMode: "Full"` write, is
      byte-for-byte unchanged. Nothing in `EntryPackageApplicationService`, `CloseApplicationService`, or
      HTTP routing calls the new method.

## 8. Spec delta

- [ ] 8.1 `specs/protection-execution/spec.md` (this change's own delta) — MODIFIED, adding requirements
      for: reconciliation exists and is production-inert; amend-only, never create/cancel; surrogate TAKE
      for `take_price = null`; fresh-evidence discipline; fail-closed on non-attributed/ambiguous/race;
      already-satisfied short-circuit. Phrased around behavior, not literal field/function names, mirroring
      `abi-native-partial-protection-attribution-v1`'s spec.md convention.

## 9. Tests (all synthetic/fixture-driven — no real Bybit call in the automated test suite; task 4.2's
      verification is a separate, manual, bounded Demo check)

- [ ] 9.1 Reconcile an already-attributed pair whose `triggerPrice`/`qty` already match desired →
      `already_satisfied`, zero `amendOrder` calls.
- [ ] 9.2 Reconcile a pair whose `stop_price` changed only → exactly one `amendOrder` call, on the STOP
      leg's `orderId`, carrying the new `triggerPrice`.
- [ ] 9.3 Reconcile a pair whose `qty` changed only (both `triggerPrice`s unchanged) → exactly one
      `amendOrder` call, deterministically on the STOP leg's `orderId`, carrying only the new `qty` — no
      second call on the TAKE leg (pair-wide sync assumed by the write-plan, not independently re-verified
      by a second write).
- [ ] 9.4 Reconcile both `stop_price` and `take_price` changed simultaneously → exactly two `amendOrder`
      calls, one per leg, each carrying its own new `triggerPrice`.
- [ ] 9.5 `take_price: null` on a cycle with an already-materialized real (non-surrogate) TAKE → reconciles
      the TAKE leg's `triggerPrice` toward the computed surrogate, same write-plan as any other
      `take_price` change — no special-cased "removal" path exists or is attempted.
- [ ] 9.6 Initial classification is `none` or `ambiguous` (any of the six reasons) →
      `attribution_lost`/`ambiguous_attribution`, zero `amendOrder` calls.
- [ ] 9.7 An `amendOrder` call returns a non-zero `retCode` → whole attempt `amend_rejected`; if it was the
      second of two planned calls, the first leg's already-applied amend is not rolled back (mirrors
      `close-execution`'s no-rollback-only-re-resolve discipline) and the next reconciliation attempt
      re-plans from fresh evidence, not from an assumption about what the failed attempt left behind.
- [ ] 9.8 Post-amend fresh read-back does not match desired (`triggerPrice`/`qty` mismatch on either leg,
      or a leg that transitioned to a classifier outcome other than the expected `attributed`) →
      `read_back_mismatch`.
- [ ] 9.9 Two same-side cycles with independent native Partial pairs on one physical scope (synthetic
      multi-owner fixture): reconciling one never touches or reads the other's `orderId`s as candidates
      for amend (reuses Change 6's own sibling-exclusion guarantee — this task only needs to prove the
      reconciler passes the right `entryOrderLinkId` through, not re-prove attribution itself).
- [ ] 9.10 `reconcileNativePartial()` (service method) full flow: fresh fill facts not yet final → fail
      closed before any attribution/amend call; final fill facts + `take_price: null` → surrogate desired
      state computed and reconciled; regression of `protectionApplicationService.test.ts`'s existing
      `apply()`/`process()` coverage — byte-for-byte unchanged, including the multi-owner guard-rejection
      test.
- [ ] 9.11 Full regression: `entryPackageApplicationService.test.ts`,
      `instrumentTradingRulesResponseDecoder.test.ts`, `bybitOrderMapper`-related tests, and any existing
      `exactDecimal`/`packageConfirmation`/`nativeProtectionAttribution` tests all pass unmodified — none
      of them call the new primitives, and every existing production path's output is unchanged.

## 10. Final verification

- [ ] 10.1 `npm run typecheck`, `npm test`, `npm run build` all clean.
- [ ] 10.2 Diff review confirms: zero fields added to `EntryPackageExecutionRecord`;
      `EntryPackageCorrelationRepository`, `CloseApplicationService`, `EntryPackageApplicationService`'s
      claim logic, `mapEntryPackageToBybit()`, and `ProtectionApplicationService.process()`/`apply()`'s
      existing behavior are byte-for-byte unmodified; `setTradingStop`/`SetTradingStopInput` untouched;
      no public HTTP route, DTO, or error code changed.
