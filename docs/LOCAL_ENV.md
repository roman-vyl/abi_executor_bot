# Local Environment

Abi reads configuration from environment variables. Keep Bybit credentials in your shell environment or in an ignored local `.env` file; never add them to tracked files.

Use credentials created for Bybit demo trading. Demo credentials must be paired with `BYBIT_ENV=demo`; testnet and mainnet credentials use different API domains.

## Option 1: Export variables in the shell

```bash
export BYBIT_ENV=demo
export BYBIT_API_KEY="your-demo-api-key"
export BYBIT_API_SECRET="your-demo-api-secret"
export ABI_DRY_RUN=false
export ABI_LIVE_TRADING_ENABLED=true

npm run build
npm start
```

Leave `ABI_DRY_RUN=true` and `ABI_LIVE_TRADING_ENABLED=false` unless you intentionally want Abi to submit demo orders.

## Option 2: Use a local `.env` file

Create an ignored local file from the committed empty template:

```bash
cp .env.example .env
```

Set the required values in `.env`:

```env
BYBIT_ENV=demo
BYBIT_API_KEY=your-demo-api-key
BYBIT_API_SECRET=your-demo-api-secret
ABI_DRY_RUN=false
ABI_LIVE_TRADING_ENABLED=true
```

Abi does not load `.env` files automatically. Export the file into the current shell before starting the service:

```bash
set -a
source .env
set +a

npm run build
npm start
```

Confirm the effective execution guard before running a smoke test:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

For demo writes, `bybitEnvironment` must be `demo` and `canExecuteLive` must be `true`. See [TESTNET_SMOKE.md](../TESTNET_SMOKE.md) for the guarded read and write checks.

## Credential hygiene

- Keep `.env` and other `.env.*` files local. Only `.env.example` is tracked, with empty values.
- Use demo-only API credentials with the minimum permissions needed for the smoke test.
- Rotate a credential immediately if it appears in a commit, log, journal, ZIP, screenshot, or shared terminal output.
- Do not store credentials in journal files or command examples.
