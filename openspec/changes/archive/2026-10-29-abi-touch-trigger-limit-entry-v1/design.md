## Context

Explore (main b783051): `tickSize` comes from `BybitInstrumentTradingRulesProvider.getRules()` with a per-symbol TTL
cache; sizing (`positionSizeCalculator`) calls it before the exchange boundary, so a second call in the same request
is a cache hit. `ceilToStep` / `floorToStep` return an exact multiple unchanged. `confirmEntryPackage` already
classifies `New`, `PartiallyFilled`, filled and terminal-without-fill by status and `cumExecQty`. Cancel / Replace /
Recovery / close work by `orderLinkId` and do not depend on order type. Snapshot 2026-10-28 19:04 UTC on Demo: each
entry has exactly one `PartialStopLoss` + one `PartialTakeProfit`, qty = that entry's filled qty.

## Decisions

- **Price alignment in the service, request in the mapper.** `createOrder` resolves the limit price after quantity
  sizing and before the provisional write: only when `liveEntryMode = touch_trigger` and order type `limit`; it calls
  `rulesProvider.getRules(symbol, category)` and `alignEntryLimitPrice(planned_entry_price, tickSize, side)`
  (`ceilToStep` for long, `floorToStep` for short). A thrown lookup returns
  `diagnosedInternalErrorResult("entry_limit_price", ...)` before the boundary, like a sizing failure.
- **Mapper input.** `EntryPackageOrderInput` gains optional `entryLimitPrice`. In `touch_trigger` + `limit` the mapper
  requires it (throws if missing) and writes `orderType: "Limit"`, `price`, `timeInForce: "GTC"`. Other modes ignore
  it. Key order of existing shapes is unchanged; the Limit shape puts `price` and `timeInForce` right after `qty`.
- **Other mapper calls.** `repeatPutRevalidate` and `metadataOnlyUpdate` call the mapper only for its query/cancel
  payloads and never send a create. The query/cancel part is split out into one exported helper (same payloads as
  today) that these two paths use, so they need no limit price; `createOrder` keeps the full mapper, which throws if
  `touch_trigger` + `limit` arrives without `entryLimitPrice`.
- **Startup refusal removed.** `loadConfig` accepts `touch_trigger` + `limit`.
- **Applied response.** Unchanged code: `trigger_price` is the exchange read-back (`"0"` or empty for Limit), which
  Runtime treats as optional.

## Risks

- Bybit may reject a price outside its price band; that is an ordinary create rejection (existing handling).
- A Limit that crosses the book fills at once (taker); expected, measured on Demo.
- The two limitations in the proposal.
