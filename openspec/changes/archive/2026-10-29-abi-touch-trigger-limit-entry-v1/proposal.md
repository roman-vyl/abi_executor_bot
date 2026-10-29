## Why

Owner plan 2026-10-28 (thread «Перевести вход на цену закрытия свечи касания»), Explore 16:18 and 16:29, decision
19:17. Step ABI-2: `touch_trigger` + `limit` places a plain GTC Limit entry at the price Strategy Engine already sends
as `planned_entry_price` (close of the confirming bar). ABI does not interpret the signal, does not read the market
and does not choose another price. Strategy Runtime keeps owning the order life cycle through `APPLY` / `CANCEL` /
`REPLACE`. The goal is a simple, predictable Limit entry that can be compared with Market on Bybit Demo.

## What Changes

- `mapEntryPackageToBybit()` (`src/exchange/bybitOrderMapper.ts`) gets a third entry shape:

  | config | entry create request |
  |---|---|
  | `ema_anchor` | unchanged: conditional `Market` with `triggerPrice`, `triggerDirection`, `triggerBy` |
  | `touch_trigger` + `market` | unchanged: plain `Market` without the three trigger fields |
  | `touch_trigger` + `limit` | `orderType: "Limit"`, `price` = entry limit price, `timeInForce: "GTC"`, no trigger fields |

  Everything else is the same in all three: `category`, `symbol`, `side`, `qty`, `orderLinkId`, `positionIdx`,
  `tpslMode: "Partial"`, stop loss / take profit with their trigger source and `Market` order types.
- Entry limit price = `planned_entry_price` aligned to the instrument `tickSize`: a price already on the tick grid is
  kept as is; otherwise long rounds UP, short rounds DOWN (toward a worse price, for a better fill chance). No extra
  tick offset. Uses the existing `ceilToStep` / `floorToStep` (`src/domain/exactDecimal.ts`).
- `EntryPackageApplicationService` receives the existing `InstrumentTradingRulesProvider` instance (the one sizing
  already uses) and computes the limit price before the provisional durable write and before any exchange call, so a
  rules lookup failure is an ordinary pre-boundary failure closed as absent. The mapper stays a pure function; it is
  given the already-aligned price.
- `loadConfig()`: the temporary startup refusal of `touch_trigger` + `limit` (ABI-1) is removed.
- `BybitCreateOrderPayload.orderType` becomes `"Market" | "Limit"` with optional `price` and `timeInForce`.
- README / RUNBOOK: the three request shapes, the rounding rule, the known limitations below.

## Unchanged

Runtime ↔ ABI contract (`planned_entry_price` stays the raw Engine price; equality checks keep comparing raw desired
entries), `APPLY` / `CANCEL` / `REPLACE`, correlation records, `orderLinkId`, confirmation, recovery, native Partial
protection attribution and management, position sizing, close execution, `ema_anchor`, `touch_trigger` + `market`.
No new services, resolvers, timers, re-placement or order-management logic. No PostOnly, no dynamic offset, no
market price or order book use.

## Known limitations of V1 (deliberate)

1. **Remainder of a partially filled Limit stays live** (owner 16:29). ABI does not cancel it. A partial fill makes
   ABI answer `position_open`; Runtime then moves to Position Management and no longer reconciles the entry, so the
   remainder can fill later at the same limit price, until it fills completely or the cycle is closed (close
   execution cancels the live entry order first, then closes the whole own filled quantity). Own filled quantity is
   always read fresh from the entry order's `cumExecQty` while it is live. Managing the remainder (e.g. Runtime
   cancelling it at signal expiry) is a later, separate change.
2. **One native SL/TP pair per entry is assumed** (owner 19:17). Bybit documents that Partial mode "creates tp/sl
   orders with the qty you actually fill"; it does not document whether a second fill of the same order enlarges the
   existing pair or adds a second one. ABI attribution accepts exactly one `PartialStopLoss` and one
   `PartialTakeProfit` per parent; more is treated as ambiguous and protection changes fail closed. If several pairs
   are observed, correlation needs a separate extension. ABI also does not resize the pair itself after a later fill
   unless Runtime sends a protection change.

## Safety

`touch_trigger` stays off on the trading stack until the Bybit Demo check of ABI-1/ABI-2 and the joint
Engine/Runtime/ABI configuration check. Detecting limitation 2 needs no new mechanism: the exchange-facts store
(`order_links`, role `stop_loss` / `take_profit` per `parent_order_link_id`) shows how many children each entry got
and their quantities.

## Out of scope

Remainder cancellation, multi-pair protection, PostOnly, price offsets, price-band checks, slippage parameters,
Demo check (separate stage), bbb_stack mount, deployment.

## Archive order

The `container-runtime` delta modifies the requirement last changed by `abi-touch-trigger-market-entry-v1`; archive
that change first, then this one.
