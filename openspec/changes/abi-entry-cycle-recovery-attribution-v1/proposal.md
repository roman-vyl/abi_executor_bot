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

This revision replaces the retracted premise. Every one of the four recovery states now resolves
primarily from this specific cycle's own durable/order/execution evidence; the aggregate position query
is demoted, per state, to a narrow sanity question that can only ever block a resolution own evidence
would otherwise reach — never manufacture one own evidence does not support, and never required as
co-equal positive agreement the way it is today. `position_open` vs `terminal_after_fill`, once this
cycle's own entry order proves a fill, is now disambiguated using this cycle's own close-order identity
(`close_order_link_id`, already durably recorded by Change 2) and that order's own confirmed fate — reusing
the same read-only order-classification primitive this capability already uses for the entry order, a
second time, pointed at a different identity. No new close-side machinery is introduced: this is the same
primitive, the same durable field, read a second time.

The original fill-facts sourcing fix is preserved, unchanged, as one part of this larger redesign —
`average_entry_price` is sourced from the own-order query response recovery already fetches, and
`first_fill_at_ms` reuses Change 3's exact durable-capture-once mechanism (same field, same shared
per-pair mutex), never a second implementation. See `design.md` for the full mechanism and the retracted
premise's exact analysis.

### The one open design question this proposal still resolves: does reusing Change 3's durable-capture mechanism violate "Recovery resolution never causes an exchange side effect"?

Unchanged from the prior draft. The requirement's own text and scenario scope it to order-mutating
actions (create/amend/cancel); read-only `GET` queries (recovery already issues several per attempt, and
this redesign adds one more — the close-order query) and ABI's own local durable write are outside that
scope. This proposal adds one explicit clarifying scenario to that requirement rather than leaving it an
implicit reading. See `design.md`'s prior-draft rationale (unchanged) for the full argument.

## What Changes

- **Every one of the four recovery states resolves from this cycle's own evidence; the aggregate is
  demoted to per-state weak sanity, never required positive agreement.** `entry_order_live` and
  `terminal_without_fill` resolve from the own-order signal alone, sanity-checked only against a genuine
  opposite-side aggregate contradiction (a real invariant violation, not a normal shared-scope condition)
  — no longer blocked by a same-side sibling's own open position. See `design.md` Decision 3.
- **`position_open` vs `terminal_after_fill` is disambiguated using this cycle's own close-order
  identity, not the aggregate.** When this cycle's own entry order proves a fill: if no close was ever
  durably attempted for this cycle (`close_order_link_id === null`), the exposure is open (sanity-checked
  against the aggregate confirming an existing same-side position — the same existence-only check Change
  3's `determine()` already performs). If a close *was* durably attempted, this cycle's own close order's
  current state (queried via the same primitive already used for the entry order, reused a second time)
  positively determines the outcome: a confirmed fill on the close order resolves `terminal_after_fill`
  with **no aggregate consultation at all** (this is the fix for the specific risk this revision was asked
  to check: a same-side sibling's own still-open aggregate contribution can never override this cycle's
  own two-order evidence chain); a confirmed zero-fill (rejected) close resolves `position_open` instead
  (sanity-checked the same way as the no-close-attempted case); any other close-order state (still live,
  not found, inconclusive) fails safe, matching this capability's existing philosophy for any
  not-yet-established evidence. See `design.md` Decision 3.
- **`average_entry_price` for `position_open` is sourced from the own-order query response recovery
  already fetches, never the aggregate `row.avgPrice`.** Unchanged from the prior draft — see `design.md`
  Decision 1.
- **`first_fill_at_ms` for `position_open` reuses Change 3's exact durable-capture-once mechanism, not a
  second implementation.** Unchanged from the prior draft — see `design.md` Decision 2.
- **No new adapter primitive, decoder, Bybit endpoint, or close-side dispatch/retry logic.** The
  close-order query reuses this capability's own existing order-classification primitive
  (`classifyOrderForRecovery`), already identity-agnostic, pointed at `close_order_link_id` instead of
  `order_link_id` — the same function, a second call site, not a second implementation. No cancel, amend,
  or create request is added anywhere in this capability.
- **No change to `entryCycleRecoveryApi.ts`, the legacy `pending_action` guard, or the durably-closed-status
  fast path.**

## Capabilities

### Modified Capabilities

- `entry-cycle-recovery-resolution`: the dual-query state-resolution grid is redesigned so every state
  resolves from this cycle's own durable/order/execution evidence, with the aggregate position query
  demoted to narrow, per-state sanity (opposite-side contradiction for the two zero-fill states,
  same-side existence for `position_open`) rather than required positive agreement. `position_open` vs
  `terminal_after_fill` is disambiguated using this cycle's own close-order identity and fate (Change 2's
  `close_order_link_id`), not the aggregate. `position_open`'s `first_fill_at_ms` and
  `average_entry_price` are resourced from this cycle's own attributable evidence instead of the
  aggregate position row. The "never causes an exchange side effect" requirement gains an explicit
  clarifying scenario distinguishing read-only exchange queries and ABI's own local durable writes from
  the order-mutating actions it actually prohibits.

## Impact

- `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`: substantially restructured.
  `OrderRecoverySignal`'s `live_with_fill`/`terminal_with_fill` variants gain `averageEntryPrice: string`.
  A new `AggregateSanity` type and `classifyAggregateSanity` function replace the current
  `positionOpen`/`positionFlat` boolean derivation. `resolveRecoveryState` is rewritten around the
  own-evidence-primary grid in `design.md` Decision 3, taking a pre-fetched, conditionally-present
  close-order signal (`closeSignal: OrderRecoverySignal | undefined`) and a `closeOrderAttempted: boolean`
  derived from `record.close_order_link_id`, in addition to its existing inputs — remaining a pure,
  synchronous function. `process()`'s per-attempt loop gains a conditional close-order query (issued only
  when that attempt's own entry-order signal proves a fill and `close_order_link_id` is non-null), reusing
  `classifyOrderForRecovery` a second time with the close order's own identity. `process()` also gains the
  Decision 2 durable-capture-or-reuse step (mutex-guarded), mirroring
  `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing block. `EntryCycleRecoveryResolutionServiceDeps`
  gains `mutex: KeyedMutex`.
- `src/app/server.ts`: `EntryCycleRecoveryResolutionService`'s construction gains the existing shared
  `mutex` instance (the same one every other application service in this codebase already uses) as a new
  dependency.
- `openspec/specs/entry-cycle-recovery-resolution/spec.md`: the "Recovery resolution classifies the trade
  cycle into exactly one of four states..." requirement is substantially rewritten — every scenario's
  aggregate dependency is re-specified per `design.md` Decision 3, and new scenarios are added for the
  close-order-based `position_open`/`terminal_after_fill` disambiguation. The "never causes an exchange
  side effect" requirement gains one new scenario clarifying read-only queries and local durable writes
  are not exchange side effects.
- No HTTP contract change. `GET .../recovery-state`'s request and response shapes, status codes, and
  error codes are unchanged.
- `src/domain/entryCycleRecoveryApi.ts`, `src/correlation/entryPackageExecutionRecord.ts`,
  `entryPackageCorrelationRepository.ts`, `openPositionResolutionService.ts`, `packageConfirmation.ts`,
  `CloseApplicationService`: not touched. This design reuses Change 2's and Change 3's existing durable
  fields and existing primitives; it adds no new field, no new adapter method, and no new close-dispatch
  logic anywhere in the codebase.
- Production behavior: for a scope's only owner (today's only production-reachable state), every recovery
  state's resolution is byte-for-byte unchanged except `position_open`'s `average_entry_price`/
  `first_fill_at_ms`, which become identical to what `GET .../open-position` already reports for the same
  pair (a fix, not a regression — see `design.md`'s regression analysis). The close-order query is never
  issued in production today, since `close_order_link_id` is only ever set by the multi-owner close path,
  unreachable until same-side ownership activation (a later change in this program).
