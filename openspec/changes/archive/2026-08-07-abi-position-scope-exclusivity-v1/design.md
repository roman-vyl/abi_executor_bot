## Context

See `proposal.md` for Why/What. This document is scoped to exactly one invariant: a physical Bybit
position scope (`category` + `symbol`, one configured account per ABI process, one-way
`positionIdx = 0`) is owned by at most one active trade cycle at a time. It intentionally stops
short of anything Issue #3 ("Backlog: virtual position ledger for shared same-symbol exposure")
already claims as future scope, and short of any protection/close execution behavior.

Current repository state relevant to this design:

- `EntryPackageExecutionRecord` (`src/correlation/entryPackageExecutionRecord.ts`) already stores
  `exchange_category`/`exchange_symbol` per pair, and a closed `status` enum
  (`pending_create | applied | pending_replace | pending_cancel | absent | create_failed | unknown |
  terminal_unfilled`). No scope-ownership concept exists anywhere today.
- `EntryPackageCorrelationRepository` (`src/correlation/entryPackageCorrelationRepository.ts`)
  already maintains three derived in-memory indexes over the same durable JSONL log
  (`byCompositeKey`, `byOrderLinkId`, `byOrderId`), built both on `save()` and on startup `replay()`.
  Replay already fails closed (`{ok:false}`) on structurally- or schema-invalid lines
  (`isValidEntryPackageExecutionRecord`), wired to `EntryPackageReadiness`
  (`src/app/entryPackageReadiness.ts`) via `app/server.ts`.
- `KeyedMutex` (`src/concurrency/keyedMutex.ts`) is a minimal `Map<string, Promise<void>>` chain,
  already used once, keyed by `correlationRecordKey(strategy_instance_id, trade_cycle_id)`
  (`entryPackageApplicationService.ts:51-52`), acquired around the entire `process()` call per pair.
- `EntryPackageApplicationService.createOrder()` (`entryPackageApplicationService.ts:136-235`) is
  the **only** place a pair transitions from "no scope" to "holds a scope": it resolves
  `ExchangeInstrumentResolver.resolve(ticker)` (pure, deterministic, no I/O —
  `src/exchange/exchangeInstrumentResolver.ts`), then durably writes a provisional record
  (`status: "pending_create"`) *before* any Bybit call (already-implemented
  "durable-before-exchange-write" ordering from `abi-entry-package-execution-v1`'s design.md §11
  step 4d), then calls Bybit, then confirms. `REPLACE`'s cancel-and-create path
  (`replaceCancelAndCreate`) also calls `createOrder()` for the same pair at a new generation, but
  never for a different ticker (`ticker` is immutable per pair, checked in `process()`), so it never
  changes which scope a pair owns.
- `OpenPositionResolutionService.classifyStatus()` (`src/services/openPosition/
  openPositionResolutionService.ts:90-106`) already partitions the same status enum into
  `durably_closed = {absent, terminal_unfilled}`, `live_query_admissible = {applied,
  pending_replace, pending_cancel}`, `unresolved = {pending_create, create_failed, unknown}`. This
  is the exact partition this change reuses for scope release (Decision 7), extracting the shared
  `durably_closed` predicate the two features have in common (Decision 10).
- `abi-position-management-api`'s existing spec already states both `PUT .../protection` and
  `DELETE .../open-position` must resolve "exactly one unambiguous, supported exchange position
  scope" before any write, and its own design.md defers "how ABI internally... resolves a position"
  to later work. Those endpoints are today transport-only stubs
  (`src/routes/positionManagementRoutes.ts:96-101,132-136`) that unconditionally return
  `internal_error` after validation — this change does not wire them, but is the dependency they
  will resolve against.

## Goals / Non-Goals

**Goals:**
- Make "one physical scope, at most one active trade cycle" an enforced invariant, not a documented
  assumption, for the one place a pair can newly acquire a scope today (`createOrder()`).
- Derive scope ownership entirely from the existing durable correlation log — zero new durable
  artifacts, zero new `EntryPackageExecutionRecord` fields, zero new files.
- Keep the existing pair-level `KeyedMutex` semantics for a single trade cycle's own commands
  completely unchanged.
- Make acquisition atomic across two different pairs racing the same scope, and independent (no
  blocking) across two different scopes.
- Preserve the existing durable-before-exchange-write ordering; the claim *is* the existing
  provisional write, not a new one.
- Make restart recovery need nothing beyond what replay already reconstructs.
- Leave the public HTTP contract (`abi-entry-package-api`, `abi-open-position-lookup-api`,
  `abi-position-management-api`) byte-for-byte unchanged.

**Non-Goals** (see `proposal.md`): virtual position ledger / shared same-symbol exposure (Issue #3),
multiple trade cycles sharing one scope, protection execution, close execution, partial
protection/close, hedge mode, a new database, a new durable ownership store, a general ABI refactor.
**Explicitly deferred, not designed here:** the release path for a scope *after* a fill has
occurred — Runtime-commanded close, take-profit, stop-loss, exchange-side manual close, or
liquidation/ADL. This change only defines pre-fill release (Decision 6); post-fill release is a
future position-management change's responsibility, once it can durably prove cycle completion.

## Decisions

### 1. Physical position scope: a new, minimal value type

New file `src/domain/positionScope.ts`:

```ts
export type PositionScope = {
  category: ExchangeInstrumentCategory; // "linear" | "spot"
  symbol: string;
};

export function positionScopeKey(category: ExchangeInstrumentCategory, symbol: string): string;
```

Account and `positionIdx = 0` are **not** part of the key. Account is implicit because
`AbiConfig` (`src/config/config.ts`) carries exactly one Bybit credential pair per process — there
is only one account a key could ever mean. `positionIdx` is implicit because V1 supports only
one-way mode; `open-position-resolution`'s spec already documents `positionIdx == 0` as a validated
V1 constant, not a chosen dimension. Both are documented in this file's own comment as V1
boundaries, matching the "V1 scope is limited to..." disclosure pattern already used in
`entry-package-execution` and `open-position-resolution`'s specs — not silently generalized. If a
future change ever supports multiple accounts per process, extending `PositionScope` with an
`accountId` field is a additive, backward-compatible key change, not a redesign, since the ledger
that would need it (the correlation store) does not exist as a "reservation" store separate from
`EntryPackageExecutionRecord` that this key could otherwise leak into.

### 2. Ownership model: a fourth derived index on the existing repository, not a new store

`EntryPackageCorrelationRepository` gains a fourth in-memory index, maintained exactly like the
existing three (`byCompositeKey`, `byOrderLinkId`, `byOrderId`):

```ts
private readonly byScope = new Map<string, EntryPackageExecutionRecord>();

findOwnerByScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord | undefined
```

Unlike `byOrderLinkId`/`byOrderId` (append-only forever — a historical binding's identity is never
reassigned), `byScope` reflects **current** ownership only, so `indexRecord()` gains claim/release
logic instead of pure accumulation:

```
scope = record.exchange_category is "linear"|"spot" ? positionScopeKey(record) : none

if scope exists and record.status is NOT in {"absent", "terminal_unfilled"}:
    byScope.set(scope, record)              // claim / refresh current ownership
else if scope exists:
    // record is durably closed (or was never bound); release only if THIS pair
    // still appears to be the recorded owner, never someone else's entry
    if byScope.get(scope)?.strategy_instance_id/trade_cycle_id === record's own pair:
        byScope.delete(scope)
```

This claim/release step runs immediately, in write order, for every **live** `save()` call. It is
correct there specifically because live `save()` calls are already strictly ordered by both the
pair-lock and the scope-lock (Decisions 4-5): by the time any given `save()`'s `indexRecord()` runs,
`byScope` already reflects the actual current state, never a stale intermediate snapshot — there is
no "future" write still to come that could change the right answer.

**Startup replay does not reuse this same incremental per-line update for `byScope`.** Applying the
claim/release step to every historical line in isolation, in file order, is unsound for replay:
an intermediate line can legitimately show two different pairs both "holding" the same scope one
after another (pair A applied, then pair B pending_create, then — later in the file — pair A goes
absent), and reacting to that intermediate moment as either a conflict or a silent overwrite gives
the wrong answer either way. See Decision 8 for the two-phase algorithm replay uses instead, which
evaluates ownership only over each pair's final, latest durable record. `byCompositeKey`,
`byOrderLinkId`, and `byOrderId` are unaffected by this distinction: they have no release semantics
(a composite key simply always holds its pair's latest record; the order-id indexes are
append-only), so per-line updates during both live writes and replay remain exactly as they are
today. Only `byScope` needs the two different construction rules for the two different contexts —
ownership itself is still a pure function of "the latest durably-written record per pair" in both
cases, and `byScope` is still simply an index over those same facts, never a second source of truth.

**Why not a new repository or reservation store:** every fact needed to answer "who owns this
scope" — `exchange_category`, `exchange_symbol`, `status` — already exists on
`EntryPackageExecutionRecord` and is already durably written before any exchange call. A parallel
store would have to be kept consistent with the correlation log by hand, on every write path, with
its own crash-consistency story — a second source of truth that could drift is a strictly worse
answer than a derived view that structurally cannot.

### 3. Acquisition point: exactly one call site, `createOrder()`

`EntryPackageApplicationService.createOrder()` (`entryPackageApplicationService.ts:136`) is the only
place a pair's `exchange_category`/`exchange_symbol` transitions from absent/unset to a real,
resolved value. Every other private method that touches an existing binding
(`replaceAmend`, `replaceCancelAndCreate`'s cancel half, `cancelLiveOrder`, `metadataOnlyUpdate`'s
revalidation branch, `repeatPutRevalidate`) reuses `record.exchange_symbol`/`exchange_category`
verbatim and never re-resolves — this is already an explicit, load-bearing design decision from
`abi-entry-package-execution-v1` ("Amend reuses the order's recorded `exchange_symbol`, never
re-resolves"). Because of that existing decision, this change needs exactly one integration point,
not a scan of every write path.

The guard runs unconditionally on every `createOrder()` call (fresh pair, re-acquisition after
`absent`, and same-pair re-dispatch at a new generation via `replaceCancelAndCreate` all included) —
not conditionally by caller — because for an already-owning pair the check trivially confirms
self-ownership and proceeds, which is both simpler to reason about than branching per call site and
is exactly the mechanism that satisfies "repeat commands from the current owner are always
permitted" without a separate code path.

### 4. Two-level locking: pair-lock and scope-lock have disjoint responsibilities

A second `KeyedMutex` instance, `scopeMutex`, keyed by `positionScopeKey(...)`, is constructed in
`app/server.ts` next to the existing `mutex` and injected into
`EntryPackageApplicationServiceDeps`.

| | Pair-lock (existing, unchanged) | Scope-lock (new) |
|---|---|---|
| Key | `(strategy_instance_id, trade_cycle_id)` | `(category, symbol)` |
| Held for | the entire `process()` call for one pair's command | only the read-check-decide-write step immediately preceding the existing provisional `correlationRepository.save()` inside `createOrder()` |
| Purpose | one trade cycle's own commands never interleave with each other | two *different* pairs never both decide "scope is free" from a stale snapshot |
| Acquired in | `EntryPackageApplicationService.apply()` | `EntryPackageApplicationService.createOrder()`, nested inside an already-held pair-lock |

Precisely stated: **different scopes are not serialized against each other by the scope-ownership
lock** — the scope-lock never makes pair A wait on pair B (or vice versa) when they resolve to
different scopes. This is distinct from, and unaffected by, `EntryPackageCorrelationRepository`'s
existing single-writer FIFO `writeQueue` (`entryPackageCorrelationRepository.ts:20-23`), which
already serializes the *physical append* to the one shared JSONL file across every key, scope or
pair alike, before and after this change. This change does not remove, add to, or otherwise touch
that pre-existing queue; two different scopes' acquisitions are not serialized by the mechanism this
change introduces, not literally executed in parallel at the I/O layer.

The scope-lock is never held across a Bybit call or a confirmation retry loop (which includes
`sleep()`s in `packageConfirmation.ts`) — repeating the exact mistake already found and fixed once
for the pair-lock ("unbounded REST calls that could hold the keyed mutex indefinitely",
`abi-entry-package-execution-v1` design.md) for a second lock would be a regression, not a new bug.

### 5. Lock ordering invariant: pair-lock outer, scope-lock inner, never reversed

Deadlock-freedom rests on one invariant, stated explicitly so future changes touching either lock
preserve it: **a scope-lock is only ever acquired while a pair-lock is already held for the same
request, and no code path acquires a pair-lock while holding a scope-lock.** Concretely: the scope
lock is acquired exclusively inside `createOrder()`, which is only ever reached from within
`apply()`'s pair-locked `process()` call, and `createOrder()`'s scope-locked critical section never
calls back into `apply()` for any pair (its own or another's).

Given that invariant, two concurrent requests from different pairs contending for the same scope
each hold a *different* pair-lock and wait only on the *shared* scope-lock — there is no cycle
(neither holds the scope-lock while waiting on the other's pair-lock), so they simply serialize on
the scope-lock and one of them observes the other's claim. A request never needs a second scope-lock
while holding one (a pair's ticker, and therefore its scope, is immutable for the pair's lifetime,
confirmed by the existing ticker-mismatch rejection in `process()`), so there is no possibility of
two scope-locks being held simultaneously by the same logical operation either. This is a standard
fixed-order two-level lock hierarchy; it is proven deadlock-free by construction, not by testing, but
a stress test (Decision-adjacent, see `tasks.md`) exercises it as a liveness sanity check.

### 6. Durable-before-exchange-write: the claim *is* the existing provisional write

No new durable write is introduced. The existing sequence inside `createOrder()` —

```
resolve identity
...
await correlationRepository.save(provisional)   // status: "pending_create", already exists today
...
executeEntryOrder(...)                          // first exchange write, already exists today
```

is restructured only by moving the ownership decision to wrap the existing `save()` call:

```
await scopeMutex.withKeyLock(positionScopeKey(identity), async () => {
  const owner = correlationRepository.findOwnerByScope(identity.category, identity.symbol);
  if (owner !== undefined && !isSamePair(owner, command) && !isDurablyClosedEntryPackageStatus(owner.status)) {
    return { kind: "conflict" };
  }
  await correlationRepository.save(provisional);   // this write both claims the scope
                                                     // (via indexRecord's byScope update) and
                                                     // remains the existing pre-exchange-call record
  return { kind: "claimed" };
});
// on "conflict": return internalErrorResult() — no Bybit call, matching every other
// fail-before-exchange-call path already in this service (ticker mismatch, terminal_unfilled reentry)
```

This preserves the exact "durably persist a record of the intended action before contacting the
exchange" requirement `entry-package-execution`'s spec already states, and adds nothing to what gets
persisted — only a guard on *whether* that persist (and the exchange call that follows it) is
allowed to happen at all for this particular scope right now.

### 7. Release rule: reuse the existing durably-closed bucket; no new status; conservative by default

Scope release predicate: `record.status ∈ {"absent", "terminal_unfilled"}` — precisely
`OpenPositionResolutionService.classifyStatus()`'s existing `durably_closed` bucket. No new status
value is introduced. Every other status — including `unknown` (an exception during a create/amend
call whose Bybit-side outcome is genuinely unproven), `pending_cancel`/`pending_replace`
(live-query-admissible; a position may exist), and the `applied` status a full or partial fill
resolves to — keeps the scope held. This is deliberately the same predicate already implicit in
`classifyStatus`, not a new parallel judgment that could silently diverge from it over time —
Decision 10 extracts it into one shared helper consumed by both, rather than leaving two
independently-maintained lists of the same two statuses.

**What this change explicitly does not attempt:** once a pair's status is `applied` because a fill
was observed (full or partial), nothing in this change ever releases that pair's scope again — there
is currently no status transition out of `applied` other than through an explicit Runtime `CANCEL`,
which `entry-package-execution`'s existing behavior only allows to reach `absent` via
`cancelLiveOrder`, and that path is for cancelling a still-*unfilled* live order, not for closing an
existing position (`confirmEntryPackageCancelled`'s `filled_before_cancel` outcome routes back to
`applied`, never to `absent`, specifically because a real fill exists). Concretely, this means: after
a fill, this change holds the scope conservatively forever, until a future change adds a durable,
proof-carrying path (Runtime-commanded close execution, TP/SL execution, or exchange-side
close/liquidation/ADL detection) that can transition the record to a new terminal state meaning "the
position that once existed here is now durably gone." Designing that transition — its name, its
proof requirements, and which of `close`/`protection` execution or a new reconciliation path
produces it — is explicitly deferred to the position-management changes this change is a
prerequisite for, not decided here.

### 8. Replay/restart semantics: two explicit phases — effective state first, ownership second

**Rejected approach (caught in review): incremental per-line `byScope` update during replay.**
An earlier draft of this design had `replay()` reuse Decision 2's live claim/release step on every
line, in file order, exactly as `save()` does. This is unsound, not merely imprecise: an
intermediate line in the middle of the file can legitimately show a scope moving between pairs
*before* the file reaches its final state, and reacting to that intermediate moment produces the
wrong answer whichever way it is handled. Concrete counter-example:

```
line 1: A/A1  BTC  applied            <- A is holding BTC at this point in the file
line 2: B/B1  BTC  pending_create     <- if replay reacts to *this line* as "current" state,
                                          it must either (a) treat this as an immediate
                                          cross-pair conflict and fail closed, even though the
                                          file goes on to resolve it cleanly two lines later, or
                                          (b) silently overwrite A's claim with B's without ever
                                          checking whether A ever legitimately released it
line 3: A/A1  BTC  absent             <- A's real, final state: released
```

The correct final answer for this file is unambiguous — pair A is durably closed, pair B is the
sole current owner of BTC, no conflict exists — but only if ownership is evaluated from each pair's
**latest** record, never from an intermediate one a later line for the same pair has since
superseded. Line-by-line incremental replay cannot tell "intermediate" from "final" without looking
ahead, so it is the wrong tool for this job even though it is exactly the right tool for live writes
(Decision 2), where there is no "later line" yet to arrive.

**Adopted approach: two explicit phases, decoupled from the live write path.**

```
Phase 1 — effective state per pair (unchanged from today's replay)
  read every valid line in file order
  byCompositeKey.set(pair, record)     for every line   -> final value = each pair's LATEST record
  byOrderLinkId / byOrderId updated exactly as today (append-only, unaffected)
  (byScope is not touched in this phase at all)

Phase 2 — ownership, computed once, only from the results of Phase 1
  byScope.clear()
  for each record in byCompositeKey.values():     // exactly one record per pair: its latest
      if record is durably closed (Decision 7 predicate): skip — this pair holds no scope
      else:
          scope = positionScopeKey(record)
          existingOwner = byScope.get(scope)
          if existingOwner is undefined:            byScope.set(scope, record)   // claim
          else if existingOwner.pair == record.pair: byScope.set(scope, record)  // same pair, ok
          else:                                      FAIL replay: conflicting owners for `scope`
```

Phase 2 answers the counter-example correctly: `byCompositeKey` ends Phase 1 holding pair A's
*line-3* record (`absent`) and pair B's *line-2* record (`pending_create`) — line 1 was already
superseded within Phase 1 by the ordinary "last write wins" semantics `byCompositeKey` already has
today. Phase 2 then sees exactly one durably-open record for BTC (pair B's) and zero conflict.

Live writes (Decision 2) and replay (this decision) now intentionally use two different procedures
to reach the same kind of answer, but there is still exactly one source of truth: `byCompositeKey`'s
"latest record per pair" is what both procedures ultimately act on — live writes just don't need a
separate phase because, by construction (pair-lock + scope-lock ordering, Decisions 4-5), a live
`save()` call's record is *always* already the latest one for its pair the instant it is written,
so there is no "line 2 vs. line 3" ambiguity to resolve for live traffic in the first place. Only
historical replay ever needs to look at more than one record per pair before deciding.

**Genuine conflict, not sequencing.** With Phase 2, `replay()` reports a conflict — returns `{ok:
false, reason: "..."}` — only when two *different* pairs' **latest** records both claim the same
scope and neither is durably closed. This is already wired to
`EntryPackageReadiness.markNotReady()` — the service starts, legacy/account routes keep working, but
`entryPackageReady` (and therefore this change's own acquisition path) stays false until the
conflict is manually resolved. Because this can now only happen when the durable log's *final* state
is genuinely contradictory (a bug predating this change, manual file edits, or a hypothetical
multi-writer accident), not merely because of an intermediate historical moment, this is an
extension of the existing "fail readiness on any non-final corruption" policy to a new class of
corruption (semantic/cross-record, evaluated on final state), not a new readiness mechanism and not
a source of false positives from ordinary sequential scope reuse.

Sequential historical reuse of one scope by pairs that have since durably closed is explicitly *not*
a conflict, exactly per the counter-example above: pair A's record reaching `absent` before pair B's
`pending_create` record for the same scope appears later in the log resolves cleanly in Phase 2,
because Phase 1 already reduced pair A to its final `absent` record before Phase 2 ever runs.

No additional state needs to be persisted for restart recovery beyond what `save()` already writes
today — ownership is a pure, deterministic function of the replayed records plus the release rule in
Decision 7, so "the in-memory index was lost" and "the process just started" are indistinguishable
inputs to the same two-phase reconstruction, by construction.

**Phase 2 fails closed on a semantically corrupted active record, not just a shape-invalid one
(post-implementation review correction).** `isValidEntryPackageExecutionRecord` accepts
`exchange_category: ""` for *any* status — it only checks the field is one of `"", "linear",
"spot"`, not that `""` co-occurs only with a durably-closed status the way
`entryPackageExecutionRecord.ts`'s own comment describes (`""` only for a record that has never had
a real binding, i.e. `persistAbsentNoHistory`, which always pairs it with `status: "absent"`). The
original Phase 2 unconditionally `continue`d past any record whose `exchange_category` was not
`"linear"`/`"spot"`, regardless of status — a schema-valid-but-semantically-corrupted line (`""` or
an empty `exchange_symbol` under a real category, paired with a non-durably-closed status) would be
silently excluded from ownership reconstruction instead of failing readiness, understating an actual
held scope. No current write path produces this shape (`createOrder()` always sets a real
`category`+`symbol` before any status other than `absent` is possible), but replay is this
capability's correctness-critical path precisely for inputs the live paths don't produce, so Phase 2
now treats it the same way `replay()` already treats shape-invalid JSON: `exchange_category` not
`"linear"`/`"spot"`, or a `"linear"`/`"spot"` category with an empty `exchange_symbol`, is valid only
when durably closed; found on a non-durably-closed record, it fails replay the same way a genuine
cross-pair conflict does, rather than being silently skipped.

### 9. HTTP contract: unchanged; conflict reuses the existing `internal_error`

A scope-acquisition conflict returns the existing `internalErrorResult()`
(`src/domain/entryPackageApi.ts`) — the same response shape already used for ticker mismatch,
terminal-without-fill reentry, and every other "fail before any exchange call" outcome in
`EntryPackageApplicationService`. No new public error code, DTO field, or route is introduced. This
is a deliberate trade-off (see Risks) in favor of "public HTTP contract does not change" over
"Runtime can distinguish a scope conflict from other internal failures by error code alone."

### 10. One shared `isDurablyClosedEntryPackageStatus` predicate, not two independent lists

`{"absent", "terminal_unfilled"}` is not an incidental coincidence between two features — it is one
domain fact ("this pair's binding is durably proven to admit no position") that both
`OpenPositionResolutionService.classifyStatus()`'s `durably_closed` bucket and this change's scope
release rule (Decision 7) need. Reviewed and decided: extract it once, in
`src/correlation/entryPackageExecutionRecord.ts` next to the status type it classifies:

```ts
export function isDurablyClosedEntryPackageStatus(status: EntryPackageExecutionStatus): boolean {
  return status === "absent" || status === "terminal_unfilled";
}
```

`OpenPositionResolutionService.classifyStatus()`'s `durably_closed` branch and the new scope
claim/release logic (Decisions 2 and 8) both call this function instead of each spelling out the
same two-element set independently. This is a same-behavior extraction, not a redesign of
`open-position-resolution`: `classifyStatus()`'s inputs, outputs, and every existing test for it are
unchanged — only where the literal set is spelled out moves from two places to one. Because the
observable behavior of `open-position-resolution` does not change, this does not need a MODIFIED
capability entry in `proposal.md`; it is disclosed there as a small touched-file, not a behavior
change.

## Risks / Trade-offs

- [Reusing `internal_error` for a scope conflict gives Runtime no way to distinguish "another cycle
  already owns this symbol" from an unrelated internal failure by response code alone] → Accepted
  for this change per the stated goal of not touching the public contract (see Review Resolutions
  §1): a scope conflict signals a V1 operating-boundary violation Runtime has no legitimate
  business-logic branch for, not a new case it should react to differently.
- [An earlier draft of this design reused the live per-line claim/release step for `byScope`
  reconstruction during replay] → Not accepted, corrected in Decision 8: this was unsound (an
  intermediate historical line can show a scope legitimately mid-transfer between pairs before the
  file's final state resolves it), not merely imprecise. Fixed by evaluating ownership only from
  each pair's latest record (two explicit phases), never from an intermediate one.
- [Holding a scope conservatively forever after any fill, with no release path designed yet, could
  in principle let a single stuck `applied` record block a symbol indefinitely if a future close
  path is delayed] → Accepted and explicit: correctness (never letting a second cycle collide with a
  real position) outweighs availability here, and this is exactly the boundary the next
  position-management change is expected to close, not a defect of this one.
- [A second in-process `KeyedMutex` instance adds a small amount of composition-root wiring and one
  more invariant (lock ordering) engineers must preserve] → Accepted: the alternative (a single
  shared mutex keyed by a prefixed string) buys no additional safety and only trades an explicit
  second instance for an implicit keyspace-collision risk.
- [Multi-process ABI would defeat this change's in-process locking exactly as it would already defeat
  the existing pair-level `KeyedMutex`] → Not a new risk introduced by this change; multi-process ABI
  is already an explicit non-goal per `abi-entry-package-execution-v1`'s design.md, unchanged here.

## Migration Plan

Purely additive. No existing `EntryPackageExecutionRecord` field changes, no on-disk format change,
no existing route or DTO changes. The correlation file's existing content already contains
everything `byScope` needs; on first deploy, the next replay simply builds one more index from
already-present data. Rollback is a plain revert of the composition-root wiring and
`EntryPackageApplicationService` guard; no data migration or backward-incompatible state is created
in either direction.

## Review Resolutions

This design went through one review pass before implementation. The blocking finding (replay
correctness) is fixed in place in Decision 8 above, not merely noted here — the version of Decision
8 in this document is already the corrected one. The five points raised alongside it are closed
with an explicit decision each, so none remain open:

1. **Public error code for a scope-acquisition conflict?** Resolved: no. Stays `internal_error`
   (Decision 9). A scope conflict is a V1 operating-boundary violation, not a case Runtime should
   have its own branch for.
2. **Shared release-predicate helper instead of two independent lists?** Resolved: yes — implemented
   in this change (Decision 10), not deferred. `{"absent", "terminal_unfilled"}` is one domain fact
   with two consumers, not two coincidentally-identical lists; `open-position-resolution`'s own
   behavior and spec are unchanged by this extraction.
3. **Dedicated `PositionScopeGuard` class?** Resolved: no. `PositionScope` (Decision 1) +
   `findOwnerByScope` (Decision 2) + `scopeMutex` (Decision 4) + the inline decision step in
   `createOrder()` (Decision 6) is the full mechanism; a class would add a name and wiring without
   adding architectural value at V1's scope.
4. **`accountId` in `PositionScope` now?** Resolved: no. One ABI process is already exactly one
   configured Bybit account; adding a field for a dimension that cannot currently vary is scope
   creep. Additive later if ABI ever supports multiple accounts per process (Decision 1).
5. **Non-locked early ownership check before the position-sizing call?** Resolved: no. It is a minor
   efficiency optimization (saves one wasted network round-trip for the losing pair), not a
   correctness requirement — the authoritative check under the scope lock is unconditionally
   required regardless of whether this optimization exists. Not worth the added code path at V1.

One wording correction from the same review, applied throughout this document, `proposal.md`, and
the capability spec: this change does not make different scopes execute "fully concurrently" or
"in parallel" — it specifically ensures the new scope-ownership lock does not serialize them against
each other. `EntryPackageCorrelationRepository`'s existing single-writer append queue for the shared
JSONL file (`entryPackageCorrelationRepository.ts:20-23`) is untouched by this change and continues
to serialize physical writes regardless of scope, exactly as it does today.
