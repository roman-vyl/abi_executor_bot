## 1. `OrderRecoverySignal`: carry the own-order query's average price

- [ ] 1.1 Extend `OrderRecoverySignal`'s `live_with_fill` and `terminal_with_fill` variants with
      `averageEntryPrice: string`, in `entryCycleRecoveryResolutionService.ts` — design.md Decision 1.
- [ ] 1.2 In `classifyOrderForRecovery`, populate `averageEntryPrice` from whichever query (realtime or
      history) positively found the order in a fill-carrying state, using that response's already-decoded
      `BybitOrderView.avgPrice` — no new exchange call — design.md Decision 1.

## 2. `resolveRecoveryState`: source `position_open`'s facts from own-cycle evidence

- [ ] 2.1 `resolveRecoveryState`'s `position_open` outcome sources `averageEntryPrice` from the order
      signal's new field instead of `row.avgPrice` — design.md Decision 1.
- [ ] 2.2 An empty `averageEntryPrice` on a fill-carrying signal (Bybit's own valid-but-empty `avgPrice`
      case) is treated as unresolvable for `position_open` and fails closed, mirroring Change 3's "a fill
      with no usable average price fails closed" — design.md Decision 1.
- [ ] 2.3 `resolveRecoveryState`'s `position_open` outcome no longer reads `row.openTime` for
      `firstFillAtMs` — the pure function returns enough information for the caller to perform the
      durable-capture-or-reuse step (see Task 3), not a computed value itself — design.md Decision 2/3.
- [ ] 2.4 Every other state and every existing fail-closed combination in `resolveRecoveryState` is left
      unchanged — design.md Decision 3.

## 3. Durable `first_fill_at_ms` capture-or-reuse, under the shared mutex

- [ ] 3.1 Add `mutex: KeyedMutex` to `EntryCycleRecoveryResolutionServiceDeps` — design.md Decision 2.
- [ ] 3.2 When `process()` (or its bounded-retry loop) receives a `position_open`-shaped resolution from
      `resolveRecoveryState`, acquire the pair's mutex lock (`correlationRecordKey(strategyInstanceId,
      tradeCycleId)`) narrowly around the capture-or-reuse step only — not around the outer unlocked
      dual-query loop — design.md Decision 2.
- [ ] 3.3 Under the lock: re-read the record fresh via `correlationRepository.get(...)`; if it is now
      durably closed (a concurrent close raced ahead), resolve the correct terminal result for that status
      instead of proceeding — design.md Decision 2.
- [ ] 3.4 Under the lock: if the freshly re-read record's `first_fill_at_ms` is already non-null, reuse it
      with no exchange call. Otherwise call `resolveFirstAttributableFillAtMs` (imported unchanged from
      `packageConfirmation.ts`) and, on `"found"`, durably save `{ ...record, first_fill_at_ms:
      captured.firstFillAtMs, updated_at: new Date().toISOString() }` — mirroring
      `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing block exactly, including its
      handling of a durable-write failure (log/ignore, do not convert a truthful in-moment determination
      into an error response) — design.md Decision 2.
- [ ] 3.5 On `"no_executions_found"` or `"ambiguous"` from the capture call, fail closed
      (`internalErrorResult()`) — never fabricate or omit `first_fill_at_ms` — design.md Decision 2.

## 4. Wiring

- [ ] 4.1 In `src/app/server.ts`, pass the existing shared `mutex` instance into
      `EntryCycleRecoveryResolutionService`'s construction — design.md Decision 2.

## 5. Spec delta

- [ ] 5.1 Modify the `position_open` scenario under "Recovery resolution classifies the trade cycle into
      exactly one of four states..." to state the own-order/durable-capture sourcing, replacing the
      aggregate-row sourcing it currently implies — design.md Decisions 1/2.
- [ ] 5.2 Add a new scenario to "Recovery resolution never causes an exchange side effect" clarifying that
      read-only exchange queries (including `/v5/execution/list`) and ABI's own local durable write are not
      exchange side effects within the meaning of this requirement — design.md Decision 4.

## 6. Tests (design.md "Required tests", full list)

- [ ] 6.1 `position_open`'s `average_entry_price` matches the own-order query's `avgPrice`, with a fixture
      where own-order and aggregate `avgPrice` deliberately differ.
- [ ] 6.2 Already-durable `first_fill_at_ms` is reused with zero `getExecutionList` calls.
- [ ] 6.3 Not-yet-durable `first_fill_at_ms` is captured once, durably saved, and reused by a subsequent
      call for the same pair with no further capture call.
- [ ] 6.4 Capture failure (`no_executions_found` / `ambiguous`) → `internal_error`.
- [ ] 6.5 Fill-carrying order signal with empty `avgPrice` → `internal_error`.
- [ ] 6.6 Concurrent `GET .../recovery-state` and `GET .../open-position` for the same pair, both racing to
      capture `first_fill_at_ms` for the first time, are serialized by the shared mutex and agree on the
      single durably-written value.
- [ ] 6.7 A concurrent close durably closing the pair between recovery's unlocked resolution and its locked
      capture step is detected by the locked re-read and resolves the correct terminal state, not a stale
      `position_open`.
- [ ] 6.8 Full regression of existing `entryCycleRecoveryResolutionService.test.ts`: `entry_order_live`,
      `terminal_without_fill`, `terminal_after_fill`, every fail-closed combination, the
      durably-closed-status fast path, and the legacy `pending_action` guard — unchanged.
- [ ] 6.9 Multi-owner synthetic fixtures: cycle B sharing a scope with cycle A never reports A's fill facts
      as its own.

## 7. Final verification (only once implementation is authorized — not part of this propose-only change)

- [ ] 7.1 `npm run typecheck` (or repo equivalent) clean.
- [ ] 7.2 Full test suite passes.
- [ ] 7.3 Build clean.
- [ ] 7.4 Diff review confirms no file outside this change's stated Impact was touched.
