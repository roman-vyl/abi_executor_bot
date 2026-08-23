## 1. `OrderRecoverySignal`: carry the own-order query's average price and cumulative filled qty

- [x] 1.1 Extend `OrderRecoverySignal`'s `live_with_fill` and `terminal_with_fill` variants with
      `averageEntryPrice: string` and `cumulativeFilledQty: string`, in
      `entryCycleRecoveryResolutionService.ts` — design.md Decision 1.
- [x] 1.2 In `classifyOrderForRecovery`, populate both fields from whichever query (realtime or history)
      positively found the order in a fill-carrying state, using that response's already-decoded
      `BybitOrderView.avgPrice`/`cumExecQty` — no new exchange call — design.md Decision 1.

## 2. Shared close-outcome primitive, extracted from `CloseApplicationService`, not duplicated

- [x] 2.1 In `src/services/entryPackage/packageConfirmation.ts`, add `OwnCloseOrderOutcome = { kind:
      "matched" } | { kind: "zero_fill" } | { kind: "qty_mismatch" } | { kind: "not_found" } | { kind:
      "ambiguous" }` and `classifyOwnCloseOrderOutcome(input: { bybit, getCloseOrderPayload,
      getCloseOrderHistoryPayload, expectedQty }): Promise<OwnCloseOrderOutcome>` — single-shot (no
      internal retry loop), calling the already-defined `classifyEntryOrderTerminality` and
      `confirmEntryPackage` in this same file — design.md Decision 3.
- [x] 2.2 Refactor `CloseApplicationService.resolveCloseOrderOutcome`
      (`src/services/close/closeApplicationService.ts:471-516`) into a thin wrapper: keep its own existing
      `FINAL_VERIFY_ATTEMPTS`/`FINAL_VERIFY_RETRY_DELAY_MS` bounded-retry loop, call
      `classifyOwnCloseOrderOutcome` once per attempt, and collapse its result to the method's existing
      `"matched" | "incomplete" | "not_found" | "ambiguous"` contract (`zero_fill` and `qty_mismatch` both
      map to `"incomplete"`, `matched`/`not_found`/`ambiguous` map straight through) — design.md Decision
      3. Behavior-preserving; verify via `CloseApplicationService`'s own existing regression suite passing
      unchanged, with no assertion changes.

## 3. Aggregate sanity classification (replaces `positionOpen`/`positionFlat` booleans)

- [x] 3.1 Add `AggregateSanity = "opposite_side_contradiction" | "same_side_exists" | "no_signal"` and
      `classifyAggregateSanity(positionQuery, desiredEntry): AggregateSanity`, replacing the current
      inline `positionOpen`/`positionFlat` boolean derivation — design.md Decision 4d. Reuses the existing
      `positionSideMatches` helper unchanged.

## 4. `resolveRecoveryState`: own evidence determines the candidate; aggregate can only veto

- [x] 4.1 Rewrite `resolveRecoveryState` to take `{ orderSignal, closeOutcome: OwnCloseOrderOutcome |
      undefined, closeOrderAttempted: boolean, positionQuery, desiredEntry }` — design.md Decision 4b.
      Remains a pure, synchronous function.
- [x] 4.2 `entry_order_live` (`orderSignal.kind === "live_unfilled"`): candidate from own evidence;
      veto only if `closeOrderAttempted` (defensive) or aggregate sanity is
      `"opposite_side_contradiction"` — design.md Decision 4b.
- [x] 4.3 `terminal_without_fill` (`orderSignal.kind === "terminal_without_fill"`): identical shape to 4.2.
- [x] 4.4 Fill-carrying `orderSignal` (`live_with_fill` or `terminal_with_fill`) with
      `!closeOrderAttempted`: candidate `position_open` (carrying `orderSignal.averageEntryPrice`); veto
      unless aggregate sanity is `"same_side_exists"` — design.md Decision 4b case 1.
- [x] 4.5 `closeOrderAttempted` true and `orderSignal.kind === "live_with_fill"`: fails closed
      unconditionally (defensive structural-contradiction check); no close-order query issued — design.md
      Decision 4b case 2.
- [x] 4.6 `closeOrderAttempted` true and `orderSignal.kind === "terminal_with_fill"`: branches on
      `closeOutcome.kind` — `"matched"` → `terminal_after_fill`, **no aggregate consultation at all**
      (design.md Decision 4c); `"zero_fill"` → `position_open` (same veto as 4.4); `"qty_mismatch"` →
      fails closed (never rounded to either state); `"not_found"` / `"ambiguous"` / `closeOutcome`
      undefined → fails closed — design.md Decision 4b case 3.

## 5. Orchestration: conditional close-order check in the existing bounded-retry loop

- [x] 5.1 Read `record.close_order_link_id` once, before the loop (immutable-once-set per Change 2) —
      design.md Decision 4e.
- [x] 5.2 Within each attempt, after computing that attempt's `orderSignal`: if `orderSignal.kind ===
      "terminal_with_fill"` and `close_order_link_id` is non-null, call `classifyOwnCloseOrderOutcome`
      (Task 2) scoped to `{ category, symbol, orderLinkId: close_order_link_id, limit: "1" }` for both the
      realtime and history payloads, with `expectedQty: orderSignal.cumulativeFilledQty` — design.md
      Decision 4e. If `orderSignal.cumulativeFilledQty` is empty or not strictly positive, fail closed
      before calling `classifyOwnCloseOrderOutcome` (no valid `expectedQty`) — design.md Decision 3. No
      new outer retry loop; this call is covered by the existing attempt's bounded retry.
- [x] 5.3 Pass `orderSignal`, `closeOutcome`, `closeOrderAttempted`, `positionQuery`, `desiredEntry` into
      the rewritten `resolveRecoveryState` (Task 4).

## 6. Durable `first_fill_at_ms` capture-or-reuse, under the shared mutex (unchanged from the prior draft)

- [x] 6.1 Add `mutex: KeyedMutex` to `EntryCycleRecoveryResolutionServiceDeps` — design.md Decision 2.
- [x] 6.2 When the redesigned grid (Task 4) resolves a `position_open` outcome, acquire the pair's mutex
      lock (`correlationRecordKey(strategyInstanceId, tradeCycleId)`) narrowly around the capture-or-reuse
      step only — design.md Decision 2.
- [x] 6.3 Under the lock: re-read the record fresh; if now durably closed, resolve the correct terminal
      result for that status instead of proceeding — design.md Decision 2.
- [x] 6.4 Under the lock: reuse `record.first_fill_at_ms` if already non-null; otherwise call
      `resolveFirstAttributableFillAtMs` (imported unchanged from `packageConfirmation.ts`) and, on
      `"found"`, durably save `{ ...record, first_fill_at_ms: captured.firstFillAtMs, updated_at: new
      Date().toISOString() }` — mirroring `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s
      existing block exactly — design.md Decision 2.
- [x] 6.5 On `"no_executions_found"` or `"ambiguous"` from the capture call, fail closed
      (`internalErrorResult()`) — design.md Decision 2.

## 7. Wiring

- [x] 7.1 In `src/app/server.ts`, pass the existing shared `mutex` instance into
      `EntryCycleRecoveryResolutionService`'s construction — design.md Decision 2.

## 8. Spec delta

- [x] 8.1 Rewrite the "Recovery resolution classifies the trade cycle into exactly one of four states..."
      requirement's body and scenarios per design.md Decision 4b — every scenario's aggregate dependency
      is re-specified (opposite-side veto for the two zero-fill states, own-close-order exact-qty-match
      disambiguation and same-side existence veto for `position_open`/`terminal_after_fill`).
- [x] 8.2 Add scenarios covering: `entry_order_live`/`terminal_without_fill` resolving despite a same-side
      sibling's aggregate contribution; `terminal_after_fill` resolving from an exact close-order qty match
      with no aggregate consultation, despite a same-side sibling's aggregate contribution;
      `position_open` resolving from a rejected (zero-fill) close attempt; a partial close-order fill
      failing closed rather than resolving either state; opposite-side contradiction remaining fail-closed
      for all four states; the close-order-inconclusive fail-closed case.
- [x] 8.3 Add a new scenario to "Recovery resolution never causes an exchange side effect" clarifying that
      read-only exchange queries (including the close-order check) and ABI's own local durable write are
      not exchange side effects within the meaning of this requirement — design.md's prior-draft rationale
      (unchanged).

## 9. Tests (design.md "Required tests", full list — supersedes prior drafts' Task 8/6)

- [x] 9.1 `average_entry_price`/`first_fill_at_ms` sourcing tests (own-order `avgPrice`; durable capture
      reuse/first-capture/failure/concurrency/racing-close scenarios) — unchanged from the first draft.
- [x] 9.2 A open + B `live_unfilled`, no close attempted → recovery(B) = `entry_order_live`, aggregate
      reporting A's open position on the matching side.
- [x] 9.3 A open + B `terminal_without_fill`, no close attempted → recovery(B) = `terminal_without_fill`,
      aggregate reporting A's open position on the matching side.
- [x] 9.4 A open + B has its own fill, no close attempted → recovery(B) = `position_open` with B's own
      `average_entry_price`/`first_fill_at_ms`, verified against a fixture where A's aggregate `avgPrice`
      deliberately differs from B's own order response.
- [x] 9.5 Aggregate sibling activity alone never turns a B with zero own fill into `position_open` —
      verified for every non-fill-carrying `orderSignal.kind` combined with every aggregate state.
- [x] 9.6 A open + B's own close order confirms an exact qty match → recovery(B) = `terminal_after_fill`,
      with the aggregate still positively reporting A's open position throughout, and verifying no call to
      `queryPositionForInstrument`'s result influences this outcome.
- [x] 9.7 B's own close order fills but not the exact expected quantity (`qty_mismatch`) → recovery(B)
      fails closed, regardless of aggregate state.
- [x] 9.8 B's own close order durably recorded but still live/not found/inconclusive → recovery(B) fails
      closed, regardless of aggregate state.
- [x] 9.9 B's own close order durably recorded and positively terminal with zero fill (rejected) →
      recovery(B) = `position_open`, sanity-checked against an existing same-side aggregate position.
- [x] 9.10 Opposite-side contradiction remains fail-closed for `entry_order_live`/`terminal_without_fill`.
- [x] 9.11 `position_open`'s existence veto still fails closed when the aggregate cannot confirm a matching
      position at all (no position, or wrong side), despite positive own fill evidence.
- [x] 9.12 `classifyOwnCloseOrderOutcome` is a pure extraction: `CloseApplicationService`'s own existing
      `resolveCloseOrderOutcome` regression suite passes unchanged.
- [x] 9.13 B's own entry order carries an empty/non-positive `cumulativeFilledQty` on an otherwise
      fill-carrying signal, with a close order durably recorded → fails closed before calling
      `classifyOwnCloseOrderOutcome`.
- [x] 9.14 Full regression of every existing `entryCycleRecoveryResolutionService.test.ts` scenario this
      redesign does not intentionally change: durably-closed-status fast path, legacy `pending_action`
      guard, every single-owner (`close_order_link_id === null`) combination.

## 10. Final verification (only once implementation is authorized — not part of this propose-only change)

- [x] 10.1 `npm run typecheck` (or repo equivalent) clean.
- [x] 10.2 Full test suite passes.
- [x] 10.3 Build clean.
- [x] 10.4 Diff review confirms no file outside this change's stated Impact was touched.
