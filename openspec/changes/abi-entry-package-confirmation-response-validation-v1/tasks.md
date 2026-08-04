## 1. Decoder module

- [ ] 1.1 Create `src/services/entryPackage/orderQueryResponseDecoder.ts` with
      `BybitOrderView`, `DecodedOrderQuery`, and `OrderQueryProtocolFailureReason`
      types as specified in design.md.
- [ ] 1.2 Implement `decodeOrderQueryResponse({ response, expectedCategory,
      expectedSymbol, expectedOrderLinkId })`:
      - envelope/`result`/`category` checks → `malformed_envelope` /
        `category_mismatch`
      - `list` not array → `list_not_array`; empty array → `not_found`
      - `list.length > 1` → `multiple_rows_returned`
      - non-object row → `malformed_item`
      - `symbol`/`orderLinkId` mismatch → `symbol_mismatch` /
        `order_link_id_mismatch`
      - empty `orderStatus` → `invalid_order_status`; non-empty string of any
        value → accepted
      - `qty`/`cumExecQty`/`triggerPrice`/`stopLoss`/`takeProfit`/`avgPrice`
        validated as empty-or-exact-decimal (non-negative; `avgPrice`
        positive-or-empty) using the existing `exactDecimal` helpers → the
        matching `invalid_*` reason on failure
      - all checks pass with exactly one row → `{ kind: "found", item }`
- [ ] 1.3 Unit tests covering the full pure decoder matrix from proposal.md
      ("Pure decoder matrix" list): valid empty list, valid one row, missing
      result, missing list, list not array, multiple rows, null/scalar row,
      category mismatch, symbol mismatch, orderLinkId mismatch, each malformed
      decimal field individually, unknown non-empty `orderStatus`.

## 2. Wire into packageConfirmation.ts

- [ ] 2.1 Rewrite `queryOrderView()` in
      `src/services/entryPackage/packageConfirmation.ts` to call
      `decodeOrderQueryResponse()` with `expectedCategory`/`expectedSymbol`/
      `expectedOrderLinkId` sourced from the payload passed to the query
      (`getEntryOrderPayload/getEntryOrderHistoryPayload` already carry
      `category`/`symbol`/`orderLinkId`), mapping `found`/`not_found` through
      unchanged and `protocol_failure` to `{ status: "query_failed" }`.
- [ ] 2.2 Delete `readOrderViewFromBybitList()` and the now-unused
      `BybitOrderView` type in `packageConfirmation.ts` (import the type from
      the new decoder module instead).
- [ ] 2.3 Confirm `confirmEntryPackage`, `confirmEntryPackageCancelled`, and
      all their helper functions are untouched (no edits beyond the
      `queryOrderView` body and the type import).

## 3. Confirmation-behavior regression tests

- [ ] 3.1 Add tests in the existing `packageConfirmation` test suite for the
      "Confirmation behavior" matrix from proposal.md:
      - malformed realtime + valid empty history → `ambiguous`, not `not_found`
      - valid empty realtime + malformed history → `ambiguous`, not `not_found`
      - malformed response during cancel confirmation → `ambiguous`, not
        `cancelled_confirmed`
      - valid empty realtime + valid empty history for the whole retry budget
        → `not_found` / `cancelled_confirmed` per existing rules (regression
        guard that the fix didn't break the legitimate-absence path)

## 4. Application-service safety regression tests

- [ ] 4.1 Add/extend `EntryPackageApplicationService` tests: malformed
      confirmation on create/amend → HTTP 500 `internal_error`, record status
      `unknown`, `pending_action` preserved, no success acknowledgement.
- [ ] 4.2 Add a test for a repeat PUT after a malformed confirmation: the
      command is not resent to the exchange solely because the prior
      confirmation was malformed (only a cleanly-absent query result permits
      resend, per the existing "not_found" gate).
- [ ] 4.3 Add a test for cancel confirmation with a malformed response:
      `entry_package_absent` is not returned, the record does not become
      absent, and state remains unresolved/`unknown`.

## 5. Verification

- [ ] 5.1 Run `npm test`.
- [ ] 5.2 Run `npm run typecheck`.
