## Why

Strategy Runtime needs a stable public HTTP boundary for sending one desired entry package or its explicit absence to ABI. The current ABI signal endpoints are legacy interfaces and do not define this Runtime-facing contract.

## What Changes

- Add a standalone versioned Runtime → ABI endpoint for one ownership-scoped desired entry package.
- Define exact request DTOs for path identifiers, ticker, `DesiredEntry | null`, and `risk_multiplier | null`.
- Define exact success DTOs for `entry_package_applied` and `entry_package_absent`.
- Define one public error envelope, a closed error-code set, and deterministic HTTP status mapping.
- Define request validation for JSON structure, field types, required/nullability rules, the existing Runtime `DesiredEntry` invariants, and the desired-entry/risk-multiplier combination.
- Define safe transport-error serialization without inventing future application error classes.
- Add future OpenAPI and contract-test work for the external API boundary.

Non-goal: internal ABI execution implementation is outside this change.

## Capabilities

### New Capabilities

- `abi-entry-package-api`: Defines the public V1 HTTP transport contract for reconciling a Runtime-owned desired entry package.

### Modified Capabilities

None.

## Impact

- Future public API: one new versioned route with closed request, success, and error schemas.
- Future ABI code: DTOs, transport validation, a thin HTTP handler boundary, response/error serialization, OpenAPI, and contract-level tests.
- Trading safety: a failed or rejected request cannot be serialized as a successful acknowledgement; this change does not define or modify execution behavior.
