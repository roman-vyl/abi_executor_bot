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

Set `BBB_DATA_ROOT` to the shared BBB host data root, then build and run the safe dry-run
container:

```bash
export BBB_DATA_ROOT=/path/to/bbb-data
docker compose up --build
```

The base compose file sets `ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`, and
`BYBIT_ENV=testnet`, and requires no Bybit keys. It mounts `${BBB_DATA_ROOT}/abi` to `/app/var`,
which is where the entry-package correlation store lives inside the container (see below).
Repo-local `./var` is not the production/local Compose durable-storage location.

The container process runs as the non-root `node` user (uid/gid 1000, built into the
`node:20-bookworm-slim` base image), not root. Only `/app/var` is owned by that user inside the
image; application code and dependencies stay root-owned and merely readable. The host
`${BBB_DATA_ROOT}/abi` directory (bind-mounted to `/app/var`) needs to be writable by uid/gid
1000, otherwise correlation-store creation/append/replay fails. On a Linux host this may require
an explicit:

```bash
mkdir -p "${BBB_DATA_ROOT}/abi"
chown 1000:1000 "${BBB_DATA_ROOT}/abi"
```

On Docker Desktop (macOS/Windows), bind-mount ownership goes through the
virtualization/file-sharing layer, and a numeric `chown` is usually not needed — only run it if
you actually hit a permission error on first start.

Container logs are structured: every ABI-controlled line is one JSON object
(`timestamp`/`level`/`service`/`event` plus event-specific fields), not free text.

```bash
docker compose logs -f abi
```

A normal startup emits, among others, `service_starting`, `correlation_replay_started`,
`correlation_replay_succeeded`/`correlation_replay_failed`, `readiness_ready`/`readiness_failed`,
and `server_listening`. Correlation-store replay runs asynchronously relative to the HTTP server
starting to listen, so the relative order between `server_listening` and the replay/readiness
events is not a guaranteed contract — the container can already be accepting connections before
`readiness_ready` fires, which is exactly what `/health` (and the container healthcheck) gates
on. A graceful `docker compose stop` emits `shutdown_started` then `shutdown_completed`.
Error-level events (`level: "error"`) go to stderr; everything else goes to stdout.

For an explicit demo-live override:

```bash
export BBB_SECRETS_ROOT=/path/to/bbb-secrets
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

This loads Bybit credentials from `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` on the host and sets
`ABI_DRY_RUN=false`, `ABI_LIVE_TRADING_ENABLED=true`, `BYBIT_ENV=demo`. `BBB_SECRETS_ROOT` is
required only for this Demo Compose path; the base Compose stack above starts with no secrets
root and no Bybit credentials. If `BBB_SECRETS_ROOT` is not set, the Demo Compose command fails
immediately with an explicit `BBB_SECRETS_ROOT must be set` error instead of starting without
credentials.

`${BBB_SECRETS_ROOT}/abi/bybit-demo.env` is the canonical Demo credential location — it is a
host-side file outside the ABI repo checkout and outside `BBB_DATA_ROOT`, never tracked or
copied into the image. It must contain only the two Bybit credential lines:

```bash
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
```

Execution-mode settings (`ABI_DRY_RUN`, `ABI_LIVE_TRADING_ENABLED`, `BYBIT_ENV`) stay in
`docker-compose.demo.yml` as deployment configuration — do not add them to the secret file.

Recommended host setup (example path — express any real path through `BBB_SECRETS_ROOT`):

```bash
mkdir -p "${BBB_SECRETS_ROOT}/abi"
chmod 700 "${BBB_SECRETS_ROOT}"
chmod 700 "${BBB_SECRETS_ROOT}/abi"
chmod 600 "${BBB_SECRETS_ROOT}/abi/bybit-demo.env"
```

## Credential hygiene

- Keep `.env` and other `.env.*` files local; only `.env.example` is tracked, with empty values.
- Keep Demo credentials only in `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` or runtime environment
  variables — never in a tracked file, and never repo-local.
- Use demo-only API credentials with the minimum permissions needed.
- Rotate a credential immediately if it appears in a commit, log, correlation-store file, ZIP,
  screenshot, or shared terminal output.
- Never put credentials in this document, other tracked files, or command examples.

To load credentials locally for non-Docker runs:

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
`ABI_ENTRY_PACKAGE_CORRELATION_PATH` (default `./var/abi_entry_package_correlation.jsonl` for
local, non-Docker runs). In the Docker Compose setup, `${BBB_DATA_ROOT}/abi` on the host is
mounted to `/app/var` in the container, so the store survives container rebuilds and restarts.

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
