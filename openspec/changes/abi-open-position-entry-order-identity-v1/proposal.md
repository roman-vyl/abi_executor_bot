## Why

The open-position lookup tells Runtime that this cycle's own entry order has filled (`first_fill_at_ms`, `average_entry_price`) but not which physical order that was. Runtime is to record the transition to an open trade (`trade_cycle_opened`) as a self-contained observation that a future ABI physical journal can join by order identity, the same way `entry_package_applied` and `trade_cycle_closed` already carry their order ids. Runtime must get the ids from ABI together with the proof, not reconstruct them.

## What Changes

- The `GET .../open-position` success body gets two new keys, `entry_order_link_id` and `entry_order_id`, always present:
  - both `null` unless `position_open` is `true`;
  - `entry_order_link_id` is the `orderLinkId` by which ABI queried the order and its executions to prove this fill;
  - `entry_order_id` is the Bybit `orderId` from the order row matched by that `orderLinkId`, or `null` when no such row was read with the proof.
- The `position_open` recovery-state response gets the same two keys with the same sourcing, because Runtime's recovery path can also move a cycle to an open trade.
- To carry `orderId` where the proof does not re-read the order:
  - the stored `early_execution_observation` gains an optional `order_id`, written from the same confirmation row it is already built from;
  - the recovery entry-order signal gains the `orderId` of the row it already reads.
- When the row behind the proof has no `orderId` (Bybit gave none, or the observation holds no `order_id`), `entry_order_id` is `null`. ABI never substitutes the `order_id` stored from the create response and never re-queries.
- No backward compatibility, data migration or rewrite of stored records. The only accommodation: an observation without the `order_id` key still loads as "order id unknown", because otherwise ABI fails readiness on the existing correlation file.
- Nothing else changes:
  - no new Bybit request;
  - no change to when a position counts as open, to partial-fill handling, to `first_fill_at_ms` or `average_entry_price`, or to the closure or error responses;
  - no other change to the correlation record.

## Capabilities

### Modified Capabilities

- `abi-open-position-lookup-api`: two more keys in the success body.
- `open-position-resolution`: where the two identifiers come from on each path.
- `abi-entry-cycle-recovery-api`: two more keys in the success body, non-null only for `position_open`.

## Impact

- **Code:**
  - `domain/openPositionApi.ts`
  - `services/openPosition/openPositionResolutionService.ts`
  - `services/entryPackage/packageConfirmation.ts` (observation and recovery signal carry `orderId`)
  - `correlation/entryPackageExecutionRecord.ts` (optional `order_id` in the observation, tolerated when absent)
  - `services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`
  - recovery-state serialization
  - `docs/openapi/abi-open-position-lookup-api-v1.json`, `docs/openapi/abi-entry-cycle-recovery-api-v1.json`
  - tests
- **Runtime:** changing ABI's public DTO requires a matching Runtime update. Runtime's ABI codecs accept exact field sets, so Runtime ships the same keys in step:
  - Runtime merges first;
  - ABI and Runtime are deployed together.
- **Spec dependency:** this change modifies requirements that two unarchived changes also modify, `abi-trade-cycle-closure-confirmation-v1` (open-position body) and `abi-entry-order-not-found-recovery-v1` (recovery body). Its deltas are written on top of those versions, so it MUST be archived after both.
