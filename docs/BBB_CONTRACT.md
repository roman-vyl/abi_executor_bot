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
- `stop_loss`: optional. When present, `type` is `stop_market` and `trigger_price` is a positive absolute stop-loss price.
- `take_profit`: optional, but allowed only when `stop_loss` is also present. When present, `type` is `take_profit_market` and `trigger_price` is a positive absolute take-profit price.

Trigger prices may be JSON strings or numbers; Abi normalizes them to strings internally.

## Identifier semantics

`signal_id` identifies a particular submission and its lifecycle. Repeating an existing `signal_id` is treated as a duplicate submission.

`instance_id` identifies the longer-lived strategy slot behind the submission. It remains unchanged when the pending entry is amended and gives the entry a stable deterministic `orderLinkId`. Different strategy instances may have active intents for the same symbol at the same time.

## Price ownership and validation

bbb always calculates the entry price and may also send absolute stop-loss and take-profit prices. Abi does not derive these levels. The supported shapes are:

- entry only;
- entry plus stop loss;
- entry plus stop loss and take profit.

Take profit without stop loss is invalid. Abi validates that all supplied prices are positive and coherently ordered:

- stop-only `long`: `stop_loss < entry`;
- stop-only `short`: `entry < stop_loss`;
- fully protected `long`: `stop_loss < entry < take_profit`;
- fully protected `short`: `take_profit < entry < stop_loss`.

Abi submits the stop-market entry with any supplied protection attached to the same Bybit create request. Attached protection uses `tpslMode=Full`, market order types, and `BYBIT_TRIGGER_BY` (currently `LastPrice`). Missing protection legs are omitted from the create payload. Abi does not yet verify or repair protection after create or fill.

`PUT /intents/:signalId` is the complete desired representation for a pending intent: it can update entry, stop loss, and take profit together, and omission removes an existing protection leg.

Abi owns position sizing, deterministic entry `orderLinkId` generation, guarded Bybit execution, journaling, and intent status.
