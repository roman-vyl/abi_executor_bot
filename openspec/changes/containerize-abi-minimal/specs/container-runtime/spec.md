## ADDED Requirements

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
- **AND** trading runtime behavior is unchanged from the non-container compiled startup path

### Requirement: Docker image excludes secrets and local runtime state
Abi SHALL keep secrets, local environment files, local journals, archives, dependencies, and host build output out of the Docker image build context.

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

### Requirement: Journal state persists outside the image
Abi SHALL keep journal state outside the Docker image by mounting a host runtime directory into the container.

#### Scenario: Journal path is mounted
- **WHEN** the base Compose stack starts
- **THEN** the host `./var` path is mounted at `/app/var`
- **AND** journal data written by Abi is outside the image layer
- **AND** rebuilding the image does not intentionally delete host journal data

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

### Requirement: Docker documentation covers safe operation and smoke verification
Abi SHALL include Docker documentation that explains how to build, run, verify, and smoke-test the container without committing secrets.

#### Scenario: Safe Docker workflow is documented
- **WHEN** an operator reads `docs/DOCKER.md`
- **THEN** the docs include how to build the image
- **AND** how to start the safe dry-run container
- **AND** how to check `/health`
- **AND** how to check `/execution/mode`
- **AND** how to confirm `.env.demo.local` is not committed

#### Scenario: Demo workflow is documented
- **WHEN** an operator reads `docs/DOCKER.md`
- **THEN** the docs include the demo startup command using `docker-compose.yml` plus `docker-compose.demo.yml`
- **AND** the docs explain that demo credentials are supplied by `.env.demo.local`
- **AND** the docs state that containerization does not include mainnet deployment

#### Scenario: Smoke commands against container are documented
- **WHEN** an operator reads `docs/DOCKER.md`
- **THEN** the docs include commands for running `smoke:sandbox:read` against `ABI_BASE_URL=http://127.0.0.1:8787`
- **AND** the docs include commands for running `smoke:sandbox:contract` against `ABI_BASE_URL=http://127.0.0.1:8787`
- **AND** the docs state that real Bybit write smoke requires separate explicit authorization

### Requirement: Existing non-Docker verification remains green
Abi SHALL preserve existing local verification behavior outside Docker.

#### Scenario: Local tests and fake smoke remain green
- **WHEN** implementation of this change is complete
- **THEN** `npm test` passes outside Docker
- **AND** `npm run build` passes outside Docker
- **AND** `npm run smoke:contract:fake` passes outside Docker

#### Scenario: Trading behavior is unchanged
- **WHEN** Abi is run outside Docker after this change
- **THEN** the bbb signal contract is unchanged
- **AND** Bybit payload mapping is unchanged
- **AND** protection verification behavior is unchanged
- **AND** sizing behavior is unchanged
- **AND** mainnet live guard behavior is unchanged
