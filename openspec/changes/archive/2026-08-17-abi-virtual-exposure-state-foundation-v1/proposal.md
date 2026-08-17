## Why

`docs/virtual-exposure-ownership-delivery-plan.md` (the multi-change program tracking GitHub Issue
#3, "Backlog: virtual position ledger for shared same-symbol exposure") lays out a sequence of
OpenSpec changes that eventually let one physical Bybit scope be shared by several same-side trade
cycles. Every later change in that program (`abi-pair-scoped-close-execution-v1`,
`abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1`, and
ultimately the ownership-activation change) needs one thing to already exist: a trustworthy,
per-`(strategy_instance_id, trade_cycle_id)` record of what that cycle's own entry order has actually
filled, distinct from Bybit's aggregate position.

Investigation for this change confirmed a specific, load-bearing problem the delivery plan only
partially resolved: `EntryPackageExecutionRecord.status === "applied"` does **not** mean a fill is
final. `PARTIAL_FILL_STATUSES` (`packageConfirmation.ts:24`) is explicitly classified as a *live*,
non-terminal order status (`isLiveOrderStatus`, `packageConfirmation.ts:234-236`; the adjacent
comment states "a still-open partially-filled state can still add exposure"), and both the
`partial_fill` and `full_fill` confirmation outcomes write the identical `status: "applied"`
(`entryPackageApplicationService.ts:605-611`). Any durable fill-fact contract this change defines has
to be built around that fact.

Further investigation found that almost everything this contract needs already exists.
`EntryPackageExecutionRecord.early_execution_observation`
(`entryPackageExecutionRecord.ts:53-59,92`) already durably stores, sourced only from *this cycle's
own entry order* (never the aggregate Bybit position), a cumulative filled quantity, an average
execution price, and the order's own status — refreshed at exactly the observation points a later
change would need. This change formalizes that existing field's invariants rather than duplicating
it: it adds **no new stored field**. It also states, as an explicit architectural decision, the
boundary the whole program depends on: per-cycle absolute exposure quantity is ABI-private state;
future Runtime commands express relative intent; ABI resolves the absolute quantity. Change 1 states
that boundary; implementing it (a close request contract, quantity resolution, materializing a Bybit
`reduceOnly` order) is entirely Change 2's work, not this change's.

This change deliberately does **not** attempt to solve `first_fill_at_ms` / a durable "first observed
fill" timestamp. That fact's only real consumer is Strategy Engine's entry-strategy-bar
identification (via Runtime), and ABI's own observation timing is not a reliable proxy for it — ABI
may not observe a fill until after a later strategy bar has already opened, so a value built from
ABI's own confirmation timing would look precise while silently being wrong for that purpose (see
design.md Decision 0). That question belongs to Change 3, once it investigates what own-order
evidence is actually sufficient — not to this change.

This is a foundation-only change. It changes no observable production behavior: `PUT
.../entry-package`, `GET .../open-position`, `PUT .../protection`, and `DELETE .../open-position`
all behave exactly as they do today after this change ships; `position-scope-exclusivity` continues
to reject a second trade cycle on an already-owned physical scope exactly as it does today; Runtime
and MDS are not touched.

## What Changes

- **No field is added anywhere.** `EntryPackageExecutionRecord` and `EarlyExecutionObservation` keep
  their exact current shape.
- `EntryPackageCorrelationRepository.save()` and `replay()` both gain fail-closed validation of one
  invariant already true by construction for every current write path: `early_execution_observation
  .cumulative_filled_qty` never decreases across writes for the same pair.
- A new pure predicate, `isFillFactFinal(observation)`, derives — from the already-durable
  `order_status` alone, no new flag — whether a cycle's recorded fill facts are settled or merely a
  live snapshot.
- Two more facts are specified as **documented contracts, not new stored fields**, because no
  consumer this change unblocks needs them stored independently yet: which side a cycle's exposure
  belongs to (derived from `desired_entry.side`), and what a cycle currently owns pending a future
  close (derived from `cumulative_filled_qty`, once `isFillFactFinal` — see design.md Decision 3 for
  the quantity-ownership architectural boundary this rests on).
- A new, purely-computed (non-indexed) repository query, `findActiveRecordsForScope(category,
  symbol)`, proving the repository can already represent and enumerate more than one active record
  sharing a physical scope — exercised only by repository-level tests with synthetically seeded
  data. `byScope`/`findOwnerByScope`/`rebuildScopeIndexFromReplay` are not touched; the derived
  scope-ownership index itself, and `EntryPackageApplicationService`'s single-owner claim policy, are
  unchanged (deferred to the program's later activation change).

## Capabilities

### New Capabilities

- `virtual-exposure-state`: Defines the durable, per-trade-cycle fill-fact contract ABI derives from
  its own entry order's confirmed observations — how it is sourced, its monotonicity invariant, how a
  consumer decides whether it is final, the quantity-ownership architectural boundary the program
  depends on, and what later changes may and may not yet build on it.

### Modified Capabilities

None. This change adds no field and changes no documented behavior of `entry-package-execution`
(its "Early execution observed before acknowledgement still receives a truthful acknowledgement"
requirement — one aggregate observation per binding — is satisfied exactly as before; this change
only adds a rejection path for a write shape no current code path produces) or of
`position-scope-exclusivity` (its "Scope ownership is derived from existing durable correlation
state, not a new store" requirement is unaffected — no field is added at all, and the one new query
this change adds is not read by ownership computation).

## Impact

- Public HTTP contract: unchanged. No new route, DTO field, or public error code.
- Correlation store on-disk shape: unchanged. No field is added anywhere.
- Production behavior: unchanged. `EntryPackageApplicationService`'s claim policy
  (`createOrder()`), `CloseApplicationService`, `OpenPositionResolutionService`, protection, and
  recovery are not modified; none of them read the new predicate or the new query method.
- Runtime / MDS: unaffected. No fill data is pushed to Runtime; no absolute quantity is sent to or
  expected from Runtime.
- Concurrency: unchanged. No new lock, no new lock ordering.
- Startup readiness: gains one new class of fail-closed condition (a replayed sequence for one pair
  whose cumulative fill regresses), evaluated the same way existing replay corruption already is.
- Prerequisite relationship: this is the foundation `abi-pair-scoped-close-execution-v1`,
  `abi-pair-scoped-open-position-resolution-v1`, and `abi-entry-cycle-recovery-attribution-v1` (the
  next three changes in `docs/virtual-exposure-ownership-delivery-plan.md`) will read from. The
  quantity-ownership boundary this change states is what `abi-pair-scoped-close-execution-v1` will
  implement against; the entry-bar-identity question this change explicitly leaves open is what
  `abi-pair-scoped-open-position-resolution-v1` will resolve.
