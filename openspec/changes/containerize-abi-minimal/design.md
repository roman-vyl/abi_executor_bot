## Context

Abi is a TypeScript Node.js service that already runs from compiled output with `npm start`, currently mapped to `node dist/app/index.js`. The project has stable local verification points: unit tests, TypeScript build, fake BBB contract smoke, Bybit demo/testnet smoke, post-create protection verification, and the existing mainnet live guard.

The containerization goal is intentionally narrow: package the existing service so it can be built and started reproducibly for local safe dry-run operation and future demo smoke. The image must not contain local secrets, `.env` files, journal data, or host build artifacts.

## Goals / Non-Goals

**Goals:**

- Build an Abi Docker image from source and run the compiled service.
- Keep image contents free of `.env`, `.env.*`, API keys, journals, archives, local dependencies, and host build output.
- Provide a safe default Compose path with dry-run enabled, live trading disabled, and `BYBIT_ENV=testnet`.
- Persist journal state outside the image via `./var:/app/var`.
- Provide an explicit demo Compose override that uses `.env.demo.local` at runtime.
- Document safe dry-run startup, health checks, execution-mode checks, demo startup, and smoke commands against the container.
- Preserve existing trading runtime behavior, API contracts, protection verification, sizing, and mainnet guard semantics.

**Non-Goals:**

- No changes to `/signals`, intent handling, Bybit mapping, protection verification, sizing, or bbb payload contracts.
- No new watcher, repair loop, process supervisor, lifecycle daemon, or restart recovery behavior.
- No CI/CD, registry publishing, Kubernetes, nginx, TLS, or production mainnet deployment.
- No inclusion of secrets in image layers.
- No automatic real Bybit write smoke execution during implementation.

## Decisions

### Use the existing compiled Node entrypoint

The Docker image should run the same compiled entrypoint used locally: `dist/app/index.js`. Since current `npm start` already runs `node dist/app/index.js`, adding `start:prod` is optional rather than required for correctness. If added, it should be a clear alias and not change runtime behavior.

Alternative considered: run TypeScript directly in the container. That would make the runtime image depend on development tooling and would not match the compiled production path.

### Build in the image, run from compiled output

The Dockerfile should install dependencies, run the TypeScript build, and start the compiled service. The implementation may use a single-stage or multi-stage Node image, but the resulting runtime should not rely on host `dist` or host `node_modules`.

Alternative considered: copy host `dist` into the image. That is less reproducible and can package stale local output, so the image should build from source.

### Keep secrets and local state out of the image

`.dockerignore` must exclude `.env`, `.env.*`, `var/`, `archives/`, `node_modules/`, `dist/`, logs, and local OS/editor noise. Secrets must enter only through Compose `env_file` or explicit environment values at container runtime.

Alternative considered: copy `.env.example` into the image. That file is non-secret, but it is not required for running the service and keeping the image context minimal is clearer.

### Make Compose safe by default

`docker-compose.yml` should start Abi with:

- `ABI_DRY_RUN=true`
- `ABI_LIVE_TRADING_ENABLED=false`
- `BYBIT_ENV=testnet`
- no API keys
- a host bind mount from `./var` to `/app/var`
- a host port mapping suitable for local checks, expected to expose Abi on `127.0.0.1:8787`

Choosing `testnet` for the safe default keeps the configured exchange environment non-mainnet while avoiding any implication that demo credentials are present. Because dry-run is enabled and live trading is disabled, the default container path must not place orders.

Alternative considered: default to `demo`. Demo is useful for later live smoke, but it implies a credential-backed sandbox account. The base Compose file should be able to start safely without keys.

### Use a separate demo override for live sandbox runs

`docker-compose.demo.yml` should be an explicit override that loads `.env.demo.local`. The documented command should combine the base and demo files:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

The demo env file is local and ignored by Git. It may set `ABI_DRY_RUN=false`, `ABI_LIVE_TRADING_ENABLED=true`, `BYBIT_ENV=demo`, and Bybit credentials when the operator intentionally wants demo live mode.

Alternative considered: put `env_file: .env.demo.local` in the base Compose file. That would make the default path depend on a secret-bearing local file and would blur the safe default.

### Document smoke commands against the container

`docs/DOCKER.md` should include:

- image build command;
- safe dry-run container startup;
- `/health` check;
- `/execution/mode` check showing dry-run/live-disabled mode;
- demo startup using `.env.demo.local`;
- read-only smoke against the container using `ABI_BASE_URL=http://127.0.0.1:8787`;
- contract matrix smoke against the container using `ABI_CONFIRM_TESTNET_WRITE=YES` only for explicit demo/testnet live mode;
- a note that `.env.demo.local` is not committed;
- a note that this change does not deploy or enable mainnet.

The docs should state that real Bybit write smoke is not run unless separately authorized.

## Risks / Trade-offs

- [Docker context accidentally includes secrets] -> Use `.dockerignore` to exclude `.env`, `.env.*`, journals, archives, and local output; docs must repeat that secrets enter only at runtime.
- [Default Compose mode accidentally enables live trading] -> Hard-code safe defaults in `docker-compose.yml` and verify `/execution/mode`.
- [Journal state disappears on container rebuild] -> Bind-mount `./var:/app/var`.
- [Demo override is confused with safe default] -> Keep it in a separate file and document the combined Compose command.
- [Smoke scripts target the wrong service] -> Docs must set `ABI_BASE_URL=http://127.0.0.1:8787` for container smoke.
- [Containerization hides runtime regressions] -> Verification keeps `npm test`, `npm run build`, and `npm run smoke:contract:fake` green outside Docker, then verifies Docker build/start/health/mode separately.
- [Mainnet expectations creep into container docs] -> Explicitly state no mainnet deployment or mainnet live enablement.

## Migration Plan

No data migration is required. Operators can continue running Abi locally with existing npm commands. Container usage is additive: build the image, start safe Compose, and optionally use the demo override with local credentials.

Rollback is removing or ignoring the Docker files and docs; no runtime state or API contract migration is involved.

## Open Questions

- Whether to add `start:prod` as a readability alias even though `npm start` already runs the compiled `dist/app/index.js` entrypoint.
