## Why

Runtime is to journal every confirmed protection change as `protection_applied`, symmetric with `entry_package_applied`, including the identifiers of the concrete protective orders on the exchange (owner, 2026-10-19). ABI already reads both protective orders (stop and take) from Bybit to prove every protection success, but the success body returns only the echoed `stop_price`/`take_price`. Runtime must get the orders from ABI together with the proof, not reconstruct them.

## What Changes

- The protection `200` success body gets one new required key, `protection_orders`:
  ```
  protection_orders: {
    quantity,                       # position quantity both legs protect
    stop: { order_id, trigger_price },
    take: { order_id, trigger_price }
  }
  ```
- Values are the attributed native protective children that proved the success:
  - `reconciled`: the fresh read-back after the amend;
  - `already_satisfied`: the fresh read that matched without a write.
- `take` is always present: when the request's `take_price` is `null`, it is the dormant surrogate take order ABI keeps on the exchange.
- `quantity` is the cycle's current own filled position quantity, which both legs carry on Bybit (ABI already proves both legs' `qty` equal it). Values are Bybit's own strings (`orderId`, `triggerPrice`, `qty`) unchanged. No `order_link_id`: native children have an empty `orderLinkId`; they are attributed by `parentOrderLinkId`, the entry order's link id that Runtime already has.
- Nothing else changes:
  - no new Bybit request;
  - no change to when protection counts as applied, to the write plan, the surrogate take, the read-back, the live-execution guard, or the error responses;
  - `stop_price`/`take_price` still echo the accepted request strings unchanged;
  - no correlation record change, nothing persisted.

## Capabilities

### Modified Capabilities

- `abi-position-management-api`: the protection success body gains `protection_orders`.
- `protection-execution`: a successful reconciliation returns the two legs that proved it.

## Impact

- **Code:**
  - `services/protection/nativeProtectionReconciliation.ts` (success outcomes carry the proving legs)
  - `services/protection/protectionApplicationService.ts`
  - `domain/positionManagementApi.ts` (`ProtectionConfirmation`, `serializeProtectionApplied`)
  - `docs/openapi/abi-position-management-api-v1.json`
  - tests
- **Runtime:** Runtime's ABI codec accepts exact field sets, so Runtime ships the same key in step (`strategy_runtime` change `runtime-open-trade-journal-v1`, D6): Runtime merges first, ABI and Runtime are deployed together.
