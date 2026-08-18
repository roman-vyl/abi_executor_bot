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
  no `priceFilter` field (`tickSize`, `minPrice`, `maxPrice`) is decoded anywhere in this codebase today.
  `BybitInstrumentTradingRulesProvider` (`src/exchange/instrumentTradingRulesProvider.ts`) already
  fetches and caches the underlying response per `(category, symbol)`; adding fields to what it decodes
  needs no new Bybit query. `minPrice`/`maxPrice` (Bybit's own accepted price bounds for the instrument)
  are what let this change's surrogate TAKE formula (Decision 5) be exchange-valid by construction,
  instead of by an unverified assumption about one instrument.
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
- Represent `take_price = null` as a deterministic, tick-valid, far-away dormant surrogate TAKE, computed
  from this cycle's own stable `planned_entry_price`, clamped into the instrument's own exchange-valid
  price bounds, never from fluctuating current market price and never from a value that can move on its
  own as later fills accumulate.
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
- A dynamic, mark-price-relative max-deviation guard Bybit may separately enforce beyond the static
  `minPrice`/`maxPrice` instrument bounds — Decision 5 clamps against the static bounds only; a live
  guard beyond that, if one exists, is an accepted residual gap (Risks section), not something this
  design checks (checking it would require exactly the live-market-price dependency this design forbids
  itself from taking).
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
  | "amend_race"                // fresh evidence right before amend no longer matches what triggered the amend
  | "read_back_mismatch";       // post-amend fresh read-back does not match desired state

export async function reconcileNativePartialProtection(input: {
  bybit: BybitAdapter;
  tradingRules: InstrumentTradingRulesProvider;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
  side: "long" | "short";
  desired: DesiredProtectionState;
}): Promise<ReconciliationOutcome>;
```

New file, `src/services/protection/nativeProtectionReconciliation.ts` — colocated with
`nativeProtectionAttribution.ts` (same protection-domain grouping), consuming it as a dependency rather
than folding reconciliation logic into it: attribution stays a pure read; reconciliation is a write
pipeline built on top of that read. `DesiredProtectionState` is computed by the caller (Decision 4) —
this primitive itself does not read `early_execution_observation` or compute the surrogate price; it only
compares an already-resolved desired state against attributable reality and amends toward it. Keeping the
boundary here (rather than folding desired-state computation into the reconciler) mirrors
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
(`src/domain/exactDecimal.ts:85`) — same shape, opposite rounding direction. Needed because the surrogate
TAKE (Decision 5) must round **away from the reference price** in both directions: up (ceil) for a LONG
surrogate above entry, down (floor) for a SHORT surrogate below entry — a single rounding direction cannot
serve both without sometimes rounding a surrogate closer to entry than intended.

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

### 5. Surrogate TAKE price: stable reference, exchange-valid bounds by clamping

**Reference: `desired_entry.planned_entry_price`, not `average_entry_price`.** The prior version of this
design anchored the surrogate to `early_execution_observation.avg_execution_price`. That is wrong: a
cumulative average execution price is defined to change on every additional partial fill of the same
entry order — anchoring to it would make a *repeated, unchanged* `take_price: null` intent compute a
*different* surrogate after a later fill, silently violating this section's own idempotency requirement
and Decision 9's already-satisfied short-circuit (a later fill would make an already-reconciled surrogate
look stale even though the caller's logical intent never changed). `desired_entry.planned_entry_price` has
no such problem: per the Context section's own grep-confirmed invariant, it is set once when the entry is
first bound and never rewritten in place for the life of one generation, through partial fills, through
the eventual full fill, for as long as any own exposure from that generation remains live. It is therefore
the correct stable, cycle-owned reference — same cycle, same generation, same number, no matter how many
partial fills have landed by the time a given `PUT .../protection` call reconciles.

**Structure:**

```
reference = record's own desired_entry.planned_entry_price   // stable for the life of this generation

if side == "long":
  raw = reference * (1 + SURROGATE_TAKE_DISTANCE_RATIO)
  candidate = ceilToStep(raw, tickSize)          // round further away from reference
else:
  raw = reference * (1 - SURROGATE_TAKE_DISTANCE_RATIO)
  candidate = floorToStep(raw, tickSize)         // round further away from reference

surrogateTakePrice = clampToInstrumentBounds(candidate, minPrice, maxPrice, tickSize, side)
```

**Exchange-valid by construction, via clamping — not by an unverified constant.** Change 7 already
extends `InstrumentTradingRules` with `tickSize` (Decision 3); this design extends that same addition to
also decode `priceFilter.minPrice` and `priceFilter.maxPrice` from the same already-fetched
`/v5/market/instruments-info` response (no new Bybit query — same reasoning as `tickSize` itself). Given
those, `clampToInstrumentBounds` guarantees a **provably in-range** result without ever having verified
one specific instrument's behavior as a stand-in for all instruments:

```
function clampToInstrumentBounds(candidate, minPrice, maxPrice, tickSize, side): Result<string, "surrogate_unrepresentable"> {
  if (side == "long") {
    if (candidate <= maxPrice) return ok(candidate);
    clamped = floorToStep(maxPrice, tickSize);          // pull back inside the ceiling, stay tick-valid
  } else {
    if (candidate >= minPrice) return ok(candidate);
    clamped = ceilToStep(minPrice, tickSize);            // pull up inside the floor, stay tick-valid
  }
  if (clamped == reference) return err("surrogate_unrepresentable");  // no room left to be a dormant TAKE at all
  return ok(clamped);
}
```

The 50%-distance preference (`SURROGATE_TAKE_DISTANCE_RATIO = 0.5`, unchanged from the prior version, kept
as a named documented constant — task 4.1) is retained as the **preferred** distance precisely because it
is now only a preference, not a claim: when `reference * 1.5` (long) / `reference * 0.5` (short) already
falls inside `[minPrice, maxPrice]`, it is used as-is; when it does not, clamping pulls it back to the
nearest tick-valid price still inside the instrument's own accepted range, which by definition Bybit
itself defines as acceptable for that instrument — no live verification of any single instrument's
tolerance is needed to trust that outcome. `surrogate_unrepresentable` (clamping would leave the surrogate
exactly at the reference price, i.e. no room exists for *any* distinct dormant TAKE on this instrument's
current bounds) is a new, explicit fail-closed reconciliation outcome — an edge case, expected to be rare
to never in practice for real trading instruments, but named and handled rather than silently producing a
surrogate indistinguishable from the entry price.

This satisfies every remaining policy requirement: deterministic (pure function of `reference`, `side`,
`tickSize`, `minPrice`, `maxPrice`, and the fixed ratio — no current-price input at all); anchored to a
stable, truly immutable cycle-owned reference; correctly directional (multiplicatively above for long,
below for short — never produces a non-positive price for short, unlike a purely additive offset that
could exceed 100%); tick-normalized; provably exchange-valid from static instrument data alone; and
idempotent — the same `(planned_entry_price, side, tickSize, minPrice, maxPrice)` always produces the
same surrogate, so a repeated identical `take_price: null` intent never moves the surrogate on a later
reconcile call, matching Decision 9's already-satisfied short-circuit, and — because the reference no
longer moves with later fills — never moves it *because of* a later fill either.

**No live-Demo verification task is needed before this reaches production-reachable code.** The prior
version gated the shipped constant on a bounded Bybit Demo check (formerly `tasks.md` task 4.2) because a
single Demo instrument's acceptance of `reference * 1.5` was, at best, evidence about that one instrument,
never a general proof. Clamping against `minPrice`/`maxPrice` removes the need for that evidence entirely:
the result is in-range by construction for whichever instrument's own decoded bounds are used, for every
instrument, without per-instrument verification. What clamping does **not** rule out — a dynamic,
mark-price-relative maximum-deviation guard Bybit might separately enforce at order-placement time,
beyond its static `minPrice`/`maxPrice` — is called out explicitly as a residual, accepted gap in Risks
below, not silently assumed away.

**Rejected: a purely additive offset (`reference ± fixed_amount`).** Fails the "correctly directional,
never produces a non-positive price" requirement for instruments trading at low absolute prices, and does
not scale with the instrument's own price level the way a ratio does.

**Rejected: deriving the surrogate from live current market price.** Explicitly disallowed by the master
plan — a moving reference breaks idempotency (the same logical intent would compute a different surrogate
depending on when it happens to reconcile), and reintroduces exactly the "fluctuating price" dependency
this design otherwise avoids entirely by anchoring to `planned_entry_price` instead.

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
both legs' `triggerPrice`/`qty` exactly matching `desired`, the reconciler returns `{ kind:
"already_satisfied" }` without issuing any `amendOrder` call. This is why Decision 5's idempotent
surrogate formula matters operationally, not just semantically: a repeated `take_price: null` intent
against an already-reconciled cycle takes this short-circuit, not a redundant amend.

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
added to `ProtectionApplicationService`, following the flow Decision 4 now specifies: resolve this cycle's
current authoritative own filled qty (reuse-if-final, else fresh `confirmEntryPackage()`, fail closed on
`no_authoritative_qty`) → resolve desired state (Decision 4/5, including surrogate computation) →
`reconcileNativePartialProtection()` (Decisions 1-9).
`process()` (the method `apply()`/the production HTTP path actually calls) is **not modified** — this is
a sibling method, called only by this change's own tests and, later, by
`abi-native-partial-protection-cutover-v1`'s production-decision switch. Locking: reuses the same
per-pair `mutex.withKeyLock` this service already acquires in `apply()` (`protectionApplicationService.ts:60-63`),
so a test exercising this method takes the identical concurrency discipline the eventual production caller
will.

## Risks / Trade-offs

- [Bybit may enforce a dynamic, mark-price-relative maximum price-deviation guard for conditional/TP-SL
  order placement, beyond its static `minPrice`/`maxPrice` instrument bounds — this design's clamping
  (Decision 5) only guarantees validity against the static bounds, and checking a dynamic guard would
  require exactly the live-market-price dependency this design deliberately avoids] → Accepted as an
  explicit, stated gap, not a silent one: if such a guard exists and rejects a clamped-but-still-far
  surrogate, the reconciliation attempt fails closed via the ordinary `amend_rejected` path (Decision 7)
  — no silent fallback, no retry with a different distance. Closing this gap for real, if it ever proves
  necessary, is `abi-native-partial-protection-cutover-v1`'s concern, not this change's.
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
one new decoded field on an already-fetched response, (c) one new pure step-rounding function, (d) one new
reconciliation primitive, (e) one new, non-production-decision service method. Rollback is a plain revert;
no data becomes unreadable in either direction.
