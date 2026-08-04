## Why

`packageConfirmation.ts`'s `readOrderViewFromBybitList()` collapses every kind
of structurally broken Bybit response — missing `result`, missing/non-array
`list`, empty `list`, non-object first row — into the same `undefined` that
`queryOrderView()` then reports as `{ status: "not_found" }`. A malformed
response and a genuine "order does not exist" answer are indistinguishable.
`confirmEntryPackage` can treat a broken realtime+history pair as grounds to
resend a create/amend, and `confirmEntryPackageCancelled` can treat it as
proof a cancel succeeded — both are safety-relevant lies.

Separately, `confirmEntryPackage`'s own state machine has a narrower version
of the same bug: a realtime query that returns a correctly-identified order
whose status is neither a definitive live/filled/pending match nor one of
the explicitly handled branches (an unrecognized status, or a terminal
status intentionally falling through to the history fallback) does not mark
the attempt inconclusive. If the following history query then cleanly
reports an empty list, the attempt's inconclusive flag was never set, and
the loop can conclude `not_found` — even though a real, identified order was
just seen on realtime. A found order must never later degrade to
`not_found` only because history came back empty.

The fix is narrow: give the confirmation state machine a way to tell
"structurally valid, empty" apart from "the response was garbage" at the
decode boundary, and close the one gap in the state machine itself where a
found-but-inconclusive realtime result could still be overwritten by an
empty history result.

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
  request, a non-empty string `orderStatus` (any value — unrecognized-but-
  well-formed is still `found`, not a protocol failure), and each of
  `qty`/`cumExecQty`/`triggerPrice`/`stopLoss`/`takeProfit`/`avgPrice`
  satisfying the exact numeric rule in the "Numeric field validation" section
  below.
- Anything else structurally wrong (missing `result`, non-array `list`,
  `list.length > 1`, non-object row, category/symbol/orderLinkId mismatch,
  a numeric field violating its rule) is `protocol_failure` with a specific
  reason code.
- Rewrite `queryOrderView()` in `packageConfirmation.ts` to call the new
  decoder: `found` and `not_found` pass through unchanged; `protocol_failure`
  is folded into the existing `query_failed` status (the confirmation state
  machine does not need finer-grained transport-vs-protocol distinction —
  both already resolve to `ambiguous`). `queryOrderView` gains the expected
  `category`/`symbol`/`orderLinkId` it needs to pass to the decoder — see
  "Internal identity plumbing" below.
- Delete the old permissive `readOrderViewFromBybitList()`.
- Correct `confirmEntryPackage`'s realtime-handling branch so that any
  `realtime.status === "found"` result which does not itself produce a
  definitive `pending_confirmed`/`full_fill`/`partial_fill` outcome marks the
  attempt inconclusive (`sawInconclusiveFinding = true`) before falling
  through to the history query — see "Unknown/terminal order status
  semantics" below. This is the one state-machine change in this proposal;
  every other outcome-classification helper is untouched.

## Unknown/terminal order status semantics

This corrects the previously-assumed (and inaccurate) claim that an unknown
`orderStatus` already always resolved to `ambiguous`. In the current code, a
realtime `found` result whose status is unrecognized, or is in
`TERMINAL_WITHOUT_FILL_STATUSES` (which intentionally falls through to the
history fallback), does not set `sawInconclusiveFinding`. If history then
also cleanly reports empty, the loop can wrongly conclude `not_found`
despite having positively found an order on realtime.

Exact required semantics after this correction:

- Unknown (unrecognized) realtime `orderStatus`, clean empty history for the
  entire retry budget → `ambiguous`.
- Terminal (`TERMINAL_WITHOUT_FILL_STATUSES`) realtime `orderStatus`, clean
  empty history → `ambiguous`, **not** `not_found`.
- Unknown realtime `orderStatus`, history resolves `terminal_without_fill`
  → `terminal_without_fill` (history's definitive read still wins).
- Unknown realtime `orderStatus` during cancel confirmation → `ambiguous`,
  **not** `cancelled_confirmed`.
- A found order is never later downgraded to `not_found` solely because a
  subsequent history query returns a clean empty list.
- Unaffected: valid empty realtime **and** valid empty history for the
  entire bounded retry budget still resolve to `not_found` /
  `cancelled_confirmed` per the existing rules — this correction only closes
  the gap where a realtime `found` result was being discarded.

Confirmation attempt count and retry delay are unchanged.

## Numeric field validation

The decoder validates each numeric field against a rule specific to its
sign semantics, not merely "does not throw when parsed":

| Field | Empty allowed | Non-empty rule | `"0"` | negative |
|---|---|---|---|---|
| `qty` | yes | positive exact-decimal | `protocol_failure` | `protocol_failure` |
| `cumExecQty` | yes | non-negative exact-decimal | allowed | `protocol_failure` |
| `triggerPrice` | yes | non-negative exact-decimal | allowed | `protocol_failure` |
| `stopLoss` | yes | non-negative exact-decimal | allowed | `protocol_failure` |
| `takeProfit` | yes | non-negative exact-decimal | allowed | `protocol_failure` |
| `avgPrice` | yes | positive exact-decimal | `protocol_failure` | `protocol_failure` |

Malformed decimal text or an out-of-range exponent is `protocol_failure` for
every field. Each field's violation maps to its own reason code
(`invalid_qty`, `invalid_cumulative_filled_qty`, `invalid_trigger_price`,
`invalid_stop_loss`, `invalid_take_profit`, `invalid_average_price`). This
distinguishes malformed text, negative, zero, and positive as four separate
classes per field — a bare "does the existing `compareDecimal` throw?" check
is not sufficient, since it does not by itself distinguish sign or zero.

## Internal identity plumbing

`queryOrderView()` currently receives only the request callback. The decoder
needs the identity the caller expected back (`category`, `symbol`,
`orderLinkId`) to validate the response against. `queryOrderView` is
extended to also take that expected identity — either as an explicit
`expected: { category, symbol, orderLinkId }` argument, or by taking the
already-available `BybitGetOrderByLinkIdPayload` /
`BybitGetOrderHistoryPayload` as its source (both already carry all three
fields). This is an internal-only refactor of one function's parameter
list: it is not a new application port, not a new application dependency,
does not change the `BybitAdapter` interface, and does not touch the HTTP
contract or correlation state.

## Capabilities

### Modified Capabilities
- `entry-package-execution`: the confirmation query result classification
  (`queryOrderView` / `readOrderViewFromBybitList`) must reject structurally
  malformed or identity-mismatched Bybit realtime/history responses instead
  of silently treating them as "not found," and a positively-found realtime
  order must never be discarded into `not_found` by a later empty history
  result.

## Impact

- `src/services/entryPackage/packageConfirmation.ts`: `queryOrderView()` and
  `readOrderViewFromBybitList()` are rewritten as described above, plus the
  one-line inconclusive-marking correction inside `confirmEntryPackage`'s
  realtime-handling branch. `confirmEntryPackageCancelled` and the shared
  helpers (`fieldsMatch`, `fillFieldsPlausible`, `hasFill`,
  `confirmsAbsenceOrTerminal`) are unchanged.
- New file `src/services/entryPackage/orderQueryResponseDecoder.ts`.
- No change to `EntryPackageApplicationService`'s decision table, HTTP
  route/DTO, correlation record schema, `pending_action`,
  `EntryPackageExecutionStatus` vocabulary, `binding_history`,
  generation/order identity, confirmation attempt count/delay, Runtime
  contract, sizing, open-position lookup, first-fill observation/sender,
  private WebSocket, polling worker, or `instruments-info` decoding (that
  hardening is a later, separate change).
- Dry-run and demo/testnet gates are untouched — this is a pure response-
  interpretation fix on the live-confirmation path and has no effect on
  whether an order is sent, only on how its confirmation query is read.
- Observable behavior: the external HTTP contract, request/response
  schemas, and the vocabulary of HTTP statuses and error codes are
  unchanged. Observable *outcome* behavior is deliberately changed as a
  safety correction: a malformed or identity-mismatched Bybit response, or
  a found-but-inconclusive realtime result followed by an empty history
  result, that previously could produce a false `not_found` (enabling a
  false resend) or a false `cancelled_confirmed` (enabling a false
  `entry_package_absent` acknowledgement) now produces `ambiguous`. The
  application service already routes `ambiguous`/`query_failed` to
  `status: "unknown"` with `pending_action` preserved and returns
  `internal_error` without any success acknowledgement — this change makes
  the facts feeding that existing routing trustworthy; it does not add a new
  wire contract or a new response shape.
