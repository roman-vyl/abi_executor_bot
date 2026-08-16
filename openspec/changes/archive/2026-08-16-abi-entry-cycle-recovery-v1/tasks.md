## 1. Remove in-place amend and atomic cancel-and-create

- [x] 1.1 Remove `replaceAmend` from `entryPackageApplicationService.ts`; repoint the
      changed-non-null-desired-entry branch of `handleNonNullDesiredEntry` to call the
      CANCEL path instead (cancel, confirm, return `entry_package_absent`; never create).
- [x] 1.2 Remove `replaceCancelAndCreate` and the `pending_action: "cancel_and_create"`
      dispatch branch in `resendPendingAction`.
- [x] 1.3 Remove `amendEntryOrder` from `execution.ts` and `amendOrder` from
      `bybitAdapter.ts` (both become unused).
- [x] 1.4 Remove or update any test fixtures/mocks that stub the removed amend/BybitAdapter
      surface.

## 2. Fix `cancelLiveOrder` ambiguity handling

- [x] 2.1 In `cancelLiveOrder`'s transport-exception catch block, durably record
      `status: "unknown"` (preserving `pending_action: "cancel"`) before returning a safe
      error, matching `createOrder`'s catch block.
- [x] 2.2 Add preflight revalidation to `handleNullDesiredEntry`: before dispatching into
      `cancelLiveOrder` for a binding whose status is not already `absent` or
      `terminal_unfilled`, query current exchange state (reuse
      `classifyEntryOrderTerminality`/`confirmEntryOrderNeutralized` from
      `close-execution`) and resend cancel only if the order is confirmed still live;
      record the confirmed outcome without resending if already terminal; record
      `unknown` without resending if the query is inconclusive.

## 3. New `entry-cycle-recovery-resolution` domain service

- [x] 3.1 Implement the four-state classification (`entry_order_live`, `position_open`,
      `terminal_without_fill`, `terminal_after_fill`) as a new composition of the existing
      order-history fill-priority classification (`confirmEntryPackage`'s
      constants/priority) and `queryPositionForInstrument`, following
      `CloseApplicationService.verifyBothPostconditions`'s bounded dual-query pattern. No
      time-based gate of any kind.
- [x] 3.2 `terminal_without_fill`/`terminal_after_fill` require positive evidence
      (a definitively observed terminal-without-fill status with zero cumulative filled
      quantity, or a definitively observed fill) — never inferred from an empty or
      unavailable realtime/history/position query. A clean-but-empty result everywhere
      (no live order, no history match, no open position) returns the same safe-error
      response already used for a genuine query failure, not `terminal_without_fill`.
- [x] 3.3 Implement dual-positive-confirmation resolution: `position_open`,
      `terminal_after_fill`, and `terminal_without_fill` all require the order query's
      finding AND the position query's confirmation to positively agree (never resolved
      from either signal alone, including a `PartiallyFilled` order by itself, and never
      from a position query that merely fails to contradict rather than positively
      confirming flat). Any contradictory or incomplete combination (e.g. fill observed +
      order still live + position flat; zero-fill terminal order + position query reports
      open; zero-fill terminal order + inconclusive/failed position query) fails safe
      rather than resolving any state.
- [x] 3.4 Use the same bounded realtime-plus-history query pattern
      `confirmEntryPackage` already uses; no special `startTime`/`endTime` windowing is
      introduced by this change.
- [x] 3.5 Include the correlation record's `desired_entry` + `calculated_quantity` as
      `AppliedEntryPackage` in the response for `entry_order_live`/`position_open`; omit
      it for the other two states.
- [x] 3.6 Missing correlation record for the requested pair returns `422
      unknown_trade_cycle_binding` — a fail-closed ownership mismatch, never treated as
      or documented as equivalent to `terminal_without_fill`.

## 4. New `abi-entry-cycle-recovery-api` HTTP endpoint

- [x] 4.1 Add `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/recovery-state`,
      routed alongside `openPositionRoutes.ts`, delegating to the new resolution service.
- [x] 4.2 Apply the same opaque-path-parameter handling (percent-decoding, non-empty
      validation, `422 validation_failed`) already used by the open-position lookup
      route.
- [x] 4.3 Add the OpenAPI document for the new endpoint under `docs/openapi/`.

## 5. Regression coverage

- [x] 5.1 Cancel-only replace: a changed non-null `desired_entry` against an existing
      binding cancels and returns `entry_package_absent`, and never creates a second
      order.
- [x] 5.2 `cancelLiveOrder` transport failure records `status: "unknown"`.
- [x] 5.3 Repeat cancel-intent PUT against a still-live order resends cancel only after
      confirming liveness; against an already-terminal order, records the outcome without
      resending; against an inconclusive query, records `unknown` without resending.
- [x] 5.4 Recovery-state resolution: each of the four states from agreeing dual evidence,
      including a `PartiallyFilled` order confirmed by an open position resolving
      `position_open`.
- [x] 5.5 Recovery-state resolution: a clean-but-empty result everywhere (no live order,
      no history match, no position) returns the safe-error response, never
      `terminal_without_fill` — this is the central regression test for the
      absence-of-evidence rule.
- [x] 5.6 Recovery-state resolution: contradictory or incomplete evidence fails safe —
      (a) fill observed on a still-live/`PartiallyFilled` order but position query
      reports flat; (b) zero-fill terminal order but position query reports open; (c)
      zero-fill terminal order but position query fails/times out/is inconclusive. None
      of these resolves any `recovery_state`.
- [x] 5.7 Missing correlation record returns `422 unknown_trade_cycle_binding`, and this
      response is never treated as, or asserted to be equivalent to,
      `terminal_without_fill` anywhere in the resolution or route layer.
- [x] 5.8 `AppliedEntryPackage` is present only for `entry_order_live`/`position_open`.

## 6. Verification

- [x] 6.1 Run `npm test`, `npm run typecheck`, and the OpenAPI verification command.
- [x] 6.2 Run strict OpenSpec validation (`npm exec -- openspec validate --all --strict`).

## 7. Fix: durable-status short-circuit (post-implementation correctness fix)

A lost `EntryPackageAbsent`/terminal HTTP response after a positively confirmed cancel or
terminal outcome left the pair permanently unrecoverable, since the same write that
confirms it also clears `order_link_id` to `null`, and `order_link_id === null` was
unconditionally fail-safe. See design.md Decision 6.

- [x] 7.1 In `EntryCycleRecoveryResolutionService.process`, check
      `isDurablyClosedEntryPackageStatus(record.status)` before the `order_link_id`-null
      check and before any exchange query: `absent`/`terminal_unfilled` resolve
      `terminal_without_fill`; `terminal_closed` resolves `terminal_after_fill`. No
      exchange query is issued for this path.
- [x] 7.2 Every other status (including a null `order_link_id` on a non-durably-closed
      status) proceeds to the existing `order_link_id`/dual-query resolution unchanged.
- [x] 7.3 Regression coverage: `absent`, `terminal_unfilled`, and `terminal_closed` each
      resolve their matching state with zero Bybit queries; a null `order_link_id` on a
      non-durably-closed status still fails safe; a cross-service integration regression
      proves a lost `EntryPackageAbsent` response from a real confirmed cancel remains
      recoverable via a later, independent recovery-state query against the same durable
      file.
