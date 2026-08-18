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

This design implements the corrected scope: own-cycle durable/order/execution evidence determines the
**candidate** state for all four recovery states; the aggregate position query can only **veto** a
candidate as narrow, per-state weak sanity (existence/side-compatibility only) — it can never manufacture
a state own evidence does not already support, and it is never a required positive-agreement gate own
evidence must wait on. This is the same attributable-evidence-primary, aggregate-weak-sanity pattern
Change 2 and Change 3 already established, now actually applied to every state this capability resolves,
not only to `position_open`'s two fill facts. (An earlier draft of this document phrased this as "own
evidence is sufficient" — that overstated it in the `position_open`/`terminal_after_fill` direction,
where a veto can still apply; "own evidence determines the candidate, aggregate can only veto" is the
precise framing used throughout this document from here on.)

## Goals / Non-Goals

**Goals:**
- Every one of the four recovery states' **candidate** resolution comes from this specific cycle's own
  durable/order/execution evidence, and is never blocked or mis-resolved solely because a same-side
  sibling cycle's own activity is visible in the shared aggregate position.
- `position_open` vs `terminal_after_fill`, once this cycle's own entry order proves a fill, is
  disambiguated using this cycle's own close-order identity and its own confirmed fate, verified with
  **exactly the same qty-matching strictness** `CloseApplicationService` already uses to confirm its own
  dispatch succeeded (Decision 3) — not a looser "any fill counts" rule. This reuses Change 2's
  already-durable `close_order_link_id` field and a **shared, extracted primitive** (Decision 3) that both
  `CloseApplicationService` and this capability call — never a second implementation, and never the
  aggregate.
- The aggregate position query is retained only where it can still say something both true and useful
  under shared scope, and only as a **veto**: a genuine opposite-side contradiction (a real, structural
  invariant violation, not a normal shared-scope condition) for the two zero-fill states, and same-side
  existence sanity (mirroring Change 3's Decision 1 exactly) for `position_open`. It is consulted at all
  only after own evidence has already produced a candidate state — it never itself produces one.
- `average_entry_price`/`first_fill_at_ms` sourcing (the original scope of this change) is preserved
  exactly as previously designed and reused, not duplicated.
- No new close-side machinery beyond one minimal, shared, read-only classification primitive extracted
  from `CloseApplicationService`'s own existing logic (Decision 3) — no new adapter primitive, no new
  decoder, no cancel/retry/dispatch logic, no second close-execution state machine, no generic
  order-management subsystem.

**Non-Goals:**
- A new close-side decision policy. `terminal_after_fill` requires an *exact* qty match between this
  cycle's own close order's confirmed fill and this cycle's own entry order's confirmed fill — the same
  strictness `CloseApplicationService.resolveCloseOrderOutcome` already applies for its own, different
  purpose (verifying its own dispatch fully succeeded before durably writing `terminal_closed`). This
  design does not loosen that strictness for recovery's purposes; it reuses it exactly, via the shared
  primitive in Decision 3.
- Partial-close-of-own-share *accounting* — recovery still only produces one of its four existing coarse
  states, never a fractional or partial-close state of its own. A close order that only partially filled
  is reported as a genuine disagreement recovery fails safe on (see Decision 3), not silently rounded to
  either `position_open` or `terminal_after_fill`; V1 does not support partial-close-of-own-share as a
  target end state at all (master plan, "V1 full-close-only"), and finishing an incomplete close remains
  `CloseApplicationService`'s own concern via a caller's retried `POST /close`.
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

`OrderRecoverySignal`'s two fill-carrying variants are extended with **both** `averageEntryPrice` (this
Decision) **and** `cumulativeFilledQty` (needed by Decision 3's close-order disambiguation, added here
because it comes from the exact same already-decoded response — see that Decision for why):

```ts
type OrderRecoverySignal =
  | { kind: "live_unfilled" }
  | { kind: "live_with_fill"; averageEntryPrice: string; cumulativeFilledQty: string }
  | { kind: "terminal_with_fill"; averageEntryPrice: string; cumulativeFilledQty: string }
  | { kind: "terminal_without_fill" }
  | { kind: "not_found" }
  | { kind: "inconclusive" };
```

`classifyOrderForRecovery` populates `averageEntryPrice` and `cumulativeFilledQty` from whichever query
(realtime or history) positively found the order in a fill-carrying state, using that response's own
`avgPrice`/`cumExecQty` fields — both already decoded into `BybitOrderView`. Zero new exchange calls: the
data is already in hand every attempt this classification already runs. An empty `avgPrice` (a valid,
Bybit-documented transient omission — `orderQueryResponseDecoder.ts`'s `isPositiveOrEmptyExactDecimal`
already tolerates it) on a fill-carrying result cannot construct a valid `average_entry_price`; whichever
branch of Decision 4 would otherwise resolve `position_open` fails closed instead, mirroring Change 3's "a
fill with no usable average price fails closed" requirement exactly. The identical empty/non-positive
tolerance applies to `cumulativeFilledQty` — see Decision 3 for where and how that value is actually
consumed and what happens when it is unusable.

`averageEntryPrice` is this cycle's own entry cost basis and is reported only for `position_open` — it
plays no role in resolving `terminal_after_fill` (which reports no fill facts at all, unchanged).
`cumulativeFilledQty` plays no role in `position_open`'s own response fields at all — it exists solely to
serve as the expected close quantity Decision 3's shared primitive verifies this cycle's own close order
against.

## Decision 2 — `first_fill_at_ms` reuses Change 3's exact durable-capture mechanism (unchanged from the prior draft)

Unchanged from the prior draft of this design. When Decision 4's grid resolves a `position_open` outcome:
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
of that is unchanged by this revision; only *which* pure-function outcome triggers it changes (Decision 4
below), not the mechanism itself.

A capture failure (`no_executions_found` or `ambiguous`) fails closed (`internal_error`) — `position_open`
is never resolved with a fabricated or omitted `first_fill_at_ms`.

## Decision 3 — a shared, minimal close-outcome primitive, extracted from Change 2, not duplicated

**Blocker found on review of the first correction pass, fixed here.** That pass had Decision 4's
`position_open`/`terminal_after_fill` disambiguation query this cycle's own close order using
`classifyOrderForRecovery` alone — the same primitive used for the entry order, which only classifies
*whether* a fill occurred (`terminal_with_fill` iff cumulative fill is positive), not *how much* was
filled relative to what this cycle's own close was expected to close. `CloseApplicationService` already
has strictly stronger, already-shipped semantics for this exact question — `resolveCloseOrderOutcome`
(`closeApplicationService.ts:471-516`): terminality, **then** an exact quantity match between the close
order's own confirmed cumulative fill and this cycle's own expected close quantity, via
`confirmEntryPackage` and `decimalEquals`. Reusing only `classifyOrderForRecovery`'s coarser signal would
let a **partial** close-order fill (real qty < expected qty — a genuinely unresolved, ambiguous state
`CloseApplicationService` itself treats as `"incomplete"`, never as done) be reported by recovery as a
clean `terminal_after_fill`, which is wrong: this cycle's own exposure would not actually be fully closed.

This design does not re-derive that stronger logic a second time. It extracts the **single-shot**
classification core of `CloseApplicationService.resolveCloseOrderOutcome` (terminality check, then
`confirmEntryPackage`-based qty comparison — no internal retry loop) into a new function in
`packageConfirmation.ts`, alongside `classifyEntryOrderTerminality`/`confirmEntryPackage`, which it calls
directly and unchanged:

```ts
export type OwnCloseOrderOutcome =
  | { kind: "matched" }        // terminal, cumulative fill exactly equals expectedQty
  | { kind: "zero_fill" }      // terminal, confirmed zero fill (rejected / never executed)
  | { kind: "qty_mismatch" }   // terminal, a fill occurred but does not exactly equal expectedQty
  | { kind: "not_found" }      // genuinely absent from both realtime and history
  | { kind: "ambiguous" };     // still live, or a query/classification failure — caller retries

// Single-shot (no internal retry) classification of one close order's own
// fate against an expected fully-closed quantity. Both CloseApplicationService
// and EntryCycleRecoveryResolutionService call this directly; each owns its
// own retry cadence around it (see below) rather than sharing one, since the
// two callers' existing bounded-retry shapes are already independently
// established and differ (different attempt counts, different callers).
export async function classifyOwnCloseOrderOutcome(input: {
  bybit: BybitAdapter;
  getCloseOrderPayload: BybitGetOrderByLinkIdPayload;
  getCloseOrderHistoryPayload: BybitGetOrderHistoryPayload;
  expectedQty: string;
}): Promise<OwnCloseOrderOutcome> {
  const terminality = await classifyEntryOrderTerminality({
    bybit: input.bybit,
    getEntryOrderPayload: input.getCloseOrderPayload,
    getEntryOrderHistoryPayload: input.getCloseOrderHistoryPayload,
  });
  if (terminality.kind !== "terminal") return { kind: "ambiguous" };

  const confirmation = await confirmEntryPackage({
    bybit: input.bybit,
    getEntryOrderPayload: input.getCloseOrderPayload,
    getEntryOrderHistoryPayload: input.getCloseOrderHistoryPayload,
    expected: { qty: input.expectedQty },
  });

  if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
    return decimalEquals(confirmation.observation.cumulative_filled_qty, input.expectedQty)
      ? { kind: "matched" }
      : { kind: "qty_mismatch" };
  }
  if (confirmation.kind === "terminal_without_fill") return { kind: "zero_fill" };
  if (confirmation.kind === "not_found") return { kind: "not_found" };
  return { kind: "ambiguous" }; // "ambiguous" despite terminal classification
}
```

**`CloseApplicationService.resolveCloseOrderOutcome` becomes a thin wrapper**, unchanged in behavior: it
loops (its own existing `FINAL_VERIFY_ATTEMPTS`/`FINAL_VERIFY_RETRY_DELAY_MS`), calls
`classifyOwnCloseOrderOutcome` once per attempt, and collapses the richer taxonomy back to its own
existing four-value contract — `"matched"` unchanged, `"zero_fill"` and `"qty_mismatch"` both collapse to
its existing `"incomplete"` (Close never needed to tell these apart; recovery does — see Decision 4),
`"not_found"` unchanged, `"ambiguous"` unchanged (retry, then give up after the bound). This is a pure
extraction: Close's own byte-for-byte behavior, verified by its own existing regression suite, is
unaffected.

**`EntryCycleRecoveryResolutionService` calls the same function once per its own outer attempt** — no
second, nested retry loop; the existing `RECOVERY_ATTEMPTS`/`RECOVERY_RETRY_DELAY_MS` bounded-retry loop
already covers it, exactly as it already covers the entry-order and aggregate-position queries within
each attempt (Decision 4e). The one difference from Close's own usage: recovery's `expectedQty` is this
cycle's own entry order's own confirmed cumulative fill — already available as
`orderSignal.cumulativeFilledQty` (Decision 1's extension to `OrderRecoverySignal`), not a fresh
`confirmEntryPackage` call the way `CloseApplicationService.resolveOwnExposure` performs one for its own,
different purpose (verifying a value it has not already fetched this request). If
`orderSignal.cumulativeFilledQty` is empty or not strictly positive on a fill-carrying signal — the same
kind of transient Bybit omission Decision 1 already accounts for on `averageEntryPrice` — there is no
valid `expectedQty` to check the close order against, and resolution fails closed before ever calling
`classifyOwnCloseOrderOutcome`.

This adds exactly one new file-level export (`classifyOwnCloseOrderOutcome`, in an existing file) and
zero new adapter primitives, decoders, or Bybit endpoints — no generic order-management subsystem, no
second close-execution machine, one classification function two callers share.

## Decision 4 (replaces the retracted "grid is unchanged" premise) — own evidence determines the candidate state; the aggregate can only veto, as weak sanity

### 4a. What was actually wrong

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

### 4b. Corrected design: own evidence determines the candidate state; the aggregate can only veto, as a bounded, per-state sanity question

Every state's **candidate** is now determined primarily from evidence this specific cycle's own identity
produces — its own entry order (already the case for the order-query signal) and, when its entry order
proves a fill, its own close order (queried via the shared `classifyOwnCloseOrderOutcome` primitive,
Decision 3 — reusing Change 2's existing durable `close_order_link_id` field and Change 2's own
already-shipped strict qty-matching semantics, not a new mechanism). The aggregate position query is
retained, but every use of it is downgraded from "required positive agreement" to a narrow,
state-appropriate **veto**: it is consulted only after own evidence has already produced a candidate, and
it can only fail that candidate closed — it can never itself produce a candidate own evidence does not
already support.

**`entry_order_live`** (own order signal `live_unfilled`):
- Own evidence (a positively live, unfilled entry order under this cycle's own `order_link_id`) produces
  the candidate.
- Veto: fails closed only if the aggregate positively confirms an open position on the **opposite**
  side of this record's own `desired_entry.side`. A same-side aggregate position (a sibling's own
  exposure) or no position at all are both compatible with this cycle's own order genuinely still being
  live and unfilled, and no longer veto the candidate.
- Defensive check, expected unreachable in practice: fails closed if `record.close_order_link_id` is
  non-null — `CloseApplicationService` always neutralizes (cancels and confirms terminal) the entry order
  before ever dispatching a close order (`closeApplicationService.ts:166-192`, entered before
  `processMultiOwnerClose`/`dispatchMultiOwnerCloseOrder`), so a durably-recorded close attempt
  co-occurring with a still-live entry order is a structural contradiction, not a state this capability
  should try to interpret.

**`terminal_without_fill`** (own order signal `terminal_without_fill`, i.e. positively terminal with zero
cumulative fill):
- Own evidence produces the candidate directly — identical reasoning and the identical two checks
  (opposite-side veto, defensive `close_order_link_id` non-null check) as `entry_order_live` above.

**`position_open` / `terminal_after_fill`** (own order signal `live_with_fill` or `terminal_with_fill` — a
positively observed fill on this cycle's own entry order):

1. If `record.close_order_link_id` is `null` — ABI has never durably recorded a close attempt for this
   cycle. This cycle's own exposure is open by definition of ABI's own durable state, independent of
   what any sibling is doing — this produces the `position_open` candidate. Veto: the aggregate must
   positively confirm an existing position on the matching side (the same existence-only check Change 3's
   `determine()` already performs before returning "open" — mirrors, does not duplicate, that pattern) —
   if the aggregate shows no position at all, or a wrong-side position, that is a genuine contradiction
   between this cycle's own fill evidence and physical reality, and resolution fails closed rather than
   trusting own evidence blindly. If the aggregate confirms an existing same-side position (whether or
   not a sibling also contributes to it), the veto does not apply and `position_open` resolves.
2. If `record.close_order_link_id` is non-null and the own order signal is `live_with_fill` — fails
   closed (the same structural-contradiction reasoning as the defensive checks above: a close cannot have
   been durably dispatched while the entry order that funds it is still live). No close-order query is
   issued in this case.
3. If `record.close_order_link_id` is non-null and the own order signal is `terminal_with_fill` — call
   the shared `classifyOwnCloseOrderOutcome` (Decision 3), scoped to `close_order_link_id`/`close_order_id`
   (`{ category, symbol, orderLinkId: record.close_order_link_id, limit: "1" }` for both the realtime and
   history payloads) with `expectedQty` set to `orderSignal.cumulativeFilledQty` (this cycle's own entry
   order's own confirmed cumulative fill — Decision 1):
   - `{ kind: "matched" }` (this cycle's own close order's confirmed fill exactly equals this cycle's own
     expected close quantity) → resolve `terminal_after_fill`. No aggregate check at all: this cycle's own
     two-order evidence chain (entry filled the expected amount, close filled that same exact amount) is
     fully self-contained and requires no external corroboration — critically, it must never be blocked or
     reinterpreted by a same-side sibling's own still-open aggregate contribution (see 4c below, the case
     this fixes).
   - `{ kind: "zero_fill" }` (the close order is positively confirmed terminal with zero fill — the close
     attempt was rejected or otherwise never executed) → this cycle's own exposure was never actually
     reduced; resolve `position_open` using the same veto as case 1 above (aggregate must confirm an
     existing same-side position).
   - `{ kind: "qty_mismatch" }` (the close order filled, but not exactly the expected amount — a genuine,
     unresolved partial close) → fails closed. This is neither `position_open` (some of this cycle's own
     exposure was reduced, so reporting the original fill facts as still fully open would be wrong) nor
     `terminal_after_fill` (the reduction is not confirmed complete) — it is exactly the ambiguous
     in-between state `CloseApplicationService.resolveCloseOrderOutcome` itself already treats as
     unresolved (`"incomplete"`, prompting a caller's retried `POST /close`), and recovery fails closed on
     it for the identical reason, rather than inventing a fifth state or guessing which of the existing
     four it should round to.
   - `{ kind: "not_found" }` or `{ kind: "ambiguous" }` — the close order's own fate is not yet positively
     established; fails closed, exactly like any other inconclusive evidence this capability already
     treats this way. A caller retries later: either this capability resolves cleanly on a subsequent
     attempt once the close order's fate is positively established, or a caller's retried `POST /close`
     durably closes the cycle first, after which the existing durably-closed-status fast path (unchanged)
     answers directly with zero exchange calls.

### 4c. Why `terminal_after_fill` must never consult the aggregate

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
`{ kind: "matched" }` branch is reached. This is a structural guarantee (the code path physically does not
call `queryPositionForInstrument`'s result for this branch), not a behavioral coincidence to be verified
only by test — though Required Test 6 below verifies it anyway, per this change's own instruction not to
rely on inspection alone for a claim this consequential (the same discipline Change 3's proposal already
applied to its own `ProtectionApplicationService` regression claim).

### 4d. Aggregate sanity, formalized

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

### 4e. Orchestration: where the close-order query fits in the existing bounded-retry loop

`process()`'s existing per-attempt loop already issues the entry-order query and the aggregate query
every attempt. The close-order query (`classifyOwnCloseOrderOutcome`, Decision 3 — itself internally
issuing up to two further reads, terminality then confirmation, each with their own realtime/history
fallback; the same cost `CloseApplicationService` already pays for the identical reason, not a new
inefficiency this design introduces) is issued **conditionally**, only within an attempt where the
entry-order signal that same attempt just produced is `terminal_with_fill` (never `live_with_fill` — case
2 above fails closed without querying) **and** `record.close_order_link_id` (read once, before the loop,
from the record already loaded — this field is immutable-once-set per Change 2's own design, so
re-reading it every attempt is unnecessary) is non-null. This mirrors the existing loop's own shape
(multiple sequential reads per attempt, no concurrent in-flight requests, matching every other
bounded-retry pipeline in this codebase) rather than introducing a nested retry loop of its own — the
close-order query gets the same bounded-retry coverage as the entry order and aggregate queries simply by
being inside the same loop.

`resolveRecoveryState` itself remains a pure, synchronous function — all evidence (`orderSignal`,
`closeOutcome: OwnCloseOrderOutcome | undefined`, `closeOrderAttempted: boolean`, `positionQuery`,
`desiredEntry`) is gathered by the async orchestration in `process()` before being passed in, exactly
matching this capability's existing separation between async I/O and pure decision logic.

## Regression analysis (single-owner, today's only production-reachable state)

For a scope with exactly one owner, `record.close_order_link_id` is always `null` while the record is
non-durably-closed (single-owner close, `CloseApplicationService`'s `processSingleOwnerClose` path, never
sets `close_order_link_id` — that field is written only by the multi-owner close path). This means, for
every production-reachable record today: the close-order query (`classifyOwnCloseOrderOutcome`) is never
issued (its precondition, `close_order_link_id !== null`, is never true) — Decision 4b's case 3 and its
`qty_mismatch`/`zero_fill`/`matched` taxonomy are unreached in production until same-side ownership
activation. `entry_order_live`/`terminal_without_fill`/`position_open`'s case-1 candidate-plus-veto
behaves exactly as the retracted, single-owner-only `positionFlat`/`positionOpen` gate did before (a
single owner's own aggregate is definitionally either flat or this cycle's own position — no sibling
exists to create the gap this redesign fixes), and `terminal_after_fill` is reached, as before, only via the
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
6. **A open + B's own close order confirms an exact qty match (`{ kind: "matched" }`) → recovery(B) =
   `terminal_after_fill`**, with the aggregate still positively reporting `A`'s open position throughout —
   the specific scenario Decision 4c analyzes, verifying a same-side sibling's aggregate contribution
   never overrides B's own two-order evidence chain, and verifying no call to `queryPositionForInstrument`
   influences this outcome (construction, not just behavior).
7. **B's own close order fills, but not the exact expected quantity (`{ kind: "qty_mismatch" }`) →
   recovery(B) fails closed**, regardless of aggregate state — the specific blocker this revision fixes:
   a partial close-order fill must never be reported as a clean `terminal_after_fill`, and must never be
   silently rounded to `position_open` either.
8. **B's own close order is durably recorded but still live/not found/inconclusive (`{ kind: "not_found"
   }` / `{ kind: "ambiguous" }`) → recovery(B) fails closed**, regardless of aggregate state — the close
   order's own fate is not yet positively established.
9. **B's own close order is durably recorded and positively terminal with zero fill (`{ kind: "zero_fill"
   }`, a rejected close attempt) → recovery(B) = `position_open`**, using B's own entry-order fill facts,
   sanity-checked against an existing same-side aggregate position.
10. **Opposite-side contradiction remains fail-closed for `entry_order_live`/`terminal_without_fill`**: own
    evidence positively supports either zero-fill state, but the aggregate positively confirms an open
    position on the opposite side — fails closed, unchanged in spirit from this capability's existing
    opposite-side handling, now explicitly covering these two states too.
11. **`position_open`'s existence veto still fails closed when the aggregate cannot confirm a matching
    position at all** (no position, or wrong side) even though B's own fill evidence is positive — the
    same contradiction-detection Change 3's Decision 1 already establishes, now verified for recovery too.
12. **`classifyOwnCloseOrderOutcome` (Decision 3) is a pure extraction**: `CloseApplicationService`'s own
    existing `resolveCloseOrderOutcome` regression suite passes unchanged after the extraction — its
    `"matched"`/`"incomplete"`/`"not_found"`/`"ambiguous"` outcomes are byte-for-byte identical to before,
    with `zero_fill` and `qty_mismatch` both correctly collapsing to `"incomplete"`.
13. B's own entry order carries an empty/non-positive `cumulativeFilledQty` on an otherwise fill-carrying
    signal, with a close order durably recorded → fails closed before ever calling
    `classifyOwnCloseOrderOutcome` (no valid `expectedQty` to check against).
14. Full regression of every existing `entryCycleRecoveryResolutionService.test.ts` scenario that this
    redesign does not intentionally change: the durably-closed-status fast path, the legacy
    `pending_action` guard, and every single-owner (`close_order_link_id === null`) combination — these
    must resolve identically to today.
