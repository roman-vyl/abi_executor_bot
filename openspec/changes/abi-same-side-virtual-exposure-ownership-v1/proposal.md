## Why

`docs/virtual-exposure-ownership-delivery-plan.md` names this change, Change 5, as the activation step
of the program: the only change in the first five that actually lets more than one trade cycle hold a
physical Bybit position scope in production. Changes 1-4 (all applied/archived) already made
close-execution, open-position-resolution, and entry-cycle-recovery-resolution own-cycle-evidence-primary
and multi-owner-safe, verified against **synthetic** multi-owner fixtures seeded directly into the
correlation repository — but the one and only place multi-owner is actually *created* — the claim check in
`EntryPackageApplicationService.createOrder()` — has never been touched, and still enforces the original
`position-scope-exclusivity` invariant ("at most one pair owns a scope") unconditionally.

A short architecture-review pass against the actual, applied code (not the master plan's original v3-era
text) found the master plan's own description of this change's claim-side work understated its scope, and
identified two real correctness gaps that must be closed as part of this change, not left as follow-up:

1. **The claim check's ownership primitive, `EntryPackageCorrelationRepository.findOwnerByScope()`, is a
   single-pointer index** (`entryPackageCorrelationRepository.ts:31,148-150`) — `byScope.set(scope,
   record)` on every non-durably-closed write means it remembers only whichever pair wrote to a scope
   *most recently*, never the full set of active owners. `close-execution` (Change 2) already discovered
   this and switched to `findActiveRecordsForScope()` instead, with a comment explaining exactly why
   (`closeApplicationService.ts:124-129`). The claim check and `ProtectionApplicationService`'s ownership
   re-verification (`protectionApplicationService.ts:93-102`) are the two remaining call sites still on
   the single-pointer primitive, and both must move to the same, already-established fix Change 2 already
   proved — not a new mechanism.
2. **Left unfixed, the single-pointer primitive produces a real self-conflict bug once a second same-side
   pair exists**: if pair B joins a scope after pair A (so `byScope` now points to B, since it always
   reflects the *last* write), a later retry/new-generation `createOrder()` call for pair A itself
   (`repeatPutRevalidate` → `createOrder()` when `order_link_id === null`) would read `owner = B`,
   `isOwnedBySamePair(B, A) === false`, and reject A's own legitimate retry as a scope conflict — even
   though A is, and remains, one of the scope's own active owners. This is not a hypothetical
   multi-owner-era problem; it is a direct, mechanical consequence of the primitive `findOwnerByScope`
   already is, and it must be fixed by this change's own admission logic, not discovered later as a field
   incident.

This proposal implements exactly the activation step the master plan names, corrected by these two
findings: replace the ownership decision in both the claim check and the protection guard with
`findActiveRecordsForScope()` (already exists, already proven for this exact purpose by Change 2), change
the invariant from "at most one owner" to "at most one **side** active at a time, any number of same-side
owners," and add the protection safety companion the master plan already calls a mandatory, inseparable
part of this same change (a shared-scope scope must never let one owner's `PUT .../protection` silently
manage another owner's exposure).

## What Changes

- **Admission (`EntryPackageApplicationService.createOrder()`, inside the existing
  `scopeMutex.withKeyLock(...)` critical section)**: the ownership decision is rewritten from
  `findOwnerByScope()`-based single-owner exclusivity to `findActiveRecordsForScope()`-based side
  compatibility. For the requested pair: read every active record for the scope, exclude the requested
  pair's own record if present (self-claim/retry is never a conflict against itself — this is what fixes
  the self-conflict bug above), then: no other active records → claim; every remaining active record
  shares the requested `desired_entry.side` → join; at least one has the opposite side → conflict, before
  any durable write or exchange call (unchanged fail-before-any-write discipline). An active record with a
  `null` `desired_entry` is a contradiction this capability has no basis to resolve — the attempt fails
  closed rather than being silently excluded or guessed through. The mutex, the "check and durable write in
  one critical section" structure, and the fail-before-exchange-call ordering are all unchanged.
- **`findOwnerByScope()`/`byScope`**: retained, unchanged in implementation, but reclassified — after this
  change it is no longer a valid primitive for any ownership/admission decision (it cannot represent more
  than one owner). It remains available as a cheap, non-authoritative existence check only.
  `findActiveRecordsForScope()` is the one primitive both admission and protection use going forward.
- **Replay (`rebuildScopeIndexFromReplay()`)**: the conflict rule changes from "any second active record on
  a scope" to "any second active record on a scope whose `desired_entry.side` differs from the first
  active record's side already seen for that scope." This is a local, per-replay-pass comparison (a
  transient side-tracking value scoped to the function, discarded after replay) — no new persistent index.
  An active record with no usable `desired_entry.side` fails readiness closed, the same treatment the
  capability's existing spec already gives an active record with no usable exchange binding.
- **Protection guard (`ProtectionApplicationService`)**: the existing `findOwnerByScope`-based ownership
  re-verification is replaced with `findActiveRecordsForScope()`-based verification: the requested pair
  SHALL be among the scope's active records (fails closed otherwise, same as today's "ownership mismatch"
  outcome); if more than one active record shares the scope, the request fails closed with a new public
  error code, `shared_scope_protection_unsupported`, before `open-position-resolution`'s determination and
  before any exchange call. Exactly one active owner, and it is the requested pair: the existing
  single-owner flow (live-position determination, already-satisfied short-circuit, write, read-back) is
  completely unchanged.
- **Release**: no new mechanism. `findActiveRecordsForScope()` already excludes durably closed records
  (`isDurablyClosedEntryPackageStatus`), and `close-execution` (Change 2) already durably terminalizes only
  the closing cycle's own record. This was already true before this change; this proposal does not modify
  either mechanism.
- **`position-scope-exclusivity` capability**: its central invariant is rewritten from "at most one active
  trade cycle" to "at most one active side," its readiness-conflict requirement is rewritten from "any two
  active owners" to "mixed active sides," and its explicit "V1 scope excludes shared same-symbol exposure"
  disclosure is replaced — same-side sharing is no longer deferred, only opposite-side coexistence remains
  explicitly out of scope. The capability's identity/id is deliberately not renamed by this proposal (see
  `design.md`'s Non-Goals) — only its requirement text changes, the same pattern Change 3 already used for
  `open-position-resolution` when its own central semantics changed substantially.
- **`protection-execution` capability**: its "pair is classified before any exchange call" requirement is
  rewritten to describe the new `findActiveRecordsForScope()`-based check and the new
  `shared_scope_protection_unsupported` outcome.
- **`abi-position-management-api`**: the closed error-code table gains one new row,
  `422 | shared_scope_protection_unsupported | protection only`.

## Capabilities

### Modified Capabilities

- `position-scope-exclusivity`: central invariant, readiness-conflict detection, and V1-scope-exclusion
  disclosure all rewritten for same-side multi-owner. Everything else (atomic acquisition, durable-state
  derivation with no new store, self-repeat-never-conflicts, no-exchange-write-before-durable-claim,
  release conditions, restart reconstruction) is unchanged in substance — only restated where "one owner"
  language needed to become "one side."
- `protection-execution`: the pre-write classification requirement gains the shared-scope guard; every
  other requirement (live-position delegation to `open-position-resolution`, the combined-legs write,
  execution boundaries, read-back verification) is unchanged.
- `abi-position-management-api`: one new closed-vocabulary error code, no route/DTO/schema change.

## Impact

- `src/services/entryPackage/entryPackageApplicationService.ts`: the `scopeMutex.withKeyLock(...)`
  callback's internal ownership decision is rewritten per "What Changes" above. No change to the mutex
  structure, the provisional-record shape, or anything outside that one callback's decision logic.
- `src/correlation/entryPackageCorrelationRepository.ts`: `rebuildScopeIndexFromReplay()`'s conflict rule
  changes from identity-based to side-based, using a local (non-persisted) per-scope side map for the
  duration of one replay pass. `findOwnerByScope()`, `byScope`, and `applyScopeClaimOnWrite()` are
  **not** modified — their existing single-pointer behavior is retained as-is (see "What Changes"'
  reclassification note). `findActiveRecordsForScope()` is **not** modified — it is reused exactly as
  Change 2 already built it.
- `src/services/protection/protectionApplicationService.ts`: the ownership re-verification block
  (lines 93-102 today) is rewritten to use `findActiveRecordsForScope()` and to return the new guard
  error before `determine()` is ever called for a shared scope. No other part of this service changes —
  single-owner behavior (the live-position gate, the already-satisfied short-circuit, the write, and the
  read-back) is untouched.
- `src/domain/positionManagementApi.ts`: `PositionManagementErrorCode` gains
  `"shared_scope_protection_unsupported"`; a new `sharedScopeProtectionUnsupportedResult()` (or
  equivalently named) helper is added alongside the existing `errorResult(422, code, message)` pattern
  `close_execution_incomplete` already established.
- `openspec/specs/position-scope-exclusivity/spec.md`,
  `openspec/specs/protection-execution/spec.md`,
  `openspec/specs/abi-position-management-api/spec.md`: modified per "Capabilities" above.
- `docs/openapi/abi-position-management-api-v1.json`: gains the new error code in its documented
  vocabulary; no schema/route change (prose/enum only, matching how `close_execution_incomplete` was
  added).
- Not touched: `src/services/close/closeApplicationService.ts`,
  `src/services/openPosition/openPositionResolutionService.ts`,
  `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts` — Changes 2/3/4 already made
  these owner-aware against synthetic fixtures; this change is what makes their multi-owner branches
  production-reachable for the first time, without changing their own logic.
- No new store, index, mutex, or registry anywhere in this change.
- Production behavior for a scope's only owner (today's only production-reachable state, and the only
  state most scopes will ever be in even after this change ships): byte-for-byte unchanged. The only
  newly reachable branches are: a second same-side claim succeeding instead of being rejected, and a
  shared-scope `PUT .../protection` returning the new guard error instead of proceeding.
