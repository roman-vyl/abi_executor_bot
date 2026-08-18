## Context

See `proposal.md` for Why/What. This design implements master-plan Change 5 as corrected by a short
architecture-review pass against the actually-applied Changes 1-4 (not the master plan's original v3-era
text, which the plan's own "Примечание к ревизиям v4/v5" caveat already flags as stale for Changes 4-6).
That review's findings are authoritative for this design; see `proposal.md`'s "Why" for the two concrete
gaps it found (the `findOwnerByScope` single-pointer primitive, and the self-conflict bug it produces).

This is an **activation-only** change: it does not build anything new. Every primitive it needs already
exists and is already proven for exactly this purpose — `findActiveRecordsForScope()` (Change 1,
already reused by Change 2), `isDurablyClosedEntryPackageStatus` (pre-existing), the existing
`scopeMutex`/`mutex` `KeyedMutex` instances (pre-existing, already correctly scoped). The only genuinely
new code is: one rewritten decision inside an existing critical section (admission), one rewritten
comparison inside an existing replay function (startup), one rewritten decision inside an existing method
(protection guard), and one new closed-vocabulary error code.

## Goals / Non-Goals

**Goals:**
- Any number of same-side trade cycles can claim and hold one physical scope concurrently; opposite-side
  claims continue to be rejected exactly as any conflicting claim is today (fail closed, before any
  durable write or exchange call).
- Fix the two correctness gaps the architecture review found (`findOwnerByScope`'s unsoundness for
  admission decisions, and the self-conflict bug it causes) as part of this change, not as follow-up.
- Replay reconstructs multi-owner scopes correctly and continues to fail readiness closed on any
  genuine (mixed-side) conflict, with no time window in which a corrupted or ambiguous scope is silently
  accepted.
- `PUT .../protection` never lets one owner's write silently manage another same-scope owner's exposure —
  this ships in the same change as admission, not as separate follow-up work, closing the unsafe window
  the master plan itself already calls out.
- No new store, index, mutex, or registry. Every decision this change makes is computed on demand from
  data `EntryPackageCorrelationRepository` already durably holds.

**Non-Goals:**
- Opposite-side coexistence (hedge mode or any dual-side model) — remains rejected, unconditionally, per
  the master plan's own explicit user requirement.
- Pair-owned protection (Changes 6-8) — the guard added here is a temporary safety companion, not a
  redesign; it is explicitly meant to be *removed* by a later change (Change 7/8), not extended.
- Any Runtime-side change.
- A `VirtualExposure` type or a new persisted per-cycle-quantity field — this change touches only *who*
  may hold a scope, never *how much* of it any owner holds (that boundary was already resolved by
  Changes 1/2, out of this change's scope).
- Renaming the `position-scope-exclusivity` capability id/folder to something like
  `virtual-exposure-ownership`, even though the master plan's original text suggests it. The capability's
  *requirements* change substantially (see the spec delta), but Change 3 already established the
  precedent of rewriting a capability's requirements in place — including a full purpose/semantics change
  — without renaming its id (`open-position-resolution` kept its name through Change 3's own
  fill-derived-vs-aggregate-derived rewrite). Renaming a capability folder is a documentation-organization
  decision independent of this change's actual code delta, and doing it here would be scope creep against
  "activation only." If a future reviewer wants the rename, it can be done as its own zero-behavior-change
  documentation pass.
- Any change to `findOwnerByScope()`'s or `byScope`'s own implementation. They are correct at what they
  already do (report the most recent writer); this change only stops treating that answer as sufficient
  for a decision that needs the full active set.

## Decision 1 — Admission: `findActiveRecordsForScope()` replaces `findOwnerByScope()` inside the existing critical section

Current code (`entryPackageApplicationService.ts:278-296`):

```ts
const claim = await this.deps.scopeMutex.withKeyLock(positionScopeKey(category, symbol), async () => {
  const owner = this.deps.correlationRepository.findOwnerByScope(category, symbol);
  const ownedByAnotherActivePair =
    owner !== undefined && !isOwnedBySamePair(owner, command) && !isDurablyClosedEntryPackageStatus(owner.status);
  if (ownedByAnotherActivePair) return "conflict";
  await this.deps.correlationRepository.save(provisional);
  return "claimed";
});
```

New logic, same critical section, same "claimed" | "conflict" return shape:

```ts
const claim = await this.deps.scopeMutex.withKeyLock(positionScopeKey(category, symbol), async () => {
  const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, symbol);
  const otherActiveRecords = activeRecords.filter((r) => !isOwnedBySamePair(r, command));

  for (const other of otherActiveRecords) {
    if (other.desired_entry === null) {
      return "corrupt"; // new outcome — see below
    }
  }
  const conflictingSide = otherActiveRecords.find((r) => r.desired_entry!.side !== desiredEntry.side);
  if (conflictingSide !== undefined) {
    return "conflict";
  }

  await this.deps.correlationRepository.save(provisional);
  return "claimed";
});
```

**Why filter out the requested pair's own record first, not just check `isOwnedBySamePair` inline per
candidate as the old code did.** The old code only ever compared against a *single* `owner` value, so
"is this the same pair" and "is this pair's own record" were the same question. Once `activeRecords` can
contain more than one record, the requested pair's own (possibly still-active) record must be excluded
from the "others" set *before* the side comparison runs — otherwise a pair would trivially "conflict"
with itself (same side, so harmless in practice, but conceptually wrong and wasteful) and, more
importantly, a stale reviewer extending this logic later could accidentally compare the pair against its
own record instead of only against genuine others. Filtering first makes "am I already active here" and
"do the *other* active owners' sides allow me to join" two clearly separate questions — this is also
exactly what fixes the self-conflict bug the architecture review found: the requested pair's own record,
wherever it is (including if it happens to be what `findOwnerByScope` would NOT have pointed to), is never
compared against itself.

**The `null desired_entry` case.** An active (non-durably-closed) record with `desired_entry === null` is
not a state any current write path produces — `createOrder()` always writes a real `desired_entry`
alongside any non-`absent` status, and a null-`desired_entry` CANCEL write durably transitions status to
`absent` in the same write (`isDurablyClosedEntryPackageStatus` already excludes it from
`findActiveRecordsForScope`'s results). This is the same class of "structurally impossible, verify anyway"
defensive check already used throughout this codebase (e.g. `CloseApplicationService`'s repeated
"Unreachable... re-verified rather than assumed" checks). Encountering it here is a genuine correlation
data contradiction — a request under it must fail closed, not silently exclude that record from the side
check (which could let a real opposite-side owner go undetected) or crash with a null-dereference.

**Why this new "corrupt" outcome doesn't need a new public error code.** Both `"conflict"` and this new
contradiction both already map to the same pre-exchange-call safe error the caller returns for a scope
conflict today (`internalErrorResult()`, no new correlation write, no exchange call) — see "Decision 4:
error codes" below for why this stays as-is rather than gaining its own code.

## Decision 2 — `findOwnerByScope()`/`byScope`: reclassified, not removed, not repaired

`findOwnerByScope()` continues to return exactly what it always has — the record from the most recent
non-durably-closed write to a scope. That answer remains **correct** for what it actually promises; what
changes is that after this proposal, no remaining production code path is allowed to treat "the current
`byScope` pointer" as "the current owner" for an admission or protection decision, because once same-side
sharing is active in production, that promise is no longer strong enough for either decision. This
proposal's two rewrites (Decisions 1 and 3 for the guard) are, together, the last two production call
sites of `findOwnerByScope()` — after this change ships, no production decision-making code calls it.
It is deliberately left in place (not deleted, not repointed to a set) as a cheap, still-truthful,
non-authoritative existence/debugging primitive — repointing it to return a set would just be
`findActiveRecordsForScope()` again under a different name, and deleting a correct, harmless primitive
with no remaining unsafe callers is unrelated churn this "activation only" change does not need.

## Decision 3 — Replay: side comparison replaces identity comparison, no new persisted index

Current code (`entryPackageCorrelationRepository.ts:268-320`, `rebuildScopeIndexFromReplay`): any second
active record for a scope, regardless of side, is an unconditional hard failure.

New logic — a **local, function-scoped** `Map<string, "long" | "short">` tracking, per scope, the side
already seen among that scope's active records during this one replay pass (discarded when the function
returns; never exposed, never persisted, not a new index in the sense the review was asked to avoid):

```ts
private rebuildScopeIndexFromReplay(): string | undefined {
  this.byScope.clear();
  const activeSideByScope = new Map<string, "long" | "short">();

  for (const record of this.byCompositeKey.values()) {
    // ...existing category/symbol contradiction checks, unchanged...
    if (isDurablyClosedEntryPackageStatus(record.status)) continue;

    const scope = positionScopeKey(record.exchange_category, record.exchange_symbol);
    const side = record.desired_entry?.side;
    if (side === undefined) {
      return `record for ${key} is active but has no usable desired_entry.side`;
    }

    const existingSide = activeSideByScope.get(scope);
    if (existingSide !== undefined && existingSide !== side) {
      return `conflicting scope ownership for ${scope}: mixed sides among active records`;
    }
    activeSideByScope.set(scope, side);
    this.byScope.set(scope, record); // last-writer-in-iteration-order pointer, unchanged semantics
  }

  return undefined;
}
```

`byScope` itself keeps being populated exactly as before (last record wins) — Decision 2 already
established that no production decision depends on which specific record `byScope` ends up pointing to
after replay, only on `findActiveRecordsForScope()`'s full scan, which is untouched by this change (it
already derives everything fresh from `byCompositeKey` on every call, replay included).

**Why `record.desired_entry?.side === undefined` (missing, not present) fails closed here, distinct from
Decision 1's `null` check.** Replay works from raw records already validated by
`isValidEntryPackageExecutionRecord` — `desired_entry` there is typed `DesiredEntryDto | null`, so a
present-but-`null` value decodes to exactly `undefined` under `?.side` here too; this is the same
contradiction as Decision 1's, expressed as a startup readiness failure instead of a request-time one,
consistent with how this same function already turns other structural contradictions (missing exchange
binding on a non-durably-closed record) into readiness failures rather than silently excluding the record.

**Iteration order independence.** `byCompositeKey.values()` iterates in insertion order (JS `Map`
semantics), which for a fresh replay is file order — but the side-conflict check above is symmetric
(compares against whatever side was recorded *first* for that scope, regardless of which pair that was),
so which of two same-side records happens to be "first" never changes the outcome, only which one
`byScope` ends up pointing to (which, per Decision 2, no longer matters).

## Decision 4 — Protection guard: placed before `determine()`, using the same `findActiveRecordsForScope()` primitive

Current code (`protectionApplicationService.ts:93-102`):

```ts
const owner = this.deps.correlationRepository.findOwnerByScope(category, record.exchange_symbol);
if (owner === undefined || owner.strategy_instance_id !== command.strategyInstanceId || owner.trade_cycle_id !== command.tradeCycleId) {
  return internalErrorResult();
}
```

New logic, same call site (replacing this block entirely, immediately before the existing
`determine()` call):

```ts
const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, record.exchange_symbol);
const selfIsActive = activeRecords.some(
  (r) => r.strategy_instance_id === command.strategyInstanceId && r.trade_cycle_id === command.tradeCycleId,
);
if (!selfIsActive) {
  return internalErrorResult(); // same outcome as today's "ownership mismatch"
}
if (activeRecords.length > 1) {
  return sharedScopeProtectionUnsupportedResult(); // new — before determine(), before any exchange call
}
```

**Why before `determine()`, not after.** `determine()` is itself read-only (a live position query, no
exchange write) — placing the guard after it would still technically satisfy "fail closed before any
exchange *mutation*." This design places it *before* anyway, for the same reason `entryPackageApplicationService`'s
own claim check runs before its exchange call rather than merely before the write half of it: cheaper
(skips a live query that can never matter for a scope this request can't act on regardless of what it
returns), and it keeps this method's decision order legible — "who am I, is this scope safe for me to act
on, only then what is its live state" — rather than interleaving an ownership decision in the middle of a
read-only determination the guard doesn't need.

**Single-owner path is untouched.** When `activeRecords.length === 1` and that one record is the
requested pair, execution falls through to exactly the same `determine()` call, the same already-satisfied
short-circuit, the same write, and the same read-back this method already has — none of that code changes.

**Error code: `shared_scope_protection_unsupported`, additive to the closed vocabulary, not a
reinterpretation of `internal_error`.** Unlike Decision 1's admission conflict (kept as the existing
`internal_error`, see below), this is a genuinely new, distinct, and — importantly — **caller-actionable**
outcome: a Runtime caller seeing `shared_scope_protection_unsupported` learns something it can use (this
scope currently has more than one owner, protection is not yet available for it, try
`GET .../open-position` or wait for Change 7/8) that `internal_error` cannot communicate. This mirrors
exactly why `close_execution_incomplete` (Change 2) was given its own code instead of reusing
`internal_error`: both are outcomes a caller can reasonably distinguish and act on differently, not a
generic "something went wrong."

**Why admission's opposite-side conflict does NOT get a new code, but protection's shared-scope guard
does.** The master plan's own §6 risk list left this as an open question; this design resolves it by
precedent, not by symmetry for its own sake. Admission's conflict (Decision 1) is reported through the
*same* `internal_error` response the pre-existing same-pair conflict already uses
(`position-scope-exclusivity` spec, "This capability introduces no public HTTP contract change") — that
requirement is explicit that a scope-acquisition conflict, of any kind, reuses the existing safe error
with no new code, and this proposal does not touch that requirement's substance, only the condition under
which the existing error fires (opposite-side, instead of any-second-owner). Protection's guard is a
*new* capability-level outcome this scope has never been able to produce before (there was no way to
reach a "more than one owner" state to guard against), so there is no existing "reuse this" precedent to
follow the way admission has one — and per the pattern `close_execution_incomplete` already set, a new
distinguishable, actionable outcome earns its own code rather than being folded into `internal_error`.

## Decision 5 — Release needs no design; it already works

`findActiveRecordsForScope()` already filters on `isDurablyClosedEntryPackageStatus`
(`entryPackageCorrelationRepository.ts:171`), and `CloseApplicationService`'s multi-owner path (Change 2,
already shipped) already durably writes `terminal_closed` for only the closing pair's own record
(`finalizeMultiOwnerClose`, `closeApplicationService.ts:518-529`), never touching a sibling's record. The
combination of these two already-shipped mechanisms is a complete, correct release implementation — a
closed pair's record stops appearing in `findActiveRecordsForScope()`'s results on its very next call,
with zero code in this proposal. The master plan's original phrasing ("Release generalized... реализовано
в Change 2/1") is accurate about *where* the mechanism lives but reads as a work item for this change; it
is not — see `proposal.md`'s corrected description and the master-plan revision this design's own
correction produces.

## Required tests

1. Two same-side pairs (A long, B long) on one scope: both claims succeed, both remain independently
   active, `findActiveRecordsForScope` returns both.
2. Self-claim/retry: pair A already active on a scope, pair B joins (same side) after A — so `byScope`'s
   pointer now reflects B — a subsequent retry/new-generation `createOrder()` for pair A itself succeeds
   without a false conflict (the specific bug the architecture review found).
3. Opposite-side conflict: pair A long already active, pair B attempts short on the same scope — B's
   attempt fails closed (`internal_error`, unchanged code) before any durable write or exchange call for
   B; A's ownership is unaffected.
4. An active record with `desired_entry: null` present among a scope's active records → the requesting
   pair's claim attempt fails closed, distinct assertion from the opposite-side case (both currently map
   to the same response, but the two conditions are tested separately since they are logically distinct
   per Decision 1).
5. Replay: a correlation log whose final state has two same-side active records for one scope → replay
   succeeds, both are reconstructed as active.
6. Replay: a correlation log whose final state has mixed-side active records for one scope → replay
   fails, entry-package readiness reports not-ready (same failure shape as today's "conflicting scope
   ownership", reworded per Decision 3).
7. Replay: an active record with no usable `desired_entry.side` → replay fails readiness closed.
8. Durable close of pair A (multi-owner close path, Change 2) does not affect pair B's continued active
   ownership of the same scope — reuses/extends Change 2's own existing close tests under real (not
   synthetic) multi-owner activation.
9. Protection: two active owners (A, B) on one scope — `PUT .../protection` for either returns
   `shared_scope_protection_unsupported`, and no `setTradingStop`/exchange write of any kind is sent.
10. Protection: exactly one active owner, matching the requested pair — full regression of today's
    existing behavior (already-satisfied short-circuit, write, read-back) — byte-for-byte unchanged.
11. Protection: the requested pair is not among the scope's active records (e.g. a stale/inconsistent
    record) — fails closed with the existing `internal_error`, unchanged from today's "ownership mismatch"
    outcome, not the new shared-scope code (the two failure conditions must remain distinguishable in the
    implementation even though this design does not require them to be distinguishable to the caller).
12. Full regression of existing `entryPackageApplicationService.test.ts` scope-race tests
    (`entryPackageApplicationService.test.ts:827-946`) — these currently use same-side (`long`) commands
    for both racing pairs implicitly (`makeDesiredEntry()`'s default), which under the corrected same-side
    semantics would now legitimately *both succeed* rather than conflict. Each of these tests needs its
    non-owning pair's command changed to the opposite side to keep testing genuine conflict semantics, and
    a new sibling test added alongside each, asserting the same-side case now succeeds. Tests not
    concerned with conflict at all (different-scope independence, restart/release tests) are unaffected
    and are not adapted.
13. Full regression of `protectionApplicationService.test.ts`'s existing single-owner scenarios —
    unchanged assertions.
