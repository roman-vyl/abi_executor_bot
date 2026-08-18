## 1. Admission: same-side join replaces single-owner exclusivity

- [ ] 1.1 In `EntryPackageApplicationService.createOrder()`, inside the existing
      `scopeMutex.withKeyLock(...)` callback, replace the `findOwnerByScope()`-based ownership check with
      `findActiveRecordsForScope(category, symbol)`, filtered to exclude the requesting pair's own record
      — design.md Decision 1.
- [ ] 1.2 If any remaining (other-pair) active record has `desired_entry === null`, fail the claim
      (same outcome as a conflict — see Task 3) — design.md Decision 1.
- [ ] 1.3 If any remaining active record's `desired_entry.side` differs from the requested command's side,
      fail the claim as a conflict. Otherwise (empty, or all matching side) durably save the provisional
      record and return "claimed" — design.md Decision 1. The critical section, the mutex, and the
      fail-before-any-durable-write-or-exchange-call ordering are unchanged.

## 2. `findOwnerByScope()` / `byScope`: no implementation change, reclassify only

- [ ] 2.1 No code change to `findOwnerByScope()`, `byScope`, or `applyScopeClaimOnWrite()` — design.md
      Decision 2. Add a doc comment at `findOwnerByScope()`'s definition noting it is no longer a valid
      primitive for ownership/admission decisions after this change, kept only as a cheap
      non-authoritative existence check, with `findActiveRecordsForScope()` named as the replacement for
      any future decision-making use.

## 3. Replay: side comparison replaces identity comparison

- [ ] 3.1 In `rebuildScopeIndexFromReplay()`, add a local (function-scoped, not persisted)
      `Map<string, "long" | "short">` tracking the side already seen per scope during this replay pass —
      design.md Decision 3.
- [ ] 3.2 Replace the existing "any second active record for a scope → conflict" check with: an active
      record whose `desired_entry?.side` is `undefined` → readiness failure (new reason string, distinct
      from the existing missing-exchange-binding failure); an active record whose side disagrees with the
      side already seen for that scope → readiness failure ("mixed sides"); otherwise record the side and
      continue. `byScope`'s own population (last record in iteration order) is unchanged — design.md
      Decision 3.

## 4. Protection guard

- [ ] 4.1 In `ProtectionApplicationService.process()`, replace the `findOwnerByScope()`-based ownership
      re-verification block with `findActiveRecordsForScope(category, record.exchange_symbol)` —
      design.md Decision 4.
- [ ] 4.2 If the requested pair is not among the returned active records, fail closed with the existing
      `internalErrorResult()` (unchanged outcome/code from today's "ownership mismatch") — design.md
      Decision 4.
- [ ] 4.3 If more than one active record is returned, fail closed with the new
      `sharedScopeProtectionUnsupportedResult()`, placed before `determine()` is called and before any
      exchange call — design.md Decision 4.
- [ ] 4.4 Exactly one active record, matching the requested pair: fall through to the existing,
      byte-for-byte-unchanged `determine()` → already-satisfied short-circuit → write → read-back flow —
      design.md Decision 4.

## 5. New error code

- [ ] 5.1 Add `"shared_scope_protection_unsupported"` to `PositionManagementErrorCode`
      (`src/domain/positionManagementApi.ts`) and a `sharedScopeProtectionUnsupportedResult()` helper
      (HTTP 422), following the exact `errorResult(422, code, message)` pattern
      `closeExecutionIncompleteResult()` already established — design.md Decision 4.

## 6. Spec deltas (this proposal's own artifacts, not implementation)

- [ ] 6.1 `position-scope-exclusivity/spec.md`: MODIFIED central invariant ("at most one side," not "at
      most one pair"), MODIFIED readiness-conflict requirement (mixed-side, not any-second-owner),
      MODIFIED V1-scope-exclusion disclosure (same-side sharing no longer deferred; opposite-side
      coexistence remains explicitly out of scope). Every other requirement (atomic acquisition, no new
      store, self-repeat-never-conflicts, no-write-before-durable-claim, release conditions, restart
      reconstruction, no public HTTP contract change) is unchanged.
- [ ] 6.2 `protection-execution/spec.md`: MODIFIED "The pair is classified before any exchange call"
      requirement, describing the `findActiveRecordsForScope()`-based check and the new
      `shared_scope_protection_unsupported` outcome. Every other requirement unchanged.
- [ ] 6.3 `abi-position-management-api/spec.md`: MODIFIED closed error-code table, one new row.

## 7. Tests (design.md "Required tests", full list)

- [ ] 7.1 Two same-side pairs on one scope: both claims succeed, both remain active.
- [ ] 7.2 Self-claim/retry after a same-side sibling becomes the `byScope` pointer does not false-conflict
      (the specific architecture-review bug).
- [ ] 7.3 Opposite-side conflict fails closed before any durable write or exchange call; existing owner
      unaffected.
- [ ] 7.4 An active record with `desired_entry: null` among a scope's active records fails the requesting
      pair's claim closed (asserted separately from the opposite-side case).
- [ ] 7.5 Replay: two same-side active records for one scope → success, both reconstructed active.
- [ ] 7.6 Replay: mixed-side active records for one scope → readiness failure.
- [ ] 7.7 Replay: an active record with no usable `desired_entry.side` → readiness failure.
- [ ] 7.8 Durable close of one owner does not affect a same-scope sibling's continued active ownership.
- [ ] 7.9 Protection with two active owners → `shared_scope_protection_unsupported`, zero exchange writes.
- [ ] 7.10 Protection with exactly one active owner (matching pair) → full regression, unchanged.
- [ ] 7.11 Protection where the requested pair is not among active records → existing `internal_error`,
      distinguishable in the implementation from the shared-scope guard even though both currently map to
      different codes now.
- [ ] 7.12 Adapt `entryPackageApplicationService.test.ts`'s existing scope-race tests
      (lines ~827-946): give the non-owning pair in each conflict test an opposite side (their current
      implicit same-side default would otherwise now legitimately succeed instead of conflict), and add a
      new sibling test per adapted case asserting the same-side join now succeeds. Tests unrelated to
      conflict (different-scope independence, restart/release) are not adapted.
- [ ] 7.13 Full regression of `protectionApplicationService.test.ts`'s existing single-owner scenarios.

## 8. Final verification (only once implementation is authorized — not part of this propose-only change)

- [ ] 8.1 `npm run typecheck` clean.
- [ ] 8.2 Full test suite passes.
- [ ] 8.3 Build clean.
- [ ] 8.4 Diff review confirms no file outside this change's stated Impact was touched.
