## 1. Admission: correct classification + temporary production guard

- [ ] 1.1 In `EntryPackageApplicationService.createOrder()`, inside the existing
      `scopeMutex.withKeyLock(...)` callback, compute `findActiveRecordsForScope(category, symbol)`,
      filtered to exclude the requesting pair's own record — design.md Decision 1.
- [ ] 1.2 If any remaining (other-pair) active record has `desired_entry === null`, classify as
      `"corrupt"` — design.md Decision 1.
- [ ] 1.3 Otherwise classify as `"empty"` (no other active records), `"same_side"`, or `"opposite_side"`
      by comparing `desired_entry.side` — design.md Decision 1. This classification step is the real,
      permanent foundation; do not gate or simplify it.
- [ ] 1.4 Add the temporary production guard, clearly commented and naming this change and Change 8 by
      id: only `"empty"` claims; `"same_side"`, `"opposite_side"`, and `"corrupt"` all conflict — design.md
      Decision 1. This is the one block Change 8 removes to activate real same-side admission.

## 2. `findOwnerByScope()` / `byScope`: no implementation change, reclassify only

- [ ] 2.1 No code change. Add a doc comment at `findOwnerByScope()`'s definition noting it is no longer a
      valid primitive for ownership/admission decisions, kept only as a cheap non-authoritative existence
      check — design.md Decision 2 (unchanged from the prior draft).

## 3. Replay: side comparison replaces identity comparison

- [ ] 3.1 In `rebuildScopeIndexFromReplay()`, add a local (function-scoped, not persisted)
      `Map<string, "long" | "short">` tracking the side already seen per scope during this replay pass —
      design.md Decision 3 (unchanged from the prior draft).
- [ ] 3.2 An active record whose `desired_entry?.side` is `undefined` → readiness failure. An active
      record whose side disagrees with the side already seen for that scope → readiness failure
      ("mixed sides"). Otherwise record the side and continue. `byScope`'s own population is unchanged —
      design.md Decision 3.

## 4. Protection guard

- [ ] 4.1 In `ProtectionApplicationService.process()`, replace the `findOwnerByScope()`-based ownership
      re-verification block with `findActiveRecordsForScope(category, record.exchange_symbol)` —
      design.md Decision 4 (unchanged from the prior draft).
- [ ] 4.2 If the requested pair is not among the returned active records, fail closed with the existing
      `internalErrorResult()` — design.md Decision 4.
- [ ] 4.3 If more than one active record is returned, fail closed with the new
      `sharedScopeProtectionUnsupportedResult()`, before `determine()` and before any exchange call —
      design.md Decision 4. No guard/flag needed here beyond the check itself — this branch's inertness
      in production is a consequence of Task 1's admission guard, not something protection enforces.
- [ ] 4.4 Exactly one active record, matching the requested pair: fall through to the existing,
      byte-for-byte-unchanged `determine()` → already-satisfied short-circuit → write → read-back flow.

## 5. New error code

- [ ] 5.1 Add `"shared_scope_protection_unsupported"` to `PositionManagementErrorCode`
      (`src/domain/positionManagementApi.ts`) and a `sharedScopeProtectionUnsupportedResult()` helper
      (HTTP 422), following the exact `errorResult(422, code, message)` pattern
      `closeExecutionIncompleteResult()` already established — unchanged from the prior draft.

## 6. Spec deltas (this proposal's own artifacts, not implementation)

- [ ] 6.1 `position-scope-exclusivity/spec.md`: document the internal mechanism swap (single-pointer →
      full active-set, explicit self-exclusion) and the inert, synthetic-fixture-only side-aware replay
      relaxation, WITHOUT relaxing any requirement's production-observable outcome — the "at most one
      active trade cycle" invariant stays true in production until Change 8. Do not restate this
      capability's central invariant as "at most one side" — that restatement belongs to Change 8's own
      spec delta, once it is actually true.
- [ ] 6.2 `protection-execution/spec.md`: MODIFIED "The pair is classified before any exchange call"
      requirement, documenting the `findActiveRecordsForScope()`-based check and the
      `shared_scope_protection_unsupported` outcome as real, tested, but currently-unreachable-in-production
      behavior (mirrors Change 7's "production-инертен" framing).
- [ ] 6.3 `abi-position-management-api/spec.md`: MODIFIED closed error-code table, one new row, noted as
      currently unreachable in production for the same reason.

## 7. Tests (design.md "Required tests", full list)

- [ ] 7.1 Admission classification correctness (synthetic fixtures): empty / same-side / opposite-side /
      corrupt, all four outcomes distinguished.
- [ ] 7.2 Admission self-exclusion (synthetic): a requesting pair's own record is excluded from the
      "other" set even when a genuinely different same-side sibling is also active.
- [ ] 7.3 Admission temporary guard (end-to-end): two different pairs, same side, racing one scope —
      exactly one wins, matching today's existing behavior with **no adaptation** to the existing
      `entryPackageApplicationService.test.ts` scope-race tests.
- [ ] 7.4 Self-repeat regression (end-to-end, existing coverage) continues to pass unmodified.
- [ ] 7.5 Replay: two same-side active records for one scope (synthetic) → success, both active.
- [ ] 7.6 Replay: mixed-side active records for one scope → readiness failure.
- [ ] 7.7 Replay: an active record with no usable `desired_entry.side` → readiness failure.
- [ ] 7.8 Durable close of a synthetically-seeded owner does not affect a synthetically-seeded sibling's
      continued active ownership.
- [ ] 7.9 Protection with two synthetically-seeded active owners → `shared_scope_protection_unsupported`,
      zero exchange writes.
- [ ] 7.10 Protection with exactly one active owner (matching pair) → full regression, unchanged.
- [ ] 7.11 Protection where the requested pair is not among active records → existing `internal_error`.
- [ ] 7.12 Full regression of `protectionApplicationService.test.ts`'s existing single-owner scenarios.
- [ ] 7.13 Full regression of `entryPackageApplicationService.test.ts` in its entirety — explicitly
      including confirmation that no existing test needed adaptation (see Task 7.3).

**Explicitly deferred to Change 8, not written here** (design.md "Deferred to Change 8"): removing the
Task 1.4 guard; any end-to-end test asserting two same-side `service.apply()` calls both durably succeed
and coexist; any end-to-end (non-synthetic) exercise of the protection guard or replay relaxation.

## 8. Final verification (only once implementation is authorized — not part of this propose-only change)

- [ ] 8.1 `npm run typecheck` clean.
- [ ] 8.2 Full test suite passes.
- [ ] 8.3 Build clean.
- [ ] 8.4 Diff review confirms no file outside this change's stated Impact was touched, and specifically
      that `src/exchange/bybitOrderMapper.ts` (entry-package's own TP/SL attachment) was not touched.
