## Context

See `proposal.md` for Why/What. This document resolves exactly one thing: a durable, per-`(strategy_
instance_id, trade_cycle_id)` fill-fact record ABI can trust for its own trade cycle's own entry
order, sourced only from that order (never from Bybit's aggregate position), that survives restart,
introduces no new durable store, and does not let `status: "applied"` be mistaken for "exposure is
final." It intentionally stops short of anything `docs/virtual-exposure-ownership-delivery-plan.md`
assigns to Changes 2-8: no close/open-position/protection/recovery behavior change, no relaxation of
`position-scope-exclusivity`, no HTTP contract change.

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
                                     // unfilled — NOT this cycle's owned exposure. See Decision 4.
    avg_execution_price?: string;
    observed_at: string;            // when this observation was taken, not when the first fill
                                     // happened. See Decision 2.
  };
  ```
- It is built by `toObservation()` (`packageConfirmation.ts:366-385`) directly from a fresh query of
  **this cycle's own order** (`item.cumExecQty`, `item.avgPrice`, `item.orderStatus` — Bybit's
  `/v5/order/realtime` or `/v5/order/history` response for this order's own `orderLinkId`), never
  from a position query. It is durably written (`entryPackageApplicationService.ts:605-611,550-561`)
  at exactly three points, all of them already-existing observation points, none newly invented by
  this change:
  1. Initial create confirmation (`confirmAndFinalize` → `persistConfirmationOutcome`, full_fill or
     partial_fill outcome).
  2. Repeat-PUT revalidation of an existing binding (`repeatPutRevalidate` →
     `persistConfirmationOutcome` — the *same* code path as 1; `confirmEntryPackage` is re-run
     against the same `orderLinkId` every time, so this is a full requery, not a cached read).
  3. A CANCEL-intent request discovering a fill instead
     (`confirmCancelOutcomeAndPersist`'s `filled_before_cancel` branch).
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
  ever reset to `null` by `persistAbsentNoHistory` / `persistTransitionToAbsent`
  (`entryPackageApplicationService.ts:641-663,665-...`), and — verified by reading every call site —
  those two functions are only ever reached when the binding is durably proven to have **no** fill
  (`terminal_unfilled`, or a cancel confirmed with `cancelled_confirmed`, never `filled_before_cancel`).
  **Consequence: `early_execution_observation`, once non-null, is never silently regressed, and is
  never nulled out while real exposure exists.**
- A new generation (rebind) is only ever created from `record === undefined` or `record.status ===
  "absent"` (`entryPackageApplicationService.ts:172-182`). Every other non-null-desired-entry change
  against an existing live/confirmed binding is served **exclusively** by cancel — "no in-place
  amend, no atomic cancel-and-create... a new desired entry is only applied by a later, independent
  PUT for a trade cycle with no existing binding" (`entryPackageApplicationService.ts:198-203`, and
  `entry-package-execution` spec's own "A desired-entry change on an existing binding is served by
  cancellation only" requirement). Combined with the previous point (absent ⇒ no fill ever occurred
  for that binding), this proves a fact this design leans on directly: **a cycle's fill facts never
  need to be carried across generations.** Generation N+1 only ever begins from a state that
  contributed zero exposure, so "this generation's fill facts" and "this cycle's currently owned
  exposure" are the same thing — no cross-generation summation is a real scenario to design for.
- `EntryPackageCorrelationRepository` (`entryPackageCorrelationRepository.ts`) is a single-writer
  append-only JSONL log with four in-memory derived indexes rebuilt on `replay()`; `save()` appends
  then calls `indexRecord()` then `applyScopeClaimOnWrite()`. `isValidEntryPackageExecutionRecord`/
  `isValidEarlyExecutionObservation` (`entryPackageExecutionRecord.ts:152-216`) validate *shape* only
  — no cross-record or cross-field semantic invariant is checked anywhere today.
- `position-scope-exclusivity`'s existing requirement "Scope ownership is derived from existing
  durable correlation state, not a new store" states ABI "SHALL NOT introduce... a new persisted
  field on the correlation record" as part of how scope *ownership* is computed. This change's new
  field is not read by, and does not participate in, ownership computation (`findOwnerByScope`,
  `applyScopeClaimOnWrite`, `rebuildScopeIndexFromReplay` are all untouched — see Decision 6); the
  requirement's own scope is specifically the ownership mechanism, not "no field may ever be added to
  the record for any purpose," so this change does not conflict with it. Stated explicitly here so a
  future reader does not need to re-derive that this was actually checked.

## Goals / Non-Goals

**Goals:**
- Make "this cycle's own entry order has filled this much, first observed at this time, at this
  average price" a fact later changes can read, trust, and know precisely how stale it may be —
  without duplicating state that already exists for this purpose.
- Define, precisely enough that Change 2/3/4 need no architectural guesswork, how a consumer decides
  whether that fact is *final* (the entry order can no longer add exposure) versus merely a snapshot
  that may already be stale.
- Enforce the two invariants that make the fact trustworthy at all: fill quantity never regresses;
  first-fill time never changes once known.
- Survive restart using only what `replay()` already reconstructs — no new durable store, no schema
  migration subsystem.
- Leave every current production code path — claim policy, close, open-position, protection,
  recovery, and every public HTTP contract — byte-for-byte unchanged.

**Non-Goals** (all explicitly deferred to later changes in `docs/virtual-exposure-ownership-delivery-plan.md`):
removing or relaxing `position-scope-exclusivity`; same-side multi-owner activation; opposite-side
policy; pair-scoped close; any change to `GET .../open-position`'s behavior or response; recovery
attribution redesign; pair-owned protection or conditional stop/take orders; any public HTTP contract
change; Runtime/MDS changes; a portfolio/netting engine; hedge mode; partial close of one's own
exposure; a background reconciliation/polling process; a new durable store.

## Decisions

### 1. Extend the existing `EarlyExecutionObservation`, do not introduce parallel top-level fields

**Rejected approach:** add five new top-level fields to `EntryPackageExecutionRecord`
(`physical_side`, `first_fill_at_ms`, `cumulative_filled_quantity`, `average_entry_price`,
`remaining_quantity`), mirroring `docs/virtual-exposure-ownership-delivery-plan.md`'s Change-1
sketch mechanically. Rejected because the repository investigation above shows `cumulative_filled_qty`
and `avg_execution_price` **already exist**, already sourced correctly (this cycle's own order only),
already updated at exactly the right points, and already never regressed by an inconclusive write.
Adding parallel fields for the same facts would be exactly the "duplicate existing state without
necessity" this program has been explicitly warned against — and would create two numbers a future
reader has to reconcile instead of one.

**Adopted:** `EarlyExecutionObservation` gains exactly one new field:

```ts
export type EarlyExecutionObservation = {
  order_status: string;
  cumulative_filled_qty: string;
  remaining_qty: string;
  avg_execution_price?: string;
  observed_at: string;
  first_observed_at: string | null;   // NEW
};
```

`cumulative_filled_qty` is this design's `cumulative_filled_quantity`; `avg_execution_price` is this
design's `average_entry_price`. Both already satisfy every semantic requirement laid out in the
program's master plan (exact-decimal, own-order-only sourcing, may grow/change until the order is
final, never taken from the aggregate position) with zero new code. Only "when was the first fill
observed" was genuinely missing — `observed_at` already exists but means "most recent observation,"
not "first observed."

### 2. `first_observed_at`: immutable once set, carried forward, never fabricated

Set the first time a binding's cumulative fill becomes nonzero; on every later write of the same
binding's observation, carried forward unchanged from the prior value rather than recomputed. New
pure helper in `packageConfirmation.ts` (next to `toObservation`, which already has no access to the
prior record — this merge happens one layer up, at the two write call sites):

```ts
export function mergeExposureObservation(
  priorObservation: EarlyExecutionObservation | null,
  freshObservation: EarlyExecutionObservation,
): EarlyExecutionObservation {
  return {
    ...freshObservation,
    first_observed_at: priorObservation?.first_observed_at ?? freshObservation.observed_at,
  };
}
```

Both existing write sites — `persistConfirmationOutcome`'s `full_fill`/`partial_fill` branch
(`entryPackageApplicationService.ts:605-614`) and `confirmCancelOutcomeAndPersist`'s
`filled_before_cancel` branch (`entryPackageApplicationService.ts:550-561`) — call
`mergeExposureObservation(record.early_execution_observation, confirmation.observation)` instead of
using `confirmation.observation` directly. No third write site exists (verified in Context); no new
observation point is introduced.

**Backward compatibility, explicitly not fabricated:** a record whose `early_execution_observation`
was durably written before this change exists has no `first_observed_at` in its stored JSON.
`isValidEarlyExecutionObservation` treats the field as optional/nullable on read, defaulting an
absent value to `null` — **never** to that observation's own `observed_at` (which is a *last*-observed
timestamp for a pre-this-change write, not a first-fill timestamp, and reusing it would silently
claim a precision the data was never designed to support). Consumers must treat `first_observed_at:
null` as "unknown, not zero, not now" — a fact this design states explicitly rather than leaving
implicit, per the "don't derive when deriving would be fabrication" requirement. This is the one
field on this record for which "unknown" is a legitimate, permanent value for pre-existing data, not
a state a future write will necessarily resolve.

### 3. `physical_side`: not a new stored field — derived from `desired_entry.side`

**Rejected approach:** a new top-level `physical_side` field, set once at first bind.

**Adopted:** derive it from `record.desired_entry.side` at read time. This is safe only because of a
specific, verified invariant (Context, penultimate bullet): `desired_entry` is only ever nulled by
`persistAbsentNoHistory`/`persistTransitionToAbsent`, and both are only reached when the binding is
durably proven to have **no** fill. The one path that discovers a fill during a cancel attempt
(`filled_before_cancel`) explicitly does not null `desired_entry` — it spreads `...record` and only
overrides `status`/`pending_action`/`early_execution_observation`/`updated_at`
(`entryPackageApplicationService.ts:554-560`). So: whenever `early_execution_observation` is
non-null (exposure exists), `desired_entry` is guaranteed non-null and its `side` is this cycle's
side. A consumer needing "this cycle's side" reads `record.desired_entry?.side`; if exposure exists
this is never `undefined`. No new field, no duplication, no drift risk between two copies of the same
fact.

### 4. "Owned remaining quantity": a documented contract for later changes, not new stored state — yet

`docs/virtual-exposure-ownership-delivery-plan.md`'s Change 1 sketch, and the naming
`remaining_quantity`, collide with the *existing* `EarlyExecutionObservation.remaining_qty`, which
already means something different: how much of the **desired/calculated** entry quantity is still
unfilled (`toObservation`: `desiredQty - cumulativeFilledQty`, `packageConfirmation.ts:368-371`).
Reusing that name, or that field, for "how much of this cycle's exposure remains open to be closed"
would silently conflate two different numbers.

**Considered:** add a genuinely new field (e.g. `owned_remaining_quantity`) now, initialized to
`cumulative_filled_qty` and left otherwise unused until a later change decrements it.

**Rejected, for this change specifically:** within this change's own scope, no code path ever
decrements it — it would be provably, permanently equal to `cumulative_filled_qty` for the entire
lifetime of this change. Storing a field that is always redundant with another already-stored field,
for a duration this change itself controls, is exactly the state duplication this program has been
warned against; it also invents a second name a future reader has to learn now for no observable
benefit yet.

**Adopted:** specify the contract precisely, without storing it separately:

> A cycle's currently-owned exposure quantity, for any future close/protection consumer, **is**
> `early_execution_observation.cumulative_filled_qty`, and is authoritative **only once**
> `isFillFactFinal(early_execution_observation)` (Decision 5) is true. While not yet final, a
> consumer must not treat that number as settled — it must either force finality (the existing
> cancel-and-confirm-neutralized flow `close-execution`'s current single-owner behavior already
> performs, extended per-cycle by a later change) or re-observe fresh before trusting it.

The change that first needs a value which can *diverge* from `cumulative_filled_qty` — i.e. the first
change that actually decrements anything — is `abi-pair-scoped-close-execution-v1` (program Change
2). That is exactly where a real, independently-mutated field belongs, and where its own monotonicity
invariant ("never exceeds confirmed cumulative fill," from the delivery plan) will have a genuine
second value to be validated against. Introducing it here would be premature.

### 5. Finality: derive on-demand from the already-durable `order_status`, not a new flag

Compared, per the task brief, at least three options:

1. **A separate durable terminal/finality marker on the record**, set once and never unset.
2. **No durable marker at all — always re-derive live**, via a fresh `classifyEntryOrderTerminality`-
   style query, every time a consumer needs to know.
3. **Reuse the existing terminality classification, and define the specific point at which its result
   becomes a durable fact** — i.e. treat the *already-stored* evidence as the durable fact, rather
   than adding a new field or always re-querying.

**Adopted: Option 3**, at zero storage cost. `early_execution_observation.order_status` is *already*
the raw Bybit order status string from the last confirmed observation (`toObservation`:
`order_status: item.orderStatus`), and it is already durably written at exactly the same three points
that would populate a dedicated flag — the flag would just be a redundant restatement of information
this field already carries. New pure predicate, next to `isTerminalOrderStatus`/`isLiveOrderStatus`
in `packageConfirmation.ts`:

```ts
export function isFillFactFinal(observation: EarlyExecutionObservation | null): boolean {
  return observation !== null && isTerminalOrderStatus(observation.order_status);
}
```

Semantics a later change must follow, stated explicitly so none of them have to re-derive this:
- `observation === null`: no exposure has ever been observed for this binding. Not "final zero" —
  simply nothing to be final about yet (the order may still be live-unfilled, or the binding may not
  exist).
- `observation !== null` and `isFillFactFinal(observation)` is **true**: the order reached a terminal
  Bybit status (`Filled`, or a terminal-without-fill status observed *after* a fill had already been
  recorded — see the note below) the last time it was durably observed. Bybit order statuses do not
  un-terminalize, so this is a **permanent** fact; `cumulative_filled_qty`/`avg_execution_price` at
  that observation are final and may be trusted by a future consumer without re-querying.
- `observation !== null` and `isFillFactFinal(observation)` is **false** (a live status, most commonly
  `PartiallyFilled`): the fact is a snapshot only. A consumer needing an authoritative up-to-the-
  moment answer must force or re-check terminality first, using the existing
  `classifyEntryOrderTerminality`/`confirmEntryPackage` machinery a later change already has access
  to — this change invents no new query mechanism for that; it only defines the contract those
  existing mechanisms feed.

*Edge note, for completeness:* `TERMINAL_WITHOUT_FILL_STATUSES` overlaps with statuses that could in
principle appear on an observation object that also has `cumulative_filled_qty > 0`, if a fill and a
subsequent terminal-without-further-fill status were both captured in the same observation write
(this does not happen via any current write path — `toObservation` is only reached from branches that
already gate on a positive fill — but `isFillFactFinal` is defined purely in terms of
`order_status`, so it is correct regardless: any terminal status means no further exposure can be
added, independent of what quantity was captured on the way there).

**Rejected: Option 1** (new durable flag) — pure duplication of what `order_status` already proves,
for zero additional expressive power; a second boolean to keep consistent with the first is a new
opportunity for drift, not a new fact. **Rejected: Option 2** (always re-derive live) — this
change's whole point is a durable, restart-surviving fact a consumer can consult without an exchange
round-trip in the common case (terminal); forcing every future read through a live query would
reintroduce exactly the kind of dependency on-the-fly exchange state this program is trying to
reduce, and would make `first_observed_at`/`cumulative_filled_qty` pointless to store durably at all
if every consumer had to re-verify them live regardless.

### 6. The derived scope index (`byScope`) is not touched by this change

The task brief explicitly permits (does not require) evolving `byScope` toward a multi-owner-capable
shape in this change. **Deferred to the program's later activation change instead.** Reasoning:

- None of the three consumer-prep changes this foundation unblocks (`abi-pair-scoped-close-execution-v1`,
  `abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1`) need a
  multi-owner scope index — they need per-cycle fill facts (Decisions 1-5), which are entirely
  independent of how scope ownership is indexed. Only the activation change itself, which actually
  relaxes the claim policy, has a genuine consumer for a multi-owner `byScope`.
- `byScope`/`findOwnerByScope`/`applyScopeClaimOnWrite`/`rebuildScopeIndexFromReplay`
  (`entryPackageCorrelationRepository.ts:30,124-126,179-197,205-257`) are exactly the mechanism
  `position-scope-exclusivity`'s existing, still-fully-in-force requirements describe. Leaving every
  line of that mechanism untouched is the simplest possible proof that this change does not alter
  scope-ownership behavior — no diff to review there at all, versus a diff that has to be argued
  behaviorally inert.
- The one test requirement this design still owes — "synthetic same-side multi-owner records can be
  represented by the repository/index layer without activating production join" — does not actually
  require touching `byScope`'s shape. It requires proving the repository *can already* represent and
  enumerate multiple active records sharing a scope. See Decision 7.

### 7. `findActiveRecordsForScope`: a computed query, not a new maintained index

New repository method, additive only:

```ts
findActiveRecordsForScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord[]
```

Implemented as a plain linear scan over `byCompositeKey.values()` (already the authoritative "latest
record per pair" collection — see `position-scope-exclusivity` design.md Decision 8, unchanged),
filtering to records whose resolved scope matches and whose status is not durably closed
(`isDurablyClosedEntryPackageStatus`, reused, not reimplemented). No new mutable index is introduced:
this is a query over already-correct state, not a second structure that could drift out of sync with
it. In production today this can only ever return zero or one record (claim policy is unchanged —
Decision 6); in a repository-level test, two same-side records can be seeded directly (bypassing
`EntryPackageApplicationService`'s claim guard entirely, exactly as the task brief specifies) to prove
the method itself has no single-owner assumption baked in.

### 8. Validation: monotonicity and immutability enforced at both write time and replay time

**Live-write path (`save()`):** before appending, if a record already exists for the same pair
(`byCompositeKey.get(...)`) and both the existing and new record carry a non-null
`early_execution_observation`, `save()` rejects (throws) the write if:
- new `cumulative_filled_qty` < existing `cumulative_filled_qty` (exact-decimal comparison, reusing
  `compareDecimal` from `src/domain/exactDecimal.ts` — the same primitive `packageConfirmation.ts`
  already uses), or
- existing `first_observed_at` is non-null and new `first_observed_at` differs from it.

This is a defensive assertion against a future application-service bug, not a new
externally-observable outcome: every current write path already satisfies both invariants by
construction (Decision 2's merge helper enforces `first_observed_at`; `cumulative_filled_qty` is
sourced from Bybit's own monotonic `cumExecQty` for the same order at every observation point). The
check exists so a violation fails loudly and immediately at the point of the bug, not silently, and
not only three restarts later when replay happens to notice.

**Replay path:** Phase 1 (`entryPackageCorrelationRepository.ts:60-96`) already processes every valid
line for a pair in file order, `byCompositeKey.set()`-ing each one in turn — the exact same
opportunity live writes get to compare "this line" against "the previous line for this pair" is
already present in that loop. Extend it: immediately before each `indexRecord()` call, if the
previously-indexed record for the same pair (i.e. `byCompositeKey.get(key)` *before* this line's
`set()`) had a non-null `early_execution_observation`, apply the same two checks as the live path
above against this line's record. A violation fails replay closed (`{ok: false, reason: ...}`) the
same way existing structural/schema corruption already does — this is a new class of the same
existing "fail readiness on non-final corruption" policy, not a new readiness mechanism.

This intentionally mirrors `position-scope-exclusivity` design.md Decision 8's own lesson (evaluate
ownership from final state, not an intermediate line) by *not* repeating that mistake here: unlike
scope ownership (which can legitimately move between different pairs across lines and must be judged
only on final state), a single pair's own fill-fact sequence has no legitimate "intermediate
disagreement" case to protect against — every line for the same pair is either a strictly compatible
continuation of the previous line's fill facts or it is real corruption, so line-by-line comparison
in file order is both correct and sufficient here (unlike the ownership case, there is no scenario
where an earlier line's fill facts for pair A are legitimately superseded by an unrelated pair B's
line in between).

## Risks / Trade-offs

- [`first_observed_at: null` on old data is a permanent, non-recoverable gap — a pre-this-change
  binding's true first-fill time can never be known] → Accepted: fabricating it from `observed_at`
  would be a worse outcome (silently wrong data that looks precise) than an honest, explicitly-
  documented `null`. `open-position-resolution`'s own existing V1 attribution boundary already
  accepts a comparable class of "correctness depends on data ABI does not have" gap; this is
  consistent with that precedent, not a new category of risk for this codebase.
- [Deferring `owned_remaining_quantity`'s actual storage to Change 2 means this change's own "creates
  and saves this semantics" framing in the delivery-plan document is satisfied only as a documented
  contract, not as a stored field] → Accepted and treated as a deliberate refinement of the plan
  document (which is explicitly non-binding, per its own text) rather than a scope gap: the contract
  is fully specified (Decision 4) and Change 2 has everything it needs to introduce the real field
  without any further architectural decision-making — only Change 2's own design needs to name and
  wire it.
- [The live-write monotonicity check in `save()` is new authority for the repository to reject a
  write it previously always accepted] → Accepted: every current call site already satisfies the
  invariant by construction, so this is provably a no-op for existing behavior; it only starts
  mattering if a future bug is introduced, which is exactly the point of adding it now rather than
  after such a bug ships.
- [`findActiveRecordsForScope` is dead code in production until a later change consumes it] →
  Accepted, explicitly: it exists to prove a capability (the repository can already represent
  multi-owner scope state) the delivery-plan's required test coverage calls for, ahead of any
  production consumer, exactly as `docs/virtual-exposure-ownership-delivery-plan.md`'s own "prepare
  consumers on synthetic fixtures before activation" strategy intends for this whole program.

## Migration Plan

Purely additive. No existing field changes shape or meaning; no existing route, DTO, or on-disk
record shape becomes invalid. Old JSONL lines with `early_execution_observation` objects lacking
`first_observed_at` replay successfully with that field read as `null` (Decision 2). Old JSONL lines
predating `early_execution_observation` entirely (`null`) are already handled by existing shape
validation and are unaffected. Rollback is a plain revert of the two touched write sites, the two new
validation checks, and the new type field/predicates/query method; no data becomes unreadable in
either direction, since nothing this change adds is required for any existing read path to function.
