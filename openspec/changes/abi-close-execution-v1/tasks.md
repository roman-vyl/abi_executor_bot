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

## 2. Entry-order neutralization (design.md Decision 2)

- [ ] 2.1 Add a close-specific neutralization classification, built from `packageConfirmation.ts`'s
      existing query/decode/bounded-retry building blocks, that determines "no live remainder" from
      the order's own terminal-vs-live status — treating `FILLED_STATUSES` and
      `TERMINAL_WITHOUT_FILL_STATUSES` as non-live regardless of executed quantity, and
      `LIVE_UNFILLED_STATUSES`/`PARTIAL_FILL_STATUSES` as still live, requiring a cancel-and-recheck
      loop. Do not change `confirmEntryPackageCancelled`'s existing behavior or its callers — it
      remains correct for entry-package's own null-desired-entry (CANCEL) flow, which must keep
      treating any observed fill as evidence it cannot safely confirm absence.
- [ ] 2.2 Add a small neutralization helper (e.g. alongside `packageConfirmation.ts`) that, given a
      record's current `order_link_id`, returns: already-non-live (no cancel needed), neutralized
      (cancel sent and confirmed terminal per 2.1), or ambiguous. A record reaching this step with no
      `order_link_id` is not handled here — it fails earlier as contradictory correlation (4.1).

## 3. Live position read and market close

- [ ] 3.1 In the close pipeline, call `bybit.queryPositionForInstrument` directly for the pair's
      owned `(exchange_category, exchange_symbol)`, reusing `evaluatePositionQueryResponse`'s existing
      validation as-is; do not route through `OpenPositionResolutionService.determine()` (its
      side-match check and status-bucket classification are wrong for close — design.md Decision 4).
- [ ] 3.2 Wire the already-defined `executeMarketCloseOrder` (`execution.ts`) and
      `BybitMarketCloseOrderPayload`/`mapPositionSideToCloseSide` (`bybitOrderMapper.ts`) to send a
      `reduceOnly: true`, `positionIdx: 0` market order using the live query row's actual `side` and
      `size` — never `desired_entry.side` or `calculated_quantity`. Skip this call entirely when the
      live size is zero.

## 4. `CloseApplicationService`

- [ ] 4.1 Add `src/services/close/closeApplicationService.ts` implementing three paths from pair
      classification (design.md Decision 6):
      - already `terminal_closed` → return `trade_cycle_closed` directly, no write, no exchange call.
      - `absent` or `terminal_unfilled` → durably write `status: "terminal_closed"` (no exchange call
        needed — both postconditions already durably hold), then return `trade_cycle_closed`. Both
        statuses get identical treatment; neither is a no-write shortcut.
      - every other status → ownership re-check → a record with no `order_link_id` fails as
        contradictory correlation (`internal_error`, design.md Decision 5) → entry-order
        neutralization (2.2) → live position read (3.1) → close write when size > 0 (3.2), gated by
        the existing live-execution guard → bounded re-verification of both postconditions → durable
        `terminal_closed` write → `trade_cycle_closed`.
      No correlation write happens before either terminal write above.
- [ ] 4.2 Reuse the existing `KeyedMutex` instance and `correlationRecordKey`, mirroring
      `ProtectionApplicationService`; do not use `scopeMutex` (design.md Decision 8). Introduce no new
      lock that serializes across different pairs.
- [ ] 4.3 On the terminal write (either path), set `status: "terminal_closed"` and clear
      `pending_action`. Do NOT clear `order_link_id`, `order_id`, `desired_entry`, or
      `calculated_quantity` — `terminal_closed` alone is sufficient to block resurrection (5.1), so
      there is no need to destroy the last binding's provenance. If a later change does need to clear
      the current binding's identity fields, it MUST first append a `binding_history` entry for it
      using an existing `end_reason` that matches how the binding actually ended (`cancelled` for a
      confirmed cancel, `exchange_terminal` for a fill/exchange-terminal outcome) — never clear
      identity fields without historicizing them first.

## 5. Entry-package guard for `terminal_closed`

- [ ] 5.1 In `EntryPackageApplicationService.handleNonNullDesiredEntry`, add the same fail-closed
      branch already used for `terminal_unfilled` when `record.status === "terminal_closed"`.
- [ ] 5.2 In `EntryPackageApplicationService.handleNullDesiredEntry`, return the existing absent
      acknowledgement for a `terminal_closed` record without calling `persistTransitionToAbsent` or
      `cancelLiveOrder` — required regardless of whether 4.3 leaves `order_link_id` non-null (design.md
      Decision 6's null-desired-entry consequence).

## 6. Wiring

- [ ] 6.1 Add a `CloseApplicationServicePort` to `positionManagementRoutes.ts`, mirroring
      `ProtectionApplicationServicePort`, and thread it through `handlePositionManagementRoutes` and
      `handleClose`.
- [ ] 6.2 Construct `CloseApplicationService` in `app/server.ts` and pass it into
      `handlePositionManagementRoutes`, alongside the existing `protectionApplicationService`.

## 7. Tests

- [ ] 7.1 `CloseApplicationService` unit tests covering: unknown pair; already `terminal_closed` pair
      (no exchange write, no further write); an `absent` pair is durably promoted to `terminal_closed`
      before `trade_cycle_closed` is returned, with no exchange call; a `terminal_unfilled` pair is
      durably promoted to `terminal_closed` before `trade_cycle_closed` is returned, with no exchange
      call; ownership mismatch; unsupported scope; a non-durably-closed record with no `order_link_id`
      fails as contradictory correlation before any exchange call; live unfilled entry order cancelled
      and confirmed non-live before the position query runs; a cancelled order with nonzero executed
      quantity is still treated as neutralized (design.md Decision 2); a still-live partially-filled
      order is not treated as neutralized merely because a fill was observed; cancel ambiguity blocks
      the whole close with no market-close sent; position already zero sends no market-close; an
      unexpected live position side is still closed using the actual side; close quantity equals the
      actual live remainder, not `calculated_quantity`; live-execution guard disabled on either the
      cancel or the close write; market-close write failure; bounded position confirmation succeeding
      only on a later attempt; confirmation exhaustion without a match; final pre-terminalization check
      failing when the entry order is not confirmed non-live even though the position reads zero; no
      scope release observable before any of the three terminal-write paths; scope release observable
      once any of them completes.
- [ ] 7.2 `position-scope-exclusivity`-facing tests: a new entry request for a former `terminal_closed`
      pair's scope succeeds once that scope is released; replay reconstructs `terminal_closed` as
      durably closed and releases the scope on restart.
- [ ] 7.3 `entry-package-execution`-facing tests: a non-null `desired_entry` request against a
      `terminal_closed` pair fails closed without creating an order; a null `desired_entry` request
      against a `terminal_closed` pair acknowledges absence without altering the record; a non-null
      `desired_entry` request against a pair that was `absent` and then closed via `DELETE` fails
      closed the same way; a non-null `desired_entry` request against a pair that was `terminal_unfilled`
      and then closed via `DELETE` fails closed the same way — this is the specific resurrection chain
      (`terminal_unfilled` → stale null PUT → `absent` → stale non-null PUT → new generation)
      design.md Decision 6 exists to break.
- [ ] 7.4 `open-position-resolution`-facing test: `GET .../open-position` for a `terminal_closed` pair
      returns `position_open: false` without querying the exchange.
- [ ] 7.5 Idempotency tests: a repeated `DELETE` after `terminal_closed` — reached via the full
      pipeline, the `absent` promotion, or the `terminal_unfilled` promotion — performs no exchange
      write and no further correlation write, and returns `trade_cycle_closed`; a repeated `DELETE`
      mid-close does not resend a cancel or close order for a fact already confirmed true.
- [ ] 7.6 Concurrency tests: a close command and a concurrent entry-package or protection command for
      the same pair never interleave; close commands for two different pairs are not serialized by any
      lock this capability introduces or reuses (do not assert full global concurrency, since the
      correlation store's own single-writer append ordering is pre-existing and out of scope here).
- [ ] 7.7 Update `positionManagementRoutes.test.ts`'s close stub-behavior test to exercise the real
      (fake-backed) service path.

## 8. Verification

- [ ] 8.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 8.2 Run the repo's existing OpenAPI validation for `docs/openapi/abi-position-management-api-v1.json`
      and confirm it is unchanged (no public contract change in this OpenSpec).
- [ ] 8.3 Run `git diff --check`.
- [ ] 8.4 Review the diff: no new public DTO, route, or error code; no account-wide/symbol-wide cancel
      call anywhere in the new code path; the three terminal-write paths (full pipeline, `absent`
      promotion, `terminal_unfilled` promotion) are the only places scope release can occur for a close
      request; no identity field is cleared without a corresponding `binding_history` entry.

## Deferred follow-up (not this change's scope)

- Any shared/virtual scope ownership.
- Partial close, or any Runtime-supplied close quantity.
- Webhook- or polling-driven detection of an externally closed position outside a close request.
