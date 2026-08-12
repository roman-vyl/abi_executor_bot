## Why

Demo Bybit credentials currently live in the repo-local `.env.demo.local` file referenced by
`docker-compose.demo.yml`. Repo-local placement ties Demo credentials to the ABI checkout instead
of a shared host-side secrets location, the same problem `BBB_DATA_ROOT` already solved for
durable correlation-store state. The rest of the BBB stack is standardizing on a shared secrets
root outside any individual repo.

## What Changes

Demo Compose now loads Bybit credentials from `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` on the
host instead of repo-local `.env.demo.local`. `BBB_SECRETS_ROOT` is required only for the Demo
Compose path (`docker-compose.yml` + `docker-compose.demo.yml`); the base safe Compose path keeps
starting with no secrets root set. The secret file itself carries only `BYBIT_API_KEY` and
`BYBIT_API_SECRET` — execution-mode overrides (`ABI_DRY_RUN`, `ABI_LIVE_TRADING_ENABLED`,
`BYBIT_ENV`) stay in `docker-compose.demo.yml` as deployment configuration, not secrets.

Non-goals: ABI application/config code changes (`src/config/config.ts` and how it reads
`BYBIT_API_KEY`/`BYBIT_API_SECRET` from `process.env` are unchanged), correlation-store/
`BBB_DATA_ROOT` behavior changes, execution/business logic changes, mainnet scope changes.

## Impact

Trading-safety and business semantics are unchanged. Operators must set `BBB_SECRETS_ROOT` and
provision `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` (mode `600`, containing only the two Bybit
credential lines) before starting the Demo Compose override; repo-local `.env.demo.local` is no
longer the canonical Demo credential location. The base Compose path is unaffected and keeps
working with no secrets root and no Bybit credentials.
