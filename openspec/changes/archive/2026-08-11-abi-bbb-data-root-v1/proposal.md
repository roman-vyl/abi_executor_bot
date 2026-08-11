## Why

ABI's durable entry-package correlation store is currently mounted from a repository-local `./var`
host directory in `docker-compose.yml`. That placement ties production/local Compose durable
storage to the repo checkout instead of the shared BBB data root, which the rest of the BBB stack
is moving durable state onto.

## What Changes

Production/local Compose now mounts the ABI correlation store from `${BBB_DATA_ROOT}/abi` on the
host instead of repo-local `./var`, while the container-internal target `/app/var` and
`ABI_ENTRY_PACKAGE_CORRELATION_PATH=/app/var/abi_entry_package_correlation.jsonl` are unchanged.
Correlation record schema, append/replay semantics, trade-cycle lifecycle, position-scope
ownership, and execution behavior are unaffected — this is a host-side storage placement change
only.

Non-goals: correlation repository/schema changes, execution/business logic changes, container-
internal path changes, non-root ownership model changes.

## Impact

Trading-safety and business semantics are unchanged. Operators must set `BBB_DATA_ROOT` and
provision `${BBB_DATA_ROOT}/abi` (writable by uid/gid 1000) before starting the base Compose
stack; repo-local `./var` is no longer the production/local Compose durable-storage location.
