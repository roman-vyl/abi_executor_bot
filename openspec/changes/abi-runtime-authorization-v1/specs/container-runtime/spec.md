## MODIFIED Requirements

### Requirement: Container readiness composes existing ABI execution readiness
Abi SHALL expose process liveness separately from execution readiness. Docker health SHALL use GET /health/live. GET /health/ready SHALL report execution readiness. GET /health SHALL retain its existing readiness meaning for callers.

#### Scenario: Healthy process awaits credentials
- **WHEN** ABI awaits credentials, verifies a candidate, or has not completed necessary trading startup checks
- **THEN** /health/live returns 200 and Docker health can become healthy
- **AND** /health/ready returns 503 while /health retains its existing readiness meaning
- **AND** Runtime and the ordinary deployment can start without an operator password

#### Scenario: Execution recovery fails
- **WHEN** a live process cannot complete the existing execution startup checks
- **THEN** /health/ready returns 503
- **AND** process liveness alone does not enable trading

#### Scenario: Restart loses the authorization session
- **WHEN** protected ABI restarts after deploy, a crash, or Mac restart
- **THEN** the process starts LOCKED and stays available for later authorization
- **AND** the stack deployment requires no password
