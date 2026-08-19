## 0. Blocking evidence task — order-price-limits applicability to native Partial TP `triggerPrice`

**This task must close, and its result must be folded back into design.md Decision 5 as a follow-up
correction, before task 4's surrogate-price formula is designed or implemented.** It is a bounded Demo
evidence check, not a new spike subsystem — no new provider, decoder, or production code is built to run
it; it consumes only what `abi-native-partial-protection-attribution-v1` and
`abi-current-order-price-limits-v1` already provide.

- [ ] 0.1 On Bybit Demo, for one representative linear instrument:
      1. obtain a fresh `CurrentOrderPriceLimitsProvider.getCurrent({ category: "linear", symbol })`
         snapshot (`buyLimit`, `sellLimit`, `observedAtMs`);
      2. materialize an attributable native Partial `STOP + TAKE` pair for a test position (same
         mechanism already used by `abi-native-partial-protection-attribution-v1`'s own spike);
      3. record the exact TAKE child's `orderId`;
      4. attempt `POST /v5/order/amend` on that `orderId`'s `triggerPrice`, first to a value clearly
         inside a plausible normal trading range, then to a value at or beyond the corresponding
         `buyLimit`/`sellLimit` boundary from step 1;
      5. perform an independent fresh read-back after each amend acknowledgment (not reusing pre-amend
         evidence), per this change's own Decision 7 discipline;
      6. record the raw `retCode`/`retMsg` and the child's actual resulting state (not an assumption) for
         each attempt;
      7. determine and record in design.md Decision 5: (a) whether `/v5/market/price-limit`'s band
         constrains this TP `triggerPrice` amend at all; (b) if it does, which of `buyLimit`/`sellLimit`
         is the applicable bound for a LONG TP versus a SHORT TP; (c) if it does not, that conclusion is
         recorded explicitly and design.md Decision 5 is revised to select a different, separately-proven
         boundary source rather than silently keeping the unproven mapping.
- [ ] 0.2 Do not generalize a single instrument's result into a universal claim without the same caveat
      this program has applied to every other single-instrument Demo finding so far (e.g. the stop-only
      spike's own explicit "evidence about one instrument" framing) — if genuine doubt remains about
      cross-instrument applicability, say so in the recorded result rather than asserting certainty task
      0.1 does not support.

## 1. `floorToStep` (exact-decimal primitive)

- [ ] 1.1 Add `floorToStep(valueText: string, stepText: string): string` to `src/domain/exactDecimal.ts`,
      alongside the existing `ceilToStep` (design.md Decision 3) — same shape, rounds toward zero along
      the step grid instead of away from it.
- [ ] 1.2 Unit tests: exact-multiple-of-step input is unchanged; a value strictly between two step
      boundaries rounds down to the lower one; symmetry/asymmetry with `ceilToStep` on the same inputs is
      explicitly asserted (they must differ whenever the input is not already an exact multiple).

## 2. `tickSize` on `InstrumentTradingRules`

**Scope note:** this task adds `tickSize` only. It does **not** add `minPrice`/`maxPrice` — an earlier
version of this task did, to support a now-retracted clamping formula (design.md Decision 5). Static
instrument price-filter bounds are a different capability's remaining concern (if any) than the dynamic
`order-price-limits` capability this change consumes instead (Context section, task 0).

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

## 4. Surrogate TAKE price computation — BLOCKED on task 0

**This entire section is blocked until task 0 closes and its result is folded back into design.md
Decision 5 as a follow-up correction.** Do not implement `computeSurrogateTakePrice` or any
concrete surrogate-distance/clamping logic against a guessed boundary source before that correction
exists — design.md Decision 5 explicitly retracts the prior `planned_entry_price * 1.5/0.5` +
`clampToInstrumentBounds(minPrice, maxPrice)` formula and does not replace it with a new one here.

- [ ] 4.1 **Not actionable yet.** Once task 0's evidence closes and design.md Decision 5 is corrected with
      a proven formula (including which of `buyLimit`/`sellLimit`, or another proven boundary source, is
      applicable and how), add the concrete pure function here, sourced from that corrected design.md
      text — not invented at implementation time.
- [ ] 4.2 **Not actionable yet.** Tests for whatever concrete function task 4.1 ends up defining
      (determinism, idempotency, side-correct direction, tick-alignment, and boundary-edge behavior using
      the evidence-proven boundary source) are written against that corrected formula, not against the
      retracted one.

## 5. Desired-state resolution

- [ ] 5.1 New function `resolveCurrentOwnFilledQty(record, confirmEntryPackage)` (design.md Decision 4):
      if `record.early_execution_observation` is present and `isFillFactFinal(...)` is true, reuse its
      `cumulative_filled_qty` directly; otherwise issue a fresh `confirmEntryPackage()` call for this
      cycle's own entry order — `partial_fill` and `full_fill` both resolve to their `observation`'s
      `cumulative_filled_qty` as equally authoritative; `pending_confirmed`/`terminal_without_fill`/
      `not_found`/`ambiguous` all resolve to `err("no_authoritative_qty")` (fail closed, no fallback to
      `"0"`). Does **not** wait for `isFillFactFinal` as a gate — a live partial fill is a valid,
      immediately-usable answer.
- [ ] 5.2 New function resolving a `ProtectionCommand` + a record into a `DesiredProtectionState` (design.md
      Decision 4): `qty` from task 5.1 (propagates its `err` as fail-closed); `stop.triggerPrice` from
      `command.stopPrice`; `take.triggerPrice` from `command.takePrice` when non-null. **When
      `command.takePrice` is `null`:** query `CurrentOrderPriceLimitsProvider.getCurrent({ category,
      symbol })` fresh (design.md Decision 5) — any `OrderPriceLimitsFailure` propagates as
      `err("order_price_limits_unavailable")`, fail closed, before any attribution read or amend call; on
      success, delegate to `computeSurrogateTakePrice(...)` (task 4.1 — **not actionable until task 0
      closes**, so this branch cannot be completed end-to-end before then). Both legs always carry the
      same `qty`.
- [ ] 5.3 **Required test — current cumulative qty at partial fill, not final fill:** entry command qty
      `10`; first reconciliation attempt observes `confirmEntryPackage()` → `partial_fill` with
      `cumulative_filled_qty: "4"` → resolved desired protection `qty` is `"4"` (not blocked, not an
      error). A second, later reconciliation attempt on the same cycle observes a fresh
      `confirmEntryPackage()` → (`partial_fill` or `full_fill`) with `cumulative_filled_qty: "7"` →
      resolved desired protection `qty` is `"7"`. Across both attempts, the entry order's own remainder is
      never cancelled or amended by anything this function does — the function only reads fill facts, it
      issues no entry-order write.
- [ ] 5.4 Tests: `early_execution_observation` present and final → reused without a `confirmEntryPackage()`
      call; absent or non-final → fresh `confirmEntryPackage()` call issued, `partial_fill` and `full_fill`
      both accepted as authoritative; `terminal_without_fill`/`not_found`/`ambiguous`/`pending_confirmed`
      → `no_authoritative_qty`, fail closed, distinct from `OpenPositionResolutionService
      .resolveOwnFillFacts()`'s own zero-fill-is-valid handling (assert the two functions disagree on
      this input, documenting the deliberate divergence); non-null `take_price` passes through unchanged
      and does **not** query `CurrentOrderPriceLimitsProvider` at all (it is only consulted on the
      `take_price: null` path); `take_price: null` with a `CurrentOrderPriceLimitsProvider` failure
      (any `OrderPriceLimitsFailure` reason) → `no_authoritative_qty`-sibling fail-closed outcome
      `order_price_limits_unavailable`, no attribution read, no amend call; both legs' `qty` always equal
      regardless of which take path is taken. The `take_price: null` **success** path itself
      (`computeSurrogateTakePrice` actually producing a price) is not testable end-to-end until task 4
      unblocks — this task only covers the dependency-wiring and fail-closed behavior around it.

## 6. Reconciliation primitive

- [ ] 6.1 New file `src/services/protection/nativeProtectionReconciliation.ts`:
      `DesiredProtectionState`/`DesiredProtectionLeg`, `ReconciliationOutcome`/
      `ReconciliationFailureReason`, `reconcileNativePartialProtection()` (design.md Decisions 1, 6, 7,
      9) — calls `resolveOwnAttachedProtection()` (Change 6, unmodified), computes the minimal
      `amendOrder` write-plan (Decision 6's full eight-case matrix: at most two calls total, and `qty` —
      whenever it changes — travels only in the STOP leg's call, never the TAKE leg's), sends it, then
      re-verifies with an independent fresh `resolveOwnAttachedProtection()` call (Decision 7 step 3).
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
      the existing `mutex.withKeyLock` pattern `apply()` already uses; resolves current own filled qty
      (task 5.1 — reuse-if-final, else fresh `confirmEntryPackage()`, fail closed on
      `no_authoritative_qty`, no `isFillFactFinal` gate); resolves desired state (task 5.2); calls
      `reconcileNativePartialProtection()` (task 6.1).
- [ ] 7.2 Do **not** modify `process()`/`apply()` — the existing production-decision path, including the
      `shared_scope_protection_unsupported` guard and the `setTradingStop`/`tpslMode: "Full"` write, is
      byte-for-byte unchanged. Nothing in `EntryPackageApplicationService`, `CloseApplicationService`, or
      HTTP routing calls the new method.

## 8. Spec delta

- [ ] 8.1 `specs/protection-execution/spec.md` (this change's own delta) — MODIFIED, adding requirements
      for: reconciliation exists and is production-inert; amend-only, never create/cancel; surrogate TAKE
      for `take_price = null` (anchored to the immutable planned entry price, deterministic, never derived
      from live current market price — **not** asserting a proven instrument/exchange price-bound
      mechanism, since that mapping is not yet established, see design.md Decision 5/task 0); computing
      that surrogate depends on a fresh current-order-price-limits read and fails the reconciliation
      attempt closed, before any attribution read or amend, when that read cannot be obtained;
      reconciliation targets the trade cycle's current own filled quantity without waiting for its entry
      to reach a terminal fill state, and fails closed on no own fill evidence at all; fresh-evidence
      discipline; fail-closed on non-attributed/ambiguous/race; already-satisfied short-circuit. Phrased
      around behavior, not literal field/function names, mirroring
      `abi-native-partial-protection-attribution-v1`'s spec.md convention.

## 9. Tests (all synthetic/fixture-driven — no real Bybit call in the automated test suite; the
      reconciliation primitive itself is exercised with synthetic `DesiredProtectionState` fixtures and
      does not depend on task 4's still-blocked surrogate formula — only task 5.2's dependency-wiring and
      fail-closed behavior around `CurrentOrderPriceLimitsProvider` do, per task 0/4's blocked status)

- [ ] 9.1 Reconcile an already-attributed pair whose `triggerPrice`/`qty` already match desired →
      `already_satisfied`, zero `amendOrder` calls.
- [ ] 9.2 Reconcile a pair whose `stop_price` changed only → exactly one `amendOrder` call, on the STOP
      leg's `orderId`, carrying the new `triggerPrice`.
- [ ] 9.3 Reconcile a pair whose `qty` changed only (both `triggerPrice`s unchanged) → exactly one
      `amendOrder` call, deterministically on the STOP leg's `orderId`, carrying only the new `qty` — no
      second call on the TAKE leg (pair-wide sync assumed by the write-plan, not independently re-verified
      by a second write).
- [ ] 9.4 Reconcile both `stop_price` and `take_price` changed simultaneously, `qty` unchanged → exactly
      two `amendOrder` calls, one per leg, each carrying only its own new `triggerPrice` — neither call
      carries `qty`.
- [ ] 9.4a **Required test — qty and both triggerPrices change together:** exactly two `amendOrder` calls
      — STOP's call carries its new `triggerPrice` **and** the new `qty` together; TAKE's call carries
      only its new `triggerPrice`, never `qty` — asserting the full design.md Decision 6 case matrix, not
      just the single-field-changed cases.
- [ ] 9.4b Reconcile a pair whose `qty` changed and only TAKE's `triggerPrice` also changed (STOP's
      `triggerPrice` unchanged) → exactly two `amendOrder` calls — STOP's call carries `qty` only (issued
      even though STOP's own `triggerPrice` did not change); TAKE's call carries only its new
      `triggerPrice`.
- [ ] 9.5 A `DesiredProtectionState` whose `take.triggerPrice` differs from an already-materialized real
      (non-surrogate) TAKE's actual `triggerPrice` → reconciles the TAKE leg's `triggerPrice` toward the
      given desired value, same write-plan as any other `take_price` change — no special-cased "removal"
      path exists or is attempted. This test exercises the reconciliation primitive directly with a
      synthetic desired value (task 6.1) and does not require task 4's surrogate formula — it proves the
      write-plan is agnostic to how `take.triggerPrice` was computed.
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
- [ ] 9.10 `reconcileNativePartial()` (service method) full flow: a live, still-partial entry order with
      an available `partial_fill` observation → reconciles toward that partial's `cumulative_filled_qty`,
      not blocked and not failed closed; no fill evidence obtainable at all
      (`terminal_without_fill`/`not_found`/`ambiguous`/`pending_confirmed`) → fail closed
      (`no_authoritative_qty`) before any attribution/amend call; `take_price: null` with a
      `CurrentOrderPriceLimitsProvider` failure → fail closed (`order_price_limits_unavailable`) before
      any attribution/amend call (task 5.2/5.4 — testable now); `take_price: null` with a successful
      `CurrentOrderPriceLimitsProvider` snapshot end-to-end through a computed surrogate desired state is
      **not** testable here until task 4 unblocks; regression of `protectionApplicationService.test.ts`'s
      existing `apply()`/`process()` coverage — byte-for-byte unchanged, including the multi-owner
      guard-rejection test.
- [ ] 9.11 Full regression: `entryPackageApplicationService.test.ts`,
      `instrumentTradingRulesResponseDecoder.test.ts`, `bybitOrderMapper`-related tests,
      `orderPriceLimitsDecoder.test.ts`/`orderPriceLimitsProvider.test.ts`/
      `orderPriceLimitsModuleBoundary.test.ts` (`abi-current-order-price-limits-v1`), and any existing
      `exactDecimal`/`packageConfirmation`/`nativeProtectionAttribution` tests all pass unmodified — none
      of them call the new primitives, and every existing production path's output is unchanged.

## 10. Final verification

- [ ] 10.1 `npm run typecheck`, `npm test`, `npm run build` all clean.
- [ ] 10.2 Diff review confirms: zero fields added to `EntryPackageExecutionRecord`;
      `EntryPackageCorrelationRepository`, `CloseApplicationService`, `EntryPackageApplicationService`'s
      claim logic, `mapEntryPackageToBybit()`, and `ProtectionApplicationService.process()`/`apply()`'s
      existing behavior are byte-for-byte unmodified; `setTradingStop`/`SetTradingStopInput` untouched;
      no public HTTP route, DTO, or error code changed; `src/exchange/orderPriceLimits/*` and
      `openspec/specs/order-price-limits/spec.md` (`abi-current-order-price-limits-v1`'s own files) are
      consumed only through `CurrentOrderPriceLimitsProvider`'s existing interface, never modified.
- [ ] 10.3 Confirm task 0 has closed and its result is reflected in design.md Decision 5 before any task
      4 work is merged — a diff that implements `computeSurrogateTakePrice` without a corresponding
      design.md correction referencing task 0's recorded evidence is out of process for this change.
