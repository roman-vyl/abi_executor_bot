## 1. `floorToStep` (exact-decimal primitive)

- [x] 1.1 Add `floorToStep(valueText: string, stepText: string): string` to `src/domain/exactDecimal.ts`,
      alongside the existing `ceilToStep` (design.md Decision 3) — same shape, rounds toward zero along
      the step grid instead of away from it.
- [x] 1.2 Unit tests: exact-multiple-of-step input is unchanged; a value strictly between two step
      boundaries rounds down to the lower one; symmetry/asymmetry with `ceilToStep` on the same inputs is
      explicitly asserted (they must differ whenever the input is not already an exact multiple).

## 2. `tickSize`, `minPrice`, `maxPrice` on `InstrumentTradingRules`

- [x] 2.1 Add `tickSize: string`, `minPrice: string`, `maxPrice: string` to `InstrumentTradingRules`
      (`src/exchange/instrumentTradingRulesResponseDecoder.ts`), decoded from the same response's
      `priceFilter.tickSize`/`priceFilter.minPrice`/`priceFilter.maxPrice` (design.md Decision 3/5). Add
      `missing_price_filter`/`invalid_tick_size`/`invalid_min_price`/`invalid_max_price` failure reasons
      mirroring the existing `missing_lot_size_filter`/`invalid_qty_step` pattern.
- [x] 2.2 `BybitInstrumentTradingRulesProvider` — no code change expected (it already returns whatever
      `decodeInstrumentTradingRulesResponse` produces); confirm via test that the cached value now
      includes `tickSize`/`minPrice`/`maxPrice`.
- [x] 2.3 Tests: valid `priceFilter.{tickSize,minPrice,maxPrice}` decodes; missing `priceFilter` →
      `missing_price_filter`; malformed/negative/zero `tickSize` → `invalid_tick_size`;
      malformed/negative `minPrice`/`maxPrice` or `minPrice >= maxPrice` → `invalid_min_price`/
      `invalid_max_price`. Full regression of existing `instrumentTradingRulesResponseDecoder.test.ts` —
      unchanged assertions for `minOrderQty`/`qtyStep`/`minNotionalValue` still pass.

## 3. Adapter primitive: `amendOrder`

- [x] 3.1 Add `BybitAmendOrderPayload` to `src/exchange/bybitOrderMapper.ts` and `amendOrder()` to the
      `BybitAdapter` interface, `RestBybitAdapter` (`signedPost("/v5/order/amend", payload)` — design.md
      Decision 2), `StubBybitAdapter`, and `FakeBybitAdapter` (test fake, tracking calls the same way
      every other adapter method does).
- [x] 3.2 Do not modify `setTradingStop`, `SetTradingStopInput`, or any existing caller.

## 4. Surrogate TAKE price computation

- [x] 4.1 New pure function (co-located with the reconciliation primitive or its own small module):
      `computeSurrogateTakePrice(input: { plannedEntryPrice: string; side: "long" | "short"; tickSize:
      string; minPrice: string; maxPrice: string }): Result<string, "surrogate_unrepresentable">` —
      design.md Decision 5's formula, `SURROGATE_TAKE_DISTANCE_RATIO = 0.5` as a named, documented
      constant (not a magic number inline), followed by `clampToInstrumentBounds(...)` (design.md
      Decision 5) against `minPrice`/`maxPrice`.
- [x] 4.2 `clampToInstrumentBounds(candidate, minPrice, maxPrice, tickSize, side)` (design.md Decision 5):
      pulls an out-of-bounds candidate back to the nearest tick-valid price still inside
      `[minPrice, maxPrice]`; returns `err("surrogate_unrepresentable")` only when the clamped result
      would equal `reference` itself (no room for any distinct dormant surrogate on this instrument's
      current bounds). No live Bybit verification step — validity is guaranteed by construction from the
      decoded instrument bounds (task 2.1), not by a bounded Demo check against one instrument.
- [x] 4.3 Tests: deterministic (same inputs → same output across calls); idempotent under repeated calls
      with unchanged inputs; long produces a price strictly above `plannedEntryPrice`, short strictly
      below, when unclamped; result is tick-aligned per the provided `tickSize`; long rounds away from
      reference (up), short rounds away from reference (down) — assert the two directions are not
      accidentally symmetric in rounding behavior; a candidate beyond `maxPrice` (long) or below
      `minPrice` (short) clamps to the nearest valid tick inside the bound rather than being rejected;
      a synthetic instrument whose bounds leave no room for a distinct surrogate → `surrogate_unrepresentable`.

## 5. Desired-state resolution

- [x] 5.1 New function `resolveCurrentOwnFilledQty(record, confirmEntryPackage)` (design.md Decision 4):
      if `record.early_execution_observation` is present and `isFillFactFinal(...)` is true, reuse its
      `cumulative_filled_qty` directly; otherwise issue a fresh `confirmEntryPackage()` call for this
      cycle's own entry order — `partial_fill` and `full_fill` both resolve to their `observation`'s
      `cumulative_filled_qty` as equally authoritative; `pending_confirmed`/`terminal_without_fill`/
      `not_found`/`ambiguous` all resolve to `err("no_authoritative_qty")` (fail closed, no fallback to
      `"0"`). Does **not** wait for `isFillFactFinal` as a gate — a live partial fill is a valid,
      immediately-usable answer.
- [x] 5.2 New function resolving a `ProtectionCommand` + a record into a `DesiredProtectionState` (design.md
      Decision 4): `qty` from task 5.1 (propagates its `err` as fail-closed); `stop.triggerPrice` from
      `command.stopPrice`; `take.triggerPrice` from `command.takePrice` when non-null, else
      `computeSurrogateTakePrice(...)` (task 4.1) using `desired_entry.planned_entry_price`, `side`,
      `tickSize`, `minPrice`, `maxPrice`; both legs always carry the same `qty`.
- [x] 5.3 **Required test — current cumulative qty at partial fill, not final fill:** entry command qty
      `10`; first reconciliation attempt observes `confirmEntryPackage()` → `partial_fill` with
      `cumulative_filled_qty: "4"` → resolved desired protection `qty` is `"4"` (not blocked, not an
      error). A second, later reconciliation attempt on the same cycle observes a fresh
      `confirmEntryPackage()` → (`partial_fill` or `full_fill`) with `cumulative_filled_qty: "7"` →
      resolved desired protection `qty` is `"7"`. Across both attempts, the entry order's own remainder is
      never cancelled or amended by anything this function does — the function only reads fill facts, it
      issues no entry-order write.
- [x] 5.4 Tests: `early_execution_observation` present and final → reused without a `confirmEntryPackage()`
      call; absent or non-final → fresh `confirmEntryPackage()` call issued, `partial_fill` and `full_fill`
      both accepted as authoritative; `terminal_without_fill`/`not_found`/`ambiguous`/`pending_confirmed`
      → `no_authoritative_qty`, fail closed, distinct from `OpenPositionResolutionService
      .resolveOwnFillFacts()`'s own zero-fill-is-valid handling (assert the two functions disagree on
      this input, documenting the deliberate divergence); non-null `take_price` passes through unchanged;
      `take_price: null` invokes surrogate computation with this cycle's own `planned_entry_price`,
      `side`, and instrument bounds; both legs' `qty` always equal regardless of which take path is taken.

## 6. Reconciliation primitive

- [x] 6.1 New file `src/services/protection/nativeProtectionReconciliation.ts`:
      `DesiredProtectionState`/`DesiredProtectionLeg`, `ReconciliationOutcome`/
      `ReconciliationFailureReason`, `reconcileNativePartialProtection()` (design.md Decisions 1, 6, 7,
      9) — calls `resolveOwnAttachedProtection()` (Change 6, unmodified), computes the minimal
      `amendOrder` write-plan (Decision 6's full eight-case matrix: at most two calls total, and `qty` —
      whenever it changes — travels only in the STOP leg's call, never the TAKE leg's), sends it, then
      re-verifies with an independent fresh `resolveOwnAttachedProtection()` call (Decision 7 step 3).
- [x] 6.2 Already-satisfied short-circuit (design.md Decision 9): fresh attribution already matching
      `desired` on both legs' `triggerPrice`/`qty` → `{ kind: "already_satisfied" }`, zero `amendOrder`
      calls.
- [x] 6.3 Fail-closed paths (design.md Decision 7): non-`attributed` initial classification →
      `attribution_lost`/`ambiguous_attribution`; any `amendOrder` call returning non-zero `retCode` or
      throwing → `amend_rejected`, whole attempt fails, no partial success reported; post-amend read-back
      not matching `desired` → `read_back_mismatch` or `amend_race` per Decision 7 step 4's distinction.
- [x] 6.4 No internal retry loop, no caching, no durable read/write — one reconciliation attempt per call,
      caller (task 7) owns retry/error-mapping policy, mirroring `resolveOwnAttachedProtection()`'s own
      shape.

## 7. `ProtectionApplicationService` integration (non-production)

- [x] 7.1 New public method `reconcileNativePartial(command: ProtectionCommand):
      Promise<ReconciliationOutcome>` on `ProtectionApplicationService` (design.md Decision 11) — reuses
      the existing `mutex.withKeyLock` pattern `apply()` already uses; resolves current own filled qty
      (task 5.1 — reuse-if-final, else fresh `confirmEntryPackage()`, fail closed on
      `no_authoritative_qty`, no `isFillFactFinal` gate); resolves desired state (task 5.2); calls
      `reconcileNativePartialProtection()` (task 6.1).
- [x] 7.2 Do **not** modify `process()`/`apply()` — the existing production-decision path, including the
      `shared_scope_protection_unsupported` guard and the `setTradingStop`/`tpslMode: "Full"` write, is
      byte-for-byte unchanged. Nothing in `EntryPackageApplicationService`, `CloseApplicationService`, or
      HTTP routing calls the new method.

## 8. Spec delta

- [x] 8.1 `specs/protection-execution/spec.md` (this change's own delta) — MODIFIED, adding requirements
      for: reconciliation exists and is production-inert; amend-only, never create/cancel; surrogate TAKE
      for `take_price = null` (anchored to the immutable planned entry price, valid within instrument price
      bounds); reconciliation targets the trade cycle's current own filled quantity without waiting for its
      entry to reach a terminal fill state, and fails closed on no own fill evidence at all; fresh-evidence
      discipline; fail-closed on non-attributed/ambiguous/race; already-satisfied short-circuit. Phrased
      around behavior, not literal field/function names, mirroring
      `abi-native-partial-protection-attribution-v1`'s spec.md convention.

## 9. Tests (all synthetic/fixture-driven — no real Bybit call in the automated test suite; the surrogate
      TAKE formula's exchange validity is proven by clamping against decoded instrument bounds, design.md
      Decision 5, not by a manual Demo check)

- [x] 9.1 Reconcile an already-attributed pair whose `triggerPrice`/`qty` already match desired →
      `already_satisfied`, zero `amendOrder` calls.
- [x] 9.2 Reconcile a pair whose `stop_price` changed only → exactly one `amendOrder` call, on the STOP
      leg's `orderId`, carrying the new `triggerPrice`.
- [x] 9.3 Reconcile a pair whose `qty` changed only (both `triggerPrice`s unchanged) → exactly one
      `amendOrder` call, deterministically on the STOP leg's `orderId`, carrying only the new `qty` — no
      second call on the TAKE leg (pair-wide sync assumed by the write-plan, not independently re-verified
      by a second write).
- [x] 9.4 Reconcile both `stop_price` and `take_price` changed simultaneously, `qty` unchanged → exactly
      two `amendOrder` calls, one per leg, each carrying only its own new `triggerPrice` — neither call
      carries `qty`.
- [x] 9.4a **Required test — qty and both triggerPrices change together:** exactly two `amendOrder` calls
      — STOP's call carries its new `triggerPrice` **and** the new `qty` together; TAKE's call carries
      only its new `triggerPrice`, never `qty` — asserting the full design.md Decision 6 case matrix, not
      just the single-field-changed cases.
- [x] 9.4b Reconcile a pair whose `qty` changed and only TAKE's `triggerPrice` also changed (STOP's
      `triggerPrice` unchanged) → exactly two `amendOrder` calls — STOP's call carries `qty` only (issued
      even though STOP's own `triggerPrice` did not change); TAKE's call carries only its new
      `triggerPrice`.
- [x] 9.5 `take_price: null` on a cycle with an already-materialized real (non-surrogate) TAKE → reconciles
      the TAKE leg's `triggerPrice` toward the computed surrogate, same write-plan as any other
      `take_price` change — no special-cased "removal" path exists or is attempted.
- [x] 9.6 Initial classification is `none` or `ambiguous` (any of the six reasons) →
      `attribution_lost`/`ambiguous_attribution`, zero `amendOrder` calls.
- [x] 9.7 An `amendOrder` call returns a non-zero `retCode` → whole attempt `amend_rejected`; if it was the
      second of two planned calls, the first leg's already-applied amend is not rolled back (mirrors
      `close-execution`'s no-rollback-only-re-resolve discipline) and the next reconciliation attempt
      re-plans from fresh evidence, not from an assumption about what the failed attempt left behind.
- [x] 9.8 Post-amend fresh read-back does not match desired (`triggerPrice`/`qty` mismatch on either leg,
      or a leg that transitioned to a classifier outcome other than the expected `attributed`) →
      `read_back_mismatch`.
- [x] 9.9 Two same-side cycles with independent native Partial pairs on one physical scope (synthetic
      multi-owner fixture): reconciling one never touches or reads the other's `orderId`s as candidates
      for amend (reuses Change 6's own sibling-exclusion guarantee — this task only needs to prove the
      reconciler passes the right `entryOrderLinkId` through, not re-prove attribution itself).
- [x] 9.10 `reconcileNativePartial()` (service method) full flow: a live, still-partial entry order with
      an available `partial_fill` observation → reconciles toward that partial's `cumulative_filled_qty`,
      not blocked and not failed closed; no fill evidence obtainable at all
      (`terminal_without_fill`/`not_found`/`ambiguous`/`pending_confirmed`) → fail closed
      (`no_authoritative_qty`) before any attribution/amend call; final fill facts + `take_price: null` →
      surrogate desired state computed and reconciled; regression of `protectionApplicationService.test.ts`'s
      existing `apply()`/`process()` coverage — byte-for-byte unchanged, including the multi-owner
      guard-rejection test.
- [x] 9.11 Full regression: `entryPackageApplicationService.test.ts`,
      `instrumentTradingRulesResponseDecoder.test.ts`, `bybitOrderMapper`-related tests, and any existing
      `exactDecimal`/`packageConfirmation`/`nativeProtectionAttribution` tests all pass unmodified — none
      of them call the new primitives, and every existing production path's output is unchanged.

## 10. Final verification

- [x] 10.1 `npm run typecheck`, `npm test`, `npm run build` all clean.
- [x] 10.2 Diff review confirms: zero fields added to `EntryPackageExecutionRecord`;
      `EntryPackageCorrelationRepository`, `CloseApplicationService`, `EntryPackageApplicationService`'s
      claim logic, `mapEntryPackageToBybit()`, and `ProtectionApplicationService.process()`/`apply()`'s
      existing behavior are byte-for-byte unmodified; `setTradingStop`/`SetTradingStopInput` untouched;
      no public HTTP route, DTO, or error code changed.
