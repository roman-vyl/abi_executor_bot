## Why

When a cycle's own native stop-loss or take-profit fills on Bybit, ABI does not recognise the exit. The open-position lookup sees a filled entry with no live position and returns `internal_error` on every bar, so Runtime keeps the cycle forever (observed on Bybit demo 2026-10-18: BTC cycle `2beec9fd`, stop filled 03:45:21 UTC, `500` from 03:47 on). The close endpoint has the same gap and a worse one: it treats a `Filled` protection leg like a cancelled one, and with a same-side sibling in the scope it would send a market close for this cycle's quantity against the sibling's position.

The same demo check proved the facts are available: the stop child stays in order history with its own `orderId`, `parentOrderLinkId` equal to the entry `orderLinkId`, `orderStatus: "Filled"`, `cumExecQty` equal to the entry quantity, `leavesQty: "0"`, and a matching `Trade` execution.

## What Changes

- ABI proves a cycle's completion for exactly three reasons: `stop_loss` (own native stop fully filled), `take_profit` (own native take-profit fully filled), `runtime_signal` (own close order fully filled, as today).
- The open-position success response gains `closure`: `null` when the position is open or the entry never filled; an object `{strategy_instance_id, trade_cycle_id, reason, order_id, order_link_id, parent_order_link_id}` when completion is proven.
- A filled entry without a proven completion stays `internal_error`. Partial, ambiguous or contradictory evidence is always `internal_error` with no durable write.
- A proven completion is durably recorded on the correlation record (`terminal_closed` plus the closure fields). Later lookups and closes answer from the record with no exchange call.
- Close: before any close order, ABI checks own protection. A proven protection exit terminalizes the record and returns `trade_cycle_closed` with no new order. Any `Filled` or `PartiallyFilled` own protection leg without a full proof blocks every close order (`internal_error`).
- Close success gains the same `closure` field.
- Execution price and time are not part of the contract.

## Capabilities

### Modified Capabilities

- `abi-open-position-lookup-api`: `closure` in the success object.
- `open-position-resolution`: completion proof for a filled, flat cycle; `terminal_closed` answers from the record.
- `close-execution`: protection exit is detected before any close order; no close order while an own protection leg has any fill.
- `abi-position-management-api`: `closure` in the close success object.

## Impact

`openPositionResolutionService.ts`, `closeApplicationService.ts`, `nativeProtectionAttribution.ts`, `orderQueryResponseDecoder.ts` (child `cumExecQty`), a new completion-proof module, `entryPackageExecutionRecord.ts` (three nullable fields), `openPositionApi.ts`, `positionManagementApi.ts`, both OpenAPI documents, tests. Runtime's codecs are exact-field, so Runtime must accept `closure` before this ships (`runtime-trade-cycle-closure-v1`). Entry-cycle recovery (`terminal_after_fill` for a protection exit) is out of scope.
