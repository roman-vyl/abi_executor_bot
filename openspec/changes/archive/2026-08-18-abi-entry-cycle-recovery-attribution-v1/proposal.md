## Why

`docs/virtual-exposure-ownership-delivery-plan.md` names this change, Change 4, as the third consumer to
build on `abi-virtual-exposure-state-foundation-v1` (Change 1, applied/archived), applying the same
attributable-evidence pattern Change 2 (close) and Change 3 (open-position) already proved: own-cycle
evidence is the source of per-cycle facts, the shared aggregate physical position is weak sanity only,
never a required, co-equal source of truth.

**This proposal was corrected once already, before any implementation was written**, after a review found
its first draft's premise wrong. That first draft concluded `EntryCycleRecoveryResolutionService`'s
existing dual-query state-resolution grid (`entryCycleRecoveryResolutionService.ts:212-238`,
`resolveRecoveryState`) was already multi-owner-safe, and that this change's only real scope was
redirecting `position_open`'s two fill facts (`first_fill_at_ms`/`average_entry_price`) away from the
aggregate row — the same sourcing bug Change 3 already fixed for `GET .../open-position`. Direct
inspection of the actual code disproved this: `entry_order_live` requires the aggregate query to
positively report `no_position` at all (`positionFlat`); `terminal_without_fill` requires the identical
condition. Under same-side shared scope (a later change in this program), a same-side sibling cycle's own
open position makes the aggregate never report `no_position` for as long as that sibling is open — so a
cycle whose own entry order is genuinely, positively live-and-unfilled (or genuinely, positively
terminal-with-zero-fill) can never resolve `entry_order_live`/`terminal_without_fill` while any same-side
sibling holds the scope, even though nothing about its own evidence is ambiguous. This is a real gap this
capability would otherwise ship, not a restatement of the fill-facts sourcing bug — the two are
independent defects in the same requirement, both must be fixed here.

This revision replaces the retracted premise. Every one of the four recovery states' **candidate**
resolution now comes primarily from this specific cycle's own durable/order/execution evidence; the
aggregate position query is demoted, per state, to a narrow question that can only **veto** a candidate
own evidence would otherwise reach — never manufacture one own evidence does not support, and never
required as co-equal positive agreement the way it is today. `position_open` vs `terminal_after_fill`,
once this cycle's own entry order proves a fill, is now disambiguated using this cycle's own close-order
identity (`close_order_link_id`, already durably recorded by Change 2) and that order's own confirmed
fate — reusing Change 2's own exact-qty-match strictness, via a new minimal shared primitive (below), not
the aggregate.

**This proposal was corrected a second time, before any implementation was written**, after a second
review found its second draft's own close-order check too weak. That draft reused this capability's
existing `classifyOrderForRecovery` (the same coarse "did this order accumulate any fill" classifier
already used for the entry order) to read the close order's own state — but that classifier only proves a
*non-zero* fill, not that the close order's confirmed fill exactly matches this cycle's own expected close
quantity. `CloseApplicationService.resolveCloseOrderOutcome` already has, and needs, the stricter
semantics recovery was missing: terminality, then an exact quantity match via `confirmEntryPackage` and
`decimalEquals`. Reusing only the coarse classifier would let a genuinely **partial** close-order fill be
reported as a clean `terminal_after_fill`, when this cycle's own exposure was not actually fully closed.
This revision fixes that by extracting the minimal, single-shot core of Close's own existing check into
one shared, read-only primitive (`classifyOwnCloseOrderOutcome`, `design.md` Decision 3) that both
`CloseApplicationService` and this capability call — not a second implementation of Close's own semantics,
and not a generic order-management abstraction.

The original fill-facts sourcing fix is preserved, unchanged, as one part of this larger redesign —
`average_entry_price` is sourced from the own-order query response recovery already fetches, and
`first_fill_at_ms` reuses Change 3's exact durable-capture-once mechanism (same field, same shared
per-pair mutex), never a second implementation. See `design.md` for the full mechanism and both retracted
premises' exact analysis.

### The one open design question this proposal still resolves: does reusing Change 3's durable-capture mechanism violate "Recovery resolution never causes an exchange side effect"?

Unchanged from the prior draft. The requirement's own text and scenario scope it to order-mutating
actions (create/amend/cancel); read-only `GET` queries (recovery already issues several per attempt, and
this redesign adds one more — the close-order query) and ABI's own local durable write are outside that
scope. This proposal adds one explicit clarifying scenario to that requirement rather than leaving it an
implicit reading. See `design.md`'s prior-draft rationale (unchanged) for the full argument.

## What Changes

- **Every one of the four recovery states' candidate resolution comes from this cycle's own evidence; the
  aggregate can only veto, never manufacture one, as per-state weak sanity.** `entry_order_live` and
  `terminal_without_fill` resolve from the own-order signal alone, vetoed only by a genuine opposite-side
  aggregate contradiction (a real invariant violation, not a normal shared-scope condition) — no longer
  blocked by a same-side sibling's own open position. See `design.md` Decision 4.
- **`position_open` vs `terminal_after_fill` is disambiguated using this cycle's own close-order identity
  and Change 2's own exact-qty-match strictness, not the aggregate and not a looser "any fill" rule.**
  When this cycle's own entry order proves a fill: if no close was ever durably attempted for this cycle
  (`close_order_link_id === null`), the exposure is open (vetoed only if the aggregate cannot confirm an
  existing same-side position — the same existence-only check Change 3's `determine()` already performs).
  If a close *was* durably attempted, a new shared primitive (`classifyOwnCloseOrderOutcome`, extracted
  from `CloseApplicationService`'s own existing `resolveCloseOrderOutcome`, see below) positively
  determines the outcome by exact quantity match against this cycle's own expected close quantity: an
  exact match resolves `terminal_after_fill` with **no aggregate consultation at all** (the fix for the
  specific risk this revision was asked to check: a same-side sibling's own still-open aggregate
  contribution can never override this cycle's own two-order evidence chain); a confirmed zero-fill
  (rejected) close resolves `position_open` instead (vetoed the same way as the no-close-attempted case);
  a confirmed **partial** fill (a genuine, unresolved close) fails safe rather than being reported as
  either state; any other close-order state (still live, not found, inconclusive) fails safe too, matching
  this capability's existing philosophy for any not-yet-established evidence. See `design.md` Decision 4.
- **A new, minimal, shared, read-only close-outcome primitive — not a second implementation of Change 2's
  semantics, and not a generic order-management abstraction.** `classifyOwnCloseOrderOutcome`
  (`packageConfirmation.ts`) extracts the single-shot core of `CloseApplicationService.resolveCloseOrderOutcome`
  (terminality check, then exact-qty-match confirmation) into one function both `CloseApplicationService`
  (as a thin, behavior-preserving wrapper around its own existing bounded-retry loop) and this capability
  (called once per its own existing bounded-retry attempt) call directly. See `design.md` Decision 3.
- **`average_entry_price` for `position_open` is sourced from the own-order query response recovery
  already fetches, never the aggregate `row.avgPrice`.** Unchanged from the prior draft — see `design.md`
  Decision 1.
- **`first_fill_at_ms` for `position_open` reuses Change 3's exact durable-capture-once mechanism, not a
  second implementation.** Unchanged from the prior draft — see `design.md` Decision 2.
- **No new adapter primitive, decoder, or Bybit endpoint.** One new shared classification function in an
  existing file (`packageConfirmation.ts`), reusing existing adapter calls (`classifyEntryOrderTerminality`,
  `confirmEntryPackage`) unchanged. No cancel, amend, or create request is added anywhere in this
  capability.
- **No change to `entryCycleRecoveryApi.ts`, the legacy `pending_action` guard, or the durably-closed-status
  fast path.**

## Capabilities

### Modified Capabilities

- `entry-cycle-recovery-resolution`: the dual-query state-resolution grid is redesigned so every state's
  candidate resolves from this cycle's own durable/order/execution evidence, with the aggregate position
  query demoted to a narrow, per-state veto (opposite-side contradiction for the two zero-fill states,
  same-side existence for `position_open`) rather than required positive agreement, and never consulted at
  all for `terminal_after_fill`. `position_open` vs `terminal_after_fill` is disambiguated using this
  cycle's own close-order identity and fate (Change 2's `close_order_link_id`), verified by exact quantity
  match, not the aggregate and not a coarser "any fill" check. `position_open`'s `first_fill_at_ms` and
  `average_entry_price` are resourced from this cycle's own attributable evidence instead of the
  aggregate position row. The "never causes an exchange side effect" requirement gains an explicit
  clarifying scenario distinguishing read-only exchange queries and ABI's own local durable writes from
  the order-mutating actions it actually prohibits.
- `close-execution`: no behavior change. `CloseApplicationService.resolveCloseOrderOutcome`'s single-shot
  classification core is extracted into a shared primitive this proposal also calls; its own bounded-retry
  wrapper and four-value outcome contract are preserved byte-for-byte, verified by its own existing
  regression suite.

## Impact

- `src/services/entryPackage/packageConfirmation.ts`: gains one new exported function,
  `classifyOwnCloseOrderOutcome` (and its `OwnCloseOrderOutcome` type) — `design.md` Decision 3. Calls
  `classifyEntryOrderTerminality`/`confirmEntryPackage` (both already defined in this file) unchanged; adds
  no new adapter call.
- `src/services/close/closeApplicationService.ts`: `resolveCloseOrderOutcome` is refactored into a thin
  wrapper around the new shared primitive, keeping its own existing `FINAL_VERIFY_ATTEMPTS`/
  `FINAL_VERIFY_RETRY_DELAY_MS` bounded-retry loop and collapsing the primitive's richer outcome back to
  its own existing `"matched" | "incomplete" | "not_found" | "ambiguous"` contract — `design.md` Decision
  3. Behavior-preserving; verified by `CloseApplicationService`'s own existing regression suite passing
  unchanged.
- `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`: substantially restructured.
  `OrderRecoverySignal`'s `live_with_fill`/`terminal_with_fill` variants gain `averageEntryPrice: string`
  and `cumulativeFilledQty: string`. A new `AggregateSanity` type and `classifyAggregateSanity` function
  replace the current `positionOpen`/`positionFlat` boolean derivation. `resolveRecoveryState` is
  rewritten around the own-evidence-primary, aggregate-vetoes-only grid in `design.md` Decision 4, taking
  a pre-fetched, conditionally-present close-order outcome (`OwnCloseOrderOutcome | undefined`) and a
  `closeOrderAttempted: boolean` derived from `record.close_order_link_id`, in addition to its existing
  inputs — remaining a pure, synchronous function. `process()`'s per-attempt loop gains a conditional call
  to `classifyOwnCloseOrderOutcome` (issued only when that attempt's own entry-order signal is
  `terminal_with_fill` and `close_order_link_id` is non-null). `process()` also gains the Decision 2
  durable-capture-or-reuse step (mutex-guarded), mirroring
  `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing block. `EntryCycleRecoveryResolutionServiceDeps`
  gains `mutex: KeyedMutex`.
- `src/app/server.ts`: `EntryCycleRecoveryResolutionService`'s construction gains the existing shared
  `mutex` instance (the same one every other application service in this codebase already uses) as a new
  dependency.
- `openspec/specs/entry-cycle-recovery-resolution/spec.md`: the "Recovery resolution classifies the trade
  cycle into exactly one of four states..." requirement is substantially rewritten — every scenario's
  aggregate dependency is re-specified per `design.md` Decision 4, and new scenarios are added for the
  close-order-based `position_open`/`terminal_after_fill` disambiguation, including the partial-fill
  fail-closed case. The "never causes an exchange side effect" requirement gains one new scenario
  clarifying read-only queries and local durable writes are not exchange side effects.
- No HTTP contract change. `GET .../recovery-state`'s request and response shapes, status codes, and
  error codes are unchanged.
- `src/domain/entryCycleRecoveryApi.ts`, `src/correlation/entryPackageExecutionRecord.ts`,
  `entryPackageCorrelationRepository.ts`, `openPositionResolutionService.ts`: not touched. This design
  reuses Change 2's and Change 3's existing durable fields; it adds no new field, no new adapter method,
  and no new close-dispatch logic anywhere in the codebase.
- Production behavior: for a scope's only owner (today's only production-reachable state), every recovery
  state's resolution is byte-for-byte unchanged except `position_open`'s `average_entry_price`/
  `first_fill_at_ms`, which become identical to what `GET .../open-position` already reports for the same
  pair (a fix, not a regression — see `design.md`'s regression analysis). The close-order check is never
  issued in production today, since `close_order_link_id` is only ever set by the multi-owner close path,
  unreachable until same-side ownership activation (a later change in this program).
  `CloseApplicationService`'s own production behavior is unaffected — its extraction is behavior-preserving
  by construction, verified by its own existing regression suite.
