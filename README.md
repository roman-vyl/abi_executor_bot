# Abi

Abi is a separate execution service for bbb signals.

## Current signal contract

bbb sends the trading intent without position size:

```json
{
  "signal_id": "smoke-001",
  "instance_id": "ema200-touch:BTCUSDT:1h",
  "strategy_id": "bbb-smoke",
  "symbol": "BTCUSDT",
  "side": "long",
  "entry": {
    "type": "stop_market",
    "trigger_price": "61234.5",
    "trigger_direction": "rises_to"
  },
  "stop_loss": {
    "type": "stop_market",
    "trigger_price": "60880.0"
  },
  "take_profit": {
    "type": "take_profit_market",
    "trigger_price": "62000.0"
  }
}
```

Abi calculates the position size internally. For the first smoke version this is a fixed placeholder:

```env
ABI_FIXED_SMOKE_QTY=0.001
```

Abi rejects obviously inverted prices:

- `long`: `stop_loss < entry < take_profit`
- `short`: `take_profit < entry < stop_loss`

Abi allows multiple active intents for the same symbol when they have different `instance_id` values, for example `ema200-touch:BTCUSDT:1h` and `ema500-touch:BTCUSDT:1h`. It rejects a new active intent with an already planned `instance_id`; bbb should update the existing intent instead.

## Bybit balance check

Abi can read Bybit wallet balance without placing orders:

```env
BYBIT_TESTNET=true
BYBIT_API_KEY=
BYBIT_API_SECRET=
BYBIT_ACCOUNT_TYPE=UNIFIED
BYBIT_RECV_WINDOW=5000
BYBIT_CATEGORY=linear
BYBIT_SETTLE_COIN=USDT
BYBIT_TRIGGER_BY=LastPrice
```

```bash
curl "http://127.0.0.1:8787/account/balance?coin=USDT"
```

Active orders and open positions can be queried for the operator UI:

```bash
curl "http://127.0.0.1:8787/account/orders/active"
curl "http://127.0.0.1:8787/account/positions/open"
```

Both endpoints accept optional `symbol=BTCUSDT`.

Emergency operator actions are guarded by `/execution/mode`:

```bash
curl -X POST "http://127.0.0.1:8787/account/orders/cancel-all"
curl -X POST "http://127.0.0.1:8787/account/positions/close-all"
```

Both endpoints accept optional `symbol=BTCUSDT`.

In dry-run mode Abi returns the execution plan instead of sending orders to Bybit:

```json
{
  "status": "accepted_dry_run",
  "signalId": "smoke-001",
  "intentStatus": {
    "intentId": "smoke-001",
    "instanceId": "ema200-touch:BTCUSDT:1h",
    "status": "planned",
    "entry": "planned",
    "protection": "waiting_for_entry_fill",
    "position": "not_open"
  },
  "wouldCreateEntry": {
    "orderLinkId": "abi-entry-7f244acccf67c2764391",
    "type": "stop_market",
    "symbol": "BTCUSDT",
    "side": "long",
    "triggerPrice": "61234.5",
    "triggerDirection": "rises_to",
    "qty": "0.001"
  },
  "wouldCreateStopLossAfterFill": {
    "orderLinkId": "abi-sl-7f244acccf67c2764391",
    "type": "stop_market",
    "symbol": "BTCUSDT",
    "side": "short",
    "triggerPrice": "60880.0",
    "qty": "0.001"
  },
  "wouldCreateTakeProfitAfterFill": {
    "orderLinkId": "abi-tp-7f244acccf67c2764391",
    "type": "take_profit_market",
    "symbol": "BTCUSDT",
    "side": "short",
    "triggerPrice": "62000.0",
    "qty": "0.001"
  },
  "wouldSendToBybit": {
    "createEntryOrder": {
      "category": "linear",
      "symbol": "BTCUSDT",
      "side": "Buy",
      "orderType": "Market",
      "qty": "0.001",
      "triggerPrice": "61234.5",
      "triggerDirection": 1,
      "triggerBy": "LastPrice",
      "orderLinkId": "abi-entry-7f244acccf67c2764391"
    }
  },
  "sizingReason": "fixed_smoke_qty_from_ABI_FIXED_SMOKE_QTY"
}
```

`POST /signals`, `PUT /intents/:signalId`, and `POST /intents/:signalId/cancel` are wired through the live execution guard. By default they skip real order placement and return `skipped_live_execution`. They can only call Bybit create/amend/cancel when `/execution/mode` reports `canExecuteLive: true`.

Execution mode can be inspected before wiring live orders:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

Current intent status can be read from the journal:

```bash
curl "http://127.0.0.1:8787/intents/smoke-001"
```

Entry order can be queried by Abi's stable Bybit `orderLinkId`:

```bash
curl "http://127.0.0.1:8787/intents/smoke-001/orders/entry"
```

Pending intent can be cancelled:

```bash
curl -X POST "http://127.0.0.1:8787/intents/smoke-001/cancel"
```

Pending intent can be updated with a new signal body:

```bash
curl -X PUT "http://127.0.0.1:8787/intents/smoke-001" \
  -H "content-type: application/json" \
  -d '{"signal_id":"smoke-001","instance_id":"ema200-touch:BTCUSDT:1h","strategy_id":"bbb-smoke","symbol":"BTCUSDT","side":"long","entry":{"type":"stop_market","trigger_price":"61300.0","trigger_direction":"rises_to"},"stop_loss":{"type":"stop_market","trigger_price":"60900.0"},"take_profit":{"type":"take_profit_market","trigger_price":"62100.0"}}'
```
