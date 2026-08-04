## Why

`packageConfirmation.ts`'s `readOrderViewFromBybitList()` collapses every kind
of structurally broken Bybit response — missing `result`, missing/non-array
`list`, empty `list`, non-object first row — into the same `undefined` that
`queryOrderView()` then reports as `{ status: "not_found" }`. A malformed
response and a genuine "order does not exist" answer are indistinguishable.
`confirmEntryPackage` can treat a broken realtime+history pair as grounds to
resend a create/amend, and `confirmEntryPackageCancelled` can treat it as
proof a cancel succeeded — both are safety-relevant lies. The fix is narrow:
give the confirmation state machine a way to tell "structurally valid, empty"
apart from "the response was garbage," without touching the state machine's
decision logic itself, since that logic already treats `ambiguous` safely.

## What Changes

- Add `src/services/entryPackage/orderQueryResponseDecoder.ts`: a pure
  `decodeOrderQueryResponse()` function that validates a raw Bybit
  `order/realtime` or `order/history` response against an expected
  `category`/`symbol`/`orderLinkId` and returns one of three outcomes:
  `{ kind: "found", item }`, `{ kind: "not_found" }`, or
  `{ kind: "protocol_failure", reason }`.
- `not_found` is only returned when the envelope is structurally valid, is a
  correct-category response, and `result.list` is a genuinely empty array.
- `found` requires exactly one row whose `symbol`/`orderLinkId` match the
  request, and whose `qty`/`cumExecQty`/`triggerPrice`/`stopLoss`/
  `takeProfit`/`avgPrice` fields are each either empty or valid exact-decimal
  text (non-negative, `avgPrice` positive-or-empty). `orderStatus` need only
  be a non-empty string — an unrecognized-but-well-formed status is `found`,
  not a protocol failure; the existing confirmation logic already treats an
  unrecognized status as inconclusive and lands on `ambiguous`.
- Anything else structurally wrong (missing `result`, non-array `list`,
  `list.length > 1`, non-object row, category/symbol/orderLinkId mismatch,
  a malformed decimal field) is `protocol_failure` with a specific reason
  code.
- Rewrite `queryOrderView()` in `packageConfirmation.ts` to call the new
  decoder: `found` and `not_found` pass through unchanged; `protocol_failure`
  is folded into the existing `query_failed` status (the confirmation state
  machine does not need finer-grained transport-vs-protocol distinction —
  both already resolve to `ambiguous`).
- Delete the old permissive `readOrderViewFromBybitList()`.

## Capabilities

### Modified Capabilities
- `entry-package-execution`: the confirmation query result classification
  (`queryOrderView` / `readOrderViewFromBybitList`) must reject structurally
  malformed or identity-mismatched Bybit realtime/history responses instead
  of silently treating them as "not found."

## Impact

- `src/services/entryPackage/packageConfirmation.ts`: `queryOrderView()` and
  `readOrderViewFromBybitList()` only. No change to `confirmEntryPackage`,
  `confirmEntryPackageCancelled`, or any of their outcome-classification
  logic (`fieldsMatch`, `fillFieldsPlausible`, `hasFill`,
  `confirmsAbsenceOrTerminal`).
- New file `src/services/entryPackage/orderQueryResponseDecoder.ts`.
- No change to `EntryPackageApplicationService`, HTTP route/DTO,
  correlation record schema, `pending_action`, `EntryPackageExecutionStatus`,
  confirmation attempt count/delay, Runtime contract, sizing, open-position
  lookup, or first-fill sender. Those already route `ambiguous`/`query_failed`
  to safe outcomes (`status: "unknown"`, no absent/applied acknowledgement);
  this change only makes the facts feeding that routing trustworthy.
- Dry-run and demo/testnet gates are untouched — this is a pure response-
  interpretation fix on the live-confirmation path and has no effect on
  whether an order is sent, only on how its confirmation query is read.
- No new Runtime-visible behavior: outcomes previously misclassified as
  `not_found`/`cancelled_confirmed` due to a malformed response now surface
  as `ambiguous` and `status: "unknown"`, matching the failure mode already
  used for query timeouts.
