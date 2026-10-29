## 1. Code

- [x] 1.1 `BybitCreateOrderPayload`: `triggerPrice`, `triggerDirection`, `triggerBy` optional
- [x] 1.2 `mapEntryPackageToBybit`: trigger fields only in `ema_anchor`; plain `Market` in `touch_trigger` + `market`; throw on `touch_trigger` without `market`
- [x] 1.3 `loadConfig`: `touch_trigger` + `limit` stops startup (temporary until ABI-2)
- [x] 1.4 README / RUNBOOK: payload per mode, limit refused, Demo check before enabling

## 2. Tests (targeted only)

- [x] 2.1 Mapper: `ema_anchor` payload exactly as before (long, short, hedge `positionIdx`)
- [x] 2.2 Mapper: `touch_trigger` + `market` payload has no `triggerPrice`/`triggerDirection`/`triggerBy` keys; all other fields equal to `ema_anchor`
- [x] 2.3 Mapper: query/cancel payloads identical in both modes; throws on `touch_trigger` without `market`
- [x] 2.4 Config: `touch_trigger` + `limit` throws; `ema_anchor` + `limit` and `touch_trigger` + `market` load
- [x] 2.5 Service-level: createOrder in `touch_trigger` + `market` sends the plain Market payload; existing entry-package and config tests green; typecheck clean
