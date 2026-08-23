## Context

See `proposal.md` for Why/What. This document resolves exactly one thing: how ABI's existing,
already-durable, own-entry-order fill facts for a `(strategy_instance_id, trade_cycle_id)` pair
become a formalized, invariant-enforced record later changes can trust — without adding stored state
for facts that either already exist correctly, or are not yet needed by any change this one unblocks.
It intentionally stops short of everything `docs/virtual-exposure-ownership-delivery-plan.md` assigns
to Changes 2-8: no close/open-position/protection/recovery behavior change, no relaxation of
`position-scope-exclusivity`, no HTTP contract change, no Runtime change.

### Repository state relevant to this design (verified by reading the code, not assumed)

- `EntryPackageExecutionRecord` (`src/correlation/entryPackageExecutionRecord.ts:75-104`) already
  carries `desired_entry: DesiredEntryDto | null` (includes `side: "long" | "short"`),
  `calculated_quantity`, `status`, and `early_execution_observation: EarlyExecutionObservation |
  null`.
- `EarlyExecutionObservation` (`entryPackageExecutionRecord.ts:53-59`) already exists:
  ```ts
  export type EarlyExecutionObservation = {
    order_status: string;
    cumulative_filled_qty: string;
    remaining_qty: string;          // remaining of the DESIRED/calculated entry qty still
                                     // unfilled — NOT this cycle's owned position exposure.
                                     // See Decision 3.
    avg_execution_price?: string;
    observed_at: string;            // when this observation was taken — a diagnostic
                                     // timestamp, not part of virtual-exposure accounting.
                                     // See Decision 0.
  };
  ```
- It is built by `toObservation()` (`packageConfirmation.ts:366-385`) directly from a fresh query of
  **this cycle's own order** (`item.cumExecQty`, `item.avgPrice`, `item.orderStatus` — Bybit's
  `/v5/order/realtime` or `/v5/order/history` response for this order's own `orderLinkId`), never
  from a position query. It is durably written (`entryPackageApplicationService.ts:605-611,550-561`)
  at exactly three points, all already-existing, none newly invented by this change: initial create
  confirmation, repeat-PUT revalidation (the same code path — `confirmEntryPackage` is re-run against
  the same `orderLinkId` every time, so this is a full requery, not a cached read), and a CANCEL-
  intent request discovering a fill instead of a clean cancel.
- `PartiallyFilled` is explicitly a **live**, non-terminal order status:
  `PARTIAL_FILL_STATUSES = new Set(["PartiallyFilled"])` (`packageConfirmation.ts:24`) is included in
  `isLiveOrderStatus()` (`packageConfirmation.ts:234-236`), with the adjacent comment
  (`packageConfirmation.ts:220-227`) stating explicitly: "only a live status (new/untriggered/
  triggered, or a still-open partially-filled state) can still add exposure." `isTerminalOrderStatus()`
  (`packageConfirmation.ts:230-232`) is `FILLED_STATUSES ∪ TERMINAL_WITHOUT_FILL_STATUSES` — i.e.
  `Filled`, or one of `Rejected | Deactivated | Cancelled`.
- Both `partial_fill` and `full_fill` confirmation outcomes write the identical
  `status: "applied"` (`entryPackageApplicationService.ts:605-611`). A third case also reaches
  `status: "applied"` with `early_execution_observation` left `null`: `pending_confirmed`
  (`entryPackageApplicationService.ts:594-602`) — the order is live and confirmed, but has not filled
  at all yet. **Consequence: `status === "applied"` alone never tells you whether any exposure exists,
  let alone whether it is final.** The only trustworthy signal is `early_execution_observation` itself
  (present or not, and its own `order_status`).
- `early_execution_observation` is written **only** at the three points above, and only on a
  *positive, definitive* new observation. Every other write path that reaches `save()` with an
  unresolved outcome (`unknown`, ambiguous confirmation, a query failure) spreads `...record` first
  and never overwrites `early_execution_observation`
  (`entryPackageApplicationService.ts:632-638,564`), i.e. it is left exactly as it was. It is only
  ever reset to `null` by `persistAbsentNoHistory` / `persistTransitionToAbsent`, and — verified by
  reading every call site — those two functions are only ever reached when the binding is durably
  proven to have **no** fill (`terminal_unfilled`, or a cancel confirmed with `cancelled_confirmed`,
  never `filled_before_cancel`). **Consequence: `early_execution_observation`, once non-null, is never
  silently regressed, and is never nulled out while real exposure exists.**
- A new generation (rebind) is only ever created from `record === undefined` or `record.status ===
  "absent"` (`entryPackageApplicationService.ts:172-182`). Every other non-null-desired-entry change
  against an existing live/confirmed binding is served **exclusively** by cancel — "no in-place
  amend, no atomic cancel-and-create... a new desired entry is only applied by a later, independent
  PUT for a trade cycle with no existing binding" (`entryPackageApplicationService.ts:198-203`).
  Combined with the previous point (absent ⇒ no fill ever occurred for that binding), this proves a
  fact this design leans on directly: **a cycle's fill facts never need to be carried across
  generations.** Generation N+1 only ever begins from a state that contributed zero exposure, so
  "this generation's fill facts" and "this cycle's currently owned exposure" are the same thing.
- `EntryPackageCorrelationRepository` (`entryPackageCorrelationRepository.ts`) is a single-writer
  append-only JSONL log with four in-memory derived indexes rebuilt on `replay()`. `save()` appends
  then calls `indexRecord()` then `applyScopeClaimOnWrite()`. `isValidEntryPackageExecutionRecord`/
  `isValidEarlyExecutionObservation` (`entryPackageExecutionRecord.ts:152-216`) validate *shape* only
  — no cross-record or cross-field semantic invariant is checked anywhere today.
- `position-scope-exclusivity`'s existing requirement "Scope ownership is derived from existing
  durable correlation state, not a new store" states ABI "SHALL NOT introduce... a new persisted
  field on the correlation record" as part of how scope *ownership* is computed. Nothing in this
  change touches that requirement: no field is added at all (Decision 0), and the one new query this
  change does add (Decision 6) is not read by, and does not participate in, ownership computation.

## Goals / Non-Goals

**Goals:**
- Formalize the own-order-sourced fill facts ABI already durably records
  (`cumulative_filled_qty`, `avg_execution_price`, `order_status`) into a record later changes can
  trust — without adding new stored fields for facts that already exist and are already sourced
  correctly.
- Define, precisely enough that Change 2/3/4 need no architectural guesswork, how a consumer decides
  whether those facts are *final* (the entry order can no longer add exposure) versus a snapshot that
  may already be stale.
- Enforce the one invariant that makes the fact trustworthy at all: `cumulative_filled_qty` never
  regresses, live or on replay.
- State, as an explicit architectural decision (not an implementation), the boundary this whole
  program is built on: per-cycle absolute exposure quantity is ABI-private state; Runtime expresses
  relative intent; ABI resolves the absolute quantity. Change 1 states this boundary; it does not
  implement any of the mechanism that boundary implies.
- Survive restart using only what `replay()` already reconstructs — no new durable store, no schema
  migration subsystem.
- Leave every current production code path — claim policy, close, open-position, protection,
  recovery, Runtime, and every public HTTP contract — byte-for-byte unchanged.

**Non-Goals** (all explicitly deferred, most to specific later changes in
`docs/virtual-exposure-ownership-delivery-plan.md`):

- `first_fill_at_ms` / a durable "first-observed" timestamp of any kind, and entry-strategy-bar
  identification for Strategy Engine. See Decision 0 for why this is a deliberate exclusion, not an
  oversight: ABI's own first-observation time is not a reliable proxy for "which strategy bar this
  trade began on" (ABI may not observe a fill until after a later bar has already opened), so
  approximating it here would produce a value that looks precise but is not fit for that purpose.
  Change 3 is responsible for investigating what own-order/execution evidence *is* sufficient for
  correct entry-bar identity — as a Change 3 question, not solved or pre-empted here.
- Any change to Runtime or MDS, including any ABI → Runtime fill push/callback.
- Absolute exchange quantity ever being sent to or stored by Runtime.
- A `close_fraction` (or equivalent relative-intent) HTTP contract, or any other public HTTP contract
  change.
- Pair-scoped close, and pair-owned close of any kind.
- Partial close of one's own exposure, and any durable mutable "owned remainder" field — see
  Decision 3.
- Removing or relaxing `position-scope-exclusivity`; same-side multi-owner activation; opposite-side
  policy.
- Any change to `GET .../open-position`'s behavior or response.
- Recovery attribution redesign.
- Protection execution, pair-owned protection, or conditional stop/take orders.
- A new durable store, or any background fill-polling/reconciliation process.

## Decisions

### 0. No new fields on `EarlyExecutionObservation` — formalize what already exists, add nothing

**Superseded approach (an earlier draft of this change, before this revision):** add a new
`first_observed_at` field, immutable once set, plus a `mergeExposureObservation` helper to carry it
forward across observations. **Removed entirely**, for a reason stronger than "not yet needed":
`observed_at` is *when ABI last queried the order*, and a would-be `first_observed_at` would be *when
ABI first queried it and saw a fill* — neither is, or was ever going to be, the fact Runtime/Engine
actually need (which strategy bar a trade's entry belongs to). Introducing a durable field to
approximate that fact here would have been actively misleading: ABI's own observation timing lags
real fill timing by an unbounded, unmeasured amount (bounded confirmation retries, repeat-PUT timing,
process scheduling), so "first time ABI observed a fill" is not "first time the fill happened," and
using it as an entry-bar proxy could silently attribute a trade to the wrong bar. That decision
belongs entirely to Change 3, once it has investigated what evidence is actually fit for purpose —
not pre-decided here by shipping a field whose only role was to look like foundation work for a
requirement it does not correctly satisfy.

**Adopted:** `EarlyExecutionObservation`'s shape does not change at all. `cumulative_filled_qty` and
`avg_execution_price` already satisfy every semantic requirement virtual-exposure accounting needs
(exact-decimal, own-order-only sourcing, may grow/change until the order is final, never taken from
the aggregate position) with zero new code. This change adds only: read-time derivations (Decisions
1, 4), validation of an invariant the field already satisfies by construction (Decision 7), and one
additive query (Decision 6). No write path changes shape.

### 1. `physical_side`: not a stored field — derived from `desired_entry.side`

Derive it from `record.desired_entry.side` at read time. Safe only because of a specific, verified
invariant (Context): `desired_entry` is only ever nulled by `persistAbsentNoHistory`/
`persistTransitionToAbsent`, and both are only reached when the binding is durably proven to have
**no** fill. The one path that discovers a fill during a cancel attempt (`filled_before_cancel`)
explicitly does not null `desired_entry` — it spreads `...record` and only overrides `status`/
`pending_action`/`early_execution_observation`/`updated_at`
(`entryPackageApplicationService.ts:554-560`). So: whenever `early_execution_observation` is
non-null (exposure exists), `desired_entry` is guaranteed non-null and its `side` is this cycle's
side. A consumer needing "this cycle's side" reads `record.desired_entry?.side`; if exposure exists
this is never `undefined`. No new field, no duplication, no drift risk between two copies of the same
fact.

### 2. Finality: derive on-demand from the already-durable `order_status`, not a new flag

`early_execution_observation.order_status` is already the raw Bybit order status string from the last
confirmed observation, already durably written at exactly the points that would populate a dedicated
flag — a flag would be a redundant restatement of information this field already carries. New pure
predicate, next to `isTerminalOrderStatus`/`isLiveOrderStatus` in `packageConfirmation.ts`:

```ts
export function isFillFactFinal(observation: EarlyExecutionObservation | null): boolean {
  return observation !== null && isTerminalOrderStatus(observation.order_status);
}
```

Semantics a later change must follow, stated explicitly so none of them have to re-derive this:
- `observation === null`: no exposure has ever been observed for this binding.
- `observation !== null` and `isFillFactFinal(observation)` is **true** (order reached `Filled`, or a
  terminal-without-fill status observed after a fill had already been recorded): Bybit order statuses
  do not un-terminalize, so this is a **permanent** fact; `cumulative_filled_qty`/`avg_execution_price`
  at that observation are final and may be trusted without re-querying.
- `observation !== null` and `isFillFactFinal(observation)` is **false** (a live status, most commonly
  `PartiallyFilled`): the recorded facts are a snapshot only, `cumulative_filled_qty` is **not**
  authoritative as a settled total, and a consumer needing an authoritative current answer must force
  or re-check terminality first, using the existing `classifyEntryOrderTerminality`/
  `confirmEntryPackage` machinery a later change already has access to. This change invents no new
  query mechanism; it only defines the contract those existing mechanisms feed.

**Rejected: a new durable finality boolean** — pure duplication of what `order_status` already
proves. **Rejected: always re-derive live, never durable** — this change's whole point is a fact a
consumer can trust without an exchange round-trip in the terminal case; forcing every read through a
live query would make durably recording `cumulative_filled_qty`/`avg_execution_price` pointless.

### 3. Quantity ownership boundary: an architectural decision, not an implementation

This is the load-bearing decision the rest of the program (Change 2 onward) is built on, stated here
because Change 1 is where "whose responsibility is exposure quantity" first has to be answered
precisely, even though Change 1 implements none of the mechanism:

> Per-cycle absolute fill/exposure quantity is ABI-private execution state. Future Runtime management
> commands express relative intent for the identified trade cycle. ABI resolves that intent into an
> absolute exchange quantity from its own authoritative per-cycle state.

Concretely, for a future close (Change 2's problem, not this change's): Runtime expresses "close this
trade cycle" (or a documented fraction of it) without ever knowing or sending an absolute BTC
quantity; ABI resolves that intent against its own attribution (this change's `cumulative_filled_qty`,
once `isFillFactFinal`) and materializes the actual `reduceOnly` Bybit quantity. Runtime is never
handed an absolute quantity to hold and echo back.

**Consequence for the "owned remaining quantity" field the original master-plan sketch proposed:**
not introduced in this change, and not introduced merely to exist ahead of need. Until a real partial-
close lifecycle exists, a cycle's owned exposure has exactly two states: open (`cumulative_filled_qty`
once final) or terminally closed (`0`, implied by `status` alone — no field needs to durably say "0",
since `isDurablyClosedEntryPackageStatus` already durably says "no position"). A separate *mutable*
remainder is only a distinct fact from "final cumulative fill" once something can reduce it by less
than the whole — i.e. once partial close exists. `docs/virtual-exposure-ownership-delivery-plan.md`'s
Change 2 is explicitly recommended (see that document) to support full close only (canonical fraction
= 1) for its first version, specifically so it does not need this field either, unless a real,
demonstrated need for partial close later forces the question. This change does **not** decide
whether partial close ever happens — only that nothing in this change's own scope needs the field it
would require.

**What Change 1 explicitly does not do, restated for traceability:** does not modify Runtime, does
not modify any HTTP contract, does not implement `close_fraction` or any relative-intent wire shape,
and does not design Change 2's request contract. All of that is Change 2's own design work, informed
by this boundary statement, not pre-empted by it.

### 4. `remaining_qty` (existing) vs. this change's "owned exposure" concept — explicitly distinct

`EarlyExecutionObservation.remaining_qty` already exists and already means "how much of the *desired/
calculated* entry quantity is still unfilled" (`toObservation`: `desiredQty - cumulativeFilledQty`,
`packageConfirmation.ts:368-371`) — an entry-order-fill-progress fact, unrelated to how much of an
already-filled position a cycle currently owns. This change does not rename, repurpose, or add a
second field with a colliding name; Decision 3 above is stated precisely to avoid a future reader
conflating the two.

### 5. `byScope` (the derived scope-ownership index) is not touched by this change

None of the three consumer-prep changes this foundation unblocks (`abi-pair-scoped-close-execution-v1`,
`abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1`) need a
multi-owner scope index — they need per-cycle fill facts (Decisions 0-2, 4), independent of how scope
ownership is indexed. `byScope`/`findOwnerByScope`/`applyScopeClaimOnWrite`/
`rebuildScopeIndexFromReplay` (`entryPackageCorrelationRepository.ts:30,124-126,179-197,205-257`) are
exactly the mechanism `position-scope-exclusivity`'s existing, still-fully-in-force requirements
describe; leaving every line untouched is the simplest possible proof this change does not alter
scope-ownership behavior. Deferred to the program's later activation change, which is the first
change with a genuine consumer for a multi-owner `byScope`.

### 6. `findActiveRecordsForScope`: a computed query, not a new maintained index

New repository method, additive only:

```ts
findActiveRecordsForScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord[]
```

Implemented as a plain linear scan over `byCompositeKey.values()` (already the authoritative "latest
record per pair" collection), filtering to records whose resolved scope matches and whose status is
not durably closed (`isDurablyClosedEntryPackageStatus`, reused, not reimplemented). No new mutable
index is introduced — a query over already-correct state, not a second structure that could drift out
of sync with it. In production today this can only ever return zero or one record (claim policy is
unchanged — Decision 5); in a repository-level test, two same-side records can be seeded directly
(bypassing `EntryPackageApplicationService`'s claim guard entirely) to prove the method has no
single-owner assumption baked in.

### 7. Monotonicity: `cumulative_filled_qty` never regresses, enforced live and on replay

**Live-write path (`save()`):** before appending, if a record already exists for the same pair
(`byCompositeKey.get(...)`) and both the existing and new record carry a non-null
`early_execution_observation`, `save()` rejects (throws) the write if the new
`cumulative_filled_qty` is less than the existing one (exact-decimal comparison via `compareDecimal`
from `src/domain/exactDecimal.ts`, the same primitive `packageConfirmation.ts` already uses).

This is a defensive assertion against a future application-service bug, not a new
externally-observable outcome for any current call site: every current write path already satisfies
this invariant by construction (`cumulative_filled_qty` is sourced from Bybit's own monotonic
`cumExecQty` for the same order at every observation point). The check exists so a violation fails
loudly and immediately, not silently, and not only discovered three restarts later.

**Replay path:** Phase 1 (`entryPackageCorrelationRepository.ts:60-96`) already processes every valid
line for a pair in file order, `byCompositeKey.set()`-ing each in turn — the same opportunity live
writes get, to compare "this line" against "the previous line for this pair," is already present in
that loop. Extend it: immediately before each `indexRecord()` call, if the previously-indexed record
for the same pair had a non-null `early_execution_observation`, apply the same check as the live path
against this line's record. A violation fails replay closed (`{ok: false, reason: ...}`) the same way
existing structural/schema corruption already does — a new instance of the same existing "fail
readiness on non-final corruption" policy, not a new readiness mechanism.

`avg_execution_price` is deliberately **not** subject to a monotonicity check — it is not required to
move in one direction (a new fill at a different price legitimately moves the cumulative average
either way) — only its co-occurrence with a non-decreasing `cumulative_filled_qty` matters, and that
is already what is being checked.

This mirrors `position-scope-exclusivity` design.md Decision 8's lesson (evaluate from final state,
not an intermediate line) by *not* needing to apply it here: unlike scope ownership (which can
legitimately move between different pairs across lines), a single pair's own fill-fact sequence has
no legitimate "intermediate disagreement" case — every line for the same pair is either a compatible
continuation of the previous line or it is real corruption, so line-by-line comparison in file order
is correct and sufficient.

## Risks / Trade-offs

- [Dropping `first_observed_at` means no OpenSpec change in this program will durably record when
  ABI first observed a fill] → Accepted, deliberately: no consumer this program has actually
  specified needs that fact (Decision 0); the one candidate use (entry-bar identity for Engine) is
  explicitly not solved by that fact, so recording it would have shipped state that answers a
  question no one actually has.
- [Deferring the "owned remaining quantity" field means Change 2 will need to make a real design
  decision about what it introduces, rather than reusing an existing field this change could have
  pre-built] → Accepted: Decision 3 gives Change 2 everything it needs to make that decision — the
  contract, the recommended full-close-only V1 scope, and the reason a field would currently be
  redundant — without this change guessing at a shape Change 2 has not yet designed.
- [The live-write monotonicity check in `save()` is new authority for the repository to reject a
  write it previously always accepted] → Accepted: every current call site already satisfies the
  invariant by construction, so this is provably a no-op for existing behavior; it only starts
  mattering if a future bug is introduced, which is exactly the point of adding it now.
- [`findActiveRecordsForScope` is dead code in production until a later change consumes it] →
  Accepted, explicitly: it exists to prove a capability the delivery-plan's required test coverage
  calls for, ahead of any production consumer, matching the plan's own "prepare consumers on
  synthetic fixtures before activation" strategy for this whole program.

## Migration Plan

Purely additive, and smaller than an earlier draft of this change: no field on
`EntryPackageExecutionRecord` or `EarlyExecutionObservation` changes shape or is added; no existing
route, DTO, or on-disk record shape is touched at all. The only new runtime behavior is (a) two pure
predicates/queries (`isFillFactFinal`, `findActiveRecordsForScope`) that read existing fields, and (b)
one new rejection path in `save()`/`replay()` that is unreachable by any current write path. Rollback
is a plain revert of those additions; no data becomes unreadable in either direction.
