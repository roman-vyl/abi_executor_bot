# Runbook

Operational guide for running, checking, and troubleshooting Abi.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose, for the container path
- Bybit demo or testnet API credentials, only if you intend to exercise live Bybit calls

Install dependencies once:

```bash
npm install
```

## Local startup

```bash
npm run build
npm start
```

By default Abi starts in dry-run mode (`ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`) and
requires no Bybit credentials.

## Docker Compose startup

Build and run the safe dry-run container:

```bash
docker compose up --build
```

The base compose file sets `ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`, and
`BYBIT_ENV=testnet`, and requires no Bybit keys. It mounts `./var` to `/app/var`, which is where
the entry-package correlation store lives inside the container (see below).

For an explicit demo-live override:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

This loads `.env.demo.local` (git-ignored, must not be committed) and sets `ABI_DRY_RUN=false`,
`ABI_LIVE_TRADING_ENABLED=true`, `BYBIT_ENV=demo`. Keep demo credentials only in
`.env.demo.local` or runtime environment variables — never in a tracked file.

## Credential hygiene

- Keep `.env` and other `.env.*` files local; only `.env.example` is tracked, with empty values.
- Use demo-only API credentials with the minimum permissions needed.
- Rotate a credential immediately if it appears in a commit, log, correlation-store file, ZIP,
  screenshot, or shared terminal output.
- Never put credentials in this document, other tracked files, or command examples.

To load credentials locally:

```bash
cp .env.example .env
# edit .env with your demo credentials
set -a
source .env
set +a
```

## Dry-run / live execution guard

Live Bybit writes require all of:

- `ABI_DRY_RUN=false`
- `ABI_LIVE_TRADING_ENABLED=true`
- `BYBIT_API_KEY` and `BYBIT_API_SECRET` set
- `BYBIT_ENV` set to `demo` or `testnet` (mainnet is always blocked)

Check the guard before relying on live behavior:

```bash
curl "http://127.0.0.1:8787/execution/mode"
```

The response's `canExecuteLive` field is `true` only when every condition above holds;
otherwise `blockedReasons` lists what is missing.

## Health and execution-mode checks

```bash
curl "http://127.0.0.1:8787/health"
curl "http://127.0.0.1:8787/execution/mode"
```

`/health` reports `entryPackageReady`, which becomes `true` once the correlation store has
finished replaying on startup. Entry-package and open-position routes are readiness-gated: until
replay completes, they fail closed with an `internal_error` response rather than acting on
state that might not be fully recovered.

## Entry-package correlation storage path

Abi's only durable state is the entry-package correlation store, controlled by
`ABI_ENTRY_PACKAGE_CORRELATION_PATH` (default `./var/abi_entry_package_correlation.jsonl`). In
the Docker Compose setup, `./var` on the host is mounted to `/app/var` in the container, so the
store survives container rebuilds and restarts.

## Read-only sandbox smoke

Checks connectivity and credentials without placing orders:

```bash
ABI_BASE_URL=http://127.0.0.1:8787 \
ABI_SMOKE_SYMBOL=BTCUSDT \
npm run smoke:sandbox:read
```

Expected shape:

```text
mode.bybitEnvironment=demo|testnet
mode.canExecuteLive=<reported value; not required to be true for read-only checks>
health=true
balance=ok
active_orders=ok
open_positions=ok
```

## Local fake entry-package smoke

Exercises the entry-package apply/replace/cancel request sequence against a local fake HTTP
server — no Bybit credentials required, no real orders sent:

```bash
npm run smoke:entry-package:fake
```

## Basic troubleshooting

- **`/health` never reports `entryPackageReady: true`** — check the correlation-store file at
  `ABI_ENTRY_PACKAGE_CORRELATION_PATH` for a non-final corrupt line; replay fails readiness on
  any corruption other than a truncated final line.
- **`/execution/mode` reports `canExecuteLive: false`** — read `blockedReasons` in the response;
  each entry names exactly which condition (dry-run flag, live-trading flag, credentials,
  environment) is unmet.
- **Active-orders, open-positions, or close-all return `skipped_bybit_query`** —
  `BYBIT_API_KEY`/`BYBIT_API_SECRET` are not set; the response's `wouldQueryBybit` field shows
  what would have been sent. The balance route has no such skip path — with missing or invalid
  credentials it calls Bybit and returns whatever error Bybit reports.
- **Container never becomes healthy** — check `docker compose logs abi`; the healthcheck polls
  `GET /health` and fails closed if the process is not listening.
