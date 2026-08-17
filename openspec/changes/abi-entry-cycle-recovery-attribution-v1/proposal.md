## Why

`docs/virtual-exposure-ownership-delivery-plan.md` names this change, Change 4, as the third consumer to
build on `abi-virtual-exposure-state-foundation-v1` (Change 1, applied/archived), applying the same
attributable-evidence pattern Change 2 (close) and Change 3 (open-position) already proved: own-cycle
evidence is the source of per-cycle facts, the shared aggregate physical position is weak sanity only,
never a source of a per-cycle fact.

`EntryCycleRecoveryResolutionService` (`entryCycleRecoveryResolutionService.ts:212-238`,
`resolveRecoveryState`) resolves `position_open` only once both an order-query signal and the aggregate
position query positively agree — and, when they do, sources the response's `first_fill_at_ms` and
`average_entry_price` directly from the aggregate row: `{ firstFillAtMs: row.openTime, averageEntryPrice:
row.avgPrice }` (line 226). This is the exact sourcing bug Change 3 already fixed for
`GET .../open-position`'s `determine()` — a shared aggregate physical position has only one `openTime`/
`avgPrice` for the whole scope, so once same-side ownership activation (a later change in this program)
lets more than one trade cycle share a scope, there is no way for two owners to each read "their own"
first-fill time or average price from the same row. The order-query side of the dual-query rule is
already correctly own-cycle-scoped (it queries `getOrderByLinkId`/`getOrderHistory` filtered to this
record's own `order_link_id`) — the sourcing bug is isolated to how `position_open`'s two fill facts are
extracted, not to which state gets resolved.

This proposal fixes only that sourcing: `average_entry_price` is redirected to the same own-order query
response recovery already fetches every attempt (its `avgPrice` field is decoded and currently discarded
after classification), and `first_fill_at_ms` reuses Change 3's exact durable-capture-once mechanism
(`resolveFirstAttributableFillAtMs`, the same correlation-record field, the same per-pair mutex) instead
of a second implementation. The dual-query state-resolution grid itself (`entry_order_live` /
`position_open` / `terminal_without_fill` / `terminal_after_fill`, and every existing fail-closed
combination) is unchanged — see "What Changes" for why that grid was never actually broken by shared
scope.

### Resolving this change's one open design question: does reusing Change 3's durable-capture mechanism violate "Recovery resolution never causes an exchange side effect"?

The canonical spec's last requirement states recovery "SHALL be read-only with respect to the exchange"
and "SHALL NOT cancel, amend, or create any order." Read literally and in full, this requirement was
always scoped to order-mutating actions — its own scenario says exactly that: "ABI SHALL NOT send any
create, amend, or cancel request to the exchange." It says nothing about read-only `GET` queries (recovery
already issues two of them, `getOrderByLinkId`/`getOrderHistory` and `queryPositionForInstrument`, on
every attempt) or about ABI's own local durable write (recovery already implicitly relies on ABI's own
prior durable writes — the entire durably-closed-status fast path is built on trusting ABI's own past
writes). `resolveFirstAttributableFillAtMs` (Change 3) is a read-only `GET
/v5/execution/list` call; the durable capture that follows is a local write to ABI's own correlation
store, not a request to the exchange. Reusing it introduces no new exchange write and no new class of
side effect recovery does not already have. This proposal adds one explicit new scenario to the
"never causes an exchange side effect" requirement, stating this clarification directly, so it is no
longer an implicit reading — see the spec delta.

## What Changes

- **`average_entry_price` for `position_open` is sourced from the own-order query response recovery
  already fetches, never the aggregate `row.avgPrice`.** `OrderRecoverySignal`'s `live_with_fill` and
  `terminal_with_fill` variants (`classifyOrderForRecovery`) gain an `averageEntryPrice: string` field,
  populated from the already-decoded `BybitOrderView.avgPrice` of whichever query (realtime or history)
  positively found the order — zero new exchange calls, since this data is already fetched every attempt
  for classification and simply discarded today. `resolveRecoveryState`'s `position_open` branch reads
  this value instead of `row.avgPrice`.
- **`first_fill_at_ms` for `position_open` reuses Change 3's exact durable-capture-once mechanism, not a
  second implementation.** When `resolveRecoveryState` resolves `position_open`: if the record's own
  `first_fill_at_ms` is already durable (non-null), it is reused with no exchange call, identical to
  `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing fast path. If not yet captured,
  `EntryCycleRecoveryResolutionService` calls the same exported `resolveFirstAttributableFillAtMs`
  (`packageConfirmation.ts`, unchanged) and durably saves the result exactly as Change 3 already does —
  under the same shared per-pair `KeyedMutex` instance already passed into
  `OpenPositionResolutionService`/`ProtectionApplicationService`/`CloseApplicationService`, so a
  concurrent `GET .../open-position` and `GET .../recovery-state` for the same pair can never race to
  durably write two different values into the same field. `EntryCycleRecoveryResolutionServiceDeps` gains
  a new `mutex: KeyedMutex` dependency. A capture failure (`no_executions_found` or `ambiguous`) fails
  closed (`internal_error`) — `position_open` is never resolved with a fabricated or omitted
  `first_fill_at_ms`, consistent with this capability's existing "absence of evidence is never evidence of
  absence" rule and with `entryCycleRecoveryApi.ts`'s existing strict non-null/positive-integer validation
  for this field.
- **The dual-query state-resolution grid (`resolveRecoveryState`) is unchanged.** The order-query signal
  was already own-cycle-scoped (filtered by this record's own `order_link_id`); shared scope never broke
  which of the four states gets resolved, or under what conditions each fails closed. What was broken was
  narrowly the two fields extracted from the aggregate row inside the already-correct `position_open`
  branch. The aggregate position query keeps its existing role for `entry_order_live` /
  `terminal_without_fill` / `terminal_after_fill` unchanged — it is not further weakened, and no new
  fail-closed combination is introduced beyond the capture-failure case above.
- **No change to `entryCycleRecoveryApi.ts`.** `positionOpenResult()`'s existing strict validation
  (`firstFillAtMs` a positive integer, `averageEntryPrice` a positive exact-decimal string, both
  non-null) already enforces exactly the invariant this change's sourcing now correctly satisfies.
- **No change to the legacy `pending_action` guard, the durably-closed-status fast path, or any other
  existing requirement of this capability.**

## Capabilities

### Modified Capabilities

- `entry-cycle-recovery-resolution`: `position_open`'s `first_fill_at_ms` and `average_entry_price` are
  resourced from this cycle's own attributable evidence (the own-order query response already fetched,
  and Change 3's durable `first_fill_at_ms` capture mechanism) instead of the aggregate position row. The
  "never causes an exchange side effect" requirement gains an explicit clarifying scenario distinguishing
  read-only exchange queries and ABI's own local durable writes from the order-mutating actions it
  actually prohibits.

## Impact

- `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`: `OrderRecoverySignal`'s
  `live_with_fill`/`terminal_with_fill` variants gain `averageEntryPrice: string`, populated in
  `classifyOrderForRecovery` from the already-decoded `BybitOrderView.avgPrice`. `resolveRecoveryState`'s
  `position_open` branch is restructured to source `averageEntryPrice` from the order signal and
  `firstFillAtMs` from the durable-capture-or-reuse path described above, instead of `row.openTime`/
  `row.avgPrice`. `EntryCycleRecoveryResolutionServiceDeps` gains `mutex: KeyedMutex`. The durable-capture
  block itself (reuse-if-present, capture-and-save-if-absent-under-mutex, fail-closed-on-capture-failure)
  mirrors `OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing block; no new adapter
  primitive, decoder, or orchestration function is added — `resolveFirstAttributableFillAtMs` is imported
  from `packageConfirmation.ts` unchanged.
- `src/app/server.ts`: `EntryCycleRecoveryResolutionService`'s construction gains the existing shared
  `mutex` instance (the same one `EntryPackageApplicationService`/`OpenPositionResolutionService`/
  `ProtectionApplicationService`/`CloseApplicationService` already use) as a new dependency.
- `openspec/specs/entry-cycle-recovery-resolution/spec.md`: `position_open`'s fact-sourcing requirement
  (currently embedded in "Recovery resolution classifies the trade cycle into exactly one of four
  states...", scenario "A fill confirmed by an open position resolves to position_open") is clarified to
  state the own-order/durable-capture sourcing; the "never causes an exchange side effect" requirement
  gains one new scenario clarifying read-only queries and local durable writes are not exchange side
  effects.
- No HTTP contract change. `GET .../strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/recovery-state`'s
  request and response shapes, status codes, and error codes are unchanged.
- `src/domain/entryCycleRecoveryApi.ts`: not touched — its existing validation already enforces the
  invariant this change's corrected sourcing satisfies.
- `src/correlation/entryPackageExecutionRecord.ts`, `entryPackageCorrelationRepository.ts`: not touched —
  `first_fill_at_ms`'s field definition, validator, and immutability check already exist from Change 3;
  this change adds a second reader/writer of the same existing field and mechanism, not a new one.
- `src/services/openPosition/openPositionResolutionService.ts`,
  `src/services/entryPackage/packageConfirmation.ts`: not touched — `resolveFirstAttributableFillAtMs` is
  reused verbatim, exported already, called from a second call site under the same mutex discipline.
- Production behavior: for a scope's only owner (today's only production-reachable state),
  `position_open`'s `average_entry_price` and `first_fill_at_ms` become byte-for-byte identical to what
  `GET .../open-position` already reports for the same pair at the same moment (both now source from the
  same own-cycle evidence and the same durable field) — see `design.md`'s regression analysis for the one
  case where recovery's value can differ transiently from what the aggregate previously reported, and why
  that is a fix, not a regression.
