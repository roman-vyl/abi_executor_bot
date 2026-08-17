## Context

See `proposal.md` for Why/What. This document resolves what `docs/virtual-exposure-ownership-delivery-plan.md`
explicitly left to this change's design phase: the exact wire shape for `exposure_fraction`, the drift-
tolerance algorithm, the generalized postcondition formula, and — a question the master plan flagged but
did not answer — whether `CloseApplicationService`'s existing scope-ownership reconfirmation
(`findOwnerByScope`) still works once a scope can have more than one active record. It does not.

### Repository state relevant to this design (verified by reading the code, not assumed)

- `CloseApplicationService.process()` (`closeApplicationService.ts:63-194`) today: classify the pair by
  status → reconfirm scope ownership via `findOwnerByScope` → neutralize the entry order if not already
  terminal → read the live aggregate position → close its exact `row.size` if positive → verify both
  postconditions (`no_position` and entry-order-terminal) over bounded attempts → durably write
  `terminal_closed`.
- **`byScope` cannot represent more than one owner, and `findOwnerByScope` cannot see past it.**
  `EntryPackageCorrelationRepository.applyScopeClaimOnWrite()` (`entryPackageCorrelationRepository.ts:231-249`)
  unconditionally does `this.byScope.set(scope, record)` for any non-durably-closed write — there is no
  ownership guard at the repository layer at all; the single-owner invariant is enforced entirely by
  `EntryPackageApplicationService.createOrder()`'s claim check, one layer up, which Change 1 and this
  change both leave untouched. Confirmed directly by how `abi-virtual-exposure-state-foundation-v1`'s own
  tests seed multi-owner state (`test/unit/entryPackageCorrelationRepository.test.ts:637-665`): two plain
  `repo.save()` calls for the same scope, bypassing the application-service claim guard entirely. After
  both saves, `byScope` holds whichever record was saved **last** — a single pointer, not a set. So if
  `CloseApplicationService` kept using `findOwnerByScope` to reconfirm ownership, closing the cycle `save()`
  did *not* write last would find a *different* record as "the owner" and fail closed with `internal_error`
  — multi-owner close would be unimplementable through that check, not merely inefficient through it.
- **`findActiveRecordsForScope` (delivered by Change 1) already solves this**, and was built for exactly
  this reason: it is a linear scan over `byCompositeKey.values()` (`entryPackageCorrelationRepository.ts:152-166`),
  filtered by resolved scope and `!isDurablyClosedEntryPackageStatus(record.status)` — entirely independent
  of `byScope`. In production today, before same-side ownership activation, `EntryPackageApplicationService`'s
  claim policy guarantees this returns zero or one record for any scope — the same invariant Change 1's own
  design.md Decision 6 states and relies on for its test design.
- `isFillFactFinal`/`confirmEntryPackage` (`packageConfirmation.ts:246-248,70-162`): `confirmEntryPackage`
  requires `expected: { qty: string }` (the desired/calculated entry quantity, used only for a plausibility
  check against the exchange's reported `qty`, not for computing the returned quantity) and returns
  `full_fill`/`partial_fill` with an `EarlyExecutionObservation` (from either the realtime or the order-
  history query — the history branch explicitly handles a fill discovered on an order that has *since*
  reached a terminal-without-fill status like `Cancelled`, at `packageConfirmation.ts:132-149`), or
  `terminal_without_fill` (no observation — the order never filled), or `not_found`/`ambiguous`.
- `EntryPackageExecutionRecord.calculated_quantity: string | null` (`entryPackageExecutionRecord.ts:82`) is
  the value `confirmEntryPackage`'s `expected.qty` needs. For any record reaching this pipeline's
  neutralization step, `order_link_id` is already required non-null (`closeApplicationService.ts:116-119`);
  `calculated_quantity` is set together with the same binding and is not independently re-verified there
  today — this change adds that same defensive non-null check for `calculated_quantity` before the
  multi-owner refresh query, mirroring the existing `order_link_id` check.
- `virtual-exposure-state`'s "Fill facts are durably recorded only at existing observation points"
  requirement (`openspec/specs/virtual-exposure-state/spec.md:27-36`) names exactly three write points:
  initial create confirmation, repeat-PUT revalidation, and a cancel attempt discovering a fill — close is
  not one of them, and recovery is explicitly called out as read-only for the same reason. This change
  keeps close in that same read-only relationship to `early_execution_observation` (Decision 5 below),
  rather than adding a fourth write point.
- `compareDecimal`/`subtractDecimal`/`decimalEquals` (`src/domain/exactDecimal.ts:93,108,185`) are the
  existing exact-decimal primitives already used throughout this pipeline and `packageConfirmation.ts`.
- `AbiConfig` (`src/config/config.ts:1-18`) has no existing tolerance-style decimal config field; the
  closest precedent is `readPositiveNumberString` (used for `bybitRecvWindow`), which this change's new
  field cannot reuse verbatim since a tolerance must default to `"0"` (non-negative, not strictly positive).

## Goals / Non-Goals

**Goals:**
- Make `CloseApplicationService` correct for a scope with more than one active owner, while leaving its
  single-owner behavior — the only behavior production can reach until same-side ownership activation —
  provably byte-for-byte unchanged.
- Replace the public close contract with a fraction-based command expressing relative intent, per Change
  1's quantity-ownership boundary, without implementing partial close.
- Define, precisely enough that no later change needs to re-derive it, the drift-tolerance algorithm and
  the generalized postcondition formula the master plan explicitly deferred to this design.
- Keep the correlation repository and `virtual-exposure-state` untouched: this change is a pure consumer
  of what Change 1 already delivered.

**Non-Goals** (deferred, most to specific later changes in `docs/virtual-exposure-ownership-delivery-plan.md`):
- `exposure_fraction < 1` / any partial-close execution; a mutable durable "owned remainder" field.
- Same-side production activation (a scope actually having more than one owner outside a test fixture) —
  that is the delivery plan's Change 5. This change only makes close *ready* for it.
- Any change to `open-position` (`GET .../open-position`), recovery, or protection.
- Pair-owned protection orders, or close cancelling them (delivery plan Changes 6-8).
- The Runtime-side `ClosePositionCommand`/HTTP-client change, or the cross-repo rollout mechanism (deploy
  ordering, compatibility window, feature flag) — tracked as a separate, coordinated OpenSpec change.
- Any change to `EntryPackageCorrelationRepository`, `byScope`, or `EntryPackageApplicationService`'s claim
  policy.

## Decisions

### 1. Ownership reconfirmation moves from `findOwnerByScope` to active-record membership

**Rejected: keep `findOwnerByScope`.** As shown in Context, `byScope` is a single pointer per scope, not a
set — it cannot correctly answer "is this pair one of this scope's active owners" once more than one
exists, even synthetically. Keeping it would make the multi-owner path this change exists to build
unreachable by its own ownership check, closing the cycle `save()` didn't write last with a spurious
`internal_error`.

**Adopted:** replace the ownership-reconfirmation step with: call
`correlationRepository.findActiveRecordsForScope(category, symbol)`; the requested pair's own record MUST
appear in the result (by `correlationRecordKey` equality). This is provably safe for today's single-owner
production case: a record reaching this step already passed the `absent`/`terminal_unfilled`/
`terminal_closed` short-circuits above it, so it is definitionally non-durably-closed, and
`findActiveRecordsForScope` is defined to include every non-durably-closed record whose resolved scope
matches — which this record's own `exchange_category`/`exchange_symbol` trivially do. So self-membership
is guaranteed by construction for every record that reaches this step; the check is retained anyway as a
defensive assertion (mirrors this file's existing defensive `category` re-check at
`closeApplicationService.ts:92-98`) and, more importantly, its **result count** is what the next decision
branches on.

**A new defensive check this decision adds:** when the active-record count is more than one, every active
record's `physical_side` (derived from `desired_entry.side`, per `virtual-exposure-state` Decision 1) MUST
agree. This can only be violated by a bug — same-side ownership activation's own claim-policy change is
what will make opposite-side rejection load-bearing, and until it ships, `EntryPackageApplicationService`
already prevents this — so this is a currently-unreachable-in-production assertion, exactly like Change 1's
own monotonicity check was on the day it shipped. A violation returns `internal_error`.

### 2. Single-owner and multi-owner are two separate code paths, not one generalized formula

**Rejected: a single unified quantity-resolution/postcondition formula for both cases**, with single-owner
as a special case where it happens to reduce to today's math. Mathematically this is true (`resolvedQty ==
liveAggregateSize` when there is exactly one owner, so the general formula collapses to the exact original
check) — but the requirement is not "mathematically equivalent," it is "byte-for-byte unchanged," verified
by keeping today's *exact* code path, exact call signature, and exact test suite reachable and passing
unmodified. A shared formula makes that a proof obligation about arithmetic; two separate paths make it a
tautology from the diff alone.

**Adopted:** `CloseApplicationService.process()` branches once, immediately after the ownership-membership
check, on `findActiveRecordsForScope(...).length`:
- **`=== 1`** (today's only production-reachable state): every remaining step is byte-for-byte the existing
  code — same `queryPositionForInstrument` call, same `row.size` used directly as the close quantity, same
  `verifyBothPostconditions` call with its existing signature (checking literal `no_position`). Nothing in
  this branch reads `calculated_quantity`, calls `confirmEntryPackage`, or reads the drift-tolerance config.
- **`> 1`** (synthetic fixtures only, until same-side ownership activation): the new logic in Decisions 3-4
  below.

### 3. Multi-owner quantity resolution: a transient, read-only re-query — never a durable write

After the existing entry-order neutralization step confirms the requested pair's own current entry order
has no live remainder (unchanged — the same `classifyEntryOrderTerminality`/`cancelEntryOrder`/
`confirmEntryOrderNeutralized` sequence runs for both branches, since both need it), the multi-owner branch
additionally calls:

```ts
confirmEntryPackage({
  bybit,
  getEntryOrderPayload,
  getEntryOrderHistoryPayload,
  expected: { qty: record.calculated_quantity },   // internal_error if null — contradictory correlation
})
```

reusing the exact `getEntryOrderPayload`/`getEntryOrderHistoryPayload` already built for neutralization.
Because neutralization already confirmed the order is terminal, this call's outcome is one of:
- `full_fill` / `partial_fill` → `resolvedQty = observation.cumulative_filled_qty`. (`partial_fill` is a
  legitimate outcome here despite the order being terminal: it means the order reached a terminal-without-
  fill status like `Cancelled` *after* a partial fill had already occurred — `toObservation` and the
  history-query branch that produces it, `packageConfirmation.ts:132-149`, do not require the order's
  current status to itself be `Filled`.)
- `terminal_without_fill` → `resolvedQty = "0"` — this cycle contributed no exposure; see Decision 4 for
  why that still allows the close to proceed with no exchange write.
- `not_found` / `ambiguous` → `internal_error` (unreachable within the bounded neutralization window this
  pipeline already enforced, but re-checked rather than assumed, per this codebase's general house style).

**This result is used only in memory for the remainder of this request.** It is never passed to
`correlationRepository.save()` and never written to `record.early_execution_observation`. See Decision 5
for why.

**Rejected: durably persist the refreshed observation.** Would make close a fourth write point for
`early_execution_observation`, contradicting `virtual-exposure-state`'s existing "only at existing
observation points" requirement and the master-plan invariant that close leaves
`average_entry_price`/`avg_execution_price` untouched. It would also buy nothing this change's own scope
needs: no consumer in this change reads the record's stored observation after the request completes, and
the next close request (a repeat, or a genuinely new attempt) re-derives everything fresh regardless.

### 4. Drift tolerance and the closing quantity

Let `liveAggregateSize` be the live aggregate position's size (from the same `queryPositionForInstrument`
call the single-owner branch also makes; `"0"` if `no_position`), captured once, before any close order is
sent. Let `resolvedQty` be Decision 3's result. Let `toleranceQty` be `config.positionExposureDriftToleranceQty`
(new `AbiConfig` field, exact-decimal, non-negative, default `"0"`).

```
excess = resolvedQty - liveAggregateSize        (subtractDecimal)
if excess > 0 and excess > toleranceQty:          -> fail closed: position_exposure_drift
qtyToClose = (resolvedQty <= liveAggregateSize) ? resolvedQty : liveAggregateSize   (clamp within tolerance)
```

**Why fail closed rather than always clamp:** a `resolvedQty` that exceeds the live aggregate by more than
rounding noise means this cycle's own recorded fill facts disagree with what the exchange currently shows
— exactly the "significant discrepancy... requires reconciliation" case the master plan calls out. Silently
clamping would close *some* amount and report success while masking a real bookkeeping disagreement; this
codebase's consistent house style (every other ambiguous-state branch in this pipeline) is to fail closed
and surface it, not proceed on a best-effort basis.

**Why a small tolerance rather than zero-always:** an instrument's `qtyStep` can legitimately make a
resolved value and a live aggregate differ by less than one rounding unit without any real discrepancy.
`toleranceQty` defaults to `"0"` (today's effective behavior — any excess at all fails closed) so this
change ships conservatively; an operator who has verified a specific instrument's `qtyStep` characteristics
can widen it. This change does not hardcode "one `qtyStep`" as the default, since `qtyStep` is per-instrument
and this pipeline does not otherwise fetch instrument trading rules today — introducing that dependency
here for a default value alone was judged not worth the added coupling.

**`qtyToClose == "0"`:** no close order is sent (mirrors the existing `positionQuery.kind !== "position"`
no-op branch). This is the case where the requested cycle's own resolved exposure is zero (its entry order
never filled) while a sibling's exposure keeps the aggregate positive — the requested cycle's close still
proceeds straight to postcondition verification and the durable `terminal_closed` write, exactly like
today's `absent`/`terminal_unfilled` promotion already does for a cycle with zero exposure.

### 5. Generalized postcondition: two distinct verification calls, not one parameterized method's changed default

`verifyBothPostconditions` keeps its exact existing signature and behavior for the single-owner branch
(Decision 2): still checks literal `no_position` plus entry-order terminality, over the same bounded
attempts. A second, new method — `verifyRequestedCycleExposureClosed` — is added for the multi-owner branch
only, taking an `expectedAggregateAfterClose: string` computed once as `subtractDecimal(liveAggregateSize,
qtyToClose)` (Decision 4's snapshot, not re-read per attempt). Each bounded attempt accepts either
`no_position` (only possible when `expectedAggregateAfterClose` is `"0"`) or a live position whose size is
numerically equal (`decimalEquals`) to `expectedAggregateAfterClose`, together with the same entry-order-
terminality re-check the existing method already performs. Exhausting the bounded attempts without
confirming either fails closed with `internal_error`, matching the existing method's behavior.

This intentionally duplicates a small amount of retry-loop structure rather than adding an optional
parameter to the existing method, so the single-owner call site's behavior is trivially unaffected by
inspection of the diff, not merely by re-reading the new generalized logic and confirming it degenerates
correctly for `n=1`.

### 6. `exposure_fraction` wire validation: numeric equality to 1, not literal string equality

**Rejected: require the literal string `"1"`.** Every other exact-decimal field this API accepts
(`stop_price`, `take_price`) is validated by grammar plus, where relevant, numeric equality
(`decimalEquals`) — never by literal string match; `"1.0"` and `"1"` are not meaningfully different
requests. Requiring exact byte equality would be a new, inconsistent validation style for one field alone.

**Adopted:** `exposure_fraction` must be present, a string, satisfy the existing exact-decimal grammar
(`isExactDecimalText`), and be numerically equal to `1` via `decimalEquals(value, "1")`. Any exact-decimal
value not equal to 1 (`"0.5"`, `"0"`, `"2"`, `"-1"`), any non-exact-decimal string, a missing/null field, or
an unknown additional field in the body all fail as `validation_failed` with `error.details` identifying
`/exposure_fraction` (or `/` for an unknown field, matching `validateClosedObject`'s existing convention).
This check runs entirely in `validateCloseCommand`, before `CloseApplicationService` is ever invoked — a
non-canonical fraction never reaches an exchange call or a durable write, satisfying the master plan's
requirement directly from the HTTP layer's own control flow, not from anything inside the application
service.

**Rejected: echo `exposure_fraction` back in the success response.** V1 accepts exactly one canonical
value, so echoing it back would only ever say `"1"` and add nothing a client doesn't already know from
having sent the request. `TradeCycleClosedResponse`'s shape is unchanged; this is revisited only if/when a
later change actually implements a non-canonical fraction.

### 7. New business error code: `position_exposure_drift`, not `internal_error`

**Rejected: fold the drift case into `internal_error`.** The rest of this pipeline's `internal_error` uses
are for corruption or ambiguity this codebase cannot meaningfully act on (a missing order link, an
unresolved query). Drift beyond tolerance is different: it is a specific, nameable, and — per the master
plan's own required-tests list, which calls for "fail closed с конкретным кодом" (a specific code) —
operationally actionable condition. Folding it into `internal_error` would make it indistinguishable from
genuine internal corruption in logs/alerts, undermining exactly the observability gap the master plan's
risk list (§6.5) already flags for this program.

**Adopted:** `position_exposure_drift`, HTTP `422`, added to `PositionManagementErrorCode` and to
`abi-position-management-api`'s shared error-vocabulary table as close-only (protection cannot reach this
code — it has no quantity-resolution step).

## Risks / Trade-offs

- [The public close contract is a breaking change requiring coordinated Runtime rollout] → Accepted,
  explicitly: the master plan (§6, risk 11-12) already calls this out; this proposal does not implement or
  gate on the Runtime-side change, but production rollout of this change is not safe until that change
  ships. The exact cross-repo rollout mechanism (deploy ordering, temporary compatibility window,
  feature-flag) is an operational decision for rollout planning, not this design.
- [Two separate verification code paths (Decision 2/5) duplicate some retry-loop structure] → Accepted:
  the duplication is small (a bounded-attempts loop shape already used four times in this file), and the
  alternative (one parameterized method) trades a byte-for-byte regression guarantee for a "trust the
  math" guarantee on the one pipeline in this codebase where a mistake means closing the wrong cycle's
  exposure.
- [`position_exposure_drift`'s default zero tolerance means any qtyStep-scale rounding noise fails closed
  in the multi-owner path] → Accepted for V1: conservative by default, operator-adjustable, and — until
  same-side ownership activation ships — unreachable in production at all.
- [The multi-owner re-query (Decision 3) adds one more Bybit call to the close pipeline, only on the
  branch synthetic fixtures exercise today] → Accepted: zero added calls on the single-owner branch that
  every production request takes today; the added call reuses existing bounded-retry confirmation
  machinery rather than inventing new query mechanics.

## Migration Plan

Additive to the close pipeline and the position-management HTTP surface; no correlation-store schema
change, no new repository method, no change to `EntryPackageApplicationService`'s claim policy. The public
HTTP contract change (`DELETE .../open-position` → `POST .../close`) is the one non-additive piece and is
the reason this change requires coordinated Runtime rollout rather than being independently deployable.
Rollback is a plain revert on the ABI side; it requires Runtime to also roll back to calling the old
`DELETE` route, so rollback is coordinated the same way rollout is.
