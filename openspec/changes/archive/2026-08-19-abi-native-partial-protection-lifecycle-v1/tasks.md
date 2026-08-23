## 0. Blocking evidence task — order-price-limits applicability to native Partial TP `triggerPrice` (CLOSED)

**Closed 2026-08-19 on Bybit Demo (linear `ETHUSDT`).** Full evidence recorded in design.md Decision 5.
Result: task 0 did not establish `/v5/market/price-limit`'s band as the far-side boundary a clamping
surrogate policy would need — an amend to `1.5 × buyLimit` was accepted (`retCode: 0`) identically to a
normal-range amend, and the read-back confirmed the far value was actually applied. This is the narrower,
task-0-scoped finding that the one candidate mapping considered is not supported by the evidence obtained,
not a claim that this band can never constrain any native Partial TP `triggerPrice` amend under any
circumstance. `CurrentOrderPriceLimitsProvider` is therefore not consumed anywhere in this change;
design.md Decision 5 was revised accordingly (task 0.1.7c).

- [x] 0.1 Ran the exact procedure against Bybit Demo: fresh `CurrentOrderPriceLimitsProvider.getCurrent`
      snapshot; materialized attributable native Partial `STOP + TAKE` pair; amended the exact TAKE
      child's `orderId` twice (normal-range, then beyond `buyLimit`), independent fresh read-back after
      each; raw `retCode`/`retMsg`/resulting state recorded in design.md Decision 5; determination (c)
      recorded — order-price-limits was not established as the applicable bound, no replacement boundary
      source adopted.
- [x] 0.2 Result explicitly scoped to the one instrument tested (`ETHUSDT`, linear) per design.md
      Decision 5, not generalized beyond what the evidence supports.

## 1. `floorToStep` (exact-decimal primitive)

- [x] 1.1 Add `floorToStep(valueText: string, stepText: string): string` to `src/domain/exactDecimal.ts`,
      alongside the existing `ceilToStep` (design.md Decision 3) — same shape, rounds toward zero along
      the step grid instead of away from it.
- [x] 1.2 Unit tests: exact-multiple-of-step input is unchanged; a value strictly between two step
      boundaries rounds down to the lower one; symmetry/asymmetry with `ceilToStep` on the same inputs is
      explicitly asserted (they must differ whenever the input is not already an exact multiple).

## 2. `tickSize` on `InstrumentTradingRules`

**Scope note:** this task adds `tickSize` only. It does **not** add `minPrice`/`maxPrice` — an earlier
version of this task did, to support a now-retracted clamping formula (design.md Decision 5).

- [x] 2.1 Add `tickSize: string` to `InstrumentTradingRules`
      (`src/exchange/instrumentTradingRulesResponseDecoder.ts`), decoded from the same response's
      `priceFilter.tickSize` (design.md Decision 3). Add `missing_price_filter`/`invalid_tick_size`
      failure reasons mirroring the existing `missing_lot_size_filter`/`invalid_qty_step` pattern.
- [x] 2.2 `BybitInstrumentTradingRulesProvider` — no code change expected (it already returns whatever
      `decodeInstrumentTradingRulesResponse` produces); confirm via test that the cached value now
      includes `tickSize`.
- [x] 2.3 Tests: valid `priceFilter.tickSize` decodes; missing `priceFilter` → `missing_price_filter`;
      malformed/negative/zero `tickSize` → `invalid_tick_size`. Full regression of existing
      `instrumentTradingRulesResponseDecoder.test.ts` — unchanged assertions for `minOrderQty`/`qtyStep`/
      `minNotionalValue` still pass.

## 3. Adapter primitive: `amendOrder`

- [x] 3.1 Add `BybitAmendOrderPayload` to `src/exchange/bybitOrderMapper.ts` and `amendOrder()` to the
      `BybitAdapter` interface, `RestBybitAdapter` (`signedPost("/v5/order/amend", payload)` — design.md
      Decision 2), `StubBybitAdapter`, and `FakeBybitAdapter` (test fake, tracking calls the same way
      every other adapter method does).
- [x] 3.2 Do not modify `setTradingStop`, `SetTradingStopInput`, or any existing caller.

## 4. Surrogate TAKE price computation

- [x] 4.1 `computeSurrogateTakePrice(input: { plannedEntryPrice: string; side: "long" | "short"; tickSize:
      string }): string` (design.md Decision 5, task 0 evidence folded in): `SURROGATE_TAKE_DISTANCE_RATIO
      = 0.5` as a named, documented constant; `reference * (1 ± ratio)` via exact-decimal multiplication
      (`multiplyDecimal`, `src/domain/exactDecimal.ts`), tick-normalized away from reference
      (`ceilToStep` for long, `floorToStep` for short). No clamp step, no
      `CurrentOrderPriceLimitsProvider` dependency, no `surrogate_unrepresentable` outcome — task 0 did not
      establish the only boundary source this design considered as applicable, so the function is total
      over its inputs and carries no exchange-validity claim; Bybit's own amend-time acceptance/rejection
      is the only gate (Decision 7's existing `amend_rejected` path).
- [x] 4.2 Tests: deterministic (same inputs → same output across calls); idempotent under repeated calls
      with unchanged inputs; long produces a price strictly above `plannedEntryPrice`, short strictly
      below; result is tick-aligned per the provided `tickSize`; long rounds away from reference (up),
      short rounds away from reference (down) — assert the two directions are not accidentally symmetric
      in rounding behavior.

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
      Decision 4/5): `qty` from task 5.1 (propagates its `err` as fail-closed); `stop.triggerPrice` from
      `command.stopPrice`; `take.triggerPrice` from `command.takePrice` when non-null, else
      `computeSurrogateTakePrice(...)` (task 4.1) using `desired_entry.planned_entry_price`, `side`,
      `tickSize` — no exchange dependency on this path. Both legs always carry the same `qty`.
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
      `side`, and `tickSize`; both legs' `qty` always equal regardless of which take path is taken.

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
      for `take_price = null` (anchored to the immutable planned entry price, deterministic, never derived
      from live current market price, no exchange-price-bound dependency); reconciliation targets the
      trade cycle's current own filled quantity without waiting for its entry to reach a terminal fill
      state, and fails closed on no own fill evidence at all; fresh-evidence discipline; fail-closed on
      non-attributed/ambiguous/race; already-satisfied short-circuit. Phrased around behavior, not literal
      field/function names, mirroring `abi-native-partial-protection-attribution-v1`'s spec.md convention.

## 9. Tests (all synthetic/fixture-driven — no real Bybit call in the automated test suite; task 0's Demo
      evidence-gathering was a one-off manual run, not part of the committed test suite)

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
- [x] 9.5 A `DesiredProtectionState` whose `take.triggerPrice` differs from an already-materialized real
      (non-surrogate) TAKE's actual `triggerPrice` → reconciles the TAKE leg's `triggerPrice` toward the
      given desired value, same write-plan as any other `take_price` change — no special-cased "removal"
      path exists or is attempted.
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
      (`no_authoritative_qty`) before any attribution/amend call; `take_price: null` end-to-end through a
      computed surrogate desired state, reconciled; regression of `protectionApplicationService.test.ts`'s
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
      no public HTTP route, DTO, or error code changed; `src/exchange/orderPriceLimits/*` and
      `openspec/specs/order-price-limits/spec.md` (`abi-current-order-price-limits-v1`'s own files) are
      not touched or consumed by this change at all.
- [x] 10.3 Confirmed task 0 closed and its result is reflected in design.md Decision 5 before any task 4
      work — design.md's follow-up correction cites task 0's recorded evidence directly.

## 11. Review-fix pass (integration/change7-current-design)

- [x] 11.1 Terminal attributed protection must not count as active satisfied coverage
      (`resolveOwnAttachedProtection()` is status-agnostic; the caller must interpret status).
      `reconcileNativePartialProtection()` no longer returns `already_satisfied` when a terminal leg's
      stale values happen to numerically match desired, and no longer returns `reconciled` when a
      post-amend fresh read-back shows a terminal leg even if its values match desired — both paths fail
      closed (`amend_race`). No create/cancel/replacement introduced. Regression tests added: initial
      Deactivated pair with exact desired price/qty does not return `already_satisfied`; post-amend
      terminal pair with exact desired price/qty does not return `reconciled`.
- [x] 11.2 Removed the local decimal-multiplication implementation
      (`parseForMultiply`/`formatForMultiply`/Number-ratio plumbing) from
      `nativeProtectionReconciliation.ts`. Added `multiplyDecimal(aText, bText): string` to
      `src/domain/exactDecimal.ts`, reusing the existing parser/grammar (no new regex, no binary float).
      `computeSurrogateTakePrice` now multiplies by exact-decimal-text ratios `"1.5"`/`"0.5"`. Regression
      test added: `plannedEntryPrice: "1e3"` (transport-legal exact-decimal exponent syntax) computes
      correctly.
- [x] 11.3 `InstrumentTradingRulesProvider.getRules()` throwing on the null-take path no longer rejects
      `reconcileNativePartial()`'s returned Promise — `resolveDesiredProtectionState()` wraps the call and
      resolves to a new typed failure, `trading_rules_unavailable`, surfaced as
      `{ kind: "fail_closed", reason: "trading_rules_unavailable" }`. Tests added at both layers: a
      `resolveDesiredProtectionState()` unit test, and a `reconcileNativePartial()` service-level test
      asserting zero attribution reads, zero amend writes, and no thrown/rejected Promise.
- [x] 11.4 Removed the no-longer-used `tradingRules`/`side` parameters from
      `reconcileNativePartialProtection()` — the primitive never read them (desired-state computation,
      including the surrogate's `tickSize` dependency, stays entirely the caller's concern per Decision 1).
      Updated design.md Decision 1's signature and both call sites (service, tests) to match.
- [x] 11.5 Documentation: added master-plan revision v19 (task 0 closed; `/price-limit` not established as
      the surrogate boundary, not "proven to never constrain any TP triggerPrice"; Change 7 does not
      consume `CurrentOrderPriceLimitsProvider`; ratio + tick normalization; Bybit amend acceptance/
      rejection is the actual write gate). Fixed proposal.md's stale Impact paragraph that still named
      task 0 as a remaining precondition. Removed a verbatim-duplicate paragraph in design.md Decision 5
      ("Original architecture kept" / "What this design still fixes" said the same thing twice). Reworded
      every "proved/does not constrain ... at all" claim to the narrower, evidence-accurate framing: task 0
      did not establish `/price-limit` as the needed far-side boundary, so Change 7 does not use it — not a
      universal claim about what Bybit's price-limit band can or cannot ever constrain. `abi-current-order-
      price-limits-v1` (capability "6.5") is untouched, canonical, and not archived or removed by any of
      this.
- [x] 11.6 Synced `specs/protection-execution/spec.md`: added the terminal-leg-is-never-active-coverage
      requirement (covers both the already-satisfied shortcut and the post-amend success path) and the
      trading-rules-dependency-failure-fails-closed requirement; tightened the already-satisfied
      requirement's own wording to require a non-terminal match; removed the now-stale "evidence-gated"
      phrasing on the disabled-take requirement.
