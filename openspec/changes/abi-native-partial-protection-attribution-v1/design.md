## Context

See `proposal.md` for Why/What. This document resolves exactly one thing: how ABI reads and classifies
its own entry order's Bybit-native attached protection children, without creating, cancelling, or
modifying anything, and without adding durable state. It intentionally stops short of everything
`docs/virtual-exposure-ownership-delivery-plan.md` assigns to
`abi-native-partial-protection-lifecycle-v1` (replacement/update lifecycle) and
`abi-native-partial-protection-cutover-v1` (mapping switch, guard removal, close integration).

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
  one row. It cannot be reused as-is for this change: a protection child's own `orderLinkId` is assigned
  by Bybit, not by ABI, so it can never be known in advance to pass as the expected identity, and a
  symbol-scoped query is expected to return zero, one, or several rows (siblings, the entry order itself,
  unrelated orders for the same symbol under a different generation).
- `BybitOrderView` (`orderQueryResponseDecoder.ts:3-11`) — the decoded shape `decodeOrderQueryResponse`
  produces — does not expose `orderLinkId`, `orderId`, or any parent-attribution field on the decoded
  item at all (it is only compared against the expected identity, then discarded). A new decoded shape
  is needed that *does* expose these, because this change's whole job is reading them.
- `getActiveOrders(input?: GetActiveOrdersInput)` (`src/exchange/bybitAdapter.ts:148-158`) already queries
  `/v5/order/realtime` scoped by `symbol` alone (`openOnly: "0"`, no `orderLinkId`) — the right shape for
  finding **live** children, reusable without modification. Its only current caller is
  `accountRoutes.ts:96`, a diagnostic route, not business logic.
- No existing adapter method queries `/v5/order/history` without a required `orderLinkId`
  (`BybitGetOrderHistoryPayload`, `bybitOrderMapper.ts:61-66`; `getOrderHistory`,
  `bybitAdapter.ts:213-223`). A **terminal** child (already filled — e.g. take-profit triggered — or
  already cancelled) is not discoverable by any existing primitive. This is a genuine gap, not an
  oversight to defer: correct classification (Decision 3) needs to see terminal children, not only live
  ones, so this change adds the missing symbol-scoped history primitive.
- `isFillFactFinal()`/`early_execution_observation` (`packageConfirmation.ts`, `abi-virtual-exposure-
  state-foundation-v1`) already give ABI a trustworthy, own-order-sourced answer to "has this cycle's
  entry order finished filling" — reused here as a caller-side input, not re-derived.

### What is NOT yet confirmed against a real Bybit response (spike-gated, see Decision 0)

- That a `tpslMode: "Partial"` child order's own order-query response carries a field naming its parent
  order (working hypothesis, per the direction given for this change: `parentOrderLinkId`).
- That a field on the same response reliably distinguishes a stop-loss child from a take-profit child
  (working hypothesis: `stopOrderType`, with distinct values for each role — Bybit V5's documented
  `stopOrderType` enum is the closest known candidate, not independently re-verified for this project).
- That `/v5/order/history` accepts a query scoped by `category`+`symbol` alone (no `orderLinkId`) the
  same way `/v5/order/realtime` already does for `getActiveOrders`.
- Whether Bybit itself atomically cancels a sibling leg when the other fills (an OCO guarantee) — not
  needed by this change's own classification (which reports what it finds, not what "should" remain),
  but directly informs `abi-native-partial-protection-lifecycle-v1`'s design; noted here so the spike
  answers it once for both changes.

## Goals / Non-Goals

**Goals:**
- Given a trade cycle's own entry `orderLinkId`, `category`, and `symbol`, return a truthful, fail-closed
  classification of whatever Bybit-native protection children currently exist for that entry order —
  never more, never less than the evidence supports.
- Attribute children to their parent exclusively through Bybit's own parent-attribution field — never
  through side-match, price-match, or timing heuristics (the exact failure mode `open-position-
  resolution`'s pre-existing aggregate-side-match plausibility check already documents as insufficient
  proof of attribution).
- Cover both live and terminal children — a child that has already filled or already been cancelled is
  as much this cycle's own evidence as one still pending.
- Leave `PUT .../entry-package`'s wire payload, `PUT .../protection`'s production behavior, and every
  durable record shape byte-for-byte unchanged.
- Make the exact Bybit field dependency explicit and spike-gated (Decision 0), rather than silently
  assumed.

**Non-Goals** (deferred to specific later changes):
- Creating, cancelling, or replacing any order — `abi-native-partial-protection-lifecycle-v1`.
- Deciding how to replace one desired stop/take pair with another without a coverage gap or double
  coverage — `abi-native-partial-protection-lifecycle-v1`.
- Switching `mapEntryPackageToBybit()`'s production `tpslMode` — `abi-native-partial-protection-
  cutover-v1`.
- Removing the `abi-same-side-virtual-exposure-ownership-v1` admission guard or the
  `shared_scope_protection_unsupported` protection guard — `abi-native-partial-protection-cutover-v1`.
- Any new durable field on `EntryPackageExecutionRecord`.
- Any OCO enforcement logic on ABI's side — this change reports what exists; it never assumes or relies
  on Bybit having already cleaned up a sibling.
- Sizing/qty-coverage decisions beyond what is needed to classify presence/role/uniqueness of children.

## Decisions

### 0. The Bybit response shape this design depends on is a hypothesis, not a verified fact — spike gates every other task

**Working hypothesis** (stated precisely so tasks.md §1 has an exact target to confirm or refute):
a `tpslMode: "Partial"` child order's own row in `/v5/order/realtime` and `/v5/order/history` carries
(a) a field naming its parent order — assumed `parentOrderLinkId`, matched against the parent's own
`orderLinkId` (never `orderId` — this codebase's established "orderLinkId is the lookup key, orderId is
audit-only" convention, e.g. `execution/list`'s payload doc comment, applies here identically); (b) a
field reliably distinguishing a stop-loss leg from a take-profit leg — assumed `stopOrderType` with
distinct values per role.

**If the spike confirms this**: Decisions 1-6 below proceed as designed. **If the spike finds no reliable
parent-attribution field, or no reliable role-distinguishing field**: this entire change's premise (and,
transitively, `abi-native-partial-protection-lifecycle-v1`/`-cutover-v1`) is invalid, and
`docs/virtual-exposure-ownership-delivery-plan.md` needs a new architecture-review pass before any
implementation continues — not a fallback silently substituted here. `tasks.md` §1 is a blocking
prerequisite for every other task in this change for exactly this reason.

### 1. Primitive shape and placement

```ts
export type AttachedProtectionLeg = {
  role: "stop" | "take";
  orderId: string;        // audit-only, never a lookup key (existing codebase convention)
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  cumExecQty: string;
};

export type AttachedProtectionResolution =
  | { kind: "none" }
  | { kind: "attributed"; stop: AttachedProtectionLeg; take: AttachedProtectionLeg }
  | { kind: "ambiguous"; reason: "extra_candidates" | "duplicate_role" | "unclassified_role" | "partial_pair" };

export async function resolveOwnAttachedProtection(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
}): Promise<AttachedProtectionResolution>;
```

New file, `src/services/protection/nativeProtectionAttribution.ts` — colocated with
`protectionApplicationService.ts` (protection-domain code), not `packageConfirmation.ts` (entry/close
confirmation code): this is a genuinely different concern (attribution of children Bybit created, not
confirmation of an order ABI itself created), even though it reuses the same query/decode discipline.
Pure and query-driven, no caching, no durable read/write — mirrors `classifyEntryOrderTerminality`'s
"single fresh classification, caller owns retry cadence" shape (`packageConfirmation.ts:263-316`), not
`confirmEntryPackage`'s internal bounded-retry loop: this primitive has no "write to confirm" step to
retry against, so retry policy belongs entirely to whatever calls it (a future `abi-native-partial-
protection-lifecycle-v1` operation), not baked in here.

**Rejected: folding this into `packageConfirmation.ts`.** That file's existing primitives are all scoped
to *one order ABI itself created*, known by its own deterministic `orderLinkId`. This primitive's whole
job is the opposite: find orders ABI did *not* create and never has an `orderLinkId` for in advance.
Colocating would blur that distinction for every future reader of that already-large file.

### 2. A new list-shaped decoder, not a reuse of `decodeOrderQueryResponse`

New function in `src/services/entryPackage/orderQueryResponseDecoder.ts` (same file — the existing
private helpers `readOptionalStringField`/`isPositiveOrEmptyExactDecimal`/
`isNonNegativeOrEmptyExactDecimal` are directly reusable, no need to export or duplicate them):

```ts
export type BybitChildOrderCandidate = {
  orderLinkId: string;
  orderId: string;
  parentOrderLinkId: string;   // "" when the field is absent — not every order has a parent
  stopOrderType: string;       // "" when absent — used for role classification, Decision 3
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  cumExecQty: string;
};

export function decodeChildOrderListResponse(input: {
  response: unknown;
  expected: { category: string; symbol: string };
}): { kind: "ok"; items: BybitChildOrderCandidate[] } | { kind: "protocol_failure"; reason: ... };
```

Unlike `decodeOrderQueryResponse`, this **accepts** zero or many rows (that is the whole point of a
symbol-scoped query) and does not reject on `orderLinkId` mismatch (there is no single expected
`orderLinkId` — every row is a candidate, filtered by parent-attribution one layer up in
`resolveOwnAttachedProtection`). It still validates `category`/`symbol` match and rejects a structurally
malformed envelope or item the same fail-closed way the existing decoder does — the difference is
cardinality, not strictness.

### 3. Classification rules

`resolveOwnAttachedProtection()` queries **both** `getActiveOrders({ symbol })` (live children, existing
primitive) **and** the new symbol-scoped history primitive (Decision 4), decodes both responses with
`decodeChildOrderListResponse`, concatenates the candidate lists, and filters to
`parentOrderLinkId === entryOrderLinkId`. Then:

- **Zero matching candidates** → `{ kind: "none" }`. Whether this is expected or contradictory is not
  this primitive's decision — it depends on facts this primitive is not given (was this entry mapped
  `"Partial"`, is its fill final) that belong to the caller, not baked in here (see Decision 5's note on
  keeping this primitive context-free).
- **Exactly one `stopOrderType`-classified-as-stop candidate and exactly one classified-as-take
  candidate** → `{ kind: "attributed", stop, take }`, regardless of either leg's own `orderStatus` — a
  filled or cancelled leg is still a legitimate, attributed answer; interpreting *what that means* for
  ongoing coverage is `abi-native-partial-protection-lifecycle-v1`'s job, not this primitive's.
- **Exactly one role present, the other absent** → `{ kind: "ambiguous", reason: "partial_pair" }`.
  `mapEntryPackageToBybit()`'s own existing payload (Context) always submits both `stopLoss` and
  `takeProfit` together in one write — under the same all-or-nothing precedent, Bybit creating one leg
  without the other is not an expected transitional state; fail closed rather than guess whether the
  missing leg was never created, already fully consumed, or lost.
- **More than one candidate for the same role** → `{ kind: "ambiguous", reason: "duplicate_role" }`.
- **A candidate whose `stopOrderType` does not map to either role** → `{ kind: "ambiguous", reason:
  "unclassified_role" }` — never silently dropped from consideration, since silently dropping it could
  turn a real duplicate/three-candidate situation into a false "clean pair".
- **Any candidate other than the above shapes combining into more than the two expected roles** →
  `{ kind: "ambiguous", reason: "extra_candidates" }`.

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
(`bybitAdapter.ts:148-158`) applied to the history endpoint instead of realtime. `StubBybitAdapter` gets
the matching `stub(...)` implementation, same pattern as every other method there. This is the only new
adapter-level method this change adds; every other primitive it needs (`getActiveOrders`) already exists
unmodified.

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
those caller-known facts into "is this the expected state." Keeping the primitive itself context-free
mirrors `classifyScopeAdmission`'s own shape (pure classification, wrapped by a separate caller-side
policy decision) and keeps this change testable without needing to fabricate `EntryPackageExecutionRecord`
state alongside every Bybit response fixture.

### 6. Mapper preparation: `tpslMode: "Partial"`, unwired

`BybitCreateOrderPayload.tpslMode` (`bybitOrderMapper.ts:21`) widens from the literal `"Full"` to
`"Full" | "Partial"`. A new, separate payload-construction path (not a modification of
`mapEntryPackageToBybit()`'s existing return value) is written and unit-tested against fixtures, proving
the payload shape is correct, but `mapEntryPackageToBybit()` itself keeps returning `tpslMode: "Full"` —
production `createOrder()` never calls the new path. The two paths are kept syntactically obvious as
separate functions (not a runtime flag inside one function) so a reviewer can see, without running
anything, that production output cannot have changed.

## Risks / Trade-offs

- [The core hypothesis (Decision 0) might be wrong] → Accepted as the reason `tasks.md` §1 exists and
  blocks every other task; this design does not pretend the risk is smaller than it is by implementing
  around it first and validating later.
- [A new adapter primitive (`getOrderHistoryForSymbol`) is dead code in production until
  `abi-native-partial-protection-lifecycle-v1`/`-cutover-v1` consume it] → Accepted, same reasoning
  already applied to `findActiveRecordsForScope` in `abi-virtual-exposure-state-foundation-v1`: it proves
  a capability the program's own sequencing calls for, ahead of any production consumer.
- [Querying both realtime and history on every call is two Bybit requests instead of one] → Accepted:
  this primitive is not yet called from any production path (nothing in this change wires it into
  `PUT .../protection`), and its eventual production caller (`abi-native-partial-protection-cutover-v1`)
  already accepts a bounded-retry, multi-query cost profile for protection (mirrors `confirmEntryPackage`'s
  own realtime+history fallback pattern).
- [`{ kind: "ambiguous", reason: "partial_pair" }` might prove too strict once real Bybit behavior is
  observed — e.g. if Bybit's own OCO cancellation genuinely removes a filled leg's sibling from both
  realtime and history rather than leaving a terminal record behind] → Explicitly flagged as one of the
  spike's own open questions (Context, "What is NOT yet confirmed"); if the spike shows this, Decision 3
  is revisited before `abi-native-partial-protection-lifecycle-v1` is designed, not silently reinterpreted
  here.

## Migration Plan

Purely additive: no field on `EntryPackageExecutionRecord` changes shape or is added; no existing route,
DTO, or on-disk record shape is touched; `mapEntryPackageToBybit()`'s return value for the existing,
still-only-called path is unchanged. The only new runtime behavior is (a) one new adapter method nothing
production calls yet, (b) one new pure decoder function, (c) one new pure classification primitive, (d)
one new, unwired mapper payload path. Rollback is a plain revert; no data becomes unreadable in either
direction.
