## Context

See `proposal.md` for Why/What. This design implements master-plan Change 4, revised twice now:

- **Revision (superseded by this document).** The first draft of this design concluded the existing
  dual-query grid (`resolveRecoveryState`, `entryCycleRecoveryResolutionService.ts:212-238`) was already
  multi-owner-safe, and that this change's only real scope was fixing where `position_open`'s two fill
  facts are sourced from (the same bug Change 3 already fixed for `GET .../open-position`). **This premise
  was wrong and is retracted.** Direct inspection of the code (not just the spec prose) shows three of the
  four states — `entry_order_live`, `terminal_without_fill`, and the position-query half of
  `position_open` — require the aggregate position query to positively confirm a specific state
  (`positionFlat` for the first two, `positionOpen` matching side for the third) as a co-equal,
  *required* signal, not sanity. Under same-side shared scope, a sibling cycle's own open position makes
  `positionFlat` false for every cycle sharing that scope — `entry_order_live` and `terminal_without_fill`
  become permanently unresolvable (fail closed) for any cycle sharing a scope with an already-open
  sibling, even though that cycle's own evidence positively and unambiguously proves its own state. This
  is a real, previously undetected gap, not a restatement of the already-fixed sourcing bug. This document
  replaces the grid entirely with an own-evidence-primary design; the sourcing fix (Decision 1) is
  unchanged and is now one part of a larger redesign, not the whole of it.

This design implements the corrected scope: own-cycle durable/order/execution evidence is the primary and
sufficient source for all four recovery states; the aggregate position query is demoted to per-state
weak sanity (existence/side-compatibility only, never a required positive-agreement gate) — the same
attributable-evidence-primary, aggregate-weak-sanity pattern Change 2 and Change 3 already established,
now actually applied to every state this capability resolves, not only to `position_open`'s two fill
facts.

## Goals / Non-Goals

**Goals:**
- Every one of the four recovery states resolves from this specific cycle's own durable/order/execution
  evidence, and is never blocked or mis-resolved solely because a same-side sibling cycle's own activity
  is visible in the shared aggregate position.
- `position_open` vs `terminal_after_fill`, once this cycle's own entry order proves a fill, is
  disambiguated using this cycle's own close-order identity and its own confirmed fate — reusing Change
  2's already-durable `close_order_link_id` field and the same read-only order-classification primitive
  this capability already uses for the entry order — never the aggregate.
- The aggregate position query is retained only where it can still say something both true and useful
  under shared scope: a genuine opposite-side contradiction (a real, structural invariant violation, not
  a normal shared-scope condition) for the two zero-fill states, and same-side existence sanity
  (mirroring Change 3's Decision 1 exactly) for `position_open`.
- `average_entry_price`/`first_fill_at_ms` sourcing (the original scope of this change) is preserved
  exactly as previously designed and reused, not duplicated.
- No new close-side machinery: this design reuses Change 2's existing durable `close_order_link_id` field
  and this capability's own existing order-classification primitive a second time, pointed at a different
  identity. It adds no cancel/retry/dispatch logic and no second close-execution state machine.

**Non-Goals:**
- Partial-close-of-own-share accounting. This capability's `terminal_after_fill` resolution accepts *any*
  positively confirmed fill on this cycle's own close order as sufficient (see Decision 3's own note on
  this simplification) rather than exactly qty-matching the close order's fill against this cycle's own
  resolved exposure the way `CloseApplicationService.resolveCloseOrderOutcome` does for its own,
  different purpose (verifying its own dispatch fully succeeded before durably writing
  `terminal_closed`). Recovery's job is coarse four-state read-only classification, not fine-grained
  partial-close verification — V1 does not support partial-close-of-own-share as a target end state at
  all (master plan, "V1 full-close-only"), and an incomplete close remains `CloseApplicationService`'s own
  concern to finish via a caller's retried `POST /close`, not something recovery re-verifies.
- Any change to the legacy `pending_action` guard or the durably-closed-status fast path — this design
  does not touch `process()`'s structure above the dual-query section at all.
- Any new adapter primitive, decoder, or Bybit endpoint.
- Bybit's own execution-history query/history constraints — not designed around here, for the same reason
  Change 3 already gave (durable, immutable, capture-once design; no code path ever needs to reconstruct a
  fill that was never captured at the time).

## Decision 1 — `average_entry_price` is sourced from the already-fetched own-order response (unchanged from the prior draft)

`classifyOrderForRecovery` already queries `getOrderByLinkId` and, when needed, `getOrderHistory` — both
filtered to this record's own `order_link_id` — once per attempt, decoding the response into a
`BybitOrderView` (`orderQueryResponseDecoder.ts:3-11`) that already includes `avgPrice`. Today, after
classifying the response into an `OrderRecoverySignal` `kind`, the rest of the decoded item — including
`avgPrice` — is discarded.

`OrderRecoverySignal`'s two fill-carrying variants are extended:

```ts
type OrderRecoverySignal =
  | { kind: "live_unfilled" }
  | { kind: "live_with_fill"; averageEntryPrice: string }
  | { kind: "terminal_with_fill"; averageEntryPrice: string }
  | { kind: "terminal_without_fill" }
  | { kind: "not_found" }
  | { kind: "inconclusive" };
```

`classifyOrderForRecovery` populates `averageEntryPrice` from whichever query (realtime or history)
positively found the order in a fill-carrying state, using that response's own `avgPrice` field. Zero new
exchange calls: the data is already in hand every attempt this classification already runs. An empty
`avgPrice` (a valid, Bybit-documented transient omission — `orderQueryResponseDecoder.ts`'s
`isPositiveOrEmptyExactDecimal` already tolerates it) on a fill-carrying result cannot construct a valid
`average_entry_price`; whichever branch of Decision 3 would otherwise resolve `position_open` fails closed
instead, mirroring Change 3's "a fill with no usable average price fails closed" requirement exactly.

This value is this cycle's own entry cost basis and is reported only for `position_open` — it plays no
role in resolving `terminal_after_fill` (which reports no fill facts at all, unchanged).

## Decision 2 — `first_fill_at_ms` reuses Change 3's exact durable-capture mechanism (unchanged from the prior draft)

Unchanged from the prior draft of this design. When Decision 3's grid resolves a `position_open` outcome:
if the record's own `first_fill_at_ms` is already durable, it is reused with no exchange call, identical
to `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing fast path; otherwise
`EntryCycleRecoveryResolutionService` calls the same exported `resolveFirstAttributableFillAtMs`
(`packageConfirmation.ts`, unchanged) and durably saves the result exactly as Change 3 already does,
under the same shared per-pair `KeyedMutex` instance already passed into
`OpenPositionResolutionService`/`ProtectionApplicationService`/`CloseApplicationService`.
`EntryCycleRecoveryResolutionServiceDeps` gains a new `mutex: KeyedMutex` dependency. See the prior
draft's full rationale for why the same shared instance (not a second, recovery-scoped lock) is required,
and for the narrow locked-section shape (acquire only around the capture-or-reuse step, re-read the
record fresh under the lock, resolve the correct terminal result if a concurrent close raced ahead) — all
of that is unchanged by this revision; only *which* pure-function outcome triggers it changes (Decision 3
below), not the mechanism itself.

A capture failure (`no_executions_found` or `ambiguous`) fails closed (`internal_error`) — `position_open`
is never resolved with a fabricated or omitted `first_fill_at_ms`.

## Decision 3 (replaces the retracted "grid is unchanged" premise) — every state resolves from own evidence; the aggregate becomes per-state weak sanity

### 3a. What was actually wrong

`resolveRecoveryState`'s current code:

```ts
const positionOpen = positionQuery.kind === "position" && positionSideMatches(positionQuery.row.side, desiredEntry);
const positionFlat = positionQuery.kind === "no_position";

if (orderSignal.kind === "live_unfilled" && positionFlat) return { state: "entry_order_live" };
if ((orderSignal.kind === "live_with_fill" || orderSignal.kind === "terminal_with_fill") && positionOpen) return { state: "position_open", ... };
if (orderSignal.kind === "terminal_with_fill" && positionFlat) return { state: "terminal_after_fill" };
if (orderSignal.kind === "terminal_without_fill" && positionFlat) return { state: "terminal_without_fill" };
return undefined;
```

`entry_order_live` and `terminal_without_fill` both require `positionFlat` — the aggregate reporting *no
position at all* on the scope. Under same-side shared scope this is not a rare edge case, it is the
**normal** condition whenever a sibling cycle already holds an open position on the same scope: `B` has a
genuinely live, unfilled entry order and zero fill of its own, `A` (a same-side sibling) already has an
open position, `B`'s aggregate query returns `A`'s position (`positionQuery.kind === "position"`), so
`positionFlat` is `false`, `B`'s own genuinely-live-and-unfilled state can never resolve `entry_order_live`
— it falls through to `undefined` (fail safe) on every attempt, forever, for as long as `A`'s position
remains open. The identical failure applies to `terminal_without_fill`. This is a genuine regression this
capability would otherwise ship once same-side ownership activation (a later change in the program)
allows more than one owner per scope.

### 3b. Corrected design: own evidence resolves the state; the aggregate is consulted only for a bounded, per-state sanity question

Every state is now resolved primarily from evidence this specific cycle's own identity produces — its own
entry order (already the case for the order-query signal) and, when its entry order proves a fill, its
own close order (a **new** read, reusing Change 2's existing durable `close_order_link_id` field and this
capability's own existing `classifyOrderForRecovery` primitive a second time, pointed at a different
identity — not a new mechanism). The aggregate position query is retained, but every use of it is
downgraded from "required positive agreement" to a narrow, state-appropriate sanity question that can
only ever *block* a resolution it would otherwise reach, never manufacture one own evidence does not
already support.

**`entry_order_live`** (own order signal `live_unfilled`):
- Own evidence alone (a positively live, unfilled entry order under this cycle's own `order_link_id`) is
  sufficient.
- Sanity: fails closed only if the aggregate positively confirms an open position on the **opposite**
  side of this record's own `desired_entry.side`. A same-side aggregate position (a sibling's own
  exposure) or no position at all are both compatible with this cycle's own order genuinely still being
  live and unfilled, and no longer block the resolution.
- Defensive check, expected unreachable in practice: fails closed if `record.close_order_link_id` is
  non-null — `CloseApplicationService` always neutralizes (cancels and confirms terminal) the entry order
  before ever dispatching a close order (`closeApplicationService.ts:166-192`, entered before
  `processMultiOwnerClose`/`dispatchMultiOwnerCloseOrder`), so a durably-recorded close attempt
  co-occurring with a still-live entry order is a structural contradiction, not a state this capability
  should try to interpret.

**`terminal_without_fill`** (own order signal `terminal_without_fill`, i.e. positively terminal with zero
cumulative fill):
- Own evidence alone is sufficient — identical reasoning and the identical two checks (opposite-side
  sanity, defensive `close_order_link_id` non-null check) as `entry_order_live` above.

**`position_open` / `terminal_after_fill`** (own order signal `live_with_fill` or `terminal_with_fill` — a
positively observed fill on this cycle's own entry order):

1. If `record.close_order_link_id` is `null` — ABI has never durably recorded a close attempt for this
   cycle. This cycle's own exposure is open by definition of ABI's own durable state, independent of
   what any sibling is doing. Sanity: the aggregate must positively confirm an existing position on the
   matching side (the same existence-only check Change 3's `determine()` already performs before
   returning "open" — mirrors, does not duplicate, that pattern) — if the aggregate shows no position at
   all, or a wrong-side position, that is a genuine contradiction between this cycle's own fill evidence
   and physical reality, and resolution fails closed rather than trusting own evidence blindly. If the
   aggregate confirms an existing same-side position (whether or not a sibling also contributes to it),
   resolve `position_open`.
2. If `record.close_order_link_id` is non-null and the own order signal is `live_with_fill` — fails
   closed (the same structural-contradiction reasoning as the defensive checks above: a close cannot have
   been durably dispatched while the entry order that funds it is still live).
3. If `record.close_order_link_id` is non-null and the own order signal is `terminal_with_fill` — query
   this cycle's own close order's current state via the same `classifyOrderForRecovery` primitive already
   used for the entry order, scoped to `close_order_link_id`/`close_order_id` instead
   (`{ category, symbol, orderLinkId: record.close_order_link_id, limit: "1" }` for both the realtime and
   history payloads — the function itself is already identity-agnostic; only the identity passed in
   differs):
   - Close order signal `terminal_with_fill` (positively confirmed to have executed with a fill) →
     resolve `terminal_after_fill`. No aggregate check at all: this cycle's own two-order evidence chain
     (entry filled, its own close order also confirmed filled) is fully self-contained and requires no
     external corroboration — critically, it must never be blocked or reinterpreted by a same-side
     sibling's own still-open aggregate contribution (see 3c below, the case this fixes).
   - Close order signal `terminal_without_fill` (positively confirmed terminal with zero fill — the
     close attempt was rejected or otherwise never executed) → this cycle's own exposure was never
     actually reduced; resolve `position_open` using the same sanity rule as case 1 above (aggregate must
     confirm an existing same-side position).
   - Any other close order signal (`live_unfilled`, `live_with_fill`, `not_found`, `inconclusive`) — the
     close order's own fate is not yet positively established; fails closed, exactly like any other
     inconclusive evidence this capability already treats this way. A caller retries later: either this
     capability resolves cleanly on a subsequent attempt once the close order's fate is positively
     established, or a caller's retried `POST /close` durably closes the cycle first, after which the
     existing durably-closed-status fast path (unchanged) answers directly with zero exchange calls.

### 3c. Why `terminal_after_fill` must never consult the aggregate

This is the scenario the review that produced this correction specifically asked to be checked: could a
same-side sibling's own still-open aggregate contribution cause recovery to mis-resolve `position_open`
for a cycle whose own exposure is already correctly terminal? Under the retracted first draft, this
capability would never have reached that question, because `terminal_after_fill` never queried the
aggregate at all in the original code either — the risk was theoretical only in the sense that the whole
first draft's premise (grid already safe) needed re-examination, not because this specific branch was
independently found to be at risk. Having redesigned every branch from scratch, this design deliberately
preserves that same property for the new `terminal_after_fill` path: once this cycle's own two-order
evidence chain (entry filled; its own close order also confirmed filled) is established, no aggregate
read is performed for that outcome at all — there is no code path by which a sibling `A`'s own open
position could influence it, because the aggregate is never consulted once evidence-chain step 3's
`terminal_with_fill` branch is reached. This is a structural guarantee (the code path physically does not
call `queryPositionForInstrument`'s result for this branch), not a behavioral coincidence to be verified
only by test — though Required Test 4 below verifies it anyway, per this change's own instruction not to
rely on inspection alone for a claim this consequential (the same discipline Change 3's proposal already
applied to its own `ProtectionApplicationService` regression claim).

### 3d. Aggregate sanity, formalized

```ts
type AggregateSanity = "opposite_side_contradiction" | "same_side_exists" | "no_signal";

function classifyAggregateSanity(positionQuery: PositionQueryResult, desiredEntry: DesiredEntryDto | null): AggregateSanity {
  if (positionQuery.kind !== "position") return "no_signal"; // no_position, or a query failure/inconclusive result
  return positionSideMatches(positionQuery.row.side, desiredEntry) ? "same_side_exists" : "opposite_side_contradiction";
}
```

`"no_signal"` covers both a genuinely flat aggregate and an inconclusive/failed query — deliberately
collapsed into one outcome, since this capability's own "absence of evidence is never evidence of
absence" rule already establishes that a query that merely fails to contradict is not by itself positive
proof of anything; the two zero-fill states' own evidence does not need the aggregate's corroboration
regardless, and `position_open`'s own sanity check already requires the stronger `"same_side_exists"`
outcome, not merely the absence of `"opposite_side_contradiction"`.

### 3e. Orchestration: where the close-order query fits in the existing bounded-retry loop

`process()`'s existing per-attempt loop already issues the entry-order query and the aggregate query
every attempt. The close-order query is issued **conditionally**, only within an attempt where the
entry-order signal that same attempt just produced is `live_with_fill` or `terminal_with_fill` **and**
`record.close_order_link_id` (read once, before the loop, from the record already loaded — this field is
immutable-once-set per Change 2's own design, so re-reading it every attempt is unnecessary) is non-null.
This mirrors the existing loop's own shape (multiple sequential reads per attempt, no concurrent
in-flight requests, matching every other bounded-retry pipeline in this codebase) rather than introducing
a nested retry loop of its own — the close-order query gets the same bounded-retry coverage as the entry
order and aggregate queries simply by being inside the same loop.

`resolveRecoveryState` itself remains a pure, synchronous function — all evidence (`orderSignal`,
`closeSignal: OrderRecoverySignal | undefined`, `closeOrderAttempted: boolean`, `positionQuery`,
`desiredEntry`) is gathered by the async orchestration in `process()` before being passed in, exactly
matching this capability's existing separation between async I/O and pure decision logic.

## Regression analysis (single-owner, today's only production-reachable state)

For a scope with exactly one owner, `record.close_order_link_id` is always `null` while the record is
non-durably-closed (single-owner close, `CloseApplicationService`'s `processSingleOwnerClose` path, never
sets `close_order_link_id` — that field is written only by the multi-owner close path). This means, for
every production-reachable record today: the close-order query is never issued (its precondition,
`close_order_link_id !== null`, is never true), `entry_order_live`/`terminal_without_fill`/
`position_open`'s case-1 branch behave exactly as `positionFlat`/`positionOpen` did before (a single
owner's own aggregate is definitionally either flat or this cycle's own position — no sibling exists to
create the gap this redesign fixes), and `terminal_after_fill` is reached, as before, only via the
now-superseded code path that no longer exists in production (single-owner close writes `terminal_closed`
directly, never leaving a non-durably-closed record with a proven entry fill and no close attempt for the
dual-query loop to ever resolve `terminal_after_fill` from in the first place — this was already true
before this change and is unaffected by it). `average_entry_price`/`first_fill_at_ms` sourcing changes are
unchanged from the prior draft's regression analysis (see below).

- `average_entry_price`: numerically identical to before — same underlying single fill, different
  (correct) extraction path.
- `first_fill_at_ms`: may differ from the aggregate's previous `openTime` value by a small, expected
  amount — this is the fix already analyzed in the prior draft (own-execution-derived value now agrees
  with what `GET .../open-position` already reports for the same pair, removing a latent inconsistency).
- Every fail-closed combination not touched by this redesign (opposite-side contradiction, inconclusive
  order/position queries, the legacy `pending_action` guard, the durably-closed-status fast path):
  byte-for-byte unchanged.

## Required tests

1. `average_entry_price`/`first_fill_at_ms` sourcing tests 1-8 from the prior draft (own-order `avgPrice`
   used instead of the aggregate's; durable capture reuse/first-capture/failure/concurrency/racing-close
   scenarios) — unchanged, still required, not superseded by this revision.
2. **A open + B `live_unfilled` (no own fill, no close attempted) → recovery(B) = `entry_order_live`**,
   with the aggregate query returning `A`'s own open position on the matching side. This is the exact
   scenario the retracted premise would have failed closed on.
3. **A open + B `terminal_without_fill` (no own fill, no close attempted) → recovery(B) =
   `terminal_without_fill`**, aggregate returning `A`'s own open position on the matching side.
4. **A open + B has its own fill, no close attempted → recovery(B) = `position_open` with B's own
   `average_entry_price`/`first_fill_at_ms`**, never A's — aggregate returning a position whose `avgPrice`
   deliberately differs from B's own order response, verifying the response reflects B's own value.
5. **Aggregate sibling activity alone never turns a B with zero own fill into `position_open`** — for
   every `orderSignal.kind` other than `live_with_fill`/`terminal_with_fill`, no aggregate state (open,
   flat, opposite-side, or query failure) can produce a `position_open` outcome; verified by construction
   (the fill-carrying branch is the only branch that can return `position_open`) and by an explicit test
   fixture.
6. **A open + B's own close order confirms a fill → recovery(B) = `terminal_after_fill`**, with the
   aggregate still positively reporting `A`'s open position throughout — the specific scenario Decision
   3c analyzes, verifying a same-side sibling's aggregate contribution never overrides B's own two-order
   evidence chain.
7. **B's own close order is durably recorded but still live/not found/inconclusive → recovery(B) fails
   closed**, regardless of aggregate state — the close order's own fate is not yet positively established.
8. **B's own close order is durably recorded and positively terminal with zero fill (a rejected close
   attempt) → recovery(B) = `position_open`**, using B's own entry-order fill facts, sanity-checked
   against an existing same-side aggregate position.
9. **Opposite-side contradiction remains fail-closed for `entry_order_live`/`terminal_without_fill`**: own
   evidence positively supports either zero-fill state, but the aggregate positively confirms an open
   position on the opposite side — fails closed, unchanged in spirit from this capability's existing
   opposite-side handling, now explicitly covering these two states too.
10. **`position_open`'s existence sanity still fails closed when the aggregate cannot confirm a matching
    position at all** (no position, or wrong side) even though B's own fill evidence is positive — the
    same contradiction-detection Change 3's Decision 1 already establishes, now verified for recovery too.
11. Full regression of every existing `entryCycleRecoveryResolutionService.test.ts` scenario that this
    redesign does not intentionally change: the durably-closed-status fast path, the legacy
    `pending_action` guard, and every single-owner (`close_order_link_id === null`) combination — these
    must resolve identically to today.
