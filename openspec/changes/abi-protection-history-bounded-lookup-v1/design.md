## Context

Evidence is in `proposal.md`. Closure proof (`classifyOwnProtection`, `proveOwnCycleCompletion`) already works when both legs are attributed. The defect is only that the input to it is one 50-row page.

## Decisions

### D1. Scan window starts at the cycle, not at "two years back"

The correlation record already holds `first_fill_at_ms` (nullable) and `created_at`. Scan start is `first_fill_at_ms` if present, else `created_at`, minus a small safety margin (1 minute, for clock skew and propagation). Scan end is now. A normal cycle is a few hours old, so this is one 7-day window and one or two pages.

### D2. Window and cursor walk

- Windows of exactly 7 days or less, `endTime - startTime <= 7 days`, newest window first, so the common case (recent exit) is found on the first page.
- Inside a window, follow `nextPageCursor` until it is empty. Page size 50.
- Early stop: both own legs attributed after a page. Own children are matched exactly as today, by `parentOrderLinkId` equal to the entry `orderLinkId`, then by binding.
- Caps: 200 pages and 8 windows per resolution (about 10 000 orders, roughly 8 days at the observed 50 orders an hour on BTCUSDT). A 33-hour-old cycle needs about 33 pages, so the cap must be far above that: a low cap would leave exactly the observed case unfixed. Cap reached, page failed, page undecodable, or cursor not advancing: result is `ambiguous` with reason `query_failed`. Never `none`.
- Scope of the long read: only the open-position lookup and Close continue through history. Reconciliation and replacement keep the two queries they make today.
- Cost control, optional: `orderStatus=Filled` and, if Bybit applies it to partial-mode children, `orderFilter=tpslOrder` could shrink the scan. This is unverified (task 1.1); correctness does not depend on it, the cap above does. Without a filter a 2-day-old BTCUSDT cycle reads about 2400 orders (48 pages) per bar.

### D3. One filled own leg proves completion when the other left the window (needs owner decision)

Today `classify()` returns `partial_pair` for exactly one leg and `classifyOwnProtection` turns that into `unknown`; `test/unit/tradeCycleClosure.test.ts` ("unknown protection with an observed own fill fails closed") asserts it. Bybit documents that cancelled legs without a fill stay in history for 24 hours (a 34-hour-old one was still returned on demo, a 4.5-day-old one was not), so the cancelled opposite leg eventually disappears, so a late-detected cycle can only ever show one leg. A fix of the lookup alone would not close such a cycle.

Proposed rule: class `completed` also when all of these hold: (a) exactly one own leg found, `Filled`, `leavesQty` zero, `cumExecQty` equal to `Q`; (b) its `Trade` executions sum to exactly `Q` (existing check); (c) the history read covered the whole cycle lifetime from its start to now, no cap hit, no failed page; (d) the other leg is not live: it is not among the active orders read in the same resolution. The aggregate position is deliberately not a condition: in one-way mode a sibling's position in the same scope would otherwise hide this cycle's own stop exit, which `open-position-resolution` already says it must not ("Sibling position does not hide an own stop exit"), and the cycle would stay stuck with the same `scope_conflict`. Any other single-leg shape stays `unknown`.

Why safe: in partial mode both legs are reduce-only for the same quantity; once one has filled `Q` the position is flat and the other cannot execute. Why a decision: it relaxes an existing, tested fail-closed rule. If the owner prefers, D3 is dropped and the spec covers only detection within 24 hours of the exit, which is the normal case because Runtime asks every 5 minutes.

### D4. Out of scope, on purpose

No storing of children `orderId`s, no schema change, no new log. Durable identity of protection legs stays a possible later change of ABI state.

## Risks

- Request volume per lookup grows from 1 to up to 160 for old cycles; mitigated by newest-first early stop, D2 filters and caps. ABI already issues several Bybit calls per lookup.
- Bybit history lag: unchanged rule, an empty result is never proof of absence.
