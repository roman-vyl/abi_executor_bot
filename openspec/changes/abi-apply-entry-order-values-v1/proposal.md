## Why

The `entry_package_applied` response tells Runtime only what Runtime asked for
(`applied_desired_entry`) and the quantity ABI calculated. It does not say what ABI
actually found on Bybit for that trade cycle's own entry order. ABI already reads that
order inside the same request to confirm the apply, and then discards the values.

This change returns four of those values in the same response, so Runtime can record
what was actually placed. Nothing else changes.

## What Changes

- The `entry_package_applied` response gains four optional fields describing the
  trade cycle's own entry order as read back from Bybit during the apply:
  `planned_entry_price`, `stop_loss`, `take_profit`, `quantity`.
- All four come only from the read of that cycle's own entry order (found by its own
  `orderLinkId`). None comes from Bybit's aggregated position.
- No additional Bybit request is made. The read that confirms the apply already
  returns these values.
- Contract evolution is two-step: Runtime accepts the optional fields first (separate
  change in strategy_runtime), then ABI emits them.

## Out of Scope

Order id, order status, executed quantity, average entry price, the cancel, recovery
and open-position responses, child stop-loss/take-profit orders, protection and close,
any change to correlation records, any new Bybit request.

## Capabilities

### Modified Capabilities

- `abi-entry-package-api`: four optional fields in the applied response.

## Impact

- `src/services/entryPackage/packageConfirmation.ts` (outcomes carry the order read),
  `entryPackageApplicationService.ts` (`appliedResult`), `src/domain/entryPackageApi.ts`,
  `docs/openapi/abi-entry-package-api-v1.json`, tests.
- Existing fields and responses are unchanged.
