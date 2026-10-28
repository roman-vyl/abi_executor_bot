## 1. Code

- [x] 1.1 `BybitCreateOrderPayload`: `orderType: "Market" | "Limit"`, optional `price`, `timeInForce`
- [x] 1.2 `alignEntryLimitPrice(price, tickSize, side)` with `ceilToStep` / `floorToStep`
- [x] 1.3 `EntryPackageApplicationService`: inject the existing rules provider (server wiring), compute the limit price before the provisional write in `touch_trigger` + `limit`; lookup failure = pre-boundary error
- [x] 1.4 Mapper: Limit shape (`price`, `timeInForce: "GTC"`, no trigger fields), other fields as Market; throw in `createOrder` path when the price is missing
- [x] 1.4a Query/cancel payload helper split out of the mapper (identical payloads) for `repeatPutRevalidate` / `metadataOnlyUpdate`
- [x] 1.5 `loadConfig`: remove the `touch_trigger` + `limit` startup refusal
- [x] 1.6 README / RUNBOOK: three shapes, rounding rule, both V1 limitations

## 2. Tests (targeted only)

- [x] 2.1 Rounding: on-grid price unchanged (long and short); off-grid long up, short down; small tick (e.g. 0.0001)
- [x] 2.2 Mapper: exact Limit payload; equals the market payload except `orderType`, `price`, `timeInForce`; `ema_anchor` and `market` payloads unchanged; query/cancel payloads equal
- [x] 2.3 Service: Limit APPLY sends the aligned price; rules lookup failure → no create, record closed as absent; live `New` → applied; immediate full fill → applied; `PartiallyFilled` → applied with fresh filled qty
- [x] 2.4 Config: `touch_trigger` + `limit` loads
- [x] 2.5 Existing entry-package, protection, config tests green; typecheck clean
