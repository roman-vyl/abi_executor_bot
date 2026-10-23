## Why

On Bybit demo, trade cycle `98c59c2c` (strategy `ema_pullback:6072511f…`, BTCUSDT long) stayed `applied` in the correlation journal for 33 hours after its own native stop filled (stop `ec079208`, 2026-10-22 01:38 UTC, `Filled`, `PartialStopLoss`, parent = the cycle's entry). The exchange held no position and no order. Because `scope` is the whole instrument in one-way mode, the stale record rejected every opposite-side BTCUSDT entry with `scope_conflict` from 2026-10-22 01:50 until it was closed by hand on 2026-10-23.

Cause: `resolveOwnAttachedProtection` reads one page, `GET /v5/order/history` for the symbol with `limit=50`, no time and no cursor. Runtime places and cancels about 50 BTCUSDT orders an hour, so the page covers roughly the last hour. Once the closing stop is older than that, the proof of completion cannot be built and the lookup answers `internal_error` on every bar, forever.

Bybit contract, checked on the official page and on the demo account (read only): a request covers at most 7 days (`endTime - startTime <= 7 days`, otherwise `retCode 10001`); page size 1..50 with `nextPageCursor`; executed orders stay available well past 7 days, cancelled, rejected and deactivated orders without a fill only for 24 hours; there is no filter by parent order. A lookup by `orderId` works without a time range, but ABI does not store the children's `orderId`.

## What Changes

- Own protection resolution reads the order history of the cycle's own lifetime instead of one page: from the cycle's first-fill time (entry creation time when no fill time is stored) to now, in windows of at most 7 days, following `nextPageCursor` inside each window, newest window first.
- The scan stops early once both own legs are attributed; it is bounded by a page cap and a window cap. Hitting a cap, a failed page or a malformed page makes the result `ambiguous` (`query_failed`), never "none".
- A cycle is never completed from a partially read history: completion needs a scan that covered every window from the cycle start to now without a failed page.
- The opposite leg that Bybit cancels after the other one fills is visible for only 24 hours. A filled own leg whose full execution matches the cycle exposure SHALL prove completion when the scan covered the whole cycle lifetime and the other leg is not found (see design D3). Today the same evidence gives `partial_pair` and the cycle never closes.
- No change to the correlation schema, no durable order ids, no new journal, no change to ownership or to the `closure` response contract.

## Capabilities

### Modified Capabilities

- `native-partial-protection-attribution`: bounded historical lookup, scan coverage and fail-closed caps.
- `open-position-resolution`: completion proven by one filled own leg when the other leg left the history window.

## Impact

`nativeProtectionAttribution.ts`, `bybitAdapter.ts` (`getOrderHistoryForSymbol` gains `startTime`, `endTime`, `cursor`, and optionally `orderStatus`/`orderFilter`), `bybitOrderMapper.ts` payload type, `orderQueryResponseDecoder.ts` (`nextPageCursor`), `tradeCycleClosure.ts` (D3), tests including the existing `partial_pair` fail-closed test, fakes. Callers `openPositionResolutionService.ts`, `closeApplicationService.ts` pass the cycle start time. No Runtime change.
