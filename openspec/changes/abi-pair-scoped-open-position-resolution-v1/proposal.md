## Why

`docs/virtual-exposure-ownership-delivery-plan.md` names this change, Change 3, as the second consumer
to build on `abi-virtual-exposure-state-foundation-v1` (Change 1, applied/archived) and to apply the
attributable-evidence pattern Change 2 already proved for close: `GET .../open-position` currently
sources `position_open`, `first_fill_at_ms`, and `average_entry_price` directly from Bybit's
**aggregate** physical-position row (`OpenPositionResolutionService.determine()`,
`openPositionResolutionService.ts:101-140`), documented today as attribution-by-plausibility only, "not
proof of attribution" (`open-position-resolution` spec, "V1 position attribution" requirement). That is
survivable only while a physical scope can have at most one owner. Once same-side ownership activation
(a later change in the program) lets more than one trade cycle share a physical scope, the aggregate has
only one `avgPrice`/`openTime` for the whole scope — there is no way for two owners to both read "their
own" fact from it. Independently of multi-owner, the current design also mis-attributes a **live partial
fill**: `PartiallyFilled` is already a modeled, not hypothetical, state
(`virtual-exposure-state`'s own `isFillFactFinal`), and this cycle's own entry order can be genuinely
filled while a race against Bybit's aggregate-position read (or, later, sibling activity) still reports
no matching row.

This change replaces both sources with the requested cycle's own attributable execution evidence —
`early_execution_observation`'s `cumulative_filled_qty`/`avg_execution_price`, formalized by Change 1 —
sourced from the same `confirmEntryPackage` primitive Change 2 already reuses for close, refreshed
on demand when the stored observation is not yet final. The aggregate query is kept, but demoted to
weak sanity (existence + side compatibility) and to serving `PUT .../protection`'s still-position-level
stop/take read (`ProtectionApplicationService` reuses `determine()` directly) — never again the source
of `position_open`, `average_entry_price`, or `first_fill_at_ms`. `GET .../open-position`'s wire
contract does not change shape; the semantics of two of its three fields do.

### Correction folded in before this proposal was written: First Fill's responsibility boundary

An earlier draft of this program's master plan (revision v8) assigned `first_fill_at_ms` a different,
larger meaning: "canonical entry strategy-bar identity," computed by normalizing the raw fill time to
the *containing strategy timeframe bar* and durably stored as that canonical value. Review found this
assigns ABI a responsibility it cannot correctly discharge and must not hold: **ABI has no concept of
strategy timeframe/interval/grid anywhere in its codebase** (confirmed by direct search —
`DesiredEntryDto`, `EntryPackageCommand`, `AbiConfig`, and every adapter carry no such field;
`desired_entry.source_plan_bar_open_time_ms` is one timestamp, the *plan's* bar, not a duration or grid,
and cannot by itself resolve which bar an arbitrary *later* fill timestamp belongs to). Runtime already
owns strategy timeframe/grid and already has a place to freeze a canonical, immutable execution fact
(`FrozenExecutedReceipt`, a Runtime-side concept this repository does not implement). The corrected,
now-adopted boundary (master plan revision v9, already applied to the delivery-plan document before this
proposal): **ABI's only responsibility is a trustworthy raw timestamp of this cycle's own first
attributable fill — never bar normalization.** Runtime receives that raw value from `first_fill_at_ms`,
normalizes it to the strategy bar using knowledge only Runtime has, and freezes the result itself. This
proposal implements exactly the v9-corrected scope; it introduces no timeframe/grid concept into ABI and
computes no canonical bar identity.

### Resolving this change's one remaining open question: does ABI need to durably store the raw first-fill timestamp?

The master plan left this open for this proposal's design phase. Investigation (see `design.md`,
Decision 4) found the answer is yes, for a reason specific to *this* value, not a general durability
default: Bybit's own order-query endpoints (`order/realtime`, `order/history`) expose only the order's
*current* `updatedTime` — the moment it was last touched — not a stable, independently-queryable "when
did this order's first fill happen" fact. For an order that fills in a single execution (the common
case for this system's entry orders), `updatedTime` at the moment of that fill *is* the first-fill time;
but once any further order-state change occurs (a second partial fill, a later terminal transition),
`updatedTime` moves and the original moment becomes unrecoverable through these same endpoints. Runtime
needs `first_fill_at_ms` to be **stable across repeated `GET` calls** for the same cycle — a value that
drifts between polls would make bar-boundary normalization on Runtime's side actively unreliable, not
merely imprecise. On-demand reconstruction from the same live query used for `position_open` therefore
cannot satisfy the requirement; ABI must capture the value once, the first time any observation proves a
fill occurred, and hold it immutably afterward.

## What Changes

- **`position_open` becomes fill-derived, not aggregate-existence-derived.** For a live-query-admissible
  record, `position_open` is now `true` exactly when this cycle's own cumulative attributable entry-order
  fill is greater than zero — including while that entry order is still live (`PartiallyFilled`, not yet
  terminal). The aggregate position query is no longer consulted to decide this, and (new) is skipped
  entirely when the cycle's own evidence already proves zero fill, since no aggregate answer could change
  that conclusion.
- **`average_entry_price` is sourced from the cycle's own cumulative execution facts, never the aggregate
  `avgPrice`.** When the stored `early_execution_observation` is not yet final
  (`isFillFactFinal` false — live or partial), a fresh, read-only `confirmEntryPackage` query against this
  cycle's own entry order refreshes it before answering; when already final, the stored value is used
  directly with no exchange call.
- **`first_fill_at_ms` is ABI's own raw attributable first-fill timestamp — never a canonical strategy-bar
  value, never normalized to any bar.** Captured **once**, durably, the first time any observation (this
  capability's own targeted refresh, in practice) proves this cycle's own entry order has a fill, from
  that same query's own `updatedTime`. Immutable afterward — a second capture attempt for an already-set
  value is a no-op, never an overwrite. `EntryPackageExecutionRecord` gains one new nullable field,
  `first_fill_at_ms: number | null`, and `OpenPositionResolutionService` becomes the sole writer of it,
  performing that write under the same pair-level `KeyedMutex` every other durable write in this codebase
  already uses (a new dependency for this service — it previously wrote nothing).
- **The aggregate position query is downgraded to weak sanity plus `PUT .../protection`'s existing needs
  — never a source of position_open/price/time, never quantity-compared.** It runs only when this cycle's
  own evidence already shows a fill (existence + side-compatibility check, matching this capability's
  existing, unchanged "plausibility, not proof" framing) and continues to supply the confirmed
  stop-loss/take-profit values `ProtectionApplicationService` already reads from `determine()`'s return
  value — that consumer's contract and behavior are unchanged by this proposal. A disagreement (own
  evidence proves a fill, but the aggregate has no matching-side row) fails closed, same failure
  philosophy this capability and Change 2 already use; no quantity-drift comparison of any kind is
  introduced (Change 2's already-established reason: a shared aggregate cannot prove which owner's
  activity it reflects).
- **`BybitOrderView` gains a new decoded field, `updatedTimeMs`**, from the same `order/realtime`/
  `order/history` responses `confirmEntryPackage` already queries — no new Bybit endpoint, no new
  adapter method.
- **New failure mode for a structurally impossible state**: this cycle's own evidence proves a fill
  (`cumulative_filled_qty > 0`) but the same observation carries no usable `avg_execution_price` —
  `internal_error`, since the wire contract requires a non-null, positive `average_entry_price` whenever
  `position_open` is `true` and this capability must never fabricate one.
- **Backward-compatible backfill for pre-existing durable records.** A record written before this change
  ships can have an already-final `early_execution_observation` showing a historical fill, with
  `first_fill_at_ms` absent (replay normalizes the missing key to `null`, mirroring
  `close_order_link_id`'s precedent). This capability still performs a fresh, one-time query in that case
  — even though the stored observation itself needs no refresh — specifically to backfill
  `first_fill_at_ms`, so the wire invariant (`position_open: true` implies non-null `first_fill_at_ms`)
  never breaks for old data.
- **`GET .../open-position`'s wire contract is unchanged in shape.** `position_open` / `first_fill_at_ms`
  / `average_entry_price` keep their names, types, and nullability rules; no quantity/size field is added,
  now or later in this program (`open-position-resolution` spec's own existing requirement, restated,
  not changed).

## Capabilities

### Modified Capabilities

- `open-position-resolution`: `position_open` is redefined from aggregate-existence-derived to
  fill-derived (correct while this cycle's own entry order is still live and partially filled);
  `average_entry_price` and `first_fill_at_ms` are resourced from this cycle's own attributable execution
  evidence instead of the aggregate row; the aggregate query is retained only for weak
  existence/side sanity and for `PUT .../protection`'s unchanged stop/take needs. `first_fill_at_ms`'s
  wire semantics are clarified as "this cycle's own raw first-fill timestamp," explicitly not a
  Runtime/Engine bar-identity value ABI computes.

## Impact

- `src/correlation/entryPackageExecutionRecord.ts`: one new nullable field, `first_fill_at_ms: number |
  null`; `isValidEntryPackageExecutionRecord` accepts it as absent (`undefined`), `null`, or a
  non-negative integer, mirroring `close_order_link_id`'s tolerance for pre-existing rows.
- `src/correlation/entryPackageCorrelationRepository.ts`: `replay()` normalizes a missing
  `first_fill_at_ms` key to `null` (mirrors the existing close-identity normalization); the existing
  fill-fact regression check (`fillFactRegression`, `save()`/`replay()`) gains a sibling immutability
  check — once `first_fill_at_ms` is non-null for a pair, a later record for the same pair with a
  different non-null value is rejected as corruption, both on live `save()` and on replay.
- `src/services/entryPackage/orderQueryResponseDecoder.ts`: `BybitOrderView` gains `updatedTimeMs:
  number`, decoded and validated (non-negative integer) from the existing `order/realtime`/`order/history`
  response shape; a new `OrderQueryProtocolFailureReason`, `invalid_updated_time`.
- `src/services/openPosition/openPositionResolutionService.ts`: `determine()`'s live-query-admissible
  branch is restructured around this cycle's own attributable evidence (own-order refresh via
  `confirmEntryPackage`, reusing the same primitive Change 2's `resolveOwnExposure` already established
  for close); the aggregate query becomes conditional and its role narrows to sanity + protection's
  stop/take needs. `resolve()` (the `GET` HTTP path only — `determine()` itself stays lock-free and
  side-effect-free, since `ProtectionApplicationService.process()` calls `determine()` directly while
  already holding the same mutex) gains a new `mutex: KeyedMutex` dependency, used only to durably
  capture `first_fill_at_ms` exactly once when this cycle's own evidence proves the first fill.
- `src/app/server.ts`: `OpenPositionResolutionService`'s construction gains the existing shared `mutex`
  instance (the same one `EntryPackageApplicationService`/`ProtectionApplicationService`/
  `CloseApplicationService` already use) as a new dependency.
- `openspec/specs/abi-open-position-lookup-api/spec.md`: prose-only clarification of `first_fill_at_ms`'s
  and `average_entry_price`'s sourcing (own-cycle evidence, not the aggregate); no schema, nullability,
  or route change. The spec's existing explicit prohibition on `entry_bar_open_time_ms`-shaped
  Runtime-lifecycle fields in the OpenAPI document (already present before this change, predating this
  program) is unaffected and, per this change's design, correctly anticipated the boundary this proposal
  restores.
- `docs/openapi/abi-open-position-lookup-api-v1.json`: no schema change; response description text may be
  clarified to match the spec prose above (non-normative).
- Correlation store on-disk shape: additive only (one new nullable field on one existing record type; one
  new immutability validator clause). `EntryPackageCorrelationRepository`'s indexing, `byScope`,
  `findOwnerByScope`, `findActiveRecordsForScope` are untouched.
- `ProtectionApplicationService`: no code change; its existing contract with `determine()`
  (`confirmedStopLoss`/`confirmedTakeProfit` from the aggregate row, `kind` for the open/closed/error/
  unsupported gate) is preserved exactly — verified by full regression, not by inspection alone, since
  `determine()`'s internals change substantially.
- `entryCycleRecoveryResolutionService.ts`: not touched by this change (Change 4's scope, per the master
  plan; it currently uses its own dual-query logic, independent of `OpenPositionResolutionService`).
- Runtime / MDS / Engine: not touched. `first_fill_at_ms`'s wire name and type are unchanged; only its
  documented meaning is unchanged from what Runtime has always received before this program started
  (a raw own-order fill fact) — v8's "canonical bar identity" reinterpretation, which never shipped past
  this repository's own planning document, is not carried into this proposal.
- Production behavior: for a scope's only owner (today's only production-reachable state), `position_open`
  is observably unchanged in every case except the specific gap this change fixes (a live partial fill
  visible to this cycle's own evidence before the aggregate query would have confirmed it) — see
  `design.md`'s regression analysis. `average_entry_price` is byte-for-byte unchanged for a single owner
  once the entry order is final, since the same underlying fill produces the same cumulative average
  either way.
