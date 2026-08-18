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
- `early_execution_observation.avg_execution_price` / `isFillFactFinal()`
  (`src/services/entryPackage/packageConfirmation.ts`, `abi-virtual-exposure-state-foundation-v1`) — this
  cycle's own, own-order-sourced average entry price and fill-finality predicate. This change's surrogate
  TAKE computation and its `qty` desired-state both read through this, never re-deriving or estimating.
- `ceilToStep(valueText, stepText)` (`src/domain/exactDecimal.ts:85`) — existing step-rounding primitive,
  used today for `qtyStep` rounding in `src/risk/positionSizeCalculator.ts`. No `floorToStep` counterpart
  exists yet.
- `InstrumentTradingRules` (`src/exchange/instrumentTradingRulesResponseDecoder.ts:3-7`) currently decodes
  only `minOrderQty`, `qtyStep`, `minNotionalValue` from `/v5/market/instruments-info`'s `lotSizeFilter` —
  no price tick size (`priceFilter.tickSize`) is decoded anywhere in this codebase today.
  `BybitInstrumentTradingRulesProvider` (`src/exchange/instrumentTradingRulesProvider.ts`) already
  fetches and caches the underlying response per `(category, symbol)`; adding a field to what it decodes
  needs no new Bybit query.
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
  from this cycle's own stable `average_entry_price`, never from fluctuating current market price.
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
- A verified, exchange-confirmed final surrogate-distance constant — Decision 5 below gives a structural
  formula and a provisional default; `tasks.md` gates the exact constant on a bounded verification step,
  not a claim of proof this document doesn't have.
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

Given a `ProtectionCommand` (`stopPrice`, `takePrice: string | null`) and the record's own
`early_execution_observation`:

```
qty = record.early_execution_observation.cumulative_filled_qty   // requires isFillFactFinal(...) — see below
stop.triggerPrice = command.stopPrice
stop.qty = qty
take.triggerPrice = command.takePrice !== null
                       ? command.takePrice
                       : computeSurrogateTakePrice(...)            // Decision 5
take.qty = qty
```

**`qty` requires `isFillFactFinal`.** If this cycle's own fill facts are not yet final (a live,
still-partial entry order), the reconciler does not have an authoritative `qty` to reconcile toward —
this is a **caller-side precondition**, not something `reconcileNativePartialProtection()` itself checks
(mirrors `resolveOwnAttachedProtection()`'s own context-free design, Decision 1): the new
`ProtectionApplicationService` method (Decision 11) refreshes and checks `isFillFactFinal` before calling
the reconciler at all, exactly as the master plan's flow already specifies ("refresh own cumulative fill
facts" as its own first step, before attribution).

Both legs always carry the same `qty` — this is not a coincidence of the desired-state construction, it is
the same pair-wide invariant `effective stop coverage == effective take coverage == own cumulative fill`
the master plan states, applied identically whether the take leg is the caller's real desired price or a
computed surrogate.

### 5. Surrogate TAKE price: formula and provisional distance

**Structure (fixed by this design, not gated):**

```
reference = record's own average_entry_price (early_execution_observation.avg_execution_price,
            requires isFillFactFinal — same precondition as Decision 4's qty)

if side == "long":
  raw = reference * (1 + SURROGATE_TAKE_DISTANCE_RATIO)
  surrogateTakePrice = ceilToStep(raw, tickSize)     // round further away from reference
else:
  raw = reference * (1 - SURROGATE_TAKE_DISTANCE_RATIO)
  surrogateTakePrice = floorToStep(raw, tickSize)    // round further away from reference
```

This satisfies every policy requirement the master plan (ревизия v17) states: deterministic (pure
function of `reference`, `side`, `tickSize`, and the fixed ratio — no current-price input at all);
anchored to a stable cycle-owned reference (`average_entry_price`, immutable once `isFillFactFinal`,
never re-estimated); correctly directional (multiplicatively above for long, below for short — never
produces a non-positive price for short, unlike a purely additive offset that could exceed 100%);
tick-normalized; and idempotent — the same `(average_entry_price, side, tickSize)` always produces the
same surrogate, so a repeated identical `take_price: null` intent never moves the surrogate on a later
reconcile call, matching the already-satisfied short-circuit (Decision 9).

**Provisional default, explicitly not proven: `SURROGATE_TAKE_DISTANCE_RATIO = 0.5` (50%).** Reasoning,
not a claim of verification: normal stop/take distances this system's strategies use are observed in the
single-digit-to-low-teens percent range (the stop-only spike's own experiments used ~5% stop/take
distances on ETHUSDT); 50% is an order of magnitude beyond that, making an ordinary trade's price
excursion reaching it extremely unlikely, while remaining modest enough to plausibly clear whatever
maximum-price-deviation guard Bybit enforces for conditional/TP-SL order placement — a guard this
codebase has never queried or observed directly. **This ratio is a placeholder pending `tasks.md`'s
verification task, not a proven constant** — the master plan (ревизия v17) explicitly forbids fixing a
percentage without justification and shipping it as settled; this section states the justification and
leaves the number provisional until that task closes.

**Rejected: a purely additive offset (`reference ± fixed_amount`).** Fails the "correctly directional,
never produces a non-positive price" requirement for instruments trading at low absolute prices, and does
not scale with the instrument's own price level the way a ratio does.

**Rejected: deriving the surrogate from live current market price.** Explicitly disallowed by the master
plan — a moving reference breaks idempotency (the same logical intent would compute a different surrogate
depending on when it happens to reconcile), and reintroduces exactly the "fluctuating price" dependency
`average_entry_price` was chosen to avoid.

### 6. Reconciliation write-plan: minimal amend calls, reusing the confirmed `qty` sync

Given `actual` (from `resolveOwnAttachedProtection()`, `kind: "attributed"`) and `desired`
(`DesiredProtectionState`):

- If `actual.stop.triggerPrice == desired.stop.triggerPrice` (exact-decimal) and
  `actual.take.triggerPrice == desired.take.triggerPrice` and both legs' `qty` already equal
  `desired.stop.qty` (== `desired.take.qty`, always equal by construction) — nothing to do (Decision 9).
- Otherwise, for each leg whose `triggerPrice` differs from desired: **one** `amendOrder` call for that
  leg's `orderId`, carrying the new `triggerPrice` and, if `qty` also differs, the new `qty` in the same
  call (the spike's own Experiment B confirmed a single amend can carry both together).
- If **only** `qty` differs (both `triggerPrice`s already match desired) — **exactly one** `amendOrder`
  call, deterministically always on the STOP leg's `orderId`, carrying only the new `qty`. The confirmed
  pair-wide sync fact means the TAKE leg's `qty` updates as a side effect — a second, redundant `qty`-only
  amend on the TAKE leg is never issued. (Choosing STOP over TAKE is an arbitrary but fixed, documented
  choice — either leg would work given the confirmed sync; STOP is chosen for consistency with this
  service's existing stop-price-first ordering elsewhere.)
- At most two `amendOrder` calls are ever issued in one reconciliation attempt (one per leg whose
  `triggerPrice` changed), never more.

This is the "minimal write-plan" the master plan defers to this design phase — expressed as a deterministic
rule, not a per-call optimization decision made ad hoc at runtime.

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
added to `ProtectionApplicationService`, following the same flow the master plan specifies: refresh own
cumulative fill (Change 1) → check `isFillFactFinal` (fail closed if not) → resolve desired state
(Decision 4, including surrogate computation) → `reconcileNativePartialProtection()` (Decisions 1-9).
`process()` (the method `apply()`/the production HTTP path actually calls) is **not modified** — this is
a sibling method, called only by this change's own tests and, later, by
`abi-native-partial-protection-cutover-v1`'s production-decision switch. Locking: reuses the same
per-pair `mutex.withKeyLock` this service already acquires in `apply()` (`protectionApplicationService.ts:60-63`),
so a test exercising this method takes the identical concurrency discipline the eventual production caller
will.

## Risks / Trade-offs

- [The provisional 50% surrogate distance ratio (Decision 5) might not clear Bybit's actual max-price
  constraint, or might turn out too close to be reliably dormant] → Accepted as this document's own
  explicitly-flagged provisional decision, not a silent guess: `tasks.md` gates the shipped constant on a
  bounded verification step before this reaches production-reachable code (though even then it stays
  unreachable until `abi-native-partial-protection-cutover-v1`).
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
