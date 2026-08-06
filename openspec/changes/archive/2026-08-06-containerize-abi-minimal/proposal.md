## Why

Abi is now stable enough to need a reproducible container runtime for local verification, future demo smoke, and operator handoff. Minimal Docker packaging makes the service easier to start consistently without changing trading behavior or embedding credentials.

## What Changes

- Add a minimal Docker runtime path for Abi:
  - `Dockerfile` for building and running the compiled TypeScript service.
  - `.dockerignore` that excludes secrets, local environment files, journals, archives, dependencies, and build output that should not be copied from the host.
  - `docker-compose.yml` with a safe default configuration.
  - Optional `docker-compose.demo.yml` for explicit demo runs using `.env.demo.local`.
  - `docs/DOCKER.md` with build, run, health, mode, and smoke instructions.
  - A short README section linking to Docker documentation.
- Keep the default Compose runtime safe:
  - `ABI_DRY_RUN=true`.
  - `ABI_LIVE_TRADING_ENABLED=false`.
  - `BYBIT_ENV=testnet`.
  - no API keys required or embedded.
- Preserve journals outside the image with `./var:/app/var`.
- Provide an explicit demo live path through:
  - `docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build`
  - `.env.demo.local` supplied at runtime and never committed.
- Review current package scripts and add `start:prod` only if a clearer production-dist entrypoint is needed.

Non-goals:

- no trading runtime behavior changes;
- no bbb contract changes;
- no Bybit payload changes;
- no protection verification changes;
- no sizing changes;
- no watcher, repair loop, or lifecycle daemon;
- no CI/CD, registry push, Kubernetes, nginx, or TLS;
- no mainnet deployment or mainnet live enablement;
- no real Bybit write smoke without separate authorization.

## Capabilities

### New Capabilities

- `container-runtime`: Defines the minimal Docker image, Compose runtime defaults, secret handling, journal persistence, and operator documentation for running Abi in containers.

### Modified Capabilities

- None.

## Impact

- Files: adds Docker and Compose files, Docker docs, and a short README link section.
- Package scripts: may add `start:prod` as an alias for the compiled `dist/app/index.js` entrypoint if useful; current `npm start` already points at `dist/app/index.js`.
- Runtime behavior: unchanged. Containerization only packages the existing service.
- API behavior: unchanged for `/signals`, `/health`, `/execution/mode`, intent endpoints, account endpoints, and Bybit payloads.
- Trading safety: default container mode is dry-run with live trading disabled; demo live requires an explicit override file and local env file.
- Secrets: Docker image must not contain `.env`, `.env.*`, API keys, or local journals.
- Journal state: `./var:/app/var` keeps append-only journal data outside the image and reusable across container restarts.
- Idempotency/recovery: no new recovery model is introduced; existing intent and journal semantics remain authoritative.
- Mainnet guard: unchanged and not enabled by this change.
