## Why

ABI always sizes an entry at the exchange minimum (`FixedMinimumPositionSizeCalculator`, `src/risk/positionSizeCalculator.ts`). It was a placeholder. The owner wants to trade on demo (and later mainnet) with real sizes, where each trade risks a percent of the bankroll that Runtime already sends as `risk_multiplier`.

Decisions taken by the owner on 2026-10-25:

- a sizing mode `ABI_POSITION_SIZING_MODE=minimum|risk`, independent of `BYBIT_ENV`, default `minimum`;
- in `risk` mode `risk_multiplier` is the risk percent itself (`0.5` = 0.5 %, `1` = 1 %, `2` = 2 %); ABI has no risk settings of its own (no base percent, no maximum, no coefficients);
- `quantity = (totalWalletBalance × risk_multiplier / 100) / |planned_entry_price − initial_stop_price|`, rounded DOWN to `qtyStep`, exact-decimal, net of fees and slippage;
- the balance is read from Bybit on every calculation, no cache, no fallback; Isolated margin is handled explicitly, never by silent substitution;
- if the entry is impossible ABI answers a new explicit `entry_package_declined` with a reason, never bumps the quantity up to the minimum and never substitutes another risk;
- ABI does not read or change leverage; Bybit manages leverage, margin and execution; no margin reservation or new mutex;
- the mainnet write guard is not touched.

Runtime learns the new answer first (Runtime change `runtime-entry-package-declined-v1`).

## What Changes

- New HTTP `200` success DTO `entry_package_declined` with `decline_reason` and `decline_message`, only for a PUT with a non-null `desired_entry` on a pair that has no correlation record yet (the first APPLY). The pair is durably closed as `absent` before the answer, so its recovery answer is `terminal_without_fill`.
- Closed list of reasons: `insufficient_balance_for_minimum_quantity`, `quantity_above_exchange_maximum`, `invalid_stop_distance`, `margin_mode_not_supported`.
- New config `ABI_POSITION_SIZING_MODE` (`minimum` default, `risk`). `risk` without API key and secret fails startup. Dry-run with keys is allowed (reads only).
- New calculator `RiskPercentPositionSizeCalculator` beside the unchanged `FixedMinimumPositionSizeCalculator`; the calculator port returns either a quantity or a decline.
- Two new reads before the exchange boundary in `risk` mode: `GET /v5/account/info` (`marginMode`) and `GET /v5/account/wallet-balance` (`totalWalletBalance`). Trading rules gain `maxMktOrderQty`.
- A read failure, a Bybit error or a malformed answer stays `500 internal_error` before the boundary (the existing absent-closing path). Only the four predictable refusals become `declined`.

Unchanged: `minimum` mode behavior, request body, scope admission, mutex, correlation schema, confirmation, recovery, protection, close, order shape, leverage, `liveGuard`, testnet.

## Capabilities

### Modified Capabilities

- `abi-entry-package-api`: the declined success DTO.
- `entry-package-execution`: sizing modes, risk sizing, declined refusals and their durable closing.

## Impact

`src/config/config.ts` (+ `serviceStartingEvent.ts`), `src/app/server.ts` (choose the calculator), `src/risk/positionSizeCalculator.ts` (result type, new calculator), `src/domain/exactDecimal.ts` (`floorRatioToStep`), `src/exchange/bybitAdapter.ts` (`getAccountInfo`, wallet balance for sizing) and new decoders, `instrumentTradingRulesResponseDecoder.ts` (`maxMktOrderQty`), `entryPackageApplicationService.ts` (declined branch in `createOrder`/`admitNewPair`), `src/domain/entryPackageApi.ts` (serializer), `docs/openapi/abi-entry-package-api-v1.json`, `.env.example`, `docs/RUNBOOK.md`, README, tests and fakes. No change in other services beyond the Runtime change named above. Turning `risk` on for the Mac demo is a `bbb_stack` compose change, a separate step on the owner's word.
