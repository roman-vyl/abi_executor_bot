## Context

See `proposal.md` for Why/What. This document resolves exactly one thing: how ABI reads and classifies
its own entry order's Bybit-native attached protection children, without creating, cancelling, or
modifying anything, and without adding durable state. It intentionally stops short of everything
`docs/virtual-exposure-ownership-delivery-plan.md` assigns to
`abi-native-partial-protection-lifecycle-v1` (replacement/update lifecycle) and
`abi-native-partial-protection-cutover-v1` (mapping switch, guard removal, close integration).

**Status: the technical spike (`tasks.md` §1) is complete.** Every field/shape decision below is built on
confirmed Bybit Demo evidence (Decision 0), not the working hypothesis the first draft of this proposal
carried. Where the spike did not settle a question — multi-fill parent semantics — that is stated
explicitly as unproven and out of this change's scope (see "What remains explicitly unproven" below), not
silently assumed either way.

### Code state relevant to this design (verified by reading the code, not assumed)

- `EntryPackageExecutionRecord.order_link_id` (`src/correlation/entryPackageExecutionRecord.ts:88`) is
  this cycle's own entry order's deterministic identity
  (`abi-ep-{sha256(strategyInstanceId, tradeCycleId, "entry", generation)}`,
  `src/domain/entryPackageOrderIdentity.ts:8-20`) — the only anchor this change needs; it introduces no
  new identity scheme.
- `mapEntryPackageToBybit()` (`src/exchange/bybitOrderMapper.ts:107-131`) sends `tpslMode: "Full"`,
  `stopLoss`, `slTriggerBy`, `slOrderType`, `takeProfit`, `tpTriggerBy`, `tpOrderType` directly on
  `/v5/order/create` for the entry order. `BybitCreateOrderPayload.tpslMode`
  (`src/exchange/bybitOrderMapper.ts:21`) is currently typed as the literal `"Full"` only.
- `decodeOrderQueryResponse()` (`src/services/entryPackage/orderQueryResponseDecoder.ts:47-141`) is
  **hard-scoped to exactly one order**: it takes an `ExpectedOrderIdentity` (`category`, `symbol`,
  `orderLinkId`), rejects any response whose single row's `symbol`/`orderLinkId` do not match
  (`order_link_id_mismatch`), and rejects (`multiple_rows_returned`) any response containing more than
  one row. It cannot be reused as-is for this change: a protection child never carries a usable own
  `orderLinkId` (Decision 0 — it is observed empty), so it can never be looked up by identity the way
  `decodeOrderQueryResponse`'s callers look up their own order, and a symbol-scoped query is expected to
  return zero, one, or several rows (siblings, the entry order itself, unrelated orders for the same
  symbol under a different generation).
- `BybitOrderView` (`orderQueryResponseDecoder.ts:3-11`) — the decoded shape `decodeOrderQueryResponse`
  produces — does not expose `orderId`, `parentOrderLinkId`, `stopOrderType`, `createType`, or
  `leavesQty` on the decoded item at all. A new decoded shape is needed that does expose these, because
  this change's whole job is reading them.
- `getActiveOrders(input?: GetActiveOrdersInput)` (`src/exchange/bybitAdapter.ts:148-158`) already queries
  `/v5/order/realtime` scoped by `symbol` alone (`openOnly: "0"`, no `orderLinkId`) — confirmed by the
  spike (Decision 0) to be the right shape for finding **live** children, reusable without modification.
  Its only current caller is `accountRoutes.ts:96`, a diagnostic route, not business logic.
- No existing adapter method queries `/v5/order/history` without a required `orderLinkId`
  (`BybitGetOrderHistoryPayload`, `bybitOrderMapper.ts:61-66`; `getOrderHistory`,
  `bybitAdapter.ts:213-223`). A **terminal** child (already filled, or already cancelled/deactivated) is
  not discoverable by any existing primitive. The spike confirmed a symbol-scoped history query does
  surface terminal children (Decision 0) — this change adds the missing adapter primitive for it.
- `isTerminalOrderStatus()`/`FILLED_STATUSES`/`TERMINAL_WITHOUT_FILL_STATUSES`
  (`packageConfirmation.ts:31-34,230-232`) already classify `"Deactivated"` as terminal-without-fill,
  alongside `"Rejected"`/`"Cancelled"`. The spike observed `"Deactivated"` as a real terminal status on a
  protection child (Decision 0) — this is an existing classification, not a new one this change needs to
  invent.
- `isFillFactFinal()`/`early_execution_observation` (`packageConfirmation.ts`, `abi-virtual-exposure-
  state-foundation-v1`) already give ABI a trustworthy, own-order-sourced answer to "has this cycle's
  entry order finished filling" — reused here as a caller-side input, not re-derived.

### What remains explicitly unproven (out of this change's scope)

The spike (`tasks.md` §1) proved attribution and single-pair classification (Decision 0). It did **not**
prove, and this change does **not** claim, any of the following — each is left as `NOT PROVEN`: unproven
exchange behavior that `abi-native-partial-protection-lifecycle-v1` must not assume in either direction,
not resolved here:

- That a parent entry order which fills across multiple executions (multi-fill) always ends up with
  exactly one attributable stop/take pair.
- That existing children auto-resize (qty adjusts) when the parent receives an additional fill.
- That Bybit ever creates additional pairs beyond the first for the same parent.
- That Bybit's materialization of the stop/take pair on fill is atomic (all-or-nothing, no observable
  intermediate state).
- That not observing a partial/intermediate state during the spike's own limited sampling is evidence
  that no such state exists — an observation gap is not proof of atomicity, and this change does not
  treat it as one.

This change's own classifier does not need any of these proven to be safe: if a real multi-fill parent
ever produces more than the expected one-stop-one-take shape, Decision 3's classification fails closed
(`duplicate_role` or `extra_candidates`) rather than silently accepting an unproven shape.

**Note on what this means for `abi-native-partial-protection-lifecycle-v1` (not decided here, recorded
for that change's own design phase):** demonstrating multi-fill behavior against Bybit Demo has already
proven difficult across two dedicated smoke attempts for this program — a further attempt is not a
reasonable precondition to hold that change's design hostage to. The more robust requirement for that
change is not "prove multi-fill materialization semantics first," but: do not assume auto-resize, and do
not assume additional-pair semantics; instead source an authoritative own `cumulative_filled_qty`
(`abi-virtual-exposure-state-foundation-v1`), read the actually-observed attributable protection state
through this change's own primitive, and reconcile — drive protection coverage to match own cumulative
exposure as observed, rather than as assumed from an un-provable exchange guarantee. This change's own
classifier already behaves correctly either way (fails closed on any shape beyond one pair), so nothing
here needs revisiting regardless of which model `abi-native-partial-protection-lifecycle-v1` ultimately
adopts.

## Goals / Non-Goals

**Goals:**
- Given a trade cycle's own entry `orderLinkId`, `category`, and `symbol`, return a truthful, fail-closed
  classification of whatever Bybit-native protection children currently exist for that entry order —
  never more, never less than the evidence supports.
- Attribute children to their parent exclusively through Bybit's own confirmed `parentOrderLinkId` field
  — never through side-match, price-match, timing, or a child's own `orderLinkId` (confirmed empty and
  not usable as identity).
- Cover both live and terminal children, merged and deduplicated by `orderId` — a child that has already
  filled or already been cancelled/deactivated is as much this cycle's own evidence as one still pending.
- Leave `PUT .../entry-package`'s wire payload, `PUT .../protection`'s production behavior, and every
  durable record shape byte-for-byte unchanged.

**Non-Goals** (deferred to specific later changes):
- Creating, cancelling, or replacing any order — `abi-native-partial-protection-lifecycle-v1`.
- Deciding how to replace one desired stop/take pair with another without a coverage gap or double
  coverage — `abi-native-partial-protection-lifecycle-v1`.
- Multi-fill semantics of any kind — see "What remains explicitly unproven" above: unproven exchange
  behavior `abi-native-partial-protection-lifecycle-v1` must not assume, not this change's problem to
  solve.
- Switching `mapEntryPackageToBybit()`'s production `tpslMode` — `abi-native-partial-protection-
  cutover-v1`.
- Removing the `abi-same-side-virtual-exposure-ownership-v1` admission guard or the
  `shared_scope_protection_unsupported` protection guard — `abi-native-partial-protection-cutover-v1`.
- Any new durable field on `EntryPackageExecutionRecord`.
- Any OCO enforcement logic on ABI's side — this change reports what exists; it never assumes or relies
  on Bybit having already cleaned up a sibling.
- Sizing/qty-coverage decisions beyond what is needed to classify presence/role/uniqueness of children.

## Decisions

### 0. Confirmed exchange facts (Bybit Demo spike, `tasks.md` §1 — complete)

Replaces the first draft's "working hypothesis." Every fact below was directly observed against Bybit
Demo, not inferred from documentation:

1. An attached `tpslMode: "Partial"` protection child carries `parentOrderLinkId`, equal to the parent
   entry order's own `orderLinkId`. This is the sole attribution key — never side/price/timing.
2. A child's own `orderLinkId` is observed as an empty string. It is **not** an attribution identity and
   is never used as one; `orderId` is the only identity a child reliably carries.
3. `stopOrderType = "PartialTakeProfit"` marks the take-profit leg; `stopOrderType = "PartialStopLoss"`
   marks the stop-loss leg. These two literal values are the sole role discriminator.
4. `createType = "CreateByPartialTakeProfit"` / `"CreateByPartialStopLoss"` are present and consistent
   with the corresponding `stopOrderType` — secondary corroborating evidence, not an independent
   discriminator (Decision 3).
5. Active (live) children are visible through the existing symbol-scoped realtime/open-order query shape
   (`getActiveOrders`, unmodified).
6. Terminal children (filled or cancelled/deactivated) are recoverable through a symbol-scoped order
   **history** query — not visible in the realtime query once terminal.
7. The same child, when it appears in both the realtime and history query results (observed during the
   transition window), must be deduplicated by `orderId` when the two sources are merged — it is one
   child, not two candidates.
8. Order history has a **propagation lag**: querying history immediately after a child transitions to
   terminal can return an empty/incomplete result for a short window. An immediate empty history result
   is therefore **not** universal proof that no terminal child exists — see Decision 3's explicit
   treatment of this.
9. `"Deactivated"` is an observed real terminal status for a protection child — already classified as
   terminal-without-fill by this codebase's existing `TERMINAL_WITHOUT_FILL_STATUSES`
   (`packageConfirmation.ts:34`); no new terminality classification is invented by this change.
10. A terminal child's record retains its original `qty` (not zeroed or rewritten), with `leavesQty = 0`
    signaling no remaining unexecuted quantity — `leavesQty`, not `qty`, is the field that changes to
    reflect a terminal/consumed state.

### 1. Primitive shape and placement

```ts
export type AttachedProtectionLeg = {
  role: "stop" | "take";
  orderId: string;        // the only reliable per-child identity; used for dedup (Decision 3)
  orderStatus: string;    // reuse isTerminalOrderStatus/FILLED_STATUSES/TERMINAL_WITHOUT_FILL_STATUSES
                           // (packageConfirmation.ts) if a caller needs terminal/live classification —
                           // not re-derived here
  triggerPrice: string;
  qty: string;             // original leg quantity; persists on a terminal record (fact 10)
  leavesQty: string;        // 0 on a terminal record; the field that actually reflects consumption
};

export type AttachedProtectionResolution =
  | { kind: "none" }
  | { kind: "attributed"; stop: AttachedProtectionLeg; take: AttachedProtectionLeg }
  | {
      kind: "ambiguous";
      reason: "extra_candidates" | "duplicate_role" | "unclassified_role" | "partial_pair" | "inconsistent_duplicate";
    };

export async function resolveOwnAttachedProtection(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
}): Promise<AttachedProtectionResolution>;
```

`cumExecQty` is deliberately **not** carried on `AttachedProtectionLeg` — the spike found `qty`/
`leavesQty` (fact 10) are the fields that actually distinguish a terminal child's consumed state; nothing
observed needs a separate cumulative-executed figure for attribution/classification. A future consumer
that does need it can extend the type when it has a proven need, per this codebase's established
"no field ahead of a demonstrated consumer" discipline (`abi-virtual-exposure-state-foundation-v1`).

New file, `src/services/protection/nativeProtectionAttribution.ts` — colocated with
`protectionApplicationService.ts` (protection-domain code), not `packageConfirmation.ts` (entry/close
confirmation code): this is a genuinely different concern (attribution of children Bybit created, not
confirmation of an order ABI itself created), even though it reuses the same query/decode discipline.
Pure and query-driven, no caching, no durable read/write — mirrors `classifyEntryOrderTerminality`'s
"single fresh classification, caller owns retry cadence" shape (`packageConfirmation.ts:263-316`), not
`confirmEntryPackage`'s internal bounded-retry loop: this primitive has no "write to confirm" step to
retry against, so retry policy — including how a caller handles the history-lag caveat (fact 8, Decision
3) — belongs entirely to whatever calls it (a future `abi-native-partial-protection-lifecycle-v1`
operation), not baked in here.

**Rejected: folding this into `packageConfirmation.ts`.** That file's existing primitives are all scoped
to *one order ABI itself created*, known by its own deterministic `orderLinkId`. This primitive's whole
job is the opposite: find orders ABI did *not* create and that never carry a usable own `orderLinkId` at
all (fact 2). Colocating would blur that distinction for every future reader of that already-large file.

### 2. A new list-shaped decoder, not a reuse of `decodeOrderQueryResponse`

New function in `src/services/entryPackage/orderQueryResponseDecoder.ts` (same file — the existing
private helpers `readOptionalStringField`/`isPositiveOrEmptyExactDecimal`/
`isNonNegativeOrEmptyExactDecimal` are directly reusable, no need to export or duplicate them):

```ts
export type BybitChildOrderCandidate = {
  orderLinkId: string;         // observed empty for a native child (fact 2) — decoded for completeness/
                                // audit only, never read as an identity by resolveOwnAttachedProtection
  orderId: string;
  parentOrderLinkId: string;   // "" when absent — not every order has a parent
  stopOrderType: string;       // "" when absent — the sole role discriminator (fact 3)
  createType: string;          // "" when absent — secondary consistency evidence only (fact 4)
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  leavesQty: string;
};

export function decodeChildOrderListResponse(input: {
  response: unknown;
  expected: { category: string; symbol: string };
}): { kind: "ok"; items: BybitChildOrderCandidate[] } | { kind: "protocol_failure"; reason: ... };
```

Unlike `decodeOrderQueryResponse`, this **accepts** zero or many rows (that is the whole point of a
symbol-scoped query) and does not reject on `orderLinkId` mismatch (there is no single expected
`orderLinkId` for a symbol-wide scan — every row is a candidate, filtered by `parentOrderLinkId` one
layer up in `resolveOwnAttachedProtection`). An empty `orderLinkId` on a row is a legitimate, expected
value (fact 2), never rejected as invalid — the same "empty is a legitimate value" discipline
`decodeOrderQueryResponse` already applies to `stopLoss`/`takeProfit`. It still validates `category`/
`symbol` match per row and rejects a structurally malformed envelope or item the same fail-closed way the
existing decoder does — the difference is cardinality, not strictness.

### 3. Classification rules

`resolveOwnAttachedProtection()` queries **both** `getActiveOrders({ symbol })` (live children, existing
primitive, fact 5) **and** the new symbol-scoped history primitive (Decision 4, fact 6), decodes both
responses with `decodeChildOrderListResponse`, concatenates the candidate lists, filters to
`parentOrderLinkId === entryOrderLinkId`, then **deduplicates by `orderId`** (fact 7) before role
classification — a candidate appearing in both the realtime and history result is one child, not two.

**Deduplication contradiction check.** If the same `orderId` appears in both sources with **inconsistent**
evidence (different `stopOrderType`, different `qty`, or an orderStatus combination that cannot represent
one order's real state — e.g. one source reporting it live, the other reporting a status incompatible
with that) → `{ kind: "ambiguous", reason: "inconsistent_duplicate" }`. This is deliberately distinct
from `duplicate_role` (two genuinely different orders sharing a role): a same-`orderId` disagreement means
the evidence itself is contradictory, not that there are too many candidates.

After dedup, classify the remaining candidates:

- **Zero matching candidates** → `{ kind: "none" }`. This is reported plainly, not as proof of absence —
  fact 8's history propagation lag means a just-terminalized child can be briefly invisible to the
  history query, and whether a `"none"` result should be trusted at all depends on facts this primitive
  is not given (how recently was the parent's fill observed, was this entry mapped `"Partial"` at all —
  see Decision 5). A caller for whom the lag matters is expected to re-query after a bounded delay rather
  than treat a single `"none"` as definitive — this primitive does not retry internally (Decision 1), so
  that discipline lives entirely at the call site.
- **Exactly one `stopOrderType`-classified-as-stop candidate and exactly one classified-as-take
  candidate, with no inconsistent-duplicate evidence** → `{ kind: "attributed", stop, take }`, regardless
  of either leg's own `orderStatus` — a filled or cancelled/deactivated leg is still a legitimate,
  attributed answer; interpreting *what that means* for ongoing coverage is `abi-native-partial-
  protection-lifecycle-v1`'s job, not this primitive's.
- **Exactly one role present, the other absent** → `{ kind: "ambiguous", reason: "partial_pair" }`.
  `mapEntryPackageToBybit()`'s own existing payload (Context) always submits both `stopLoss` and
  `takeProfit` together in one write — under the same all-or-nothing precedent, Bybit creating one leg
  without the other is not an expected transitional state; fail closed rather than guess whether the
  missing leg was never created, already fully consumed, or simply not yet visible due to history lag
  (fact 8) — the caller, not this primitive, decides whether to re-query.
- **More than one distinct-`orderId` candidate for the same role** → `{ kind: "ambiguous", reason:
  "duplicate_role" }`. (Fact-checked against "What remains explicitly unproven": if a real multi-fill
  parent legitimately produces a second pair, this is exactly the outcome that surfaces — fail closed,
  not silently accepted as a new legitimate shape.)
- **A candidate whose `stopOrderType` does not map to either known role value** → `{ kind: "ambiguous",
  reason: "unclassified_role" }` — never silently dropped from consideration, since silently dropping it
  could turn a real duplicate/three-candidate situation into a false "clean pair". `createType` (fact 4)
  is read and compared only as corroboration when `stopOrderType` already classified the role — it never
  substitutes for a missing or unrecognized `stopOrderType`.
- **Any remaining shape combining into more than the two expected roles after dedup** → `{ kind:
  "ambiguous", reason: "extra_candidates" }`.

No outcome here is ever resolved by "pick the most recent" or "pick the first found" — every ambiguous
shape fails closed, mirroring `classifyScopeAdmission`'s (`abi-same-side-virtual-exposure-ownership-v1`)
"corrupt" outcome and this codebase's general fail-closed-on-contradiction discipline.

### 4. New adapter primitive: symbol-scoped order history

```ts
export type BybitGetOrderHistoryForSymbolPayload = {
  category: string;
  symbol: string;
  limit: string;
};

// BybitAdapter interface addition
getOrderHistoryForSymbol(payload: BybitGetOrderHistoryForSymbolPayload): Promise<unknown>;
```

`RestBybitAdapter` implementation: `signedGet("/v5/order/history", new URLSearchParams({ category,
symbol, limit }))` — no `orderLinkId`, mirroring `getActiveOrders`'s existing symbol-scoped shape
(`bybitAdapter.ts:148-158`) applied to the history endpoint instead of realtime; confirmed reachable by
the spike (fact 6, subject to fact 8's propagation lag). `StubBybitAdapter` gets the matching `stub(...)`
implementation, same pattern as every other method there. This is the only new adapter-level method this
change adds; every other primitive it needs (`getActiveOrders`) already exists unmodified.

**Rejected: widening `BybitGetOrderHistoryPayload`'s `orderLinkId` to optional and reusing
`getOrderHistory`.** That method's existing callers (`packageConfirmation.ts`,
`entryCycleRecoveryResolutionService.ts`) all rely on it being scoped to exactly one order — widening the
shared payload type risks a future caller accidentally omitting `orderLinkId` and silently querying far
more broadly than intended. A distinct method with a distinct, narrower payload type makes the two use
cases (one-order lookup vs. symbol-wide scan) impossible to confuse at the type level.

### 5. Why the primitive takes no "was this Partial" or "is fill final" input

`resolveOwnAttachedProtection()` deliberately does not accept or compute `isFillFactFinal` or "was this
entry mapped Partial" — it answers only "what did I find," from query evidence alone. A separate, small,
pure function is left as this change's own explicit non-goal-but-anticipated seam for
`abi-native-partial-protection-lifecycle-v1`/`-cutover-v1` to combine `AttachedProtectionResolution` with
those caller-known facts (including how to weigh a `"none"`/`"partial_pair"` result against fact 8's
propagation lag) into "is this the expected state, and is it safe to act on yet." Keeping the primitive
itself context-free mirrors `classifyScopeAdmission`'s own shape (pure classification, wrapped by a
separate caller-side policy decision) and keeps this change testable without needing to fabricate
`EntryPackageExecutionRecord` state or a retry/backoff policy alongside every Bybit response fixture.

### 6. Mapper preparation: `tpslMode: "Partial"`, unwired

`BybitCreateOrderPayload.tpslMode` (`bybitOrderMapper.ts:21`) widens from the literal `"Full"` to
`"Full" | "Partial"`. A new, separate payload-construction path (not a modification of
`mapEntryPackageToBybit()`'s existing return value) is written and unit-tested against fixtures, proving
the payload shape is correct, but `mapEntryPackageToBybit()` itself keeps returning `tpslMode: "Full"` —
production `createOrder()` never calls the new path. The two paths are kept syntactically obvious as
separate functions (not a runtime flag inside one function) so a reviewer can see, without running
anything, that production output cannot have changed.

## Risks / Trade-offs

- [Deduplication by `orderId` (Decision 3) assumes `orderId` is always present and stable across the
  realtime/history transition] → Accepted based on spike evidence (fact 7 was observed specifically by
  watching a child transition from realtime-visible to history-visible and confirming the same `orderId`
  on both sides); if a future real-world case ever shows a child's `orderId` changing identity across
  that transition, dedup would under-merge into a false `duplicate_role`/`extra_candidates` — a fail-closed
  outcome, not a silent wrong answer, consistent with this change's overall discipline.
- [History propagation lag (fact 8) means `"none"` and `"partial_pair"` are not reliable proof of absence
  immediately after a fill] → Accepted and pushed to the caller by design (Decision 5): this primitive
  reports evidence, not a time-aware verdict, and baking a "wait N seconds and retry" policy into a
  read-only attribution primitive would hide a timing assumption that
  `abi-native-partial-protection-lifecycle-v1` needs to own and tune deliberately, not inherit silently.
- [Multi-fill semantics are unproven — see "What remains explicitly unproven"] → Accepted: this change's
  classifier is safe under that gap (fails closed on any shape beyond one stop + one take), so the
  unproven-ness is a scoping boundary for the next change, not a latent correctness risk in this one.
- [A new adapter primitive (`getOrderHistoryForSymbol`) is dead code in production until
  `abi-native-partial-protection-lifecycle-v1`/`-cutover-v1` consume it] → Accepted, same reasoning
  already applied to `findActiveRecordsForScope` in `abi-virtual-exposure-state-foundation-v1`: it proves
  a capability the program's own sequencing calls for, ahead of any production consumer.
- [Querying both realtime and history on every call is two Bybit requests instead of one] → Accepted:
  this primitive is not yet called from any production path (nothing in this change wires it into
  `PUT .../protection`), and its eventual production caller (`abi-native-partial-protection-cutover-v1`)
  already accepts a bounded-retry, multi-query cost profile for protection (mirrors `confirmEntryPackage`'s
  own realtime+history fallback pattern).

## Migration Plan

Purely additive: no field on `EntryPackageExecutionRecord` changes shape or is added; no existing route,
DTO, or on-disk record shape is touched; `mapEntryPackageToBybit()`'s return value for the existing,
still-only-called path is unchanged. The only new runtime behavior is (a) one new adapter method nothing
production calls yet, (b) one new pure decoder function, (c) one new pure classification primitive, (d)
one new, unwired mapper payload path. Rollback is a plain revert; no data becomes unreadable in either
direction.
