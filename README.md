# Abi

Abi is a separate execution service for bbb signals.

## Current Status

The Bybit demo smoke flow has been verified end to end:

- wallet balance query;
- active-orders query;
- open-positions query;
- stop-market entry creation;
- entry lookup by `orderLinkId`;
- entry trigger-price amendment;
- entry cancellation;
- cleanup verification with no active BTCUSDT orders and position size `0`.

Current limitations:

- position sizing uses the fixed `ABI_FIXED_SMOKE_QTY=0.001` quantity;
- optional stop-loss and take-profit are attached to the entry request, but Abi does not yet verify or repair protection after create or fill;
- the live-execution guard blocks mainnet, so live writes are limited to Bybit demo or testnet environments.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the next development steps and [docs/BBB_CONTRACT.md](docs/BBB_CONTRACT.md) for the current bbb-to-Abi payload contract.

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

`stop_loss` and `take_profit` are optional. The supported shapes are entry only, entry with stop loss, and entry with stop loss plus take profit. Take profit without stop loss is rejected.

Abi calculates the position size internally. For the first smoke version this is a fixed placeholder:

```env
ABI_FIXED_SMOKE_QTY=0.001
```

When protection is present, Abi rejects inverted prices:

- stop-only `long`: `stop_loss < entry`
- stop-only `short`: `entry < stop_loss`
- fully protected `long`: `stop_loss < entry < take_profit`
- fully protected `short`: `take_profit < entry < stop_loss`

Abi allows multiple active intents for the same symbol when they have different `instance_id` values, for example `ema200-touch:BTCUSDT:1h` and `ema500-touch:BTCUSDT:1h`. It rejects a new active intent with an already planned `instance_id`; bbb should update the existing intent instead.

## Bybit balance check

Abi can read Bybit wallet balance without placing orders. See [docs/LOCAL_ENV.md](docs/LOCAL_ENV.md) for safe local credential setup.

```env
BYBIT_ENV=demo
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
    "protection": "planned_attached_to_entry",
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
  "wouldUseProtection": {
    "mode": "attached_full_position_market",
    "stopLoss": {
      "triggerPrice": "60880.0",
      "triggerBy": "LastPrice",
      "orderType": "Market"
    },
    "takeProfit": {
      "triggerPrice": "62000.0",
      "triggerBy": "LastPrice",
      "orderType": "Market"
    }
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
      "orderLinkId": "abi-entry-7f244acccf67c2764391",
      "stopLoss": "60880.0",
      "takeProfit": "62000.0",
      "slTriggerBy": "LastPrice",
      "tpTriggerBy": "LastPrice",
      "tpslMode": "Full",
      "slOrderType": "Market",
      "tpOrderType": "Market"
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
