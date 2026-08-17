## Why

`docs/virtual-exposure-ownership-delivery-plan.md` (the multi-change program tracking GitHub Issue
#3, "Backlog: virtual position ledger for shared same-symbol exposure") lays out a sequence of
OpenSpec changes that eventually let one physical Bybit scope be shared by several same-side trade
cycles. Every later change in that program (`abi-pair-scoped-close-execution-v1`,
`abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1`, and
ultimately the ownership-activation change) needs one thing to already exist: a durable,
per-`(strategy_instance_id, trade_cycle_id)` record of what that cycle's own entry order has
actually filled, distinct from Bybit's aggregate position. Nothing in ABI durably tracks this today
in a form later changes can trust.

Investigation for this change confirmed a specific, load-bearing problem the plan document only
partially resolved: `EntryPackageExecutionRecord.status === "applied"` does **not** mean a fill is
final. `PARTIAL_FILL_STATUSES` (`packageConfirmation.ts:24`) is explicitly classified as a *live*,
non-terminal order status (`isLiveOrderStatus`, `packageConfirmation.ts:234-236`; the adjacent
comment states "a still-open partially-filled state can still add exposure"), and both the
`partial_fill` and `full_fill` confirmation outcomes write the identical `status: "applied"`
(`entryPackageApplicationService.ts:605-611`). A future consumer that trusted "applied" as "exposure
is settled" would be wrong for a still-live partially-filled order. Any durable fill-fact model this
change introduces has to be built around that fact, not against it.

Further investigation found that most of what this durable fact needs already exists:
`EntryPackageExecutionRecord.early_execution_observation`
(`entryPackageExecutionRecord.ts:53-59,92`) already durably stores, sourced only from *this cycle's
own entry order* (never the aggregate Bybit position), a cumulative filled quantity and an average
execution price, refreshed at exactly the observation points a later change would need (initial
confirmation, repeat-PUT revalidation, and cancel-discovers-a-fill) — see design.md's Decision 1 for
the full trace. What is genuinely missing is (a) an immutable "when was this cycle's exposure first
observed" fact, and (b) durable enforcement that the existing fields never regress. This change adds
exactly that, and defines — without storing redundant state for it yet — the precise contract later
changes must use for "is this cycle's fill fact final" and "which side does this cycle's exposure
belong to."

This is a foundation-only change. It changes no observable production behavior: `PUT
.../entry-package`, `GET .../open-position`, `PUT .../protection`, and `DELETE .../open-position`
all behave exactly as they do today after this change ships; `position-scope-exclusivity` continues
to reject a second trade cycle on an already-owned physical scope exactly as it does today.

## What Changes

- `EarlyExecutionObservation` gains one new field, `first_observed_at: string | null` — the ISO
  timestamp of the *first* confirmed fill observation for the current binding, immutable once set,
  carried forward unchanged on every later observation of the same binding. `null` for any binding
  whose observation predates this change (never fabricated from `observed_at`, which is a *last*-
  observed timestamp, not a first-fill timestamp).
- `EntryPackageCorrelationRepository.save()` and `replay()` both gain fail-closed validation of two
  invariants on `early_execution_observation`: `cumulative_filled_qty` never decreases across writes
  for the same pair, and `first_observed_at` never changes once non-null.
- A new pure predicate, `isFillFactFinal(observation)`, and a documented (not newly stored) contract
  for two more facts later changes will consume: which side a cycle's exposure belongs to (derived
  from `desired_entry.side`, never stored separately — see design.md Decision 3), and what a cycle
  currently owns pending a future close (derived from `cumulative_filled_qty` once
  `isFillFactFinal`, not stored yet — see design.md Decision 4).
- A new, purely-computed (non-indexed) repository query, `findActiveRecordsForScope(category,
  symbol)`, proving the repository can already represent and enumerate more than one active record
  sharing a physical scope — exercised only by repository-level tests with synthetically seeded
  data. `byScope`/`findOwnerByScope`/`rebuildScopeIndexFromReplay` are not touched; the derived
  scope-ownership index itself, and `EntryPackageApplicationService`'s single-owner claim policy, are
  unchanged by this change (deferred to the program's later activation change — see design.md
  Decision 6 for why that structural change does not belong here).

## Capabilities

### New Capabilities

- `virtual-exposure-state`: Defines the durable, per-trade-cycle fill-fact record ABI derives from
  its own entry order's confirmed observations — what is tracked, how it is sourced, when it is
  updated, its immutability/monotonicity invariants, how it survives restart, and what later changes
  may and may not yet build on it.

### Modified Capabilities

None. `entry-package-execution`'s existing requirements — including "Early execution observed before
acknowledgement still receives a truthful acknowledgement" (still exactly one aggregate observation
per binding, not a reconstructed fill history) — are unchanged in their own text; this change adds
one additional durable field to that same aggregate observation and validates it, without altering
any documented behavior. `position-scope-exclusivity`'s requirements, including "Scope ownership is
derived from existing durable correlation state, not a new store," are unaffected: this change's new
field is not part of, and is never read by, scope-ownership computation.

## Impact

- Public HTTP contract: unchanged. No new route, DTO field, or public error code.
- Correlation store on-disk shape: additive only. One new optional field inside an already-optional
  nested object (`early_execution_observation.first_observed_at`); every existing field, every
  existing record without this field, and the file format itself are unaffected.
- Production behavior: unchanged. `EntryPackageApplicationService`'s claim policy
  (`createOrder()`), `CloseApplicationService`, `OpenPositionResolutionService`, protection, and
  recovery are not modified by this change; none of them read the new field or the new query method.
- Concurrency: unchanged. No new lock, no new lock ordering.
- Startup readiness: gains one new class of fail-closed condition (a replayed sequence for one pair
  whose fill facts regress), evaluated the same way existing replay corruption already is.
- Prerequisite relationship: this is the foundation `abi-pair-scoped-close-execution-v1`,
  `abi-pair-scoped-open-position-resolution-v1`, and `abi-entry-cycle-recovery-attribution-v1` (the
  next three changes in `docs/virtual-exposure-ownership-delivery-plan.md`) will read from, and the
  program's later activation change will build the actual multi-owner scope index against.
