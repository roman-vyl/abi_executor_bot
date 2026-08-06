# Abi

Abi is the execution service between Strategy Runtime and Bybit.

## Purpose

Abi turns a Runtime-issued desired entry package into real, confirmed Bybit exchange state, and
answers whether a given trade cycle's position is currently open. It owns exchange execution and
its own correlation record of what it has done; it never decides what to trade.

## Responsibilities

- Apply, replace, or cancel a trade cycle's entry order on Bybit, bounded-confirmed before
  acknowledging success.
- Resolve a trade cycle's live open-position state from Bybit, using its own correlation record
  only to know what to ask about.
- Serve read-only account queries (balance, active orders, open positions) and emergency
  cancel-all/close-all actions.
- Enforce a dry-run/live execution guard that blocks all live Bybit writes unless explicitly
  enabled and never allows mainnet.

## Non-responsibilities

- Abi does not decide strategy, sizing policy, or trade-cycle lifecycle — Runtime owns those.
- Abi does not persist anything beyond its own entry-package correlation store.
- Abi does not support multiple concurrent exchange venues.

## Interfaces

- `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`
- `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
- `GET /account/balance`, `GET /account/orders/active`, `GET /account/positions/open`
- `POST /account/orders/cancel-all`, `POST /account/positions/close-all`
- `GET /health`, `GET /execution/mode`

Full wire schemas are in [`docs/openapi/`](docs/openapi/); behavioral contracts are in the
canonical specs under [`openspec/specs/`](openspec/specs/).

## Quick start

```bash
npm install
npm run build
npm start
```

Abi starts in dry-run mode by default and requires no Bybit credentials. Check it is up:

```bash
curl "http://127.0.0.1:8787/health"
```

Or run it in Docker:

```bash
docker compose up --build
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for full startup, credential, and smoke-test instructions.

## Verification

```bash
npm run typecheck
npm run build
npm test
npm run validate:openapi
npm run smoke:entry-package:fake
```

`smoke:entry-package:fake` exercises the entry-package apply/replace/cancel flow against a local
fake server; `smoke:sandbox:read` and `smoke:testnet:read` exercise read-only checks against a
real Bybit demo/testnet account (see [docs/RUNBOOK.md](docs/RUNBOOK.md)).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, ownership, and execution flows.
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — running, configuring, and troubleshooting Abi.
- [docs/openapi/](docs/openapi/) — the public HTTP wire schemas.
- [openspec/specs/](openspec/specs/) — canonical behavioral requirements.
