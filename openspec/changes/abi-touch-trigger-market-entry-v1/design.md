## Context

Audit of main 35773c5 (owner-reviewed 15:59):

- One entry path: `EntryPackageApplicationService.createOrder` → `mapEntryPackageToBybit` → `executeEntryOrder` →
  `/v5/order/create`. The mapper already receives `AbiConfig`. The other two mapper calls (`repeatPutRevalidate`,
  `metadataOnlyUpdate`) use only its query/cancel payloads.
- The "parent" is the entry order itself; Bybit creates native `PartialStopLoss` / `PartialTakeProfit` children from
  its `tpslMode: "Partial"` SL/TP and ABI attributes them by `parentOrderLinkId`. There is no separate ABI parent
  entity and no separate order type to configure.
- `confirmEntryPackage` classifies by order status and `cumExecQty`, so an immediate fill, a partial fill whose
  remainder was cancelled, a terminal order without fill and an inconclusive read are already handled. Protection
  quantity is read from the actual filled quantity. Runtime treats `trigger_price` in the acknowledgement as optional.

## Decisions

- **Switch point = the mapper.** `mapEntryPackageToBybit` builds the common payload once, then adds `triggerPrice`,
  `triggerDirection`, `triggerBy` only when `config.liveEntryMode === "ema_anchor"`. With `touch_trigger` +
  `market` none of the three keys is present (absent, not empty or zero). `ema_anchor` output stays byte-for-byte as
  today, key order included.
- **Type.** `BybitCreateOrderPayload` keeps `orderType: "Market"`; `triggerPrice`, `triggerDirection`, `triggerBy`
  become optional. No union with a limit variant yet (ABI-2).
- **`limit` refused at startup, not per request.** `loadConfig` throws when `live_entry_mode` is `touch_trigger` and
  `touch_trigger_entry_order_type` is `limit`, so the service never starts with a configuration it cannot execute.
  `ema_anchor` + `limit` stays valid (the type is unused there). The mapper still fails closed (throws) if it ever
  receives `touch_trigger` without `market`, as a guard against a config built outside `loadConfig`. ABI-2 removes
  the startup refusal.
- **Mode is read at each call from the config loaded at start.** Switching = edit file + restart, as in ABI-0. A
  restart with a live conditional order from the other mode needs no special handling: confirmation, cancel and
  recovery work by `orderLinkId` and do not depend on the order type.

## Risks

- Market fills as taker at a price different from `planned_entry_price`; sizing still uses `planned_entry_price` and
  the stop, so realised risk can differ slightly. Accepted; measured on Demo.
- Bybit Market is an IOC limit with price protection: partial fill is possible. Covered by existing confirmation;
  verified on Demo.
- Child creation for plain Market + Partial SL/TP is a Demo fact, not provable from code.
