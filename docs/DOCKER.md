# Docker

Abi can run in Docker for reproducible local checks and future sandbox smoke runs. The image does not contain secrets, `.env` files, or journal state.

## Build Image

```bash
docker build -t abi:local .
```

The Dockerfile installs dependencies inside the build, compiles TypeScript, and runs the compiled service with `npm run start:prod`.

## Safe Dry-Run Container

The base Compose file is safe by default:

- `ABI_DRY_RUN=true`
- `ABI_LIVE_TRADING_ENABLED=false`
- `BYBIT_ENV=testnet`
- no Bybit keys required
- journal mounted from `./var` to `/app/var`

Start it with:

```bash
docker compose up --build
```

In another shell, check health:

```bash
curl "http://127.0.0.1:8787/health"
```

Check execution mode:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

For the safe default, `canExecuteLive` must not be `true`, dry-run should be enabled, live trading should be disabled, and the Bybit environment should be `testnet`.

## Journal Mount

Compose mounts:

```text
./var:/app/var
```

Abi writes the journal to `/app/var/abi_journal.jsonl` in the container, which keeps journal state outside the image. Rebuilding the image does not intentionally delete `./var`.

## Demo Sandbox Container

Demo live mode is an explicit override path:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

The override loads `.env.demo.local` at runtime and sets:

```env
ABI_DRY_RUN=false
ABI_LIVE_TRADING_ENABLED=true
BYBIT_ENV=demo
```

Keep demo credentials only in `.env.demo.local` or runtime environment variables:

```env
BYBIT_API_KEY=your-demo-api-key
BYBIT_API_SECRET=your-demo-api-secret
```

`.env.demo.local` is ignored by Git and must not be committed. The Docker image still excludes `.env` and `.env.*`.

Containerization does not include mainnet deployment, mainnet live enablement, registry publishing, CI/CD, Kubernetes, nginx, or TLS.

## Smoke Against Container

Read-only sandbox smoke checks connectivity and credentials without placing orders. Run it against the container:

```bash
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
npm run smoke:sandbox:read
```

The contract matrix smoke creates, queries, amends, and cancels sandbox orders. Only run it against an explicitly authorized demo/testnet live container. Choose trigger prices far away from the current market so the sandbox order is not expected to execute during the smoke.

```bash
ABI_CONFIRM_TESTNET_WRITE=YES \
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
ABI_SMOKE_SIDE=long \
ABI_SMOKE_ENTRY_PRICE=200000 \
ABI_SMOKE_STOP_PRICE=190000 \
ABI_SMOKE_TAKE_PRICE=220000 \
ABI_SMOKE_TRIGGER_DIRECTION=rises_to \
npm run smoke:sandbox:contract
```

Do not run real Bybit write smoke unless it is separately authorized for the current session.
