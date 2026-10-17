## Why

`entry_package_applied` now carries four values of the cycle's own entry order (`abi-apply-entry-order-values-v1`), but not which Bybit order they belong to. To link a Runtime record to the physical order without guessing by price or time, the response needs that order's identifiers.

## What Changes

- The applied response adds optional `order_link_id` and `order_id` of the cycle's own entry order, both taken from the confirmation read-back row already used for the four values.
- The order read-back decoder also reads Bybit's `orderId`. A missing or invalid `orderId` is not reported and never changes the confirmation outcome.
- OpenAPI gains the two optional properties.
- The `order_id` stored from the create response is not used for this.

## Capabilities

### Modified Capabilities

- `abi-entry-package-api`: two more optional fields in `entry_package_applied`.

## Impact

`orderQueryResponseDecoder.ts`, `entryPackageApi.ts`, `entryPackageApplicationService.ts`, `docs/openapi/abi-entry-package-api-v1.json`, `scripts/validate-openapi.mjs`, tests. Runtime must accept the fields first (`runtime-apply-entry-order-identity-journal-v1`).
