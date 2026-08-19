## Context

See `proposal.md` for Why/What. This document resolves how ABI reconciles a trade cycle's desired
protection state against its actually observed native Partial protection children, using only in-place
amend — never create or cancel — including the `take_price = null` surrogate-TAKE case. It intentionally
stops short of `abi-native-partial-protection-cutover-v1`'s work: no entry-mapping switch, no guard
removal, no close integration.

### Foundation this change builds on (already proven, not re-derived here)

- `resolveOwnAttachedProtection()` (`src/services/protection/nativeProtectionAttribution.ts`,
  `abi-native-partial-protection-attribution-v1`, applied and archived) — pure, query-driven attribution.
  Returns `{ kind: "none" }`, `{ kind: "attributed", stop, take }` (each an `AttachedProtectionLeg`:
  `role`, `orderId`, `orderStatus`, `triggerPrice`, `qty`, `leavesQty`), or `{ kind: "ambiguous", reason:
  ... }` with six possible reasons including `query_failed`. This change's reconciler calls it fresh, on
  every reconciliation attempt — never caches its result.
- Amend confirmed safe and effective (`docs/spikes/bybit-demo-native-partial-stop-only.md` Experiment B,
  `abi-native-partial-protection-attribution-v1`'s own spike): `orderId`, `parentOrderLinkId`,
  `stopOrderType`, `createType`, `tpslMode` all survive `/v5/order/amend`; `triggerPrice` and `qty` are
  independently amendable, `qty` on one leg auto-syncs the sibling's `qty`.
  `docs/virtual-exposure-ownership-delivery-plan.md` ревизия v16 records the full fact list.
  `docs/spikes/bybit-demo-native-partial-stop-only.md` Experiment A additionally proved: cancelling the
  exact TAKE child by its `orderId` deactivates **both** legs (`Deactivated`, identical `updatedTime`),
  and Experiment B proved a TAKE child's `takeProfit: "0"` amend is an observed no-op — TAKE stays
  `Untriggered` with unchanged `qty`/`triggerPrice`. Neither is a valid mechanism for removing a leg.
- `confirmEntryPackage()` / `PackageConfirmationOutcome`
  (`src/services/entryPackage/packageConfirmation.ts`, `abi-virtual-exposure-state-foundation-v1`) —
  this cycle's own, own-order-sourced fill-fact query. Both its `partial_fill` and `full_fill` outcomes
  carry a full `EarlyExecutionObservation` (including `cumulative_filled_qty`) — either is authoritative
  for "how much of this cycle's own entry is currently filled" at the moment queried. This change's
  qty resolution (Decision 4) reads through this directly, never re-deriving or estimating, and
  deliberately does not require the fill to be `isFillFactFinal` — see Decision 4 for why waiting for
  finality would be wrong here.
- `desired_entry.planned_entry_price` (`src/domain/entryPackageApi.ts:4`,
  `abi-virtual-exposure-state-foundation-v1`) — this cycle's own commanded entry price, set once when
  `desired_entry` is first bound and never rewritten in place for the life of one generation: grep of
  `entryPackageApplicationService.ts` confirms `desired_entry` is only ever nulled via
  `persistAbsentNoHistory`/`persistTransitionToAbsent`, both reached only once no fill is durably
  provable for that generation — any real change to a live/filled generation's desired entry requires a
  CANCEL first, never an in-place amend. This makes `planned_entry_price` the stable, cycle-owned
  reference this change's surrogate TAKE (Decision 5) anchors to — unlike a cumulative average execution
  price, which can move with every additional partial fill.
- `ceilToStep(valueText, stepText)` (`src/domain/exactDecimal.ts:85`) — existing step-rounding primitive,
  used today for `qtyStep` rounding in `src/risk/positionSizeCalculator.ts`. No `floorToStep` counterpart
  exists yet.
- `InstrumentTradingRules` (`src/exchange/instrumentTradingRulesResponseDecoder.ts:3-7`) currently decodes
  only `minOrderQty`, `qtyStep`, `minNotionalValue` from `/v5/market/instruments-info`'s `lotSizeFilter` —
  no `priceFilter` field is decoded anywhere in this codebase today. `BybitInstrumentTradingRulesProvider`
  (`src/exchange/instrumentTradingRulesProvider.ts`) already fetches and caches the underlying response per
  `(category, symbol)`; adding `tickSize` to what it decodes (Decision 3) needs no new Bybit query. This
  change does **not** add `minPrice`/`maxPrice` here, or anywhere else — an earlier version of this design
  did, and used them to claim the surrogate TAKE was "exchange-valid by construction." That claim is
  retracted (Decision 5): a static instrument price filter is a different semantic object from a dynamic
  order-price band, and neither was ever shown to bound a native Partial TP `triggerPrice` specifically.
- `CurrentOrderPriceLimitsProvider` (`src/exchange/orderPriceLimits/{types,provider,decoder}.ts`,
  `abi-current-order-price-limits-v1`, applied and archived — archive commit
  `6ec349fcd02e0b908020a5eb74881cb79b6b949f`, canonical capability
  `openspec/specs/order-price-limits/spec.md`) — a fresh, read-only, per-call query of Bybit's current
  `/v5/market/price-limit`, returning `{ buyLimit, sellLimit, observedAtMs }` for one explicitly requested
  `(category, symbol)`, uncached (a new query every call, matching this change's own no-caching
  discipline for attribution). The canonical spec is explicit that the capability carries **no protection
  or trading policy**: "SHALL NOT map position side to either limit, calculate surrogate prices, clamp a
  desired price, interpret TP/SL or protection state." This change consumes it as an **injected, read-only
  exchange dependency** rather than building its own provider/decoder for dynamic price boundaries — see
  Decision 5 for exactly what is, and is not, assumed about what `buyLimit`/`sellLimit` mean for a native
  Partial TP `triggerPrice` amend (that mapping is `NOT PROVEN`).
- `ProtectionCommand` (`src/domain/positionManagementApi.ts:10-15`): `{ strategyInstanceId,
  tradeCycleId, stopPrice: string, takePrice: string | null }` — unchanged by this proposal.
- `ProtectionApplicationService`'s existing `evaluateReadBack()`/`isNumericallyEqualExactDecimal()`
  (`protectionApplicationService.ts:226-247`, `positionManagementApi.ts:231`) establish the existing
  already-satisfied comparison discipline this change's own already-satisfied check mirrors, applied to
  attributable children instead of the live aggregate position row.
- No `amend` method exists on `BybitAdapter` today (verified: `bybitAdapter.ts` has `cancelOrder`,
  `createOrder`, no amend). This change adds the first one.

## Goals / Non-Goals

**Goals:**
- Given a trade cycle's desired protection state, reconcile the actually attributable native Partial
  children to match it using only `amend` — never `create`, never `cancel`.
- Keep `take_price = null` → deterministic, far-away dormant surrogate TAKE as this program's accepted
  architectural decision — a full attributable `STOP + TAKE` pair always materialized, never a missing
  leg, never derived from fluctuating current market price. This proposal fixes that architecture; it does
  **not** fix the concrete surrogate price formula or its exchange-validity mechanism — see Decision 5 and
  the blocking evidence task (tasks.md task 0).
- Never act on stale evidence: re-read attributable state immediately before amending, and independently
  re-verify with a fresh read after.
- Treat any classifier outcome other than `none`/`attributed` (including anything a future multi-fill
  shape might produce) as fail-closed — never interpreted, never guessed at.
- Leave `PUT .../protection`'s production-decision path, `mapEntryPackageToBybit()`'s mapping, and every
  guard from `abi-same-side-virtual-exposure-ownership-v1` byte-for-byte unchanged.

**Non-Goals** (deferred to specific later work):
- Switching `mapEntryPackageToBybit()`'s production `tpslMode`, removing the admission guard, removing
  `shared_scope_protection_unsupported`, or integrating with close — all `abi-native-partial-protection-
  cutover-v1`.
- Proving OCO-after-amend — stays `NOT PROVEN`, a `abi-native-partial-protection-cutover-v1` precondition
  only if that change's own design ends up depending on it.
- Claiming the surrogate TAKE price is "exchange-valid by construction." Task 0's closed Demo evidence
  (Decision 5) did not establish Bybit's current order-price limits (`buyLimit`/`sellLimit`,
  `order-price-limits` capability) as the far-side boundary a clamping surrogate policy would need, so
  this change does not use them for that purpose, and no other proven bound exists for this V1 — the
  shipped formula makes no exchange-validity claim; validity is enforced only by Bybit's own amend-time
  acceptance or rejection (Decision 7's existing `amend_rejected` fail-closed path).
- Any real multi-fill materialization behavior (auto-resize, additional pairs) — Decision 8 explains why
  this change needs no special-case logic for it regardless of which shape Bybit actually produces.
- Partial close / `exposure_fraction < 1` — outside this program's current scope (see master plan's
  existing Future notes on Changes 2/7).

## Decisions

### 1. Reconciliation primitive: shape and placement

```ts
export type DesiredProtectionLeg = {
  triggerPrice: string;
  qty: string;
};

export type DesiredProtectionState = {
  stop: DesiredProtectionLeg;
  take: DesiredProtectionLeg; // always present — surrogate when the command's take_price is null
};

export type ReconciliationOutcome =
  | { kind: "already_satisfied" }
  | { kind: "reconciled" }
  | { kind: "fail_closed"; reason: ReconciliationFailureReason };

export type ReconciliationFailureReason =
  | "attribution_lost"          // resolveOwnAttachedProtection no longer returns attributed for this parent
  | "ambiguous_attribution"     // resolveOwnAttachedProtection returned ambiguous (any of its 6 reasons)
  | "amend_rejected"            // Bybit rejected an amend call
  | "amend_race"                // fresh evidence right before/after amend shows a leg transitioned to
                                 // terminal — including when its stale values happen to match desired
  | "read_back_mismatch"        // post-amend fresh read-back does not match desired state
  | "trading_rules_unavailable"; // caller-surfaced: InstrumentTradingRulesProvider.getRules() failed on
                                  // the null-take path (Decision 4/5/11) — never produced inside this
                                  // primitive itself, widened onto this union for one failure vocabulary

export async function reconcileNativePartialProtection(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
  desired: DesiredProtectionState;
}): Promise<ReconciliationOutcome>;
```

New file, `src/services/protection/nativeProtectionReconciliation.ts` — colocated with
`nativeProtectionAttribution.ts` (same protection-domain grouping), consuming it as a dependency rather
than folding reconciliation logic into it: attribution stays a pure read; reconciliation is a write
pipeline built on top of that read. `DesiredProtectionState` is computed by the caller (Decision 4) —
this primitive itself does not read `early_execution_observation` or compute the surrogate price; it only
compares an already-resolved desired state against attributable reality and amends toward it. It takes no
`tradingRules`/`side` input either — nothing inside the primitive ever needed them; the surrogate's
`tickSize` dependency (Decision 5) is resolved entirely by the caller before `desired` is constructed.
Keeping the boundary here (rather than folding desired-state computation into the reconciler) mirrors
`resolveOwnAttachedProtection()`'s own "context-free primitive, caller supplies policy inputs" shape
(`abi-native-partial-protection-attribution-v1` design.md Decision 5).

### 2. New adapter primitive: `amendOrder`

```ts
export type BybitAmendOrderPayload = {
  category: string;
  symbol: string;
  orderId: string;
  triggerPrice?: string;
  qty?: string;
};

// BybitAdapter interface addition
amendOrder(payload: BybitAmendOrderPayload): Promise<unknown>;
```

`RestBybitAdapter`: `signedPost("/v5/order/amend", payload)` — the same signed-POST discipline every
other write already uses. Scoped by `orderId`, never `orderLinkId` (a native child's own `orderLinkId` is
confirmed empty — `abi-native-partial-protection-attribution-v1` design.md Decision 0, fact 2 — `orderId`
is the only usable identity, matching this codebase's established "orderLinkId is the lookup key when ABI
owns it, orderId is the fallback identity for orders ABI does not own" pattern applied consistently since
Change 6). `StubBybitAdapter`/`FakeBybitAdapter` (test fake) get matching implementations, same pattern as
every other adapter method.

**Rejected: reusing `setTradingStop`'s payload shape or endpoint.** `/v5/position/trading-stop` is
position-scoped, not per-order — Experiment C in the stop-only spike proved it produces an unattributable
`parentOrderLinkId: ""` result. This change never calls it.

### 3. Price-tick support: `tickSize` on `InstrumentTradingRules`, and `floorToStep`

`InstrumentTradingRules` gains `tickSize: string`, decoded from the same `/v5/market/instruments-info`
response's `priceFilter.tickSize` field (`instrumentTradingRulesResponseDecoder.ts`) —
`BybitInstrumentTradingRulesProvider` needs no new query, only an additional decoded field from the
response it already fetches and caches. New failure reasons (`missing_price_filter`,
`invalid_tick_size`) mirror the existing `missing_lot_size_filter`/`invalid_qty_step` pattern for the
existing fields.

New `floorToStep(valueText: string, stepText: string): string` alongside the existing `ceilToStep`
(`src/domain/exactDecimal.ts:85`) — same shape, opposite rounding direction. Needed so that whatever
surrogate TAKE price Decision 5 eventually fixes can be tick-normalized in either direction: up (ceil)
for a LONG surrogate above entry, down (floor) for a SHORT surrogate below entry — a single rounding
direction cannot serve both without sometimes rounding a surrogate closer to entry than intended.

`tickSize` is a static instrument-rule fact used only to normalize whatever `triggerPrice` this change
ends up amending to — it says nothing about what that `triggerPrice` is allowed to be. Decision 5 records
why no such allowed-range fact is used by this change at all (task 0's closed evidence ruled out the one
candidate source this design considered).

### 4. Desired protection state resolution

Given a `ProtectionCommand` (`stopPrice`, `takePrice: string | null`) and this cycle's own correlation
record, `qty` is resolved by a dedicated step that deliberately does **not** wait for
`isFillFactFinal()`:

```
function resolveCurrentOwnFilledQty(record, confirmEntryPackage): Result<string, "no_authoritative_qty"> {
  if (record.early_execution_observation !== null && isFillFactFinal(record.early_execution_observation)) {
    return ok(record.early_execution_observation.cumulative_filled_qty);
  }
  const outcome = confirmEntryPackage(record's own entry orderLinkId);
  switch (outcome.kind) {
    case "partial_fill":
    case "full_fill":
      return ok(outcome.observation.cumulative_filled_qty);
    case "pending_confirmed":
    case "terminal_without_fill":
    case "not_found":
    case "ambiguous":
      return err("no_authoritative_qty");
  }
}

qty = resolveCurrentOwnFilledQty(record, confirmEntryPackage)   // fail closed on err — see below
stop.triggerPrice = command.stopPrice
stop.qty = qty
take.triggerPrice = command.takePrice !== null
                       ? command.takePrice
                       : computeSurrogateTakePrice(...)            // Decision 5
take.qty = qty
```

**Why not gate on `isFillFactFinal`.** This change's own live semantics (the master plan, and Change 1's
own design) already establish that a trade cycle enters "open trade" state on its **first** partial fill —
the entry order's own remainder stays live and un-cancelled, exactly as designed, while the cycle is
already own-exposed for whatever has filled so far. A `PUT .../protection` call arriving while that entry
remainder is still live must be able to protect the cycle's **current** own exposure, not block until the
entry order eventually reaches a terminal fill state that may be seconds or minutes away — an
`isFillFactFinal` precondition here would make protection unusable for exactly the window it matters most
(a partially-filled, still-exposed, still-unprotected position). The prior version of this design borrowed
`isFillFactFinal` as a precondition by analogy with `OpenPositionResolutionService.resolveOwnFillFacts()`;
that analogy does not hold — `resolveOwnFillFacts()` answers "does an open position currently exist,"
where premature exposure to a still-moving qty is undesirable, while this reconciler answers "protect
whatever is currently, authoritatively, this cycle's own filled exposure," where premature use of a
still-moving qty is exactly correct — the qty is expected to change again on a later fill, and the next
reconciliation call is expected to pick that up (see Decision 8, unaffected by this change).

**Resolution rule:**
- If the record's own `early_execution_observation` is already present and `isFillFactFinal(...)` is
  true, reuse its `cumulative_filled_qty` directly — no exchange call needed (this is the terminal,
  no-remainder-left case, and reuse here is a pure optimization, not a correctness requirement).
- Otherwise, issue a fresh `confirmEntryPackage()` call for this cycle's own entry order. Both
  `partial_fill` and `full_fill` outcomes carry a full `EarlyExecutionObservation`, and **either is
  equally authoritative** for "this cycle's current cumulative own fill, as of this reconciliation
  attempt" — `partial_fill` is not treated as a lesser or provisional answer than `full_fill`; it is
  simply a different, still-valid point on the same monotonically-non-decreasing `cumulative_filled_qty`
  series.
- `pending_confirmed` (no fill evidence obtained yet), `terminal_without_fill` (order ended with zero
  fill), `not_found`, and `ambiguous` all resolve to `no_authoritative_qty` — a **fail-closed** outcome,
  not a fallback to `"0"`. Reconciling protection toward a zero qty would be a contradiction (there is
  nothing to protect, and a zero-qty amend is not this reconciler's job to interpret); the caller
  (Decision 11) surfaces this as a distinct reconciliation failure before any attribution or amend call is
  attempted. This is a deliberate divergence from `OpenPositionResolutionService.resolveOwnFillFacts()`,
  which treats its own `terminal_without_fill` case as a valid `cumulativeFilledQty: "0"` answer — that
  function is answering "does a position exist" (zero is a valid, informative answer to that question);
  this resolution is answering "what quantity should protection now cover" (zero is not an actionable
  answer to that question, and folding it in silently would risk a reconciler amending toward a
  nonsensical zero-qty desired state instead of failing visibly).
- Every reconciliation attempt re-resolves `qty` fresh by this same rule — there is no caching of a
  resolved qty across attempts. A later attempt seeing a larger `cumulative_filled_qty` (because the
  entry order received an additional fill in the meantime) is not a special case; it is the same rule
  producing a different, equally authoritative answer, exactly as Decision 8 already establishes for
  multi-fill in general.

Both legs always carry the same `qty` — this is not a coincidence of the desired-state construction, it is
the same pair-wide invariant `effective stop coverage == effective take coverage == own cumulative fill`
the master plan states, applied identically whether the take leg is the caller's real desired price or a
computed surrogate.

### 5. Surrogate TAKE price: task 0 evidence closed — order-price-limits not established as the needed boundary, formula fixed without a clamp

**Task 0 evidence (closed 2026-08-19, Bybit Demo, linear `ETHUSDT`).** Following tasks.md task 0.1's exact
procedure: a fresh `CurrentOrderPriceLimitsProvider.getCurrent({ category: "linear", symbol: "ETHUSDT" })`
snapshot was obtained (`buyLimit: "2127.50"`, `sellLimit: "2044.06"`); a Market-entry conditional order with
`tpslMode: "Partial"` filled, materializing an attributable native Partial `STOP + TAKE` pair
(`orderLinkId: "abi-task0-mt0fc2f8"`); the exact TAKE child's `orderId`
(`dccebe66-ec90-4281-a8bf-a2533afc371d`) was amended twice via `POST /v5/order/amend`, each followed by an
independent fresh read-back (not reusing pre-amend evidence, per Decision 7 discipline):

1. `triggerPrice: "2195.00"` (inside a plausible normal range) → `{ retCode: 0, retMsg: "OK" }`; read-back
   confirmed `triggerPrice: "2195"`, `orderStatus: "Untriggered"`, same `orderId`/role/`parentOrderLinkId`.
2. `triggerPrice: "3191.25"` (`1.5 × buyLimit`, well beyond the `buyLimit: "2127.50"` boundary from the
   snapshot above) → **also** `{ retCode: 0, retMsg: "OK" }`; read-back confirmed `triggerPrice: "3191.25"`
   actually applied, same `orderId`/role/`parentOrderLinkId`, no rejection, no different order state.

Both amends were accepted identically regardless of the `buyLimit` boundary. Position and orders were then
closed/cancelled by exact identity; final residual state was empty (no leftover orders or positions).

**Determination (tasks.md task 0.1.7):** task 0 did not establish `/v5/market/price-limit` as the far-side
boundary a clamping surrogate policy would need — Bybit accepted a `triggerPrice` 50% beyond `buyLimit`
with no different outcome than a normal-range amend, on the one probe this evidence task ran. This is not
a claim that `/v5/market/price-limit` can never constrain any native Partial TP `triggerPrice` amend under
any circumstance; it is the narrower, task-0-scoped finding that the one candidate mapping this design
considered (`buyLimit`/`sellLimit` → LONG/SHORT surrogate bound) is not supported by the evidence
obtained, so this design does not adopt it. Per task 0.2's own caveat, this is evidence from **one
instrument** (`ETHUSDT`, linear) — genuine doubt about cross-instrument applicability is not resolved by a
single check, and no bound was found to even attempt mapping `buyLimit`/`sellLimit` to LONG vs SHORT.

**Revision (task 0.1.7c) — `CurrentOrderPriceLimitsProvider` dependency dropped from the surrogate
formula.** The evidence does not support the only clamp-boundary source this design had proposed. No different,
separately-proven boundary source exists for this V1 (task 0.1.7c explicitly forbids silently keeping the
retracted mapping or inventing a replacement without its own evidence). The formula below therefore carries
**no exchange-validity claim by construction** — it is a deterministic, tick-normalized offset from
`planned_entry_price` with no clamp step and no dependency on `CurrentOrderPriceLimitsProvider` at all.
Validity is enforced the same way this design already enforces it for every other amend in the write-plan
(Decision 7): Bybit's own `retCode` on the `amendOrder` call is the actual gate — a rejection (whatever the
reason, including a guard this design has no visibility into) fails that reconciliation attempt closed via
the existing `amend_rejected` path, no different than any other amend rejection. This is a stated, accepted
risk (see Risks below), not a silent one.

```
reference = record's own desired_entry.planned_entry_price   // stable for the life of this generation

if side == "long":
  raw = reference * (1 + SURROGATE_TAKE_DISTANCE_RATIO)   // SURROGATE_TAKE_DISTANCE_RATIO = 0.5
  surrogateTakePrice = ceilToStep(raw, tickSize)           // round further away from reference
else:
  raw = reference * (1 - SURROGATE_TAKE_DISTANCE_RATIO)
  surrogateTakePrice = floorToStep(raw, tickSize)          // round further away from reference
```

Deterministic (pure function of `reference`, `side`, `tickSize`, and the fixed ratio); anchored to a
stable, truly immutable cycle-owned reference; correctly directional; tick-normalized; idempotent (the same
`(planned_entry_price, side, tickSize)` always produces the same surrogate, so a repeated identical
`take_price: null` intent never moves the surrogate, matching Decision 9, and never moves because of a
later fill either, since the reference does not move with fills).

**What this revision removes, not carries forward as a "provisional default":** the retracted
`clampToInstrumentBounds` function, `InstrumentTradingRules.minPrice`/`maxPrice` (already removed per the
prior correction), and now also the `CurrentOrderPriceLimitsProvider` dependency in the surrogate path
described in the previous revision of this Decision — `take.triggerPrice` resolution (Decision 4) no
longer queries it at all, on either the null-take or the real-take path, and `computeSurrogateTakePrice`
no longer returns a `surrogate_unrepresentable` failure (there is no bound left to make a candidate
unrepresentable against).

**Original architecture kept (unchanged from revision v17).** `take_price = null` stays the logical HTTP
semantics "strategy take disabled"; the exchange representation stays a full attributable `STOP + TAKE`
pair, with TAKE materialized as a deterministic, far-away, dormant surrogate — never a missing leg
(Context, Goals). This is an accepted, not-hidden V1 compromise: a surrogate is not claimed mathematically
equivalent to no-TAKE.

**Rejected: a purely additive offset (`reference ± fixed_amount`).** Fails the "correctly directional,
never produces a non-positive price" requirement for instruments trading at low absolute prices, and does
not scale with the instrument's own price level the way a ratio does.

**Rejected: deriving the surrogate from live current market price.** Explicitly disallowed by the master
plan — a moving reference breaks idempotency, and reintroduces exactly the "fluctuating price" dependency
this design otherwise avoids by anchoring to `planned_entry_price`.

**Rejected: clamping against `CurrentOrderPriceLimitsProvider`'s `buyLimit`/`sellLimit`.** This was the
prior revision's proposed replacement for the retracted static `minPrice`/`maxPrice` clamp. Task 0's
closed evidence (above) did not establish this band as the applicable bound for a native Partial TP
child's `triggerPrice` amend, so clamping against it would add a dependency and a failure mode
(`order_price_limits_unavailable`) without a demonstrated basis for the protection it would claim to
provide. Dropped entirely, not kept as an inert no-op check.

### 6. Reconciliation write-plan: qty travels in at most one amend call, STOP is always the qty carrier

The confirmed spike fact is stronger than "a single amend can carry triggerPrice and qty together" — it is
"amending **either** leg's `qty` pair-wide-synchronizes the sibling's `qty`." That means qty must never be
sent twice in one reconciliation attempt, even split across two different calls that each also carry a
`triggerPrice` change — sending it on both legs' calls would be a redundant, meaningless second write of
the same pair-wide value. This design fixes **STOP as the sole, deterministic qty carrier**: whenever
`qty` needs to change, it travels only in the STOP leg's `amendOrder` call, whether or not STOP's own
`triggerPrice` also changed in the same attempt. The TAKE leg's `amendOrder` call, when one is needed,
never includes `qty` — it relies entirely on the confirmed sync fact.

Given `actual` (from `resolveOwnAttachedProtection()`, `kind: "attributed"`) and `desired`
(`DesiredProtectionState`), let `triggerChanged(leg)` mean `actual.<leg>.triggerPrice !=
desired.<leg>.triggerPrice` (exact-decimal) and `qtyChanged` mean `actual.stop.qty != desired.stop.qty`
(equivalently `actual.take.qty != desired.take.qty` — both legs' desired `qty` are always equal by
construction, Decision 4, and are compared against their own actual leg independently only as an
already-satisfied check, never as separate desired values).

The full case matrix:

| STOP trigger changed | TAKE trigger changed | qty changed | STOP call | TAKE call |
|---|---|---|---|---|
| no | no | no | none | none — `already_satisfied` (Decision 9) |
| yes | no | no | `triggerPrice` only | none |
| no | yes | no | none | `triggerPrice` only |
| yes | yes | no | `triggerPrice` only | `triggerPrice` only |
| yes | no | yes | `triggerPrice` + `qty` | none |
| no | yes | yes | `qty` only | `triggerPrice` only |
| yes | yes | yes | `triggerPrice` + `qty` | `triggerPrice` only |
| no | no | yes | `qty` only | none |

In every row where `qtyChanged` is true, exactly one call carries `qty` — the STOP leg's call — and it is
issued even when STOP's own `triggerPrice` did not change (the "no / no / yes" and "no / yes / yes" rows),
specifically so the sync fact has a call to ride on. TAKE's call, whenever issued, carries `triggerPrice`
only, never `qty`. At most two `amendOrder` calls are ever issued in one reconciliation attempt (one per
leg with any change at all), and **at most one of those two ever carries `qty`** — this second bound is
the correction over the prior version of this design, which left the qty-and-triggerPrice-changed-together
case ambiguous enough to potentially send `qty` on both legs' calls.

(Choosing STOP over TAKE as the fixed qty carrier is an arbitrary but fixed, documented choice — either
leg would work given the confirmed sync; STOP is chosen for consistency with this service's existing
stop-price-first ordering elsewhere.)

This is the "minimal write-plan" the master plan defers to this design phase — expressed as a total,
deterministic rule over all eight trigger/qty-change combinations, not a per-call optimization decision
made ad hoc at runtime.

### 7. Fresh-evidence / race discipline

1. `resolveOwnAttachedProtection()` is called once to determine the write-plan (Decision 6). If it does
   not return `{ kind: "attributed" }`, the reconciler fails closed immediately (`attribution_lost` if
   `none`, `ambiguous_attribution` if `ambiguous`) — never attempts to create the pair itself (out of
   scope, see Goals).
2. Immediately before sending each planned `amendOrder` call, the reconciler does **not** re-query — the
   `amendOrder` call itself is the fresh action, and Bybit's own response is the fresh evidence for that
   leg: a non-`retCode: 0` response or a thrown transport error is treated as `amend_rejected` and fails
   the whole reconciliation attempt closed (no partial success reported — if the STOP leg's amend
   succeeded but the TAKE leg's failed, the outcome is still `fail_closed`, and the caller's own retry —
   a fresh `PUT .../protection` — re-resolves from scratch on its next attempt, the same "re-derive
   fate from evidence, never resume blind" discipline `CloseApplicationService`'s multi-owner path
   already established).
3. After all planned `amendOrder` calls return `retCode: 0`, the reconciler performs a **fresh**
   `resolveOwnAttachedProtection()` call (not a reuse of step 1's result) and compares the result against
   `desired`: `triggerPrice` exact-match on both legs, `qty` exact-match on both legs, both legs still
   `attributed` to the same parent. Any mismatch — including a leg now reporting a terminal `orderStatus`
   that step 1 did not — is `read_back_mismatch`, not silently accepted.
4. **The `amend_race` reason is reserved for a specific, narrower case:** Bybit accepting the amend
   (`retCode: 0`) but the immediately following read-back showing that the leg amended is no longer the
   live order it appeared to be at step 1 (e.g., it independently transitioned to terminal in the window
   between step 1 and the amend, and the amend itself raced a terminal transition rather than being
   cleanly rejected). This is distinguished from `read_back_mismatch` (desired values simply do not match)
   specifically so a future consumer of this outcome can tell "the write itself was internally
   inconsistent with the leg's own lifecycle" apart from "the write succeeded but produced the wrong
   values" — both fail closed identically today; the distinction is for future diagnosability, not
   different handling in this change.

No step here ever falls back to create or cancel — every failure mode is `fail_closed`, full stop,
matching the master plan's explicit "не создавать replacement вслепую" requirement.

### 8. Multi-fill representability: resolved, no special-casing needed

The master plan left this as an open design question — whether Change 7 needs distinct logic for a
multi-fill parent. It does not, for two independent reasons:

1. **A later fill is not a distinct kind of desired-state change.** Decision 4 already recomputes `qty`
   from `early_execution_observation.cumulative_filled_qty` fresh on every reconciliation call — if a
   cycle's own entry order receives an additional fill between two `PUT .../protection` calls (or two
   internal retries), the next reconciliation simply sees a different `desired.stop.qty`/`desired.take.qty`
   than before and reconciles toward it through the exact same write-plan (Decision 6) already designed
   for any other qty change. No multi-fill-specific branch exists or is needed.
2. **If Bybit's real multi-fill behavior ever produces a shape other than one attributed pair** (an
   additional pair, a resized-without-sync anomaly, anything not `none`/`attributed`), Decision 7 step 1
   already fails the whole attempt closed on any non-`attributed` classifier outcome — the reconciler
   never has to correctly interpret a shape it cannot represent, because it never tries to act on one.

This change therefore makes **no claim** about whether Bybit auto-resizes, creates additional pairs, or
preserves single-pair-per-parent under multi-fill (still `NOT PROVEN`, unchanged from the master plan) —
it simply does not need that claim to be safe. `resolveOwnAttachedProtection()`'s classifier remains the
only place such a shape could ever be represented, and it is only ever extended by proven evidence, per
`abi-native-partial-protection-attribution-v1`'s own design.

### 9. Already-satisfied short-circuit

Mirrors `ProtectionApplicationService`'s existing `evaluateReadBack()`-based already-satisfied check
(`protectionApplicationService.ts:143-167`), applied to attributable children instead of the live
aggregate position row: if a fresh `resolveOwnAttachedProtection()` already reports `attributed` with
both legs' `triggerPrice`/`qty` exactly matching `desired`, **and neither leg's `orderStatus` is
terminal**, the reconciler returns `{ kind: "already_satisfied" }` without issuing any `amendOrder` call.
This is why Decision 5's idempotent surrogate formula matters operationally, not just semantically: a
repeated `take_price: null` intent against an already-reconciled cycle takes this short-circuit, not a
redundant amend.

**Terminal leg exclusion (review finding).** `resolveOwnAttachedProtection()` is status-agnostic by design
(`abi-native-partial-protection-attribution-v1` design.md Decision 5) — a terminal historical pair still
classifies `attributed`. A terminal leg's last-known `triggerPrice`/`qty` numerically matching `desired`
is not live coverage, so it must never satisfy this shortcut, and the same applies to the post-amend
success check (Decision 7 step 3): a fresh read-back showing a terminal leg, even one whose values match
`desired`, does not report `{ kind: "reconciled" }` either — both paths fail closed as `amend_race` instead.
No new write is attempted to "fix" this; the reconciler still never creates, cancels, or replaces anything.

### 10. OCO-after-amend: explicitly not assumed, not built

No step in Decisions 6-9 ever reads or relies on Bybit having already neutralized a sibling leg after one
side fills. Every reconciliation attempt re-derives its write-plan from a fresh
`resolveOwnAttachedProtection()` call and re-verifies with another fresh call after — if OCO turns out not
to hold (a filled TAKE leaves a live STOP still open, unneutralized), this change's reconciler is
unaffected: it would simply see and amend whatever the fresh evidence shows next time it runs. This
change does not implement OCO cleanup itself (out of scope — `abi-native-partial-protection-cutover-v1`'s
own precondition if it turns out to need one) and does not assume OCO already handled it.

### 11. `ProtectionApplicationService` integration: additive, not wired to `process()`

A new public method, `reconcileNativePartial(command: ProtectionCommand): Promise<ReconciliationOutcome>`,
added to `ProtectionApplicationService`, following the flow Decisions 4/5 now specify: resolve this
cycle's current authoritative own filled qty (reuse-if-final, else fresh `confirmEntryPackage()`, fail
closed on `no_authoritative_qty`) → resolve desired state, including `computeSurrogateTakePrice(...)`
when `command.takePrice` is `null` (Decision 5 — no exchange dependency beyond `InstrumentTradingRules`'
`tickSize`, itself resolved via `InstrumentTradingRulesProvider.getRules()`, a pure function of
`planned_entry_price`/`side`/`tickSize`) → `reconcileNativePartialProtection()` (Decisions 1-9).
`process()` (the method `apply()`/the production HTTP path actually calls) is **not modified** — this is
a sibling method, called only by this change's own tests and, later, by
`abi-native-partial-protection-cutover-v1`'s production-decision switch. Locking: reuses the same
per-pair `mutex.withKeyLock` this service already acquires in `apply()` (`protectionApplicationService.ts:60-63`),
so a test exercising this method takes the identical concurrency discipline the eventual production caller
will.

**`getRules()` failure (review finding).** `InstrumentTradingRulesProvider.getRules()` throws on a
transport/decode failure (established behavior, `BybitInstrumentTradingRulesProvider`). On the null-take
path, `resolveDesiredProtectionState()` wraps that call: a thrown failure resolves to
`{ ok: false, reason: "trading_rules_unavailable" }` rather than propagating as a rejected Promise —
`reconcileNativePartial()`'s own returned Promise always resolves to a typed `ReconciliationOutcome`,
never rejects on this dependency's failure, mirroring exactly how `no_authoritative_qty` is already
surfaced. Zero attribution reads and zero amend calls happen before this check runs.

## Risks / Trade-offs

- [The surrogate TAKE formula (Decision 5) carries no exchange-validity claim by construction — task 0's
  closed Demo evidence did not establish `/v5/market/price-limit`'s band as the far-side boundary a
  clamping surrogate policy would need, and no other proven boundary source exists for this V1, so the
  formula is an unclamped tick-normalized offset from `planned_entry_price`] → Accepted as an explicit, stated
  gap, not a silent one: if Bybit ever rejects a computed surrogate for any reason (a guard this evidence
  did not surface, a future exchange-side change, or anything else), the reconciliation attempt fails
  closed via the ordinary `amend_rejected` path (Decision 7) — no silent fallback, no retry with a
  different distance. A separately-proven boundary source, if one is ever needed, is future work, not
  invented here without its own evidence.
- [At most two `amendOrder` calls per reconciliation attempt is not atomic — a partial failure between
  the two leaves one leg amended and one not] → Accepted, matching this codebase's established pattern
  for multi-step exchange writes (e.g. `CloseApplicationService`'s cancel-then-close sequence): Decision 7
  fails the whole attempt closed on any partial failure, and the next `PUT .../protection` re-resolves
  fresh evidence and re-plans from wherever the exchange actually is — no assumption of a clean starting
  state is ever made.
- [`floorToStep`/`tickSize` are new primitives with no production caller yet, same as
  `abi-native-partial-protection-attribution-v1`'s `getOrderHistoryForSymbol`] → Accepted, same
  reasoning already applied there: proves a capability the program's own sequencing calls for, ahead of
  any production consumer.
- [Resolving "multi-fill representability" as "no special-casing needed" (Decision 8) is a claim about
  this change's own safety, not a claim about Bybit's actual behavior] → Accepted and stated precisely:
  this change asserts only that its own fail-closed design does not need the unproven fact to be safe,
  never that the fact is now proven.

## Migration Plan

Purely additive: no field on `EntryPackageExecutionRecord` changes shape or is added; no existing route,
DTO, or on-disk record shape is touched; `ProtectionApplicationService.process()`'s existing behavior is
unchanged. The only new runtime behavior is (a) one new adapter method nothing production calls yet, (b)
one new decoded field (`tickSize`) on an already-fetched response, (c) one new pure step-rounding
function, (d) one new reconciliation primitive, (e) one new, non-production-decision service method.
`CurrentOrderPriceLimitsProvider` (`abi-current-order-price-limits-v1`) is not consumed by this change —
task 0's evidence ruled it out as the surrogate formula's boundary source. Rollback is a plain revert; no
data becomes unreadable in either direction.
