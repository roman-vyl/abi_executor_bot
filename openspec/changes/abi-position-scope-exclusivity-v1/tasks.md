## 1. Shared primitives

- [x] 1.1 Add `src/domain/positionScope.ts`: `PositionScope` type (`category`, `symbol`) and
      `positionScopeKey(category, symbol)`. Document account and `positionIdx = 0` as implicit V1
      constants, not key dimensions (design.md Decision 1).
- [x] 1.2 Add `isDurablyClosedEntryPackageStatus(status)` to
      `src/correlation/entryPackageExecutionRecord.ts` (design.md Decision 10). Update
      `OpenPositionResolutionService.classifyStatus()`'s `durably_closed` branch to call it instead
      of spelling out `{"absent", "terminal_unfilled"}` independently. Run
      `test/unit/openPositionResolutionService.test.ts` unchanged to confirm no behavior change.

## 2. Ownership index on the existing correlation repository

- [x] 2.1 Add `byScope: Map<string, EntryPackageExecutionRecord>` and
      `findOwnerByScope(category, symbol)` to `EntryPackageCorrelationRepository`.
- [x] 2.2 Extend `indexRecord()`'s **live-write path only** (i.e. as called from `save()`) with the
      claim/release logic from design.md Decision 2, using `isDurablyClosedEntryPackageStatus` from
      1.2: claim when the record has a real `exchange_category` and a non-durably-closed `status`;
      release only when the currently-indexed owner for that scope is this same pair and the record
      is now durably closed. Do **not** wire this same per-line step into `replay()` — see 2.3.
- [x] 2.3 Implement `replay()`'s scope-ownership reconstruction as the two explicit phases from
      design.md Decision 8, decoupled from 2.2's live path:
      - Phase 1 (unchanged from today): replay every valid line in order, updating
        `byCompositeKey`/`byOrderLinkId`/`byOrderId` exactly as today; do not touch `byScope` in this
        phase.
      - Phase 2 (new, runs once after Phase 1 completes): clear `byScope`, then iterate
        `byCompositeKey.values()` — each pair's single latest record — and for every record that is
        not durably closed, attempt to claim its scope; if the scope is already claimed by a
        *different* pair's latest record, fail replay closed (`{ok: false, reason: ...}`) the same
        way existing structural/schema corruption already does, instead of silently overwriting the
        existing claim.
      - Verify against the design.md Decision 8 counter-example directly in a test: pair A `applied`
        BTC (line 1), pair B `pending_create` BTC (line 2), pair A `absent` BTC (line 3) — replay
        must succeed with pair B as BTC's sole owner, never failing on account of line 2 alone.
- [x] 2.4 Unit tests for 2.1-2.3 in isolation (no HTTP layer), mirroring
      `test/unit/entryPackageCorrelationRepository.test.ts`'s existing style: live claim, live
      release, self-repeat non-conflict, the Decision 8 counter-example (intermediate line is not a
      false-positive conflict), a genuine final-state conflict across two pairs' latest records, and
      sequential reuse across replay is not a conflict.

## 3. Scope-level serialization

- [x] 3.1 Construct a second `KeyedMutex` instance (`scopeMutex`) in `app/server.ts`, alongside the
      existing pair-level `mutex`, and add it to `EntryPackageApplicationServiceDeps`.
- [x] 3.2 Document the lock-ordering invariant (pair-lock outer, scope-lock inner, never reversed;
      scope-lock never held across an exchange call or a confirmation retry) at the call site in
      `EntryPackageApplicationService`, matching design.md Decision 5.

## 4. Acquisition guard in `createOrder()`

- [x] 4.1 In `EntryPackageApplicationService.createOrder()`, wrap the existing ownership
      decision-and-claim step in `scopeMutex.withKeyLock(positionScopeKey(identity), ...)`
      immediately preceding the existing `correlationRepository.save(provisional)` call: look up
      `findOwnerByScope`; if the owner is a different pair and not durably closed, return the
      existing `internalErrorResult()` without writing the provisional record and without any
      exchange call; otherwise proceed with the existing save/execute/confirm flow unchanged
      (design.md Decisions 3, 6, 9).
- [x] 4.2 Confirm no other call site needs the guard: `replaceAmend`, `replaceCancelAndCreate`'s
      cancel half, `cancelLiveOrder`, `metadataOnlyUpdate`'s revalidation branch, and
      `repeatPutRevalidate` all reuse an existing binding's stored `exchange_symbol`/
      `exchange_category` and never call the resolver — verify this remains true and add a comment
      at each site (or one shared comment on the resolver call in `createOrder()`) stating why the
      guard is not duplicated there.

## 5. Concurrency, crash, and replay test suite

- [x] 5.1 Two different pairs, same resolved scope, concurrent first-time `apply()` — exactly one
      reaches `bybit.createOrderCalls`, the other returns a safe error with zero exchange calls and
      no durable claim (extends the pattern in
      `test/unit/entryPackageApplicationService.test.ts:517-559`).
- [x] 5.2 Two different pairs, different resolved scopes, concurrent `apply()` — both succeed, and
      neither pair's scope acquisition is made to wait on the other's scope lock (the pre-existing
      single-writer correlation-file write queue is unaffected and out of scope for this assertion).
- [x] 5.3 Repeat/retry from the current owner (existing regression tests around
      `entryPackageApplicationService.test.ts:26-49` and the crash-recovery test at `:561-579`) still
      pass unchanged with the guard in place.
- [x] 5.4 Pair A reaches `absent` (explicit cancel confirmed) or `terminal_unfilled`
      (exchange-confirmed terminal-without-fill) — a different pair B can then successfully acquire
      the same scope.
- [x] 5.5 Restart test: persist a record with a held status (`pending_create` / `applied` /
      `unknown`) for pair A on a scope via a real `EntryPackageCorrelationRepository` instance,
      construct a fresh repository instance and `replay()` it, then confirm pair B's `apply()` on the
      same scope fails closed with zero exchange calls.
- [x] 5.6 Restart test: persist an `absent`/`terminal_unfilled` record for pair A on a scope, replay
      into a fresh repository, confirm pair B can acquire that scope after restart.
- [x] 5.7 Replay conflict test: construct a JSONL log with two different pairs' records both
      non-durably-closed for the same scope; `replay()` returns `{ok: false}`. Covered at the
      repository level (`entryPackageCorrelationRepository.test.ts`), not duplicated at the
      application-service level: `EntryPackageReadiness.markNotReady()` is a direct, untested-in-
      isolation pass-through of `replay()`'s own result in `app/server.ts`, so a repository-level
      `{ok: false}` assertion already proves the readiness gate would trip.
- [x] 5.8 Crash-between-claim-and-exchange-call test: simulate a thrown exception from the fake
      Bybit adapter's `createOrder` after the provisional claim write (existing pattern at
      `entryPackageApplicationService.test.ts:561-579`); confirm the scope stays held (a third pair
      cannot acquire it) while the original owner's own retry can still proceed.
- [x] 5.9 Liveness/deadlock smoke test: fire a mix of concurrent requests across same-scope and
      different-scope pairs and assert the batch completes (no hang), validating the lock-ordering
      invariant in practice.

## 6. Verification

- [x] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [x] 6.2 Review the diff to confirm: no public HTTP DTO, route, or error-code change; no new
      `EntryPackageExecutionRecord` field; no new durable file; existing pair-level `KeyedMutex`
      behavior and its existing tests are unaffected.

## Deferred follow-up (not this change's scope)

Depends on this change landing first, or belongs to a separate future change per `proposal.md`'s
non-goals — listed here only so it is not mistaken for done:

- Releasing a scope after it has held a real filled position (Runtime-commanded close, take-profit,
  stop-loss, exchange-side manual close, liquidation/ADL) — a future position-management capability,
  per design.md Decision 7.
- Wiring `PUT .../protection` and `DELETE .../open-position` (`abi-position-management-api`) to
  actually resolve and act on a pair's owned scope — those routes remain transport-only stubs after
  this change.
- Any shared ownership of one physical scope by multiple trade cycles / virtual position ledger
  (GitHub Issue #3).

Reviewed and decided against for this change (not open, listed for traceability — design.md Review
Resolutions):

- A distinguishable public error code for a scope-acquisition conflict. Resolved: reuse
  `internal_error`.
- A dedicated `PositionScopeGuard` class. Resolved: not needed at this size.
- An explicit `accountId` field on `PositionScope` now. Resolved: out of scope while one process
  means one account.
- A non-locked early ownership check before position sizing. Resolved: minor optimization, not
  worth the added code path at V1.
