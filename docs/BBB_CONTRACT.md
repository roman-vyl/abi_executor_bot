# bbb to Abi Contract

bbb submits a trading intent to Abi with `POST /signals`. The current payload is:

```json
{
  "signal_id": "smoke-001",
  "instance_id": "ema200-touch:BTCUSDT:1h",
  "strategy_id": "ema200-touch",
  "symbol": "BTCUSDT",
  "side": "long",
  "entry": {
    "type": "stop_market",
    "trigger_price": "70000",
    "trigger_direction": "rises_to"
  },
  "stop_loss": {
    "type": "stop_market",
    "trigger_price": "69000"
  },
  "take_profit": {
    "type": "take_profit_market",
    "trigger_price": "72000"
  }
}
```

## Fields

- `signal_id`: unique identifier for one submitted signal. Abi uses it for duplicate detection, journal events, intent routes, updates, queries, and cancellation.
- `instance_id`: stable identifier for the strategy instance that owns the intent, such as a strategy, symbol, and timeframe combination. Abi derives stable Bybit `orderLinkId` values from it. A new signal cannot replace an active planned intent with the same `instance_id`; use `PUT /intents/:signalId` to amend that intent.
- `strategy_id`: identifies the strategy that produced the signal.
- `symbol`: trading symbol. It must be included in Abi's configured allowlist.
- `side`: `long` or `short`.
- `entry.type`: currently only `stop_market`.
- `entry.trigger_price`: positive stop-entry trigger price.
- `entry.trigger_direction`: `rises_to` when the market must rise to the trigger price, or `falls_to` when it must fall to the trigger price. This direction describes the price crossing and is independent of `side`.
- `stop_loss.type`: currently only `stop_market`.
- `stop_loss.trigger_price`: positive stop-loss trigger price.
- `take_profit.type`: currently only `take_profit_market`.
- `take_profit.trigger_price`: positive take-profit trigger price.

Trigger prices may be JSON strings or numbers; Abi normalizes them to strings internally.

## Identifier semantics

`signal_id` identifies a particular submission and its lifecycle. Repeating an existing `signal_id` is treated as a duplicate submission.

`instance_id` identifies the longer-lived strategy slot behind the submission. It remains unchanged when the pending entry is amended and gives the entry, stop-loss, and take-profit plans stable deterministic `orderLinkId` values. Different strategy instances may have active intents for the same symbol at the same time.

## Price ownership and validation

bbb calculates and sends the entry, stop-loss, and take-profit prices. Abi does not derive these levels. Abi validates that all prices are positive and that their ordering is coherent:

- `long`: `stop_loss < entry < take_profit`;
- `short`: `take_profit < entry < stop_loss`.

Abi currently submits only the stop-market entry. Stop-loss and take-profit are retained in the execution plan as protection to create after the entry fills; automatic fill watching and protection placement are not implemented yet.

Abi owns position sizing, deterministic `orderLinkId` generation, guarded Bybit execution, journaling, and intent status.
