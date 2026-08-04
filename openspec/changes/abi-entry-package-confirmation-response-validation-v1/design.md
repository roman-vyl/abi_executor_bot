## Context

`packageConfirmation.ts` already implements the right shape: bounded
realtime/history confirmation, three-state `QueryResult` (`found` /
`not_found` / `query_failed`), and outcome routing that treats
`query_failed` as proving nothing. See [proposal.md](proposal.md) for why
its decoder, `readOrderViewFromBybitList()`, is the one unsound piece: it
folds every structurally-invalid response into the same `undefined` that
`not_found` also produces.

The request payload types (`BybitGetOrderByLinkIdPayload`,
`BybitGetOrderHistoryPayload` in `src/exchange/bybitOrderMapper.ts`) already
carry `category`, `symbol`, and `orderLinkId`, so the decoder can validate
response identity against the same values that were requested without any
new plumbing.

## Goals / Non-Goals

**Goals:**
- Make "cleanly empty" and "structurally broken" distinguishable at the
  decode boundary, as a pure function testable independently of network
  and retry timing.
- Preserve every existing outcome-routing behavior in `confirmEntryPackage`
  / `confirmEntryPackageCancelled` byte-for-byte; only the trustworthiness
  of the `found`/`not_found` facts feeding it changes.

**Non-Goals:**
- No general-purpose Bybit response parser. `order/realtime`,
  `order/history`, `position/list`, and `instruments-info` have different
  cardinality and empty-list semantics; a shared "magic parser" would paper
  over that. This change adds one decoder scoped to the order-query shape
  used by `getOrderByLinkId`/`getOrderHistory`.
- No change to confirmation attempt count, retry delay, or the
  `ambiguous`/`not_found` decision boundary in `packageConfirmation.ts`.
- No finer-grained transport-vs-protocol distinction above
  `queryOrderView()`. The confirmation state machine only ever needed to
  know "trustworthy fact" vs. "no evidence"; both transport failure and
  protocol failure already collapse to the same `query_failed` outcome.

## Decisions

**New pure decoder module, not an inline rewrite of
`readOrderViewFromBybitList`.** `decodeOrderQueryResponse()` lives in
`src/services/entryPackage/orderQueryResponseDecoder.ts` and takes the raw
response plus `expectedCategory`/`expectedSymbol`/`expectedOrderLinkId`.
Keeping it pure (no I/O, no retry awareness) makes the full decode matrix
(empty/one-row/multi-row/malformed/mismatched-identity) unit-testable
without mocking `BybitAdapter` or timers.

**Three-way decoder output, collapsed to `queryOrderView`'s existing
three-way `QueryResult` at the call site.** The decoder itself keeps
`protocol_failure` distinct from `not_found`/`found` with a typed reason
(`malformed_envelope`, `category_mismatch`, `list_not_array`,
`multiple_rows_returned`, `malformed_item`, `symbol_mismatch`,
`order_link_id_mismatch`, `invalid_order_status`, `invalid_qty`,
`invalid_cumulative_filled_qty`, `invalid_trigger_price`,
`invalid_stop_loss`, `invalid_take_profit`, `invalid_average_price`) so
regression tests can assert *why* a response was rejected. `queryOrderView`
maps `protocol_failure` to `{ status: "query_failed" }` — the same bucket
transport errors already land in — because nothing downstream currently
needs to tell "the network call threw" apart from "the response was
garbage"; both mean "no trustworthy evidence." If a future caller needs
that distinction, the reason is preserved right up to that mapping point
and can be threaded through then.

**Unrecognized-but-well-formed `orderStatus` is `found`, not
`protocol_failure`.** Bybit's status vocabulary can grow. Rejecting an
unrecognized status as malformed would make this decoder brittle against
exchange-side additions and would incorrectly turn a real, identifiable
order into "no evidence." Instead the row decodes successfully; the
existing `LIVE_UNFILLED_STATUSES`/`FILLED_STATUSES`/
`PARTIAL_FILL_STATUSES`/`TERMINAL_WITHOUT_FILL_STATUSES` matching in
`packageConfirmation.ts` already falls through to `sawInconclusiveFinding`
for any status it doesn't recognize, which resolves to `ambiguous` — the
correct fail-closed outcome without the decoder needing to know the full
status enum.

**`list.length > 1` and identity mismatch are `protocol_failure`, not
"take the first row."** The query is always sent with a specific
`orderLinkId` and `limit: "1"`. More than one row, or a row whose
`symbol`/`orderLinkId` disagrees with what was requested, means the
response cannot be trusted to be about the order ABI asked about —
silently indexing `list[0]` in that case (the old behavior) could
attribute a different order's state to this confirmation.

**Numeric fields are validated with the existing `exactDecimal` machinery,
not a new parser.** `compareDecimal()` in `src/domain/exactDecimal.ts`
already throws on non-exact-decimal text; the decoder wraps each of
`qty`/`cumExecQty`/`triggerPrice`/`stopLoss`/`takeProfit`/`avgPrice` in the
same try/catch-based validity check `decimalEquals()` in
`packageConfirmation.ts` already uses, rather than introducing a second
decimal grammar.

## Risks / Trade-offs

- [Folding `protocol_failure` into `query_failed` loses the specific reason
  at the `packageConfirmation.ts` boundary] → Acceptable: the confirmation
  state machine's contract only ever distinguished "trustworthy" from "not
  trustworthy." The reason is retained in the decoder's return value and in
  decoder-level tests, so it is not lost — just not threaded further than
  where it is currently useful.
- [Adding identity/cardinality checks could reject a previously-tolerated
  edge-case response Bybit happens to send in some account configuration]
  → Mitigated by scoping strictly to the documented `order/realtime` and
  `order/history` single-`orderLinkId` query shape (`limit: "1"`), and by
  routing every rejection to `ambiguous`/`unknown` rather than an error the
  Runtime caller can't recover from — same safe fallback already used for
  network failures today.

## Migration Plan

Internal-only change with no data-model or contract migration.
1. Add `orderQueryResponseDecoder.ts` with the decode matrix tests.
2. Rewire `queryOrderView()` to call it; delete
   `readOrderViewFromBybitList()`.
3. Run `npm test` and `npm run typecheck`; add
   `confirmEntryPackage`/`confirmEntryPackageCancelled`-level tests for the
   malformed-response scenarios listed in the proposal.
Rollback is a plain revert; no persisted state or schema is touched.
