## MODIFIED Requirements

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

#### Scenario: Missing BBB_DATA_ROOT fails explicitly
- **WHEN** `BBB_DATA_ROOT` is not set and an operator runs Compose
- **THEN** Compose fails with an explicit `BBB_DATA_ROOT must be set` error
- **AND** Compose does not silently substitute an empty host path for the mount source
