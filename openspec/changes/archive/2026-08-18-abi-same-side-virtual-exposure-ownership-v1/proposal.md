## Why

**This proposal is corrected a second time, before any implementation was written, after a new safety
blocker was found.** The first draft of this proposal treated Change 5 as the program's activation step —
the change that lets a second same-side trade cycle actually join a physical scope in production. That
premise is retracted.

`PUT .../entry-package`'s own entry-order creation already attaches **position-level** protection at
create time: `mapEntryPackageToBybit()` (`bybitOrderMapper.ts:107-129`) sends every entry order with
`tpslMode: "Full"`, `stopLoss: input.initialStopPrice`, `takeProfit: input.initialTakePrice`. This is not
`PUT .../protection`'s concern alone — `/v5/order/create`'s own `tpslMode: "Full"` write sets the **whole
physical position's** stop-loss/take-profit the moment the order is placed, exactly the same shared,
position-level mechanism `ProtectionApplicationService`'s existing guard (this proposal's own prior draft)
was designed to protect. If two same-side owners were actually admitted onto one scope today, the
**second** owner's own entry-order creation would silently overwrite the **first** owner's protection the
instant Bybit accepted it — before `PUT .../protection` is ever involved, before any of Changes 6-8 exist
to prevent it. A `PUT .../protection`-only guard is not sufficient to make same-side sharing safe; the
unsafe write happens inside entry-package creation itself.

This means same-side admission cannot be safely activated in production until the pair-owned protection
redesign (Changes 6-8) has actually replaced position-level `tpslMode: "Full"` writes with per-cycle
reduce-only conditional orders — for *both* the dedicated protection endpoint and entry-package's own
attached TP/SL. Changes 6-8 already exist for exactly this purpose; this proposal does not attempt to
solve it early, does not touch entry-package's TP/SL behavior, and does not introduce a `tpslMode:
"Partial"` workaround (rejected as an early, narrow fix to a problem the program already has a complete,
scoped answer for later).

**Change 5's role is corrected to preparation/foundation, matching the same pattern Change 1 and Change 6
already use elsewhere in this program**: build and prove the ownership mechanics — correct
multi-owner-representation, correct replay reconstruction, a real protection guard — entirely against
synthetic multi-owner fixtures, while a temporary, explicitly-labeled guard keeps real production
admission exactly as exclusive as it is today. The **only** activation point for real same-side coexistence
in this program is now Change 8, once pair-owned protection has actually shipped.

The rest of this proposal's original motivation is unchanged and still applies to the *foundation* work: a
short architecture-review pass against the actually-applied Changes 1-4 found two real correctness gaps in
`findOwnerByScope()`, the single-pointer primitive the claim check and the protection guard both still use
— see "What Changes" below. Fixing both now, as foundation work, is what makes Change 8's eventual
activation a small, safe "remove one guard" change instead of a change that has to discover and fix these
same gaps under production pressure.

## What Changes

- **Admission (`EntryPackageApplicationService.createOrder()`, inside the existing
  `scopeMutex.withKeyLock(...)` critical section)**: the ownership decision is rewritten from
  `findOwnerByScope()`-based single-owner exclusivity to a `findActiveRecordsForScope()`-based
  classification, split into two layers:
  - A pure classification step (excludes the requesting pair's own active record first, then compares
    the remaining active records' `desired_entry.side` against the requested side) that can tell "no other
    owner," "other owner(s), same side," "other owner(s), opposite side," and "other owner has no usable
    `desired_entry`" apart. This is the real, correct, fully-tested foundation Change 8 will build on.
  - **A temporary production guard, added by this same change and explicitly labeled for removal by
    Change 8**: only "no other owner" is allowed to claim. "Other owner(s), same side" is, for now, still
    treated as a conflict — identically to how it is treated today — specifically because entry-package's
    own attached `tpslMode: "Full"` write is not yet safe to share (see "Why"). Opposite-side and
    corrupt-record cases were already conflicts and remain conflicts.
  - Excluding the requesting pair's own record before this comparison also fixes a real bug the
    architecture review found in the single-pointer primitive: `findOwnerByScope()`'s `byScope` index
    remembers only the most recent writer for a scope, so once any second owner could ever legitimately
    exist, a pair's own retry could read a *different* pair as "the owner" and incorrectly self-conflict.
    Excluding self first prevents this by construction — see `design.md` Decision 1 for why this fix is
    real and worth shipping now even though its triggering precondition (a second owner existing at all)
    cannot yet occur in production under the guard above.
- **`findOwnerByScope()`/`byScope`**: unchanged in implementation, reclassified as a legacy/convenience
  primitive no longer valid for ownership/admission decisions. Unchanged from the prior draft.
- **Replay (`rebuildScopeIndexFromReplay()`)**: the conflict rule is relaxed from "any second active
  record on a scope" to "any second active record whose side differs from the first active record's side
  already seen for that scope" — implemented now, fully tested against synthetic multi-owner fixtures
  seeded directly into the repository (the same testing pattern Changes 1-4 already used before their own
  consumers were production-reachable). This relaxation is naturally inert in production today: the
  admission guard above never lets a real second same-side owner exist, so replay can never actually
  encounter that state from genuine production writes — it only becomes reachable once Change 8 removes
  the admission guard, at which point replay is already correct and needs no further change. Mixed-side
  active records remain a hard readiness failure, unchanged.
- **Protection guard (`ProtectionApplicationService`)**: the existing `findOwnerByScope`-based ownership
  re-verification is replaced with `findActiveRecordsForScope()`-based verification. This part ships fully
  active, not gated by any override — it is behaviorally identical to today for every production-reachable
  (single-owner) state, the same way Change 2's identical primitive swap for close was. The
  `shared_scope_protection_unsupported` guard for a scope with more than one active owner is added now,
  fully implemented and tested against synthetic fixtures, but — like replay's relaxation — is naturally
  inert in production until Change 8 removes the admission guard, since a real multi-owner scope cannot
  exist before then. No explicit override is needed on the protection side: it is inert as a structural
  consequence of admission's guard, not because of anything protection-specific.
- **Release**: no new mechanism, unchanged from the prior draft — already complete via
  `isDurablyClosedEntryPackageStatus` filtering plus Change 2's already-shipped close semantics.
- **`position-scope-exclusivity` capability**: production-observable behavior is **unchanged** by this
  proposal — see `design.md`'s regression analysis. The spec delta documents the internal mechanism swap
  (primitive, self-exclusion) without changing any requirement's observable outcome; it does **not**
  relax the "at most one active trade cycle" invariant, since that invariant's real relaxation is Change
  8's job, not this one's.
- **`protection-execution` capability**: gains the `shared_scope_protection_unsupported` outcome as
  documented, currently-unreachable behavior (an active `open-position-resolution`-parallel pattern: a
  requirement that documents a real, tested code path with a currently-empty precondition in production —
  see Change 7's own "production-инертен" framing, which this proposal's protection-side change now
  matches exactly).
- **`abi-position-management-api`**: gains the new error code, unchanged from the prior draft.

## Capabilities

### Modified Capabilities

- `position-scope-exclusivity`: internal ownership-computation mechanism corrected (single-pointer →
  full active-set, self-exclusion made explicit and provably correct); replay's conflict detection
  relaxed to be side-aware, currently inert in production. No requirement's production-observable outcome
  changes — the capability's central "at most one active trade cycle" invariant is unchanged and remains
  true in production until Change 8.
- `protection-execution`: gains the shared-scope guard as documented, currently-unreachable-in-production
  behavior, mirroring Change 7's "production-инертен" pattern.
- `abi-position-management-api`: one new closed-vocabulary error code, no route/DTO/schema change,
  currently unreachable in production for the same reason.

## Impact

- `src/services/entryPackage/entryPackageApplicationService.ts`: the `scopeMutex.withKeyLock(...)`
  callback's internal ownership decision is rewritten to compute the full classification via
  `findActiveRecordsForScope()` and self-exclusion, then apply the temporary production guard described
  above. The guard is a small, clearly-commented block naming Change 8 as the change that removes it.
- `src/correlation/entryPackageCorrelationRepository.ts`: `rebuildScopeIndexFromReplay()`'s conflict rule
  changes from identity-based to side-based, using a local (non-persisted) per-scope side map for the
  duration of one replay pass. `findOwnerByScope()`, `byScope`, and `applyScopeClaimOnWrite()` are
  **not** modified. `findActiveRecordsForScope()` is **not** modified.
- `src/services/protection/protectionApplicationService.ts`: the ownership re-verification block is
  rewritten to use `findActiveRecordsForScope()` and to return the new guard error for a scope with more
  than one active owner, before `determine()` and before any exchange call. No other part of this service
  changes.
- `src/domain/positionManagementApi.ts`: `PositionManagementErrorCode` gains
  `"shared_scope_protection_unsupported"`; a matching result helper is added.
- `openspec/specs/position-scope-exclusivity/spec.md`,
  `openspec/specs/protection-execution/spec.md`,
  `openspec/specs/abi-position-management-api/spec.md`: modified per "Capabilities" above.
- `docs/openapi/abi-position-management-api-v1.json`: gains the new error code in its documented
  vocabulary; no schema/route change.
- Not touched: `src/services/close/closeApplicationService.ts`,
  `src/services/openPosition/openPositionResolutionService.ts`,
  `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`,
  `src/exchange/bybitOrderMapper.ts` (entry-package's own attached TP/SL is explicitly not touched by
  this proposal — see "Why").
- No new store, index, mutex, or registry anywhere in this change.
- **Production behavior for every scenario reachable today is byte-for-byte unchanged** by this proposal.
  The only genuinely new, real, production-reaching effect is the self-exclusion correctness fix inside
  the rewritten admission logic — but its triggering precondition (a second active owner of any kind
  existing on a scope) cannot occur in production under this proposal's own guard either, so even that fix
  has no currently-observable effect; it exists so Change 8's later removal of the guard does not have to
  discover and fix it under production pressure. See `design.md`'s regression analysis for the full
  argument.
