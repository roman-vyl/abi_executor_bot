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
  is the exact partition this change reuses for scope release (Decision 6).
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

This runs on every `save()` (live writes) and on every replayed line during `replay()` — the exact
same code path, so there is no separate "rebuild ownership on startup" routine to keep in sync with
the live path. Ownership is a pure function of "the latest durably-written record per pair", which
is already what `byCompositeKey` holds; `byScope` is simply an additional index over the same facts,
never a second source of truth.

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
  if (owner !== undefined && !isSamePair(owner, command) && !isDurablyClosed(owner.status)) {
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
`classifyStatus`, not a new parallel judgment that could silently diverge from it over time; a
follow-up (see Open Questions) considers extracting it into one shared helper.

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

### 8. Replay/restart semantics: ownership is rebuilt, not remembered; conflicting durable state fails closed

`EntryPackageCorrelationRepository.replay()` already indexes every valid line via the same
`indexRecord()` used by `save()` (Decision 2), so `byScope` is reconstructed automatically as a side
effect of existing replay — no new "reconciliation pass" is added. What *is* new: `indexRecord()`,
when called during `replay()`, additionally checks that claiming a scope for the record currently
being indexed does not silently overwrite a **different**, still-active pair's existing claim in
`byScope`. Because replay processes the log in append order and every legitimate release is written
before any legitimate re-acquisition of the same scope (guaranteed by Decision 6 for live writes),
seeing two different pairs both non-durably-closed for the same scope at the end of replay is only
possible if the durable log itself contains a genuine invariant violation (a bug predating this
change, manual file edits, or a hypothetical multi-writer accident). In that case `replay()` returns
`{ok: false, reason: "..."}`, which is already wired to `EntryPackageReadiness.markNotReady()` — the
service starts, legacy/account routes keep working, but `entryPackageReady` (and therefore this
change's own acquisition path) stays false until the conflict is manually resolved. This is an
extension of the existing "fail readiness on any non-final corruption" policy to a new class of
corruption (semantic/cross-record, not just structural/shape), not a new readiness mechanism.

Sequential historical reuse of one scope by pairs that have since durably closed is explicitly *not*
a conflict: pair A's record reaching `absent` before pair B's first `pending_create` record for the
same scope appears later in the log replays cleanly (A releases, then B claims), exactly like the
live-write path.

No additional state needs to be persisted for restart recovery beyond what `save()` already writes
today — ownership is a pure, deterministic function of the replayed records plus the release rule in
Decision 7, so "the in-memory index was lost" and "the process just started" are indistinguishable
inputs to the same reconstruction, by construction.

### 9. HTTP contract: unchanged; conflict reuses the existing `internal_error`

A scope-acquisition conflict returns the existing `internalErrorResult()`
(`src/domain/entryPackageApi.ts`) — the same response shape already used for ticker mismatch,
terminal-without-fill reentry, and every other "fail before any exchange call" outcome in
`EntryPackageApplicationService`. No new public error code, DTO field, or route is introduced. This
is a deliberate trade-off (see Risks) in favor of "public HTTP contract does not change" over
"Runtime can distinguish a scope conflict from other internal failures by error code alone."

## Risks / Trade-offs

- [Reusing `internal_error` for a scope conflict gives Runtime no way to distinguish "another cycle
  already owns this symbol" from an unrelated internal failure by response code alone] → Accepted
  for this change per the stated goal of not touching the public contract; revisit only if Runtime
  demonstrates a concrete need to branch on this specific case (see Open Questions).
- [The scope-release predicate (`absent`/`terminal_unfilled`) duplicates, rather than shares, the
  list already encoded in `OpenPositionResolutionService.classifyStatus()`] → Accepted for this
  change to avoid an unrelated refactor of `openPositionResolutionService.ts`; both lists must be
  kept in sync if the status enum ever changes (flagged in Open Questions, not fixed here).
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

## Open Questions

These do not change the invariant, the approach, or this change's boundary — each has a stated
default this design proceeds with, listed here for explicit review sign-off before
implementation:

1. **Should a scope-acquisition conflict get its own public error code** (e.g. distinguishable from
   generic `internal_error`) instead of reusing the existing one? Default: reuse `internal_error`
   (Decision 9) — flag if Runtime-side product requirements demand otherwise.
2. **Should the release predicate be extracted into one shared helper** (e.g.
   `isDurablyClosedStatus(status)` in `entryPackageExecutionRecord.ts`) consumed by both
   `OpenPositionResolutionService.classifyStatus()` and the new scope-release logic, instead of two
   independently-maintained lists of the same two statuses? Default: duplicate for this change
   (smallest diff); revisit as a follow-up, not blocking.
3. **Should acquisition/ownership logic live in a small dedicated class** (e.g.
   `PositionScopeGuard`) rather than as a method addition to `EntryPackageCorrelationRepository`
   plus inline logic in `createOrder()`? Default: no new class for V1 — the logic is a single
   decision function plus two repository methods; a dedicated class can be introduced later without
   changing the invariant if protection/close need a shared call surface. Flag if code review
   prefers the extraction now.
4. **Should `PositionScope` include an explicit (currently-constant) account field now**, to avoid a
   key-shape change if ABI is ever configured for multiple Bybit accounts per process? Default: no
   — out of scope per "no general refactor", and additive later regardless (Decision 1).
5. **Is a non-locked, best-effort early ownership check worth adding before the (network-bound)
   position-sizing call**, purely to avoid wasted work on the losing pair, given the authoritative
   check still happens under the scope lock right before the durable write regardless? Default: no
   for V1 (simplicity over a minor efficiency gain); explicitly considered and deferred, not an
   oversight.
