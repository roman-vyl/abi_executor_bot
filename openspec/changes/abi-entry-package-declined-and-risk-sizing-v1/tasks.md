## 1. abi_executor_bot

- [x] 1.1 Demo read only: `instruments-info` for BTCUSDT, ETHUSDT, SOLUSDT (`maxOrderQty`, `maxMktOrderQty`) and `account/info` (`marginMode` of our demo account). Record the values in design.md. If the result is ambiguous, do not change the algorithm: report the data to the owner.
- [x] 1.2 Config `ABI_POSITION_SIZING_MODE` (default `minimum`, invalid value fails), `risk` requires keys; mode in `service_starting`; `.env.example`.
- [x] 1.3 `exactDecimal.ts`: `floorRatioToStep`; rules decoder reads `maxMktOrderQty` (fail closed if missing or invalid in `risk` mode only).
- [x] 1.4 Adapter `getAccountInfo` + decoder of `marginMode`; decoder of `totalWalletBalance` for sizing.
- [x] 1.5 Calculator result type; `RiskPercentPositionSizeCalculator` as D3; `FixedMinimumPositionSizeCalculator` returns a quantity unchanged; `server.ts` picks by mode.
- [x] 1.6 Service: declined branch in `createOrder`/`admitNewPair` as D4; serializer and OpenAPI for `entry_package_declined`.
- [x] 1.7 Tests: config (default, risk, invalid, risk without keys); calculator (each reason, rounding down, exact formula with 0.5/1/2, PM and cross allowed, isolated and unknown refused, balance ≤ 0, read failures thrown); service (declined on first APPLY → record `absent`, event, `200` body, recovery `terminal_without_fill`, no exchange write; absent write failure → `500`; existing repeat-call tests unchanged; minimum mode unchanged); OpenAPI contract test.
- [x] 1.8 `npm test`, `npm run typecheck`, `openspec validate --strict`; RUNBOOK and README (mode, formula, net of fees, multi-coin bankroll, isolated refused).

## 2. Rollout (on owner's word only)

- [ ] 2.1 Runtime change `runtime-entry-package-declined-v1` deployed first.
- [ ] 2.2 PR and merge only on the owner's word; deploy with `minimum` (no behavior change).
- [ ] 2.3 Switch the Mac demo to `risk` through `bbb_stack` compose, a separate PR on the owner's word; watch the first entries and declines in the journal.
