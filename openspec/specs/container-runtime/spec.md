# container-runtime Specification

## Purpose

Defines the minimal Docker image, Compose runtime defaults, secret handling,
correlation-store persistence, and operator documentation for running Abi in
containers.

## Requirements

### Requirement: Abi provides a reproducible Docker image
Abi SHALL provide a Dockerfile that builds the TypeScript service from source and starts the compiled Abi application without relying on host `node_modules` or host `dist` output.

#### Scenario: Docker build succeeds
- **WHEN** an operator runs `docker build` from the project root
- **THEN** the image builds successfully
- **AND** the build compiles the TypeScript application
- **AND** the image startup command runs the compiled Abi service

#### Scenario: Runtime entrypoint matches compiled service
- **WHEN** the container starts
- **THEN** Abi runs from the compiled `dist/app/index.js` application entrypoint
- **AND** service behavior is unchanged from the non-container compiled startup path

### Requirement: Docker image excludes secrets and local runtime state
Abi SHALL keep secrets, local environment files, local correlation-store state, archives, dependencies, and host build output out of the Docker image build context.

#### Scenario: Environment files are excluded
- **WHEN** `.dockerignore` is evaluated for a Docker build
- **THEN** `.env` is excluded
- **AND** `.env.*` is excluded
- **AND** `.env.demo.local` is excluded

#### Scenario: Local state and generated output are excluded
- **WHEN** `.dockerignore` is evaluated for a Docker build
- **THEN** `var/` is excluded from the image context
- **AND** `archives/` is excluded from the image context
- **AND** `node_modules/` is excluded from the image context
- **AND** `dist/` is excluded from the image context

#### Scenario: Secrets enter only at runtime
- **WHEN** Abi is run in Docker
- **THEN** Bybit API credentials are provided only through Compose `env_file` or explicit runtime environment variables
- **AND** the Docker image does not contain API keys or local `.env` files

### Requirement: Default Compose runtime is safe
Abi SHALL provide a base `docker-compose.yml` that starts the service in a safe non-live mode by default.

#### Scenario: Safe default container starts
- **WHEN** an operator starts the base Compose stack
- **THEN** the Abi container starts without requiring Bybit API keys
- **AND** `ABI_DRY_RUN` is `true`
- **AND** `ABI_LIVE_TRADING_ENABLED` is `false`
- **AND** `BYBIT_ENV` is `testnet`
- **AND** mainnet live execution is not enabled

#### Scenario: Health endpoint is reachable
- **WHEN** the base Compose stack is running
- **THEN** `GET /health` returns an ok response from the containerized Abi service

#### Scenario: Execution mode confirms safe defaults
- **WHEN** the base Compose stack is running
- **THEN** `GET /execution/mode` reports dry-run/live-disabled behavior
- **AND** `canExecuteLive` is not `true`
- **AND** the reported Bybit environment is `testnet`

### Requirement: Explicit runtime configuration fails startup when invalid
Abi SHALL allow documented defaults for missing runtime configuration values, but SHALL fail startup when a configuration value is explicitly present and invalid.

#### Scenario: Missing value uses documented default
- **WHEN** a runtime configuration value is absent
- **THEN** Abi may use that setting's documented default
- **AND** startup may continue if the resulting effective configuration is valid

#### Scenario: Explicit invalid value does not silently fall back
- **WHEN** `ABI_DRY_RUN`, `ABI_LIVE_TRADING_ENABLED`, `BYBIT_ENV`, a port value, or a timeout value is explicitly present but invalid
- **THEN** Abi startup fails
- **AND** Abi does not silently replace that invalid value with a default

### Requirement: Container readiness composes existing ABI execution readiness
Abi SHALL treat container runtime readiness as not ready whenever the existing ABI execution startup or recovery flow leaves `entryPackageReady=false`.

#### Scenario: Startup recovery leaves execution not ready
- **WHEN** startup or recovery completes with `entryPackageReady=false`
- **THEN** the container runtime is not healthy or ready
- **AND** the existing business readiness semantics remain unchanged

### Requirement: Production process shuts down gracefully on termination signals
Abi SHALL handle `SIGTERM` and `SIGINT` through the normal shutdown path.

#### Scenario: Termination signal stops new traffic and closes the server
- **WHEN** the process receives `SIGTERM` or `SIGINT`
- **THEN** Abi stops accepting new HTTP requests
- **AND** Abi closes the HTTP server
- **AND** the process exits through its normal shutdown path

### Requirement: Standalone default host is loopback
Abi SHALL default standalone and local runtime host binding to `127.0.0.1`, while container deployment explicitly configures `0.0.0.0` when external container reachability is intended.

#### Scenario: Local default host does not expose all interfaces
- **WHEN** Abi runs without an explicit host override in standalone or local mode
- **THEN** it binds to `127.0.0.1`

#### Scenario: Container runtime explicitly opts into all-interface binding
- **WHEN** Abi is deployed in a container for external reachability
- **THEN** the deployment explicitly sets host binding to `0.0.0.0`

### Requirement: Correlation store persists outside the image on the shared BBB data root
Abi SHALL keep its entry-package correlation store outside the Docker image by mounting a host
runtime directory under the shared BBB data root into the container, and repo-local `./var`
SHALL NOT be the production/local Compose durable-storage location.

#### Scenario: Correlation store path is mounted from the BBB data root
- **WHEN** the base Compose stack starts
- **THEN** the host `${BBB_DATA_ROOT}/abi` path is mounted at `/app/var`
- **AND** the mount is writable
- **AND** entry-package correlation data written by Abi is outside the image layer
- **AND** rebuilding the image does not intentionally delete host correlation-store data

#### Scenario: Container-internal path and correlation semantics are unchanged
- **WHEN** the host-side mount source moves from repo-local `./var` to `${BBB_DATA_ROOT}/abi`
- **THEN** the container-internal target remains `/app/var`
- **AND** `ABI_ENTRY_PACKAGE_CORRELATION_PATH` remains `/app/var/abi_entry_package_correlation.jsonl`
- **AND** correlation record schema, append/replay semantics, and non-root ownership model are unchanged

#### Scenario: Repo-local ./var is not the production/local durable location
- **WHEN** an operator inspects production/local Compose configuration or operational docs
- **THEN** repo-local `./var` is not documented or configured as the production/local Compose
  durable-storage location

### Requirement: Demo live startup is explicit
Abi SHALL provide an explicit demo Compose override path for sandbox live runs that uses a local env file and does not affect the safe default Compose path.

#### Scenario: Demo override uses local env file
- **WHEN** an operator starts Abi with `docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build`
- **THEN** Compose loads `.env.demo.local` at runtime
- **AND** the image still does not contain `.env.demo.local`
- **AND** demo live settings come from runtime environment values

#### Scenario: Demo live does not enable mainnet
- **WHEN** the demo override is used
- **THEN** the documented sandbox environment is `demo`
- **AND** mainnet live execution remains out of scope
- **AND** the existing live guard is not bypassed

### Requirement: Container operation is documented in the runbook
Abi SHALL document how to build, run, and verify the container without committing secrets.

#### Scenario: Safe Docker workflow is documented
- **WHEN** an operator reads `docs/RUNBOOK.md`
- **THEN** the docs include how to build the image
- **AND** how to start the safe dry-run container
- **AND** how to check `/health`
- **AND** how to check `/execution/mode`

#### Scenario: Demo workflow is documented
- **WHEN** an operator reads `docs/RUNBOOK.md`
- **THEN** the docs include the demo startup command using `docker-compose.yml` plus `docker-compose.demo.yml`
- **AND** the docs explain that demo credentials are supplied by `.env.demo.local`
- **AND** the docs state that containerization does not include mainnet deployment

#### Scenario: Read-only smoke against the container is documented
- **WHEN** an operator reads `docs/RUNBOOK.md`
- **THEN** the docs include running the read-only sandbox smoke against `ABI_BASE_URL=http://127.0.0.1:8787`

### Requirement: Existing non-Docker verification remains green
Abi SHALL preserve existing local verification behavior outside Docker.

#### Scenario: Local tests and fake smoke remain green
- **WHEN** implementation of this change is complete
- **THEN** `npm test` passes outside Docker
- **AND** `npm run build` passes outside Docker
- **AND** `npm run smoke:entry-package:fake` passes outside Docker
