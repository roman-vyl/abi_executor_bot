## Context

Evidence is in `proposal.md`. Closure proof (`classifyOwnProtection`, `proveOwnCycleCompletion`) already works when both legs are attributed. The defect is only that the input to it is one 50-row page.

## Decisions

### D1. Scan window starts at the cycle, not at "two years back"

The correlation record already holds `first_fill_at_ms` (nullable) and `created_at`. Scan start is `first_fill_at_ms` if present, else `created_at`, minus a small safety margin (1 minute, for clock skew and propagation). Scan end is now. A normal cycle is a few hours old, so this is one 7-day window and one or two pages.

### D2. Window and cursor walk

- Windows of exactly 7 days or less, `endTime - startTime <= 7 days`, newest window first, so the common case (recent exit) is found on the first page.
- Inside a window, follow `nextPageCursor` until it is empty. Page size 50.
- Early stop: both own legs attributed after a page. Own children are matched exactly as today, by `parentOrderLinkId` equal to the entry `orderLinkId`, then by binding.
- Caps: 20 pages and 8 windows per resolution (about 1000 orders per window and 8 weeks). Cap reached, page failed, page undecodable, or cursor not advancing: result is `ambiguous` with reason `query_failed`. Never `none`.
- Cost control, to be verified on demo during apply (task 1.1): `orderStatus=Filled` and, if Bybit applies it to partial-mode children, `orderFilter=tpslOrder` shrink the scan to executed protection children only. If the filter hides a child, the scan falls back to the unfiltered walk. Without this, a 2-day-old BTCUSDT cycle reads about 2400 orders (48 pages) per bar.

### D3. One filled own leg proves completion when the other left the window (needs owner decision)

Today `classify()` returns `partial_pair` for exactly one leg and `classifyOwnProtection` turns that into `unknown`; `test/unit/tradeCycleClosure.test.ts` ("unknown protection with an observed own fill fails closed") asserts it. After 24 hours the cancelled opposite leg disappears from Bybit history, so a late-detected cycle can only ever show one leg. A fix of the lookup alone would not close such a cycle.

Proposed rule: class `completed` also when all of these hold: (a) exactly one own leg found, `Filled`, `leavesQty` zero, `cumExecQty` equal to `Q`; (b) its `Trade` executions sum to exactly `Q` (existing check); (c) the scan reported full coverage from the cycle start to now (D2, no cap, no failed page); (d) the aggregate position query for the cycle's physical binding reports no position. Any other single-leg shape stays `unknown`. A single leg that is live or partly filled stays `partial_or_contradictory` or `unknown` as today.

Why safe: in partial mode both legs are reduce-only for the same quantity; once one has filled `Q` the position is flat and the other cannot execute. Why a decision: it relaxes an existing, tested fail-closed rule. If the owner prefers, D3 is dropped and the spec covers only detection within 24 hours of the exit, which is the normal case because Runtime asks every 5 minutes.

### D4. Out of scope, on purpose

No storing of children `orderId`s, no schema change, no new log. Durable identity of protection legs stays a possible later change of ABI state.

## Risks

- Request volume per lookup grows from 1 to up to 160 for old cycles; mitigated by newest-first early stop, D2 filters and caps. ABI already issues several Bybit calls per lookup.
- Bybit history lag: unchanged rule, an empty result is never proof of absence.
