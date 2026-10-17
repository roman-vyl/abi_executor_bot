## Context

Facts from the code on `main` (3d46c76):

- Every apply that returns `entry_package_applied` goes through `confirmEntryPackage`
  and then `persistConfirmationOutcome` (`entryPackageApplicationService.ts`), which
  returns `appliedResult(command, desiredEntry, calculated_quantity)`.
- `confirmEntryPackage` reads the cycle's own entry order (realtime, then history) and
  decodes `BybitOrderView{orderStatus, triggerPrice, qty, stopLoss, takeProfit,
  cumExecQty, avgPrice}`. Its outcomes `pending_confirmed`, `full_fill` and
  `partial_fill` do not carry that view out; the values are dropped.
- The order is identified by its own `orderLinkId`, which is built from
  `strategy_instance_id`, `trade_cycle_id`, role and generation. The order belongs to
  exactly one cycle.
- ABI treats the aggregated Bybit position as a sanity check only
  (`docs/ARCHITECTURE.md`).

## Decisions

### D1. Four optional fields in `entry_package_applied`

```json
{
  "status": "entry_package_applied",
  "applied_desired_entry": { … },
  "calculated_quantity": "…",
  "trigger_price": "…",
  "stop_loss": "…",
  "take_profit": "…",
  "quantity": "…"
}
```

Values are the order's own `triggerPrice`, `stopLoss`, `takeProfit` and `qty` as read
back, as exact-decimal text. `stop_loss` and `take_profit` are `null` when Bybit
reports no value (empty or zero). A field the read did not provide is omitted. Nothing
is estimated or copied from the request. `trigger_price` is named after its source, Bybit's `triggerPrice` of the order. It is
deliberately not called `planned_entry_price`, which in this API already means the Engine
intent in `applied_desired_entry`.

### D2. Source and attribution

The values are taken from the item already returned by the confirmation read of the
cycle's own entry order. No value comes from `queryPositionForInstrument` or any other
aggregated source. ABI makes no additional Bybit request for them.

### D3. Where the order read is carried

`confirmEntryPackage` outcomes `pending_confirmed`, `full_fill` and `partial_fill`
carry the decoded order view they already had. `persistConfirmationOutcome` passes it
to `appliedResult`. Other outcomes (terminal, not found, ambiguous) still return
`internal_error` and are unchanged.

### D4. Compatibility

Responses without the fields stay valid. Runtime's decoder rejects unknown keys, so
this change MUST NOT be deployed before the Runtime change that accepts them.
`docs/openapi/abi-entry-package-api-v1.json` gains the four optional properties.

## Risks / Trade-offs

- The values are a point-in-time read; they can change right after the response.
- A repeat PUT that re-confirms an existing order also returns the fields.
- Deploy order mistakes would make Runtime reject ABI responses; D4 states the order.
