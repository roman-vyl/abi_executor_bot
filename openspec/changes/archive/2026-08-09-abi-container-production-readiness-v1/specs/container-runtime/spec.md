## ADDED Requirements

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
