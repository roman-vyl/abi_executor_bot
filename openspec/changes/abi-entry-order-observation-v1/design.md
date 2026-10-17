## Context

Audit 2026-10-17 (thread "Trade Observatory"), code on `main` (3d46c76):

- ABI is pair-scoped (`docs/ARCHITECTURE.md`): each `(strategy_instance_id, trade_cycle_id)`
  has its own entry order (own `orderLinkId`). The aggregated Bybit position is a
  sanity/veto check only, never ownership proof (`virtual-exposure-state` spec).
- `BybitOrderView` (`orderQueryResponseDecoder.ts`) already carries `orderStatus`,
  `triggerPrice`, `qty`, `stopLoss`, `takeProfit`, `cumExecQty`, `avgPrice` for the
  cycle's own order. It does not decode `orderId` or `side`.
- `confirmEntryPackage` returns `pending_confirmed` with no data
  (`packageConfirmation.ts`), although the item was just read. `full_fill`/`partial_fill`
  carry only a derived observation. `appliedResult` returns the intent echo only.
- Recovery (`entryCycleRecoveryResolutionService.ts`) composes
  `RecoveryEntryOrderSignal`; `live_unfilled` carries nothing, `live_with_fill` and
  `terminal_with_fill` carry `averageEntryPrice` and `cumulativeFilledQty`.
- Open-position resolution reads the cycle's own fill facts from the stored
  observation or one fresh read of its own order (`resolveOwnFillFacts`). For a cycle
  without a fill it answers `closed` without a Bybit call.

## Goals / Non-Goals

Goals: return, inside existing requests, the physical state of the requested cycle's own
entry order. Non-goals: everything in the proposal's Out of Scope.

## Decisions

### D1. One optional object, `cycle_execution_state`

```json
"cycle_execution_state": {
  "entry_order": {
    "order_id": "…", "side": "Buy",
    "trigger_price": "…", "quantity": "…", "order_status": "Untriggered",
    "stop_loss": "…|null", "take_profit": "…|null"
  },
  "executed_quantity": "…",
  "average_entry_price": "…"
}
```

`executed_quantity` and `average_entry_price` are present only when the cycle's own
entry order has strictly positive `cumExecQty` and a usable `avgPrice`. All decimals are
exact-decimal text. `stop_loss`/`take_profit` are `null` when Bybit reports no value
(empty or zero). Nothing is fabricated: a field the read did not provide is `null`
(entry_order fields) or absent (execution fields).

### D2. Attribution invariant

The object is built only from a read of the cycle's own entry order, identified by its
`orderLinkId`. The aggregated position row (`queryPositionForInstrument`) is never a
source for any value in it, including `confirmedStopLoss`/`confirmedTakeProfit` that the
open-position service already passes internally. When ABI cannot resolve the pair to a
physical order, the response has no `cycle_execution_state`.

### D3. No additional Bybit requests

The object is assembled from the order read that each path already performs. Paths that
do not read the order today do not gain a read:

- Entry-package applied (`pending_confirmed`, `full_fill`, `partial_fill`): attach the
  read item to the confirmation outcome and map it.
- Recovery `entry_order_live` and `position_open`: the order signal carries the same
  fields. If a path cannot fill a field without a new request, the field is `null`.
- Open-position `position_open: true`: only `executed_quantity` is added (next to the
  existing `average_entry_price`), from `ownFacts.cumulativeFilledQty`. This response
  does not carry `entry_order`. Pending cycles still get `closed` with no Bybit call
  and no object.
- Responses of cancel, protection and close are unchanged.

### D4. Decoder reads `orderId` and `side`

The same order row already decoded now also yields `orderId` and `side`. A missing or
invalid value there never changes order classification; it only makes the corresponding
response field `null`. `order_id` here is Bybit's own id from the read-back, not the
create response.

### D5. Compatibility

All additions are optional. The Runtime closed-field decoders (`_require_exact_fields`)
reject unknown keys, so this change MUST NOT be deployed until the Runtime change that
accepts the field is deployed. OpenAPI documents under `docs/openapi/` gain the schema.

## Risks / Trade-offs

- Status in `entry_order` is a point-in-time read at response time; it can change right
  after. Accepted: it is an observation, not state ABI owns.
- A fill that happens between order read and response is invisible until a later response.
- Deploy ordering mistakes would make Runtime reject ABI responses. Mitigation: D5 order,
  verified on the demo stack before the pin bump.
