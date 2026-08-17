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
Decision 4) found the answer is yes — Runtime needs `first_fill_at_ms` to be **stable across repeated
`GET` calls** for the same cycle, and nothing describing an order's "current state" can provide that,
since it moves every time the order's state changes further.

**This proposal's first draft got the *source* of that raw value wrong, and this revision corrects it
before any implementation was written.** The first draft proposed sourcing `first_fill_at_ms` from the
entry order's own `updatedTime` field (via `order/realtime`/`order/history`, the endpoints
`confirmEntryPackage` already queries). Review surfaced a concrete failure this source cannot avoid: if an
order has already accumulated more than one fill by the time ABI's own confirmation pipeline first
observes it — first fill at 12:01, a second fill at 12:03, ABI's own pipeline first looking at 12:03 —
`updatedTime` at that observation is 12:03, the time of the *most recent* fill ABI happened to see, not
12:01, the true first fill. Durably capturing that would make the value stable, but **stably wrong** —
worse than not capturing it at all if 12:01 and 12:03 straddle a strategy-bar boundary Runtime needs to
resolve correctly.

**The corrected source: Bybit's `/v5/execution/list` ("Get Trade History"), filtered to this cycle's own
entry order by its already-known `orderLinkId`, taking `min(execTime)` across every one of that order's
own individually-timestamped executions.** This endpoint answers "when did this order's first fill happen"
directly and correctly regardless of how many fills occurred or how late ABI happens to look — a genuinely
different class of primitive from an order-level "current state" field, not merely a more precise version
of the same idea. This requires one new, narrow adapter primitive (no existing ABI code queries this
endpoint today) — see "What Changes" and `design.md`'s Decision 4 for the full design, including how
pagination is handled without assuming record order, and how the endpoint's own 7-day query-window limit
is handled for restart/recovery.

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
  value, never normalized to any bar.** Captured **once**, durably, the first time `resolve()` (the `GET`
  HTTP path) observes this cycle's own entry order has a fill with no `first_fill_at_ms` captured yet, by
  querying this order's own executions via a new `/v5/execution/list` primitive and taking the earliest
  `execTime` among them — never from any order-level "current state" field. Immutable afterward — a second
  capture attempt for an already-set value is a no-op, never an overwrite. `EntryPackageExecutionRecord`
  gains one new nullable field, `first_fill_at_ms: number | null`, and `OpenPositionResolutionService`
  becomes the sole writer of it, performing that write under the same pair-level `KeyedMutex` every other
  durable write in this codebase already uses (a new dependency for this service — it previously wrote
  nothing). `determine()` itself never queries `/v5/execution/list` and never changes what it returns for
  `firstFillAtMs` beyond passing through whatever is already durably captured — `ProtectionApplicationService`,
  the other caller of `determine()`, never reads that field at all, so this costs it nothing.
- **New adapter primitive, scoped narrowly to this one need.** `BybitAdapter` gains `getExecutionList`,
  filtering by this cycle's own `orderLinkId` only (never `orderId` — Bybit's own documented
  parameter-priority rule for this endpoint would let `orderId` silently override the filter if both were
  sent). Pagination is followed to completion (`nextPageCursor`) before computing a minimum — this change
  does not assume Bybit returns executions in any particular order, and does not compute a candidate
  minimum from a partial page set. Bounded by a fixed page cap that fails closed, not silently, if ever
  exceeded.
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
- **New failure mode for a structurally impossible state**: this cycle's own evidence proves a fill
  (`cumulative_filled_qty > 0`) but the same observation carries no usable `avg_execution_price` —
  `internal_error`, since the wire contract requires a non-null, positive `average_entry_price` whenever
  `position_open` is `true` and this capability must never fabricate one.
- **Backward-compatible backfill for pre-existing durable records.** A record written before this change
  ships can have an already-final `early_execution_observation` showing a historical fill, with
  `first_fill_at_ms` absent (replay normalizes the missing key to `null`, mirroring
  `close_order_link_id`'s precedent). This capability still performs a fresh, one-time `/v5/execution/list`
  query in that case — even though the stored `early_execution_observation` itself needs no refresh —
  specifically to backfill `first_fill_at_ms`, so the wire invariant (`position_open: true` implies
  non-null `first_fill_at_ms`) never breaks for old data.
- **New, explicitly accepted operational risk: the execution-list endpoint's own 7-day query window.**
  Bybit's own documentation states this endpoint defaults to, and caps, a 7-day query window. A capture
  attempted more than ~7 days after the actual fill — realistically only reachable for a pre-existing
  record that goes unpolled that long after this change ships — can permanently fail to recover the raw
  timestamp, and `GET .../open-position` will return `internal_error` for that pair until it closes. See
  `design.md`'s Decision 4c for the full reasoning and why this is accepted rather than engineered around.
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
- `src/exchange/bybitAdapter.ts`: `BybitAdapter` gains `getExecutionList(payload:
  BybitGetExecutionListPayload): Promise<unknown>`, implemented in `RestBybitAdapter` via the existing
  `signedGet` helper (same pattern as every other read on this adapter) and in `StubBybitAdapter` via the
  existing `stub(...)` placeholder.
- `src/exchange/bybitOrderMapper.ts` (or `bybitAdapter.ts` directly): new `BybitGetExecutionListPayload`
  type — `{ category, symbol, orderLinkId, startTime, endTime, limit, cursor? }`.
- New file, `src/services/entryPackage/executionListResponseDecoder.ts`: `decodeExecutionListResponsePage`,
  mirroring `orderQueryResponseDecoder.ts`'s per-field validation style — validates one page's envelope and
  items (`symbol`/`category` match, `execType === "Trade"`, `execTime` a valid non-negative integer),
  deliberately does **not** re-check a per-item `orderLinkId` echo (Bybit's own documented behavior: this
  endpoint reports an empty `orderLinkId` for maker-side trades, unlike `order/realtime`/`order/history`),
  and returns the page's decoded executions plus `nextPageCursor`.
- `src/services/entryPackage/packageConfirmation.ts`: new orchestration function,
  `resolveFirstAttributableFillAtMs`, pages through `getExecutionList` to completion (bounded), decodes
  each page, and returns `min(execTime)` across every valid execution found — or a typed failure
  (`no_executions_found`, `ambiguous`).
- `src/services/openPosition/openPositionResolutionService.ts`: `determine()`'s live-query-admissible
  branch is restructured around this cycle's own attributable evidence (own-order refresh via
  `confirmEntryPackage`, reusing the same primitive Change 2's `resolveOwnExposure` already established
  for close); the aggregate query becomes conditional and its role narrows to sanity + protection's
  stop/take needs. `determine()`'s `firstFillAtMs` is a verbatim pass-through of the record's own durable
  field — it never calls `resolveFirstAttributableFillAtMs`. `resolve()` (the `GET` HTTP path only —
  `determine()` itself stays lock-free and side-effect-free, since `ProtectionApplicationService.process()`
  calls `determine()` directly while already holding the same mutex) gains a new `mutex: KeyedMutex`
  dependency and is the sole call site for `resolveFirstAttributableFillAtMs`, used only to durably
  capture `first_fill_at_ms` exactly once when this cycle's own evidence proves a fill and no value is
  captured yet.
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
