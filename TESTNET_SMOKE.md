# Abi Sandbox Smoke

This checklist is for Bybit demo trading or testnet only. Mainnet live execution is intentionally blocked by the live guard.

Bybit demo trading API keys must use the demo REST domain. Abi selects that domain with:

```env
BYBIT_ENV=demo
```

Load demo credentials from environment variables or an ignored local `.env` file as described in [docs/LOCAL_ENV.md](docs/LOCAL_ENV.md). Do not put credentials in this document or other tracked files.

Testnet keys use:

```env
BYBIT_ENV=testnet
```

## 1. Start Abi In Sandbox Mode

```bash
ABI_HOST=127.0.0.1 \
ABI_PORT=8787 \
ABI_DRY_RUN=false \
ABI_LIVE_TRADING_ENABLED=true \
BYBIT_ENV=demo \
npm start
```

Check the guard:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

`canExecuteLive` must be `true` before any write smoke can run.

## 2. Read-Only Smoke

This checks connectivity and credentials without placing orders:

```bash
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
npm run smoke:sandbox:read
```

Expected shape:

```text
mode.bybitEnvironment=demo
mode.canExecuteLive=true
health=true
balance=ok
active_orders=ok
open_positions=ok
```

## 3. Write Smoke

This creates one stop-market entry intent, queries it by `orderLinkId`, then cancels it.

The script refuses to run unless `ABI_CONFIRM_TESTNET_WRITE=YES` and `/execution/mode` reports both:

- `bybitEnvironment: demo` or `bybitEnvironment: testnet`
- `canExecuteLive: true`

Example:

```bash
ABI_CONFIRM_TESTNET_WRITE=YES \
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
ABI_SMOKE_SIDE=long \
ABI_SMOKE_ENTRY_PRICE=61234.5 \
ABI_SMOKE_STOP_PRICE=60880.0 \
ABI_SMOKE_TAKE_PRICE=62000.0 \
ABI_SMOKE_TRIGGER_DIRECTION=rises_to \
npm run smoke:sandbox:order
```

For a long smoke, prices must satisfy:

```text
stop < entry < take
```

For a short smoke:

```text
take < entry < stop
```

## 4. Amend Smoke

This creates a stop-market entry, queries it, changes its trigger price, queries it again, and cancels it.

The same write guard applies: `ABI_CONFIRM_TESTNET_WRITE=YES` is required, and `/execution/mode` must report a `demo` or `testnet` environment with `canExecuteLive: true`.

Example:

```bash
ABI_CONFIRM_TESTNET_WRITE=YES \
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
ABI_SMOKE_SIDE=long \
ABI_SMOKE_ENTRY_PRICE=61234.5 \
ABI_SMOKE_AMENDED_ENTRY_PRICE=61300.0 \
ABI_SMOKE_STOP_PRICE=60880.0 \
ABI_SMOKE_TAKE_PRICE=62000.0 \
ABI_SMOKE_TRIGGER_DIRECTION=rises_to \
npm run smoke:sandbox:amend
```

For a long smoke, both entry prices must stay between stop and take. For a short smoke, both entry prices must stay between take and stop. Choose sandbox trigger prices that will not execute before the amend and cancel steps finish.

The script prints the create, first query, update, second query, and cancel statuses. When the query responses contain trigger prices, it also prints the initial and amended values. If a step fails after creation starts, it attempts to cancel the entry order automatically.

## 5. Cleanup Check

After the write smoke, confirm there are no remaining active orders for the symbol:

```bash
curl "http://127.0.0.1:8787/account/orders/active?symbol=BTCUSDT"
```
