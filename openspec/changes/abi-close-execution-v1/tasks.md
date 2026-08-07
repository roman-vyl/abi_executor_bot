## 1. Correlation schema: new terminal status

- [ ] 1.1 Add `"terminal_closed"` to `EntryPackageExecutionStatus` and its `STATUSES` set in
      `entryPackageExecutionRecord.ts`. Extend `isDurablyClosedEntryPackageStatus` to include it —
      `position-scope-exclusivity`'s scope release (`applyScopeClaimOnWrite`,
      `rebuildScopeIndexFromReplay`) and `open-position-resolution`'s `classifyStatus` both already
      delegate to this one function, so no further change is needed in either for the durably-closed
      classification itself.
- [ ] 1.2 Confirm `EntryPackageCorrelationRepository`'s replay-time conflict check
      (`rebuildScopeIndexFromReplay`) treats `terminal_closed` as durably closed via 1.1, with no
      separate code path.

## 2. Entry-order neutralization

- [ ] 2.1 In `packageConfirmation.ts`, verify against Bybit's documented `orderStatus` vocabulary for
      a triggered conditional market order whether an observed partial fill can leave a live,
      order-book-resident remainder distinct from a terminal partial-fill outcome (design.md Decision
      2). Adjust or wrap the existing cancel-confirmation classification so close's neutralization
      only accepts "no live remainder" once the order's status is unambiguously terminal (fully
      filled, cleanly cancelled, or the exchange's own terminal-with-partial-fill outcome), looping
      cancel+confirm while a live remainder can still exist. Reuse the existing bounded-retry and
      query-decoding building blocks; do not introduce a parallel order-query path.
- [ ] 2.2 Add a small neutralization helper (e.g. alongside `packageConfirmation.ts`) that, given a
      record's current `order_link_id`, returns: nothing-to-do (no current order), already-non-live
      (no cancel needed), neutralized (cancel sent and confirmed non-live), or ambiguous — built from
      2.1 rather than a new confirmation architecture.

## 3. Live position read and market close

- [ ] 3.1 In the close pipeline, call `bybit.queryPositionForInstrument` directly for the pair's
      owned `(exchange_category, exchange_symbol)`, reusing `evaluatePositionQueryResponse`'s existing
      validation as-is; do not route through `OpenPositionResolutionService.determine()` (its
      side-match check is wrong for close — design.md Decision 4).
- [ ] 3.2 Wire the already-defined `executeMarketCloseOrder` (`execution.ts`) and
      `BybitMarketCloseOrderPayload`/`mapPositionSideToCloseSide` (`bybitOrderMapper.ts`) to send a
      `reduceOnly: true`, `positionIdx: 0` market order using the live query row's actual `side` and
      `size` — never `desired_entry.side` or `calculated_quantity`. Skip this call entirely when the
      live size is zero.

## 4. `CloseApplicationService`

- [ ] 4.1 Add `src/services/close/closeApplicationService.ts` implementing the pipeline: durable-
      closed shortcut → ownership re-check → entry-order neutralization (2.2) → live position read
      (3.1) → close write when size > 0 (3.2), gated by the existing live-execution guard → bounded
      re-verification of both postconditions → durable `terminal_closed` write → `trade_cycle_closed`.
      No correlation write happens before the final terminal write.
- [ ] 4.2 Reuse the existing `KeyedMutex` instance and `correlationRecordKey`, mirroring
      `ProtectionApplicationService`; do not use `scopeMutex` (design.md Decision 7).
- [ ] 4.3 On the final durable write, clear `order_link_id`/`order_id`/`desired_entry` and set
      `status: "terminal_closed"`, choosing among the existing `BindingHistoryEndReason` values (or
      leaving the current binding un-historicized, matching how a full fill is handled today) rather
      than adding a new reason, unless review of `entryPackageExecutionRecord.ts` shows no existing
      value fits — preserve `early_execution_observation` and `binding_history` rather than
      discarding them.

## 5. Entry-package guard for `terminal_closed`

- [ ] 5.1 In `EntryPackageApplicationService.handleNonNullDesiredEntry`, add the same fail-closed
      branch already used for `terminal_unfilled` when `record.status === "terminal_closed"`.
- [ ] 5.2 In `EntryPackageApplicationService.handleNullDesiredEntry`, return the existing absent
      acknowledgement for a `terminal_closed` record without calling `persistTransitionToAbsent` or
      `cancelLiveOrder` (design.md Decision 5's null-desired-entry consequence).

## 6. Wiring

- [ ] 6.1 Add a `CloseApplicationServicePort` to `positionManagementRoutes.ts`, mirroring
      `ProtectionApplicationServicePort`, and thread it through `handlePositionManagementRoutes` and
      `handleClose`.
- [ ] 6.2 Construct `CloseApplicationService` in `app/server.ts` and pass it into
      `handlePositionManagementRoutes`, alongside the existing `protectionApplicationService`.

## 7. Tests

- [ ] 7.1 `CloseApplicationService` unit tests covering: unknown pair; already `terminal_closed` pair
      (no exchange write); ownership mismatch; unsupported scope; live unfilled entry order cancelled
      and confirmed non-live before the position query runs; partially filled entry order — remainder
      neutralized before close proceeds; cancel ambiguity blocks the whole close with no market-close
      sent; position already zero sends no market-close; an unexpected live position side is still
      closed using the actual side; close quantity equals the actual live remainder, not
      `calculated_quantity`; live-execution guard disabled on either the cancel or the close write;
      market-close write failure; bounded position confirmation succeeding only on a later attempt;
      confirmation exhaustion without a match; final pre-terminalization check failing when the entry
      order is not confirmed non-live even though the position reads zero; no scope release observable
      before the durable terminal write; scope release observable once the durable write completes.
- [ ] 7.2 `position-scope-exclusivity`-facing tests: a new entry request for a `terminal_closed` pair's
      former scope succeeds once that scope is released; replay reconstructs `terminal_closed` as
      durably closed and releases the scope on restart.
- [ ] 7.3 `entry-package-execution`-facing tests: a non-null `desired_entry` request against a
      `terminal_closed` pair fails closed without creating an order; a null `desired_entry` request
      against a `terminal_closed` pair acknowledges absence without altering the record.
- [ ] 7.4 `open-position-resolution`-facing test: `GET .../open-position` for a `terminal_closed` pair
      returns `position_open: false` without querying the exchange.
- [ ] 7.5 Idempotency tests: a repeated `DELETE` after `terminal_closed` performs no exchange write and
      returns `trade_cycle_closed`; a repeated `DELETE` mid-close does not resend a cancel or close
      order for a fact already confirmed true.
- [ ] 7.6 Concurrency tests: a close command and a concurrent entry-package or protection command for
      the same pair never interleave; close commands for different pairs proceed independently.
- [ ] 7.7 Update `positionManagementRoutes.test.ts`'s close stub-behavior test to exercise the real
      (fake-backed) service path.

## 8. Verification

- [ ] 8.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 8.2 Run the repo's existing OpenAPI validation for `docs/openapi/abi-position-management-api-v1.json`
      and confirm it is unchanged (no public contract change in this OpenSpec).
- [ ] 8.3 Run `git diff --check`.
- [ ] 8.4 Review the diff: no new public DTO, route, or error code; no account-wide/symbol-wide cancel
      call anywhere in the new code path; the durable `terminal_closed` write is the only place scope
      release can occur for a close request.

## Deferred follow-up (not this change's scope)

- Any shared/virtual scope ownership.
- Partial close, or any Runtime-supplied close quantity.
- Webhook- or polling-driven detection of an externally closed position outside a close request.
