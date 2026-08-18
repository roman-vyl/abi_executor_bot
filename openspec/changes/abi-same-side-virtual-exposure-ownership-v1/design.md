## Context

See `proposal.md` for Why/What, including the retracted first premise (this change activates same-side
production sharing) and the safety blocker that retracted it: entry-package's own entry-order creation
already attaches position-level `tpslMode: "Full"` protection (`bybitOrderMapper.ts:124-129`), which a
second same-side owner's own entry order would silently clobber the instant it is placed — a hazard
`PUT .../protection`'s guard alone cannot prevent, since the unsafe write happens inside entry-package
creation, not inside the protection endpoint. This design implements the corrected scope: foundation only,
proven against synthetic fixtures, one explicit temporary guard keeping real admission exactly as
exclusive as it is today.

## Goals / Non-Goals

**Goals:**
- Fix the two real correctness gaps the architecture review found in `findOwnerByScope()`
  (unsoundness for admission decisions, and the self-conflict bug it would produce) — as foundation, so
  Change 8's later activation does not have to rediscover and fix them under production pressure.
- Prove the full same-side admission classification, side-aware replay reconstruction, and the
  shared-scope protection guard against synthetic multi-owner fixtures — the same testing discipline
  Changes 1-4 already used before their own consumers were production-reachable.
- Leave every currently-reachable production behavior byte-for-byte unchanged.
- Make the one remaining activation step (Change 8) as small as possible: remove one clearly-labeled
  guard, once pair-owned protection has actually replaced position-level `tpslMode: "Full"` writes.

**Non-Goals:**
- Activating real same-side admission in production. That is Change 8's job, gated on pair-owned
  protection (Changes 6-7) actually existing first.
- Any change to entry-package's own TP/SL attachment behavior, including any `tpslMode: "Partial"`
  workaround. `mapEntryPackageToBybit()` is not touched by this change at all.
- Pair-owned protection itself (Changes 6-8).
- Any Runtime-side change.
- A `VirtualExposure` type, a new persisted per-cycle-quantity field, a new mutex/store/index — unchanged
  from the prior draft's non-goals.
- Renaming the `position-scope-exclusivity` capability id/folder — unchanged from the prior draft's
  reasoning (Change 3 precedent: rewrite requirements in place, keep the id stable).

## Decision 1 — Admission: a correct classification, gated by one temporary, explicitly-labeled production guard

**The classification (foundation, fully active, fully tested):**

```ts
const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, symbol);
const otherActiveRecords = activeRecords.filter((r) => !isOwnedBySamePair(r, command));

for (const other of otherActiveRecords) {
  if (other.desired_entry === null) {
    return "corrupt";
  }
}
const conflictingSide = otherActiveRecords.find((r) => r.desired_entry!.side !== desiredEntry.side);
```

This step is unchanged from the prior draft and is exactly what Change 8 will eventually rely on
unmodified — see that draft's Decision 1 rationale for why self-exclusion must happen before the side
comparison, and why a `null` `desired_entry` among other active records is a structural contradiction, not
a state to guess through.

**The temporary production guard, new in this correction:**

```ts
// TEMPORARY, per abi-same-side-virtual-exposure-ownership-v1: entry-package's own
// entry-order creation attaches position-level tpslMode: "Full" protection
// (bybitOrderMapper.ts) — a second same-side owner's own entry order would
// silently clobber the first owner's protection the instant it is placed,
// before pair-owned protection (Changes 6-8) exists to prevent that. Real
// same-side admission is therefore gated here until Change 8 (once pair-owned
// protection has replaced position-level TP/SL writes) removes this block and
// lets the classification above decide admission on its own.
if (otherActiveRecords.length > 0) {
  return "conflict"; // same-side, opposite-side, and corrupt all conflict for now
}
await this.deps.correlationRepository.save(provisional);
return "claimed";
```

**Why this is the right shape, not a config flag or a second mutex.** The classification and the guard are
two clearly separated steps in the same function, not two different code paths — Change 8's entire job on
the admission side is deleting the guard block and letting the classification's own three-way answer
(empty / same-side / opposite-side) drive the outcome directly, instead of collapsing same-side into
conflict. No flag, environment variable, or config toggle is introduced — this is not a feature that needs
to be turned on/off at runtime, it is prepared code waiting for a follow-up change to delete a few lines,
exactly the same shape Change 7's own "guard from Change 5 stays active" already uses for protection.

**Why the self-exclusion fix ships now even though its precondition can't occur in production yet.**
`otherActiveRecords` can only be non-empty in production today for a genuinely different pair (since no
second owner of *any* side can ever successfully join while this guard stands) — so today, self-exclusion
changes nothing observable: a genuinely different pair was already correctly treated as a conflict before
this change, and still is, via the guard above. What self-exclusion protects against is a bug that would
otherwise be *introduced* the moment Change 8 deletes the guard and same-side joining becomes real: without
self-exclusion, a pair's own retry could, at that point, misread a same-side sibling as "the owner" (under
the old single-pointer primitive) and self-conflict. Fixing this now, as foundation, means Change 8's own
diff is exactly "delete the guard block" — it does not also have to get admission's classification correct
under time pressure at the activation moment. This is the same "build correct now, activate later" pattern
Change 1 (data model) and Change 6 (protection identity) already use elsewhere in this program.

**Regression analysis.** For every pair, in every production-reachable scenario today: `otherActiveRecords`
is empty (no other pair holds the scope) → claim, identical to today's `findOwnerByScope`-based "no owner"
path; or `otherActiveRecords` is non-empty (a genuinely different pair holds it, single-owner world) →
conflict via the guard, identical to today's `findOwnerByScope`-based "owned by another pair" path. There
is no reachable input for which this change's output differs from today's.

## Decision 2 — `findOwnerByScope()`/`byScope`: unchanged from the prior draft

No implementation change; reclassified as a legacy/convenience primitive, no longer valid for any
ownership/admission decision. See the prior draft's Decision 2 for the full rationale — unaffected by this
correction.

## Decision 3 — Replay: side-aware reconstruction, naturally inert in production until Change 8

Unchanged in mechanism from the prior draft's Decision 3 (a local, function-scoped
`Map<scope, side>`, discarded after one replay pass; mixed-side remains a hard failure; a missing side on
an active record fails readiness closed). What changes in this correction is only the framing: this
relaxation cannot be exercised by genuine production writes today, because Decision 1's guard never lets
a real second same-side owner come into existence in the first place. It is exercised only by tests that
seed a synthetic second active record directly into the correlation store (bypassing the admission gate
entirely, the same technique Changes 1-4 already used for their own multi-owner tests) — proving the
replay mechanism itself is correct and ready, without requiring or implying that production can reach that
state yet. No explicit "guard" is needed on the replay side the way Decision 1 needs one: replay simply
reflects whatever the durable log contains, and the durable log can never legitimately contain a
same-side-shared scope until Change 8 removes Decision 1's guard.

## Decision 4 — Protection guard: ships fully active, inert only because admission makes it unreachable

Unchanged in mechanism from the prior draft's Decision 4 (replace the `findOwnerByScope()`-based
re-verification with `findActiveRecordsForScope()`; fail closed if the requesting pair is not among the
active records; return `shared_scope_protection_unsupported` if more than one active record exists, before
`determine()` and before any exchange call; single-owner behavior is completely unchanged).

**What changes in this correction is that this code needs no guard of its own.** Unlike admission, which
can (once Decision 1's classification runs) actually *decide* to admit a same-side owner and therefore
needs an explicit temporary override to stop it from doing so, protection's `activeRecords.length > 1`
branch has no such decision to make — it can only ever be reached if a scope with more than one active
owner already exists, and Decision 1's guard is what prevents that state from ever existing in production.
Protection's guard is therefore **not** provisional or temporary in the way Decision 1's is: it is the
real, final logic Change 8 will still rely on unmodified — Change 8's job is entirely on the admission side
(deleting Decision 1's guard); nothing on the protection side needs to change when that happens. This
mirrors exactly how Change 7 already describes its own protection-lifecycle work as "production-инертен"
without needing an explicit guard of its own — inertness is a structural consequence of admission, not a
property protection has to enforce itself.

**Error code decision — unchanged from the prior draft.** `shared_scope_protection_unsupported` is a new,
additive, caller-actionable code (the `close_execution_incomplete` precedent); admission's own conflict
(Decision 1) continues to reuse the existing `internal_error`, per `position-scope-exclusivity`'s own
existing "no new public error code for admission conflicts" requirement, which this proposal does not
touch.

## Decision 5 — Release: unchanged from the prior draft

No design needed; already complete via existing `isDurablyClosedEntryPackageStatus` filtering and Change
2's already-shipped `finalizeMultiOwnerClose`. Unaffected by this correction.

## Regression analysis (production, today's only reachable state, and — after this change ships — still
the only reachable state)

Every one of Decisions 1-5 either (a) reuses a primitive already proven behaviorally identical for
single-owner (protection, replay's untouched mixed-side/missing-exchange-binding checks), or (b) is
explicitly gated so its new branch cannot be reached by any production write path (admission's temporary
guard; replay's side relaxation, inert as a structural consequence of (b) for admission). There is no
requirement in any of the three modified capability specs whose production-observable scenario changes.
The only new, real code this proposal adds that is *not* gated is the admission self-exclusion fix — whose
effect is unobservable today for the reason given in Decision 1's own regression analysis.

## Required tests

1. **Admission classification (pure, synthetic — proves the foundation, does not require production
   activation)**: given a requesting pair and a set of other active records, `findActiveRecordsForScope()`
   correctly identifies: no other owner (empty); other owner(s), same side; other owner(s), opposite side;
   other active record with `desired_entry: null`. Verified by seeding synthetic active records directly
   into the correlation repository, not by two real `service.apply()` calls both succeeding.
2. **Admission self-exclusion (pure, synthetic)**: a requesting pair's own active record is present among
   `findActiveRecordsForScope()`'s results alongside a genuinely different, same-side active record seeded
   synthetically — the requesting pair's own record is correctly excluded from the "other" set before the
   side comparison runs, independent of what the temporary production guard (Test 6) does with the result.
3. **Admission temporary guard (end-to-end, `service.apply()`)**: two different pairs, same side,
   concurrently racing the same scope — exactly one succeeds, the other fails closed, identically to
   today's existing behavior. This is the same assertion the existing
   `entryPackageApplicationService.test.ts` scope-race tests (lines ~827-946) already make and requires
   **no adaptation** — those tests' pairs already default to the same side (`makeDesiredEntry()`'s
   `side: "long"` default) and continue to correctly assert a single winner under this proposal, since the
   temporary guard makes same-side and opposite-side racing behave identically today.
4. **Self-repeat regression (end-to-end)**: a pair that already solely owns a scope issues a repeat/retry
   command — succeeds without a false conflict, using the existing
   `entryPackageApplicationService.test.ts` self-repeat coverage (already present, must continue passing
   unmodified — this is the baseline self-exclusion behavior the original `findOwnerByScope`-based code
   already had, carried forward by the rewritten primitive, not a new scenario this proposal introduces).
5. Replay: a correlation log whose final state has two same-side active records for one scope (seeded
   synthetically, not reachable via real writes today) → replay succeeds, both reconstructed as active.
6. Replay: a correlation log whose final state has mixed-side active records for one scope → replay fails,
   entry-package readiness reports not-ready.
7. Replay: an active record with no usable `desired_entry.side` → replay fails readiness closed.
8. Durable close of a synthetically-seeded pair A does not affect a synthetically-seeded same-scope
   sibling B's continued active ownership — reuses `CloseApplicationService`'s already-owner-aware Change
   2 logic against directly-seeded multi-owner fixtures, the same technique Change 2's own tests already
   use.
9. Protection: two synthetically-seeded active owners on one scope — `PUT .../protection` for either
   returns `shared_scope_protection_unsupported`, and no `setTradingStop`/exchange write of any kind is
   sent.
10. Protection: exactly one active owner, matching the requested pair — full regression of today's
    existing behavior, byte-for-byte unchanged.
11. Protection: the requested pair is not among the scope's active records — fails closed with the
    existing `internal_error`, distinguishable in the implementation from the shared-scope guard.
12. Full regression of `protectionApplicationService.test.ts`'s existing single-owner scenarios.
13. Full regression of the existing `entryPackageApplicationService.test.ts` suite in its entirety,
    including every scope-race test — **no test in this file needs to change** (see Test 3 above); this
    is itself a required regression check, not a no-op.

## Deferred to Change 8 (not written by this proposal)

- Removing Decision 1's temporary guard, letting the classification's own same-side answer admit a second
  owner in production.
- Any end-to-end test asserting that two same-side pairs' `service.apply()` calls **both** durably succeed
  and remain independently active — this is the activation-level assertion the first draft of this
  proposal incorrectly included as a Change 5 test; it belongs to Change 8, once admission's guard is
  gone.
- Any end-to-end test exercising the shared-scope protection guard or the side-aware replay relaxation
  against a scope that became multi-owner through **real** entry-package traffic (as opposed to synthetic
  seeding) — meaningful only once Change 8 has shipped.
