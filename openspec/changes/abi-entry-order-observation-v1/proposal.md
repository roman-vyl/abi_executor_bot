## Why

Runtime wants a durable history of what it asked ABI to place and what actually exists
on Bybit for that exact trade cycle. Today ABI's responses carry only the intent echo
(`applied_desired_entry`, `calculated_quantity`) and, after a fill, `first_fill_at_ms` and
`average_entry_price`. The order id, the order's observed status, trigger price,
quantity, stop-loss and take-profit, and the executed quantity are read from Bybit
inside the same requests but dropped before the response is built.

This change makes ABI return what it has already read, no more. It adds no polling,
no event journal and no extra Bybit request.

## What Changes

- A new optional response object `cycle_execution_state` describes the physical state
  of one `(strategy_instance_id, trade_cycle_id)`:
  `entry_order` (`order_id`, `side`, `trigger_price`, `quantity`, `order_status`,
  `stop_loss`, `take_profit`) and, when the cycle's own entry order has executed
  quantity, `executed_quantity` and `average_entry_price`.
- It is returned by the existing responses that already read the cycle's own entry
  order: the entry-package applied response, the recovery-state `entry_order_live` and
  `position_open` responses, and the open-position `position_open: true` response.
- **Invariant.** Every quantity, price and status in `cycle_execution_state` is
  attributed to the requested pair through that cycle's own entry order. Nothing in it
  is read from, derived from or checked against Bybit's aggregated position row. When
  no cycle-owned physical object exists in the response, the field is absent.
- The Bybit order decoder additionally reads `orderId` and `side` from the same order
  row it already decodes. Classification of order outcomes does not change.
- Contract evolution is two-step: Runtime accepts the new optional field first
  (separate change in strategy_runtime), then ABI starts emitting it.

## Out of Scope

Per-fill execution lists, fees, `orderLinkId`, generation, child stop-loss and
take-profit order ids or status, position-level stop-loss or take-profit, protection
and close responses, exchange-triggered exits, any new Bybit request, any event
journal in ABI, any change to correlation file format.

## Capabilities

### Modified Capabilities

- `abi-entry-package-api`, `abi-entry-cycle-recovery-api`, `abi-open-position-lookup-api`:
  optional `cycle_execution_state`.

## Impact

- `src/services/entryPackage/orderQueryResponseDecoder.ts`, `packageConfirmation.ts`,
  `entryPackageApplicationService.ts`, `src/domain/entryPackageApi.ts`,
  `src/domain/entryCycleRecoveryApi.ts`, `src/domain/openPositionApi.ts`,
  entry-cycle recovery and open-position resolution services, `docs/openapi/*.json`, tests.
- Existing fields and their meaning are unchanged. Responses without the new field stay valid.
