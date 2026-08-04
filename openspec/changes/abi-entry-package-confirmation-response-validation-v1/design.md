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
response identity against those same values — `queryOrderView` just needs
to be extended to pass them through (see "Internal identity plumbing"
decision below); this is a small internal parameter-list change, not new
plumbing from scratch.

Separately, `confirmEntryPackage`'s realtime-handling branch has a gap
independent of the decoder: a `found` realtime result whose status is
unrecognized, or is in `TERMINAL_WITHOUT_FILL_STATUSES` (intentionally
falling through to history), does not set `sawInconclusiveFinding`. A
subsequent clean empty history result can then let the loop conclude
`not_found` despite realtime having positively found an order. See
proposal.md's "Unknown/terminal order status semantics" for the exact
required behavior.

## Goals / Non-Goals

**Goals:**
- Make "cleanly empty" and "structurally broken" distinguishable at the
  decode boundary, as a pure function testable independently of network
  and retry timing.
- Close the state-machine gap where a positively-found realtime result can
  be discarded into `not_found` by a later empty history result, without
  changing anything else about how `confirmEntryPackage` /
  `confirmEntryPackageCancelled` classify outcomes.

Outcome-routing behavior is **not** preserved byte-for-byte: the
inconclusive-marking correction described above is a deliberate, narrow
behavior change, not just a change in the trustworthiness of the facts
feeding an unchanged state machine.

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
order into "no evidence." Instead the row decodes successfully as `found`
and is handed to `packageConfirmation.ts` for classification.

**Correction: the decoder alone does not make an unrecognized status safe —
`confirmEntryPackage` must be fixed too.** The `LIVE_UNFILLED_STATUSES`/
`FILLED_STATUSES`/`PARTIAL_FILL_STATUSES`/`TERMINAL_WITHOUT_FILL_STATUSES`
matching in `confirmEntryPackage` does *not* currently set
`sawInconclusiveFinding` for a realtime `found` result whose status is
unrecognized or terminal-without-fill; those fall through to the history
query untagged. If history then cleanly reports empty, the loop's end-of-
attempt check (`sawQueryFailure || sawInconclusiveFinding`) sees neither
flag set and concludes `not_found` — silently discarding a positively-found
order. The fix, scoped to that one branch: mark the attempt inconclusive
whenever a realtime `found` result does not itself produce a definitive
`pending_confirmed`/`full_fill`/`partial_fill` return, before falling
through to history. History can still supply a definitive
`full_fill`/`partial_fill`/`terminal_without_fill` afterward (those returns
happen before the end-of-attempt check runs); only the "both queries came
back inconclusive/empty" tail path is affected, and it now correctly lands
on `ambiguous` instead of `not_found`. See proposal.md's "Unknown/terminal
order status semantics" table for the exact input/output matrix.

**`list.length > 1` and identity mismatch are `protocol_failure`, not
"take the first row."** The query is always sent with a specific
`orderLinkId` and `limit: "1"`. More than one row, or a row whose
`symbol`/`orderLinkId` disagrees with what was requested, means the
response cannot be trusted to be about the order ABI asked about —
silently indexing `list[0]` in that case (the old behavior) could
attribute a different order's state to this confirmation.

**Numeric fields are validated with the existing `exactDecimal` machinery,
against a per-field sign rule, not a new parser.** `compareDecimal()` in
`src/domain/exactDecimal.ts` already throws on non-exact-decimal text and
can compare a parsed value against `"0"`; the decoder uses it for both
jobs — reject malformed text/exponent, then classify the parsed value as
negative, zero, or positive against each field's own rule (see proposal.md's
numeric field validation table): `qty` and `avgPrice` require a *positive*
exact-decimal when non-empty (`"0"` and negative both `protocol_failure`);
`cumExecQty`, `triggerPrice`, `stopLoss`, and `takeProfit` require a
*non-negative* exact-decimal when non-empty (`"0"` allowed, negative
`protocol_failure`). A bare "does `compareDecimal` throw" check is
insufficient on its own — it would pass a negative or zero `qty`/`avgPrice`
that should be rejected. Each field gets its own reason code so decoder
tests can assert which field and which class (malformed / negative / zero)
triggered the rejection.

**`queryOrderView` takes an explicit `expected` identity, not a positional
tuple.** `queryOrderView({ query, expected: { category, symbol,
orderLinkId } })` (or the equivalent of passing the already-available
`BybitGetOrderByLinkIdPayload`/`BybitGetOrderHistoryPayload` through) makes
the identity the decoder validates against explicit at the call site,
rather than threading three loose strings. This is strictly internal:
`queryOrderView`'s two call sites in `confirmEntryPackage` and
`confirmEntryPackageCancelled` already have this identity on hand from the
payloads they were already passed.

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
2. Rewire `queryOrderView()` to call it, passing the expected identity from
   the existing request payload; delete `readOrderViewFromBybitList()`.
3. Apply the one-line `sawInconclusiveFinding` correction in
   `confirmEntryPackage`'s realtime-handling branch (see "Unknown/terminal
   order status semantics").
4. Run `npm test` and `npm run typecheck`; add
   `confirmEntryPackage`/`confirmEntryPackageCancelled`-level tests for the
   malformed-response and unknown/terminal-status scenarios listed in the
   proposal.
Rollback is a plain revert; no persisted state or schema is touched.
