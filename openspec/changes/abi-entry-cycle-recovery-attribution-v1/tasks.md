## 1. `OrderRecoverySignal`: carry the own-order query's average price

- [ ] 1.1 Extend `OrderRecoverySignal`'s `live_with_fill` and `terminal_with_fill` variants with
      `averageEntryPrice: string`, in `entryCycleRecoveryResolutionService.ts` — design.md Decision 1.
- [ ] 1.2 In `classifyOrderForRecovery`, populate `averageEntryPrice` from whichever query (realtime or
      history) positively found the order in a fill-carrying state, using that response's already-decoded
      `BybitOrderView.avgPrice` — no new exchange call — design.md Decision 1.

## 2. Aggregate sanity classification (replaces `positionOpen`/`positionFlat` booleans)

- [ ] 2.1 Add `AggregateSanity = "opposite_side_contradiction" | "same_side_exists" | "no_signal"` and
      `classifyAggregateSanity(positionQuery, desiredEntry): AggregateSanity`, replacing the current
      inline `positionOpen`/`positionFlat` boolean derivation — design.md Decision 3d. Reuses the existing
      `positionSideMatches` helper unchanged.

## 3. `resolveRecoveryState`: redesigned own-evidence-primary grid

- [ ] 3.1 Rewrite `resolveRecoveryState` to take `{ orderSignal, closeSignal: OrderRecoverySignal |
      undefined, closeOrderAttempted: boolean, positionQuery, desiredEntry }` and resolve every state from
      `orderSignal` (and, when needed, `closeSignal`) primarily, using `classifyAggregateSanity`'s result
      only as a state-appropriate sanity gate — design.md Decision 3b. Remains a pure, synchronous
      function.
- [ ] 3.2 `entry_order_live` (`orderSignal.kind === "live_unfilled"`): resolves unless `closeOrderAttempted`
      is true (defensive, expected unreachable) or aggregate sanity is
      `"opposite_side_contradiction"` — no longer requires `"no_signal"` (aggregate flat) — design.md
      Decision 3b.
- [ ] 3.3 `terminal_without_fill` (`orderSignal.kind === "terminal_without_fill"`): identical shape to 3.2
      — design.md Decision 3b.
- [ ] 3.4 Fill-carrying `orderSignal` (`live_with_fill` or `terminal_with_fill`) with
      `!closeOrderAttempted`: resolves `position_open` (carrying `orderSignal.averageEntryPrice`) only if
      aggregate sanity is `"same_side_exists"`; fails closed otherwise — design.md Decision 3b case 1.
- [ ] 3.5 Fill-carrying `orderSignal` with `closeOrderAttempted` true and `orderSignal.kind ===
      "live_with_fill"`: fails closed unconditionally (defensive structural-contradiction check) —
      design.md Decision 3b case 2.
- [ ] 3.6 Fill-carrying `orderSignal` with `closeOrderAttempted` true and `orderSignal.kind ===
      "terminal_with_fill"`: branches on `closeSignal.kind` —
      `"terminal_with_fill"` → `terminal_after_fill`, **no aggregate consultation at all** (design.md
      Decision 3c — this is the specific fix verifying a same-side sibling's own aggregate contribution
      can never override this cycle's own two-order evidence chain);
      `"terminal_without_fill"` → `position_open` (same aggregate sanity gate as 3.4);
      anything else (`live_unfilled`, `live_with_fill`, `not_found`, `inconclusive`, or `closeSignal`
      undefined) → fails closed — design.md Decision 3b case 3.

## 4. Orchestration: conditional close-order query in the existing bounded-retry loop

- [ ] 4.1 Read `record.close_order_link_id` once, before the loop (immutable-once-set per Change 2) —
      design.md Decision 3e.
- [ ] 4.2 Within each attempt, after computing that attempt's `orderSignal`: if `orderSignal.kind` is
      `"live_with_fill"` or `"terminal_with_fill"` and `close_order_link_id` is non-null, issue a second
      `classifyOrderForRecovery` call scoped to `{ category, symbol, orderLinkId: close_order_link_id,
      limit: "1" }` for both the realtime and history payloads, producing `closeSignal` — design.md
      Decision 3e. No new retry loop; this call is covered by the existing attempt's bounded retry.
- [ ] 4.3 Pass `orderSignal`, `closeSignal`, `closeOrderAttempted`, `positionQuery`, `desiredEntry` into
      the rewritten `resolveRecoveryState` (Task 3).

## 5. Durable `first_fill_at_ms` capture-or-reuse, under the shared mutex (unchanged from the prior draft)

- [ ] 5.1 Add `mutex: KeyedMutex` to `EntryCycleRecoveryResolutionServiceDeps` — design.md Decision 2.
- [ ] 5.2 When the redesigned grid (Task 3) resolves a `position_open` outcome, acquire the pair's mutex
      lock (`correlationRecordKey(strategyInstanceId, tradeCycleId)`) narrowly around the capture-or-reuse
      step only — design.md Decision 2.
- [ ] 5.3 Under the lock: re-read the record fresh; if now durably closed, resolve the correct terminal
      result for that status instead of proceeding — design.md Decision 2.
- [ ] 5.4 Under the lock: reuse `record.first_fill_at_ms` if already non-null; otherwise call
      `resolveFirstAttributableFillAtMs` (imported unchanged from `packageConfirmation.ts`) and, on
      `"found"`, durably save `{ ...record, first_fill_at_ms: captured.firstFillAtMs, updated_at: new
      Date().toISOString() }` — mirroring `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s
      existing block exactly — design.md Decision 2.
- [ ] 5.5 On `"no_executions_found"` or `"ambiguous"` from the capture call, fail closed
      (`internalErrorResult()`) — design.md Decision 2.

## 6. Wiring

- [ ] 6.1 In `src/app/server.ts`, pass the existing shared `mutex` instance into
      `EntryCycleRecoveryResolutionService`'s construction — design.md Decision 2.

## 7. Spec delta

- [ ] 7.1 Rewrite the "Recovery resolution classifies the trade cycle into exactly one of four states..."
      requirement's body and scenarios per design.md Decision 3b — every scenario's aggregate dependency
      is re-specified (opposite-side sanity for the two zero-fill states, own-close-order disambiguation
      and same-side existence sanity for `position_open`/`terminal_after_fill`).
- [ ] 7.2 Add scenarios covering: `entry_order_live`/`terminal_without_fill` resolving despite a same-side
      sibling's aggregate contribution; `terminal_after_fill` resolving from own close-order evidence with
      no aggregate consultation, despite a same-side sibling's aggregate contribution; `position_open`
      resolving from a rejected close attempt; opposite-side contradiction remaining fail-closed for all
      four states; the close-order-inconclusive fail-closed case.
- [ ] 7.3 Add a new scenario to "Recovery resolution never causes an exchange side effect" clarifying that
      read-only exchange queries (including the close-order query) and ABI's own local durable write are
      not exchange side effects within the meaning of this requirement — design.md's prior-draft rationale
      (unchanged).

## 8. Tests (design.md "Required tests", full list — supersedes the prior draft's Task 6)

- [ ] 8.1 `average_entry_price`/`first_fill_at_ms` sourcing tests (own-order `avgPrice`; durable capture
      reuse/first-capture/failure/concurrency/racing-close scenarios) — unchanged from the prior draft.
- [ ] 8.2 A open + B `live_unfilled`, no close attempted → recovery(B) = `entry_order_live`, aggregate
      reporting A's open position on the matching side.
- [ ] 8.3 A open + B `terminal_without_fill`, no close attempted → recovery(B) = `terminal_without_fill`,
      aggregate reporting A's open position on the matching side.
- [ ] 8.4 A open + B has its own fill, no close attempted → recovery(B) = `position_open` with B's own
      `average_entry_price`/`first_fill_at_ms`, verified against a fixture where A's aggregate `avgPrice`
      deliberately differs from B's own order response.
- [ ] 8.5 Aggregate sibling activity alone never turns a B with zero own fill into `position_open` —
      verified for every non-fill-carrying `orderSignal.kind` combined with every aggregate state.
- [ ] 8.6 A open + B's own close order confirms a fill → recovery(B) = `terminal_after_fill`, with the
      aggregate still positively reporting A's open position throughout.
- [ ] 8.7 B's own close order durably recorded but still live/not found/inconclusive → recovery(B) fails
      closed, regardless of aggregate state.
- [ ] 8.8 B's own close order durably recorded and positively terminal with zero fill (rejected) →
      recovery(B) = `position_open`, sanity-checked against an existing same-side aggregate position.
- [ ] 8.9 Opposite-side contradiction remains fail-closed for `entry_order_live`/`terminal_without_fill`.
- [ ] 8.10 `position_open`'s existence sanity still fails closed when the aggregate cannot confirm a
      matching position at all (no position, or wrong side), despite positive own fill evidence.
- [ ] 8.11 Full regression of every existing `entryCycleRecoveryResolutionService.test.ts` scenario this
      redesign does not intentionally change: durably-closed-status fast path, legacy `pending_action`
      guard, every single-owner (`close_order_link_id === null`) combination.

## 9. Final verification (only once implementation is authorized — not part of this propose-only change)

- [ ] 9.1 `npm run typecheck` (or repo equivalent) clean.
- [ ] 9.2 Full test suite passes.
- [ ] 9.3 Build clean.
- [ ] 9.4 Diff review confirms no file outside this change's stated Impact was touched.
