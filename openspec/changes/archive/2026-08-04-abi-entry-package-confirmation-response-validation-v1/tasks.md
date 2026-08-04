## 1. Decoder module

- [x] 1.1 Create `src/services/entryPackage/orderQueryResponseDecoder.ts` with
      `BybitOrderView`, `DecodedOrderQuery`, and `OrderQueryProtocolFailureReason`
      types as specified in design.md.
- [x] 1.2 Implement `decodeOrderQueryResponse({ response, expected: { category,
      symbol, orderLinkId } })`:
      - envelope/`result`/`category` checks → `malformed_envelope` /
        `category_mismatch`
      - `list` not array → `list_not_array`; empty array → `not_found`
      - `list.length > 1` → `multiple_rows_returned`
      - non-object row → `malformed_item`
      - `symbol`/`orderLinkId` mismatch → `symbol_mismatch` /
        `order_link_id_mismatch`
      - empty `orderStatus` → `invalid_order_status`; any non-empty string →
        accepted (unknown values included)
      - `qty`: empty or positive exact-decimal; `"0"` or negative →
        `invalid_qty`
      - `cumExecQty`: empty or non-negative exact-decimal; negative →
        `invalid_cumulative_filled_qty`
      - `triggerPrice`: empty or non-negative exact-decimal; negative →
        `invalid_trigger_price`
      - `stopLoss`: empty or non-negative exact-decimal; negative →
        `invalid_stop_loss`
      - `takeProfit`: empty or non-negative exact-decimal; negative →
        `invalid_take_profit`
      - `avgPrice`: empty or positive exact-decimal; `"0"` or negative →
        `invalid_average_price`
      - malformed decimal text or out-of-range exponent on any of the above →
        that field's `invalid_*` reason
      - all checks pass with exactly one row → `{ kind: "found", item }`
- [x] 1.3 Unit tests covering the full pure decoder matrix: valid empty list,
      valid one matching row, missing/non-object result, missing/non-array
      list, list not array, multiple rows, null/scalar row, category
      mismatch, symbol mismatch, orderLinkId mismatch, unknown non-empty
      `orderStatus` → found.
- [x] 1.4 Unit tests for the numeric validation matrix, at minimum: negative
      `qty`, zero `qty`, negative `cumExecQty`, zero `cumExecQty` (allowed —
      assert it decodes as `found`), negative `triggerPrice`, zero
      `triggerPrice` (allowed), negative `stopLoss`, zero `stopLoss`
      (allowed), negative `takeProfit`, zero `takeProfit` (allowed), negative
      `avgPrice`, zero `avgPrice`, malformed decimal text, malformed/
      out-of-range exponent.

## 2. Wire into packageConfirmation.ts

- [x] 2.1 Rewrite `queryOrderView()` in
      `src/services/entryPackage/packageConfirmation.ts` to accept an
      `expected: { category, symbol, orderLinkId }` (or equivalent payload)
      alongside the query callback, call `decodeOrderQueryResponse()` with
      it, mapping `found`/`not_found` through unchanged and
      `protocol_failure` to `{ status: "query_failed" }`.
- [x] 2.2 Update `queryOrderView()`'s two call sites in `confirmEntryPackage`
      and `confirmEntryPackageCancelled` to pass the expected identity from
      `getEntryOrderPayload`/`getEntryOrderHistoryPayload` (both already
      carry `category`/`symbol`/`orderLinkId`).
- [x] 2.3 Delete `readOrderViewFromBybitList()` and the now-unused
      `BybitOrderView` type in `packageConfirmation.ts` (import the type from
      the new decoder module instead).
- [x] 2.4 In `confirmEntryPackage`'s realtime-handling branch, set
      `sawInconclusiveFinding = true` whenever `realtime.status === "found"`
      and none of the `pending_confirmed`/`full_fill`/`partial_fill` return
      paths was taken (covers both an unrecognized `orderStatus` and a
      terminal-without-fill status falling through to history) — see
      design.md's "Unknown/terminal order status semantics" correction. Do
      not change any other branch, the retry loop shape, attempt count, or
      delay.
- [x] 2.5 Confirm `confirmEntryPackageCancelled` and all shared helpers
      (`fieldsMatch`, `fillFieldsPlausible`, `hasFill`,
      `confirmsAbsenceOrTerminal`, `toObservation`, `decimalEquals`) are
      untouched beyond the call-site change in 2.2.

## 3. Confirmation-behavior regression tests

- [x] 3.1 Add tests in the existing `packageConfirmation` test suite:
      - malformed realtime + valid empty history → `ambiguous`, not
        `not_found`
      - valid empty realtime + malformed history → `ambiguous`, not
        `not_found`
      - malformed response during cancel confirmation → `ambiguous`, not
        `cancelled_confirmed`
      - valid empty realtime + valid empty history for the whole retry
        budget → `not_found` / `cancelled_confirmed` per existing rules
        (regression guard that the fix didn't break the legitimate-absence
        path)
- [x] 3.2 Add tests for the unknown/terminal-status correction:
      - unrecognized realtime `orderStatus` + clean empty history for the
        whole retry budget → `ambiguous`
      - terminal-without-fill realtime `orderStatus` + clean empty history
        for the whole retry budget → `ambiguous`, not `not_found`
      - unrecognized realtime `orderStatus` + history resolves
        `terminal_without_fill` → `terminal_without_fill`
      - unrecognized realtime `orderStatus` during cancel confirmation →
        `ambiguous`, not `cancelled_confirmed`

## 4. Application-service safety regression tests

- [x] 4.1 Add/extend `EntryPackageApplicationService` tests: malformed
      confirmation on create/amend → HTTP 500 `internal_error`, record status
      `unknown`, `pending_action` preserved, `entry_package_applied` not
      returned.
- [x] 4.2 Add a test for a repeat PUT after a malformed confirmation: the
      command is not resent to the exchange solely because the prior
      confirmation was malformed (only a cleanly-absent query result permits
      resend, per the existing "not_found" gate).
- [x] 4.3 Add a test for cancel confirmation with a malformed response:
      `entry_package_absent` is not returned, the record does not become
      absent, and state remains unresolved/`unknown`.

## 5. Verification

- [x] 5.1 Run `npm test`.
- [x] 5.2 Run `npm run typecheck`.
