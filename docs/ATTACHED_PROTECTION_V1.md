# Attached Protection v1

Abi can attach optional Full-position market protection directly to a Bybit conditional entry create request. bbb remains responsible for calculating every absolute entry, stop-loss, and take-profit price.

## Supported signal shapes

v1 accepts:

1. entry only;
2. entry plus `stop_loss`;
3. entry plus `stop_loss` and `take_profit`.

`take_profit` without `stop_loss` is rejected.

## Execution plan

`ExecutionPlan.protection` is the only protection source of truth:

- `{ mode: "none" }` for entry-only signals;
- `attached_full_position_market` with a required stop-loss leg and optional take-profit leg.

There is no planned-after-fill protection model.

## Bybit create mapping

Entry-only create payloads contain no TP/SL fields. When protection is present, Abi sets `tpslMode=Full` and adds fields only for supplied legs:

- stop loss: `stopLoss`, `slTriggerBy`, `slOrderType=Market`;
- take profit: `takeProfit`, `tpTriggerBy`, `tpOrderType=Market`.

Entry and protection use `BYBIT_TRIGGER_BY`, currently defaulting to `LastPrice`. Separate trigger sources may be introduced later.

## Pending entry updates

`PUT /intents/:signalId` represents the complete desired pending intent. It amends the existing entry `orderLinkId`, updates supplied protection, and explicitly clears protection legs omitted from the new representation.

## Boundaries

v1 does not implement post-create verification, query retry, fill watching, trading-stop repair, emergency close, partial TP, limit TP/SL, sizing changes, or mainnet execution.

The next `protection-verification-and-repair-v1` change will add acknowledgement polling, pending-order verification, after-fill watching, repair through `/v5/position/trading-stop`, and emergency close when a position exists after its intended stop has already been breached.
