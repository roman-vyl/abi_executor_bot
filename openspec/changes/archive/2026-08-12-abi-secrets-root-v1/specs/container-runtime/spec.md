## MODIFIED Requirements

### Requirement: Demo live startup is explicit
Abi SHALL provide an explicit demo Compose override path for sandbox live runs that loads Bybit
credentials from a host-side secrets root outside the repository and outside the BBB data root,
and does not affect the safe default Compose path.

#### Scenario: Demo override uses the host secrets root
- **WHEN** an operator starts Abi with `docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build`
- **THEN** Compose loads `${BBB_SECRETS_ROOT}/abi/bybit-demo.env` at runtime
- **AND** the image still does not contain the secret file
- **AND** demo live settings come from runtime environment values

#### Scenario: Demo secret file carries only credentials
- **WHEN** an operator inspects `${BBB_SECRETS_ROOT}/abi/bybit-demo.env`
- **THEN** the file contains only `BYBIT_API_KEY` and `BYBIT_API_SECRET`
- **AND** execution-mode settings (`ABI_DRY_RUN`, `ABI_LIVE_TRADING_ENABLED`, `BYBIT_ENV`) are not
  in the secret file
- **AND** those execution-mode settings remain deployment configuration in
  `docker-compose.demo.yml`

#### Scenario: Missing BBB_SECRETS_ROOT fails explicitly on the Demo path
- **WHEN** `BBB_SECRETS_ROOT` is not set and an operator runs the Demo Compose override
- **THEN** Compose fails with an explicit `BBB_SECRETS_ROOT must be set` error
- **AND** Compose does not silently substitute an empty or missing host path for the env file

#### Scenario: Base Compose path does not require the secrets root
- **WHEN** an operator starts the base Compose stack without the Demo override
- **THEN** `BBB_SECRETS_ROOT` is not required
- **AND** the safe default startup behavior (dry-run, live trading disabled, testnet) is unaffected

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
- **AND** the docs explain that demo credentials are supplied by
  `${BBB_SECRETS_ROOT}/abi/bybit-demo.env`, not by any repo-local file
- **AND** the docs document the recommended host secrets-root permissions setup
  (`mkdir -p`, `chmod 700` on the directories, `chmod 600` on the secret file)
- **AND** the docs state that containerization does not include mainnet deployment

#### Scenario: Read-only smoke against the container is documented
- **WHEN** an operator reads `docs/RUNBOOK.md`
- **THEN** the docs include running the read-only sandbox smoke against `ABI_BASE_URL=http://127.0.0.1:8787`
