## Context

See `proposal.md` for Why/What. This is a **correction** of this change's first draft (baseline commit
`f52796d`). That draft's multi-owner postcondition compared an ABI-resolved quantity against a live
aggregate-position delta and called the comparison's disagreement "drift." Review found this unsafe, not
merely imprecise: aggregate delta cannot prove *which* close command produced it once more than one cycle
can independently move the same aggregate, so a retry after a lost response could resubmit a close order
sized from stale entry-order facts and consume a sibling's exposure. This document replaces that model
with one built on an *attributable close-order identity* — the same architectural shape ABI's own
entry-package pipeline already uses for exactly this reason. See "Root cause" below for the precise failure,
and Decisions 1-6 for the replacement.

### Root cause of the original draft's unsafe model

The original draft's multi-owner postcondition was: read the live aggregate once, compute
`resolvedQty` from the entry order's own fill facts, send a reduce-only order for (a clamped)
`resolvedQty`, then re-read the aggregate and check it decreased by `resolvedQty`. This conflates two
different questions a single owner never had to distinguish:

- **"Did *my* close command execute?"** — an identity question, about one specific command's fate.
- **"Is the physical scope now smaller?"** — a fact about the whole scope, caused by *any* owner's
  activity, or by any of that owner's own async fills unrelated to a close at all.

For a single owner these questions have the same answer, because nothing else can move the aggregate.
For more than one owner they diverge: `aggregate_before - aggregate_after` reflects the sum of
*everyone's* concurrent activity, not this request's own effect. The concrete failure the review traced
(quoted in `proposal.md`'s Why): ABI sends A's close order, it executes, but ABI crashes before
recording that fact; A's durable record still shows an open cycle; the aggregate is now whatever B's
continued exposure leaves it at; a retried close for A re-derives "A's original 4 BTC" from A's entry
facts (unchanged, since entry facts are immutable once final) and sends a **second** reduce-only order for
that same 4 BTC — which Bybit will happily execute against whatever aggregate exists, including B's share.
Nothing in the original draft ever asked "did I already send a close order for A, and if so, what happened
to it" before deciding to send another.

### Existing ABI primitives that already solve this class of problem (for entry, not yet for close)

Investigation for this correction found that `EntryPackageApplicationService`'s own create/cancel pipeline
already implements the exact pattern industry OMS/FIX architectures use — client order identity as the
retry-safety anchor, exchange aggregate state never treated as identity proof — and does so today, for a
different command:

- **Deterministic, stable client order identity.** `buildEntryPackageOrderLinkId(strategyInstanceId,
  tradeCycleId, role, generation)` (`src/domain/entryPackageOrderIdentity.ts:5-19`) is a pure function —
  the same inputs always produce the same `orderLinkId`. `role` is already a type parameter
  (`EntryPackageOrderRole`, currently `"entry"` only) — the master plan's own Change 6 already anticipated
  widening it (`"stop"`/`"take"` for future pair-owned protection orders), so extending it with `"close"`
  here is not a new pattern, just its second planned use.
- **Durable write before the exchange call, never after.** `createOrder()`
  (`entryPackageApplicationService.ts:246-330`) builds a `provisional` record with `order_link_id` already
  set and `pending_action: "create"`, durably `save()`s it, and *only then* calls `executeEntryOrder`. A
  thrown exception, or a `skipped_live_execution` result, leaves that durable write exactly as it is — it
  is never reverted. The write proves intent-to-dispatch before ABI can ever lose track of whether Bybit
  received it.
- **Resend is gated on a fresh, positive "genuinely never happened" query — never on absence of a local
  response.** `repeatPutRevalidate` (`entryPackageApplicationService.ts:335-367`) always re-queries the
  order's *own* current state via `confirmEntryPackage` before deciding anything. `shouldResendPendingAction`
  (`entryPackageApplicationService.ts:378-396`) permits resending the *same* identity only when that fresh
  query comes back `not_found` — genuinely absent from both the realtime and history endpoints, every query
  in the bounded window answering cleanly, `pending_action` still `"create"`/`"cancel"`. Any other outcome —
  found live, found with a fill, or a query failure — blocks resending outright.
- **The query mechanics are already generic, not entry-specific.** `confirmEntryPackage`
  (`packageConfirmation.ts:70-162`) takes only `bybit`, a `getEntryOrderPayload`/`getEntryOrderHistoryPayload`
  (both keyed by `category`/`symbol`/`orderLinkId` — nothing entry-specific in their shape,
  `bybitOrderMapper.ts:48-60`), and an `expected.qty`; it returns `full_fill` / `partial_fill` /
  `terminal_without_fill` / `not_found` / `ambiguous`, each carrying (where relevant) the order's own
  `cumulative_filled_qty` from its own execution report. Nothing about its implementation assumes the order
  being confirmed is an entry order — it is a generic "confirm this orderLinkId's fate" primitive already
  used by four different call sites in `entryPackageApplicationService.ts` alone. `classifyEntryOrderTerminality`
  (`packageConfirmation.ts:254-307`) is the same story for the coarser terminal/live/ambiguous question.
- **Close orders today have no client identity at all.** `BybitMarketCloseOrderPayload`
  (`bybitOrderMapper.ts:26-34`) has no `orderLinkId` field, and `CloseApplicationService`'s only construction
  of one (`closeApplicationService.ts:160-168`) does not set one. A close order is dispatched to Bybit
  anonymously from ABI's own tracking perspective — there is no way to look up "what happened to the order I
  already sent" after a crash, because ABI never gave itself a way to name it. This absence, not a flaw in
  any comparison formula, is the structural root of the original draft's unsafe retry behavior.
- **`isValidEntryPackageExecutionRecord`** (`entryPackageExecutionRecord.ts:152-187`) validates
  `order_link_id`/`order_id` as `string | null` with no tolerance for a missing key — meaning any new
  required-but-nullable field added the same way would break replay of durable records written before this
  change ships, unless the validator explicitly tolerates the key being entirely absent (`undefined`) on
  old rows. There is no schema-migration subsystem in this codebase (Change 1 deliberately avoided needing
  one); this change's own new fields must therefore tolerate `undefined` explicitly at the validator, not
  assume every existing durable row already has them.
- **Why single-owner close never needed any of this.** `CloseApplicationService`'s existing single-owner
  logic (unchanged by this correction, see Decision 1) only sends a close order when the live aggregate is
  currently positive (`closeApplicationService.ts:158`), and its postcondition requires that same aggregate
  to reach exactly zero. A crash-then-retry after a close order already executed re-reads the aggregate,
  finds it already zero, sends **no second order**, and proceeds straight to the durable write — safe, but
  only because "the aggregate is zero" and "this pair's own close succeeded" are *the same fact* when there
  is exactly one owner. Reduce-only's own exchange-side protection (it cannot push a position past zero or
  flip its side) also means a genuinely-sent second single-owner close order could never itself cause harm
  even in a stranger retry pattern — it would just close whatever (necessarily this same pair's) remainder
  is still there. Neither property survives more than one owner: a reduce-only order sized from stale
  per-cycle facts can still validly execute against a *sibling's* share of a nonzero aggregate, and "the
  aggregate is nonzero" no longer proves "my own cycle is still open." This is why this correction adds new
  machinery only to the multi-owner branch (Decision 1) and leaves single-owner's proven logic untouched.

## Goals / Non-Goals

**Goals:**
- Give a multi-owner close command the same class of retry/restart safety entry-package's create/cancel
  already has: an attributable identity whose own fate is checked before ever sending a second command
  under the same intent.
- Make the requested cycle's own close order — not the aggregate — the proof of whether, and how much, its
  exposure was closed. Use the aggregate only for existence/side lookup and a non-gating sanity check.
- Add the minimum durable state this requires, reusing existing generic confirmation primitives
  (`confirmEntryPackage`, `classifyEntryOrderTerminality`) rather than inventing new query mechanics.
- Leave the single-owner branch — today's only production-reachable path — completely untouched: no new
  field is read or written by it, no new Bybit call, no new identity.
- Remove the global drift-tolerance config the original draft introduced: the redesign eliminates the
  comparison that config existed to tolerate (see Decision 5).

**Non-Goals** (unchanged from the original draft, restated because the correction does not reopen them):
- `exposure_fraction < 1` / partial-close execution.
- Same-side production activation, opposite-side support, pair-owned protection, `first_fill`/entry-bar
  work, recovery redesign, Runtime changes.
- A generic order ledger, event-sourcing subsystem, command framework, or generalized execution engine.
  This correction adds two flat nullable fields to an existing record, reusing existing confirmation
  primitives — not a new subsystem.
- Background polling of any kind. All new queries here are synchronous, bounded, request-scoped, exactly
  like every existing confirmation call in this codebase.
- An automatic "resubmit under a fresh identity" retry policy for a close order that definitively executed
  for less than the requested quantity, or was rejected/cancelled with zero execution. V1 fails closed in
  that case (Decision 4); a future change may add a generation-scoped close-identity bump if real operational
  need demonstrates it, but nothing here builds toward that speculatively.

## Decisions

### 1. New machinery applies only to the multi-owner branch; single-owner is untouched

Restated from the original draft and reaffirmed, not revisited: `CloseApplicationService.process()` still
branches once on `findActiveRecordsForScope(...).length`. The `=== 1` branch — every Bybit call, the exact
existing `verifyBothPostconditions` signature, the exact existing durable write — is **not modified by this
correction**: it reads no new field, writes no new field, computes no new identity. See Context's closing
note for why this is safe, not merely "not yet updated." Everything below applies only to the `> 1` branch.

### 2. Close gets its own attributable identity: a new `EntryPackageOrderRole`, reused machinery

Widen `EntryPackageOrderRole` from `"entry"` to `"entry" | "close"` (`entryPackageOrderIdentity.ts`). The
multi-owner branch computes `closeOrderLinkId = buildEntryPackageOrderLinkId(strategyInstanceId,
tradeCycleId, "close", record.generation)` — deterministic, so it never needs to be freshly generated or
stored merely to be *computable*; it is still stored durably (next decision) because its *presence* is
itself the "was a close ever dispatched" signal, exactly as `order_link_id`'s presence already is for
entry. `BybitMarketCloseOrderPayload` gains an optional `orderLinkId?: string`, set only by the
multi-owner branch — the single-owner branch's existing payload literal is untouched, so this is additive
to the type, not a breaking change to its one existing call site.

**Rejected: a close-specific identity builder function, separate from `buildEntryPackageOrderLinkId`.**
The function is already role-parameterized for exactly this kind of reuse (the master plan's own Change 6
already earmarks it for `"stop"`/`"take"`); a second, parallel hash scheme would only add an inconsistency
for no benefit.

**Rejected (noted, not acted on): renaming `buildEntryPackageOrderLinkId`/`confirmEntryPackage` away from
their entry-flavored names now that a non-entry pipeline reuses them.** Cosmetic, ripples across every
existing call site, and not required for correctness. Left to a future change if the naming genuinely
confuses a later reader.

### 3. Minimum durable state: two flat, nullable fields — no new status, no history array, no ledger

Add to `EntryPackageExecutionRecord`:

```ts
close_order_link_id: string | null;   // this generation's own close-order identity, once dispatched
close_order_id: string | null;        // Bybit's own id for that order — audit only, never used for lookup
```

**Why these two, and nothing else:**
- `close_order_link_id`'s presence (`!== null`) is the entire "has a close order ever been dispatched for
  this generation" signal — mirroring exactly how `order_link_id`'s presence already marks "has a create
  attempt ever been dispatched" for entry, independent of `status`.
- `close_order_id` is stored for parity/audit with `order_id`'s existing role, but is never read by any
  lookup this change performs — every lookup is by `orderLinkId`, exactly like every existing entry-order
  query in this codebase (`BybitGetOrderByLinkIdPayload`/`BybitGetOrderHistoryPayload` both key on
  `orderLinkId`, never `orderId`).
- No durable "close execution quantity" field is needed: the close order's own confirmed quantity is
  re-derived live, on demand, from `confirmEntryPackage(closeOrderLinkId, ...)` — the exact same "always
  re-query live, never cache an intermediate value" discipline `virtual-exposure-state`'s own design
  already established for the entry side, and the same reasoning the original draft's (retained) Decision
  on transient quantity resolution already used (Decision 6 below).
- No new `EntryPackageExecutionStatus` value is needed: `close_order_link_id !== null && status !==
  "terminal_closed"` is exactly "a close was dispatched for this generation and its fate is not yet
  durably finalized" — the one new state this correction needs to represent, and it falls out of the two
  new fields plus the existing status enum with no enum change.
- No close-specific generation counter or history array is needed. A trade cycle only ever gets one
  legitimate close attempt per entry-package generation in V1 (Decision 4 — no same-identity resubmission
  after a definitive zero-execution outcome), and a record can never acquire a *new* entry-package
  generation while still carrying an unresolved close attempt from an old one, without first passing
  through a state (`absent`, via a cancel-intent PUT) — `createOrder()`'s `provisional` record is already
  built as a fully explicit object literal (`entryPackageApplicationService.ts:246-266`), not a spread of
  the prior record, so adding `close_order_link_id: null, close_order_id: null` to that literal correctly
  and automatically clears any stale value from an earlier generation, with no extra reset logic required.

**Validator/replay backward compatibility:** `isValidEntryPackageExecutionRecord` must accept these two
keys being entirely *absent* (`undefined`), not merely `null`, on durable rows written before this change
ships — `(record.close_order_link_id === undefined || record.close_order_link_id === null || typeof
record.close_order_link_id === "string")`, and the same shape for `close_order_id`. This is the one place
this correction deliberately does **not** mirror `order_link_id`'s stricter validator clause (which
requires the key present, `null` or a string) — because `order_link_id` has existed since before any
durable row in a real deployment could lack it, and these two fields have not.

**Rejected: a generic append-only "order attempts" ledger on the record**, or a separate correlation store
for close attempts. Two flat fields answer every question this change's retry/restart scenarios need
answered (Decision 4); a ledger would be solving a generality this pipeline does not need — a trade cycle
has at most one close identity, ever, in V1.

### 4. Retry/restart state machine (multi-owner branch)

After the existing entry-order neutralization step (shared, unchanged) confirms the requested cycle's own
entry order has no live remainder:

**A — No close ever dispatched** (`record.close_order_link_id === null`):
1. Resolve `resolvedQty` from the entry order's own fill facts via `confirmEntryPackage` (transient,
   in-memory only — Decision 6; unchanged from the original draft).
2. If `resolvedQty === "0"`: no close order is needed or ever will be for this generation (the entry order
   is terminal and immutable, so this is stable across any number of retries) — skip straight to the
   durable write. No identity is written; nothing was, or ever will be, dispatched.
3. Otherwise, read the live aggregate once (for `side`, and a pre-dispatch sanity check: if the aggregate
   is already `no_position` while `resolvedQty > 0`, this is an unexplained pre-dispatch contradiction —
   `internal_error`, distinct from a post-dispatch incomplete-execution outcome, since no close order was
   ever attempted).
4. Durably write `close_order_link_id` (computed per Decision 2) **before** sending anything — mirrors
   `createOrder()`'s provisional-write-before-exchange-call exactly.
5. Send the reduce-only close order for `resolvedQty` on the aggregate's own live side, carrying
   `orderLinkId: closeOrderLinkId`. A thrown exception or a `skipped_live_execution` result leaves the
   durable write exactly as it is — never reverted, mirroring `createOrder()`'s identical handling — and
   returns `internal_error`; the next attempt finds `close_order_link_id` already set and proceeds via
   branch B below, which itself safely resends under the same identity once a fresh query proves nothing
   was actually created (the same "not_found ⇒ safe to resend the same identity" proof
   `shouldResendPendingAction` already relies on for entry).

**B — A close was already dispatched for this generation** (`record.close_order_link_id !== null`, `status
!== "terminal_closed"` — a retry or a post-crash restart): re-derive `resolvedQty` fresh (step A.1 again;
cheap, and the entry order cannot have changed since it is already terminal), then call `confirmEntryPackage`
on `close_order_link_id` with `expected.qty = resolvedQty`, and branch on its outcome:
- **`full_fill` / `partial_fill` with `decimalEquals(observation.cumulative_filled_qty, resolvedQty)`**:
  the previously-dispatched close order fully executed the requested quantity. No new order is sent.
  Proceed to the durable write (Decision 5).
- **`full_fill` / `partial_fill` with a confirmed quantity less than `resolvedQty`, and the order's own
  terminality (`classifyEntryOrderTerminality` on the same identity) reads `terminal`**: the order is done
  executing and under-executed relative to what this cycle needed closed — `close_execution_incomplete`.
  No second order is sent under the same identity (Decision 3's "at most one attempt" scope); ABI does not
  durably terminalize.
- **`terminal_without_fill`**: the order was rejected or cancelled with zero execution —
  `close_execution_incomplete`, same treatment as the line above.
- **The order's own terminality reads `live`**: still executing (a narrow race window for a market order,
  handled defensively rather than assumed impossible) — poll within the existing bounded-retry shape; if
  still live after the bounded window, `internal_error`. No replacement order is sent while this is
  unresolved.
- **`not_found`, genuinely, after the bounded query window**: Bybit has no record of this identity ever
  being created — the one case `shouldResendPendingAction` already proves safe to resend under the *same*
  identity. Return to branch A's step 3 onward, reusing `close_order_link_id` unchanged (no new identity is
  minted).
- **`ambiguous`** (a query failure within the bounded window, or a found-but-inconclusive result):
  `internal_error`. No order is sent.

This directly satisfies the required invariant: **ABI never sends a second close order for the same
full-close intent while the previously dispatched one's fate is unconfirmed** — branch B always resolves
the existing identity's fate first, and only ever "resends" (reuses the same identity) in the one case
proven safe by precedent (genuinely never created).

**Why no automatic fresh-identity retry after a definitive zero/partial execution (scenario D/E in the
review):** an orderLinkId Bybit has already accepted and processed (found, not `not_found`) cannot safely
be reused for a different order — reusing a used client identity is exactly the kind of ambiguity this
whole design exists to avoid, and Bybit's own orderLinkId-uniqueness semantics make a same-identity resend
here actively unsafe, not merely policy-restricted. A fresh identity would require a close-specific
generation counter this change deliberately does not add (Decision 3) — fail closed and leave that to a
future change if real operational need proves it necessary, per this correction's explicit instructions.

### 5. The close order's own confirmed quantity is the gate; the aggregate is reconciliation evidence, not proof

Restated per the required proof hierarchy: **primary proof** — `decimalEquals(the requested cycle's own
close order's confirmed `cumulative_filled_qty`, resolvedQty)`, verified in Decision 4 branch B, gates the
durable `terminal_closed` write directly. This is authoritative on its own: Bybit's own execution report
for ABI's own order proves what that order did to the account, independent of any concurrent sibling
activity, because reduce-only fills are applied atomically by the exchange's matching engine regardless of
what else is happening on the same symbol.

The aggregate is read once, pre-dispatch, only for `side` and the pre-dispatch existence sanity check
(Decision 4.A.3) — it is **not** re-read post-dispatch and **not** part of the success gate. This is a
deliberate change from the original draft, not an oversight: `aggregate_before - aggregate_after` cannot
distinguish this request's own effect from a sibling's concurrent activity (Root cause, above), so it
cannot correctly serve as proof of anything about *this* request, gating or otherwise. A future change may
reintroduce an aggregate-based *reconciliation* check (comparing the sum of all known owners' resolved
exposure against the aggregate, as genuine cross-cycle consistency observability) if real operational need
demonstrates it — this correction does not build toward that speculatively, and does not gate success on
it.

### 6. Multi-owner quantity resolution stays transient — reaffirmed, not revisited by this correction

The original draft's decision that the entry order's fresh `confirmEntryPackage` re-query (used to compute
`resolvedQty`) is used only in memory, never durably written to `early_execution_observation`, is
unaffected by this correction and is **not** the state this correction was found lacking — the review's
question was answered directly against it (Context, above): after a close-submission crash, ABI does not
need the *entry* order's observation to have been persisted, because the entry order's own facts are
immutable once final and can always be re-derived fresh and cheaply from the exchange. What ABI needed and
lacked was durable knowledge of *its own close order's identity* (Decisions 2-3) — a different fact, now
added. `virtual-exposure-state`'s "only at existing observation points" requirement remains untouched by
this pipeline for the same reason as before.

### 7. `position_exposure_drift` is removed; `close_execution_incomplete` replaces it with different semantics, and the tolerance config is removed entirely

**Rejected: keep a configurable drift-tolerance quantity for a redefined comparison.** The original draft's
config existed to absorb potential exchange-side rounding noise between two *independently derived*
quantities (an ABI-resolved value and a separately-queried aggregate). This correction does not compare two
independently derived quantities at all: `resolvedQty` is submitted verbatim as the close order's own `qty`,
and the gate compares that same order's own confirmed execution against the exact value ABI itself sent —
both sides of the comparison originate from the same request, so there is no independent-rounding gap left
to tolerate. A tolerance concept has nothing left to do, so it is removed, not merely defaulted to a value
someone has to keep re-justifying per instrument.
**Rejected: keep the tolerance for a genuinely different future purpose (cross-owner aggregate
reconciliation).** No such check exists in this V1 design (Decision 5) to attach a tolerance to; adding one
speculatively for a check this change does not perform would be exactly the "unless existing exchange
semantics prove a configurable tolerance is necessary" case this correction was told to avoid.

**Adopted:** `AbiConfig.positionExposureDriftToleranceQty` is dropped entirely (it was never implemented in
code — the original proposal was propose-only — so nothing needs reverting). The new business error is
`close_execution_incomplete` (422, close-only), returned when the requested cycle's own close order is
found terminal but its confirmed executed quantity does not exactly equal `resolvedQty` (covers both
partial execution and outright zero-execution rejection/cancellation — both are "did not fully execute
what was requested," differing only in degree). Strict equality, no tolerance: the value being compared
against is the exact string ABI itself submitted moments earlier in the same request lineage, not a
value independently re-derived from a different source.

## Risks / Trade-offs

- [Two new durable fields on `EntryPackageExecutionRecord`, and a validator change, are a larger diff than
  the original draft's "correlation repository untouched" claim] → Accepted: the review found that claim
  was only defensible because the original draft's safety model was itself unsound; the minimum durable
  state actually required is two flat nullable fields and one validator clause, not a new store or index —
  `EntryPackageCorrelationRepository`'s indexing/replay/`byScope` machinery remains completely untouched.
- [A close order that definitively executes for less than the requested quantity, or is rejected with zero
  execution, permanently blocks that trade cycle's close via this pipeline in V1, with no automatic
  recovery path] → Accepted per this correction's explicit instruction not to invent retry behavior the
  codebase does not already have: fail closed, leave a generation-scoped close-identity bump to a future
  change if real operational evidence demonstrates the need. This is a narrower, more honest guarantee than
  the original draft's silent clamp-and-proceed behavior, which could have masked a real problem behind an
  apparent success.
- [The multi-owner branch now makes one additional Bybit call (the close order's own confirmation) beyond
  what the original draft did] → Accepted: zero cost to the single-owner branch (untouched, Decision 1);
  the added call reuses existing bounded-retry confirmation machinery rather than inventing new query
  mechanics, and is the direct cost of the attributable-identity proof the review requires.
- [Pre-existing durable rows lack `close_order_link_id`/`close_order_id`, so the validator must tolerate
  `undefined`, which is a slightly different validation posture from every other nullable field on this
  record] → Accepted, explicitly, rather than introducing a migration subsystem this codebase does not
  otherwise have; documented precisely in Decision 3 rather than left implicit.

## Migration Plan

Additive to `EntryPackageExecutionRecord` (two nullable fields, validator updated to tolerate their
absence on old rows) and to `BybitMarketCloseOrderPayload` (one optional field). No change to
`EntryPackageCorrelationRepository`'s indexing, replay ownership logic, or `byScope`. No new repository
method beyond what Change 1 already delivered (`findActiveRecordsForScope`, still the only query this
pipeline's ownership check uses). The single-owner branch of `CloseApplicationService` is provably
unmodified (Decision 1). The public HTTP contract is unchanged from the (already-corrected) prior draft:
`POST .../close` with `{"exposure_fraction": "1"}`, same response shape; only the multi-owner-only business
error code changes name and meaning (`position_exposure_drift` → `close_execution_incomplete`). Rollback is
a plain revert; old durable rows (lacking the two new fields) replay correctly against the corrected
validator either way, since replay never depends on them being present.
