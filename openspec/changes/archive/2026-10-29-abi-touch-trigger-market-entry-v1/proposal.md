## Why

Owner plan 2026-10-28 15:38, audit review 15:59 (thread «Перевести вход на цену закрытия свечи касания»). In
`touch_trigger` the signal is already confirmed by Strategy Engine at the touch-bar close, and Strategy Runtime already
owns the order life cycle through `APPLY` / `CANCEL` / `REPLACE`. A second exchange trigger is not needed. ABI only has
to choose how the entry `APPLY` is executed on Bybit. This is step ABI-1: market entry. ABI-2 (limit entry, price to be
agreed) and ABI-3 (integration checks) are separate changes.

## What Changes

- `mapEntryPackageToBybit()` (`src/exchange/bybitOrderMapper.ts`) is the only order-placement change:

  | config | entry create payload |
  |---|---|
  | `ema_anchor` (default) | unchanged: conditional `Market` with `triggerPrice`, `triggerDirection`, `triggerBy` |
  | `touch_trigger` + `market` | plain `Market`: the same payload without `triggerPrice`, `triggerDirection`, `triggerBy` |
  | `touch_trigger` + `limit` | ABI refuses to start (until ABI-2) |

  Everything else in the payload is kept as is: `category`, `symbol`, `side`, `qty`, `orderLinkId`, `positionIdx`,
  `tpslMode: "Partial"`, `stopLoss`/`slTriggerBy`/`slOrderType: "Market"`, `takeProfit`/`tpTriggerBy`/
  `tpOrderType: "Market"`.
- `BybitCreateOrderPayload`: the three trigger fields become optional at the type level (present only in the
  conditional variant).
- `loadConfig()` fails startup for `touch_trigger` + `limit` with an error saying limit entry is not implemented
  before ABI-2. This refusal is temporary and is removed by ABI-2.
- README / RUNBOOK: what each mode places on Bybit; `limit` refused for now.

## Unchanged

Runtime ↔ ABI contract, `APPLY` / `CANCEL` / `REPLACE`, correlation records, `orderLinkId`, confirmation
(`packageConfirmation.ts`: full fill, partial fill with remainder cancelled, terminal without fill, ambiguous),
recovery, native Partial protection attribution and management, position sizing, close execution. No new config keys,
services, routes or alternative execution paths.

## Safety

`touch_trigger` stays off on the trading stack until a separate Bybit Demo check confirms: plain `Market` with Partial
SL/TP produces `PartialStopLoss` / `PartialTakeProfit` children linked by `parentOrderLinkId`; how fast the fill and
the children appear; how a partial `Market` fill is reported. That check, ABI-2 and the joint Engine/Runtime/ABI
configuration check come before enabling the mode.

## Out of scope

Limit entry (ABI-2), slippage tolerance parameters, Demo check (separate mandatory stage), bbb_stack mount, deployment.

## Archive order

The `container-runtime` delta modifies the requirement added by `abi-live-entry-mode-config-v1`; archive that change
first, then this one.
