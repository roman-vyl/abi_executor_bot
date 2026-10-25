## Context

- `PositionSizeCalculator.calculate(...)` is called once per create, in `createOrder` (`entryPackageApplicationService.ts`), before the scope claim and before the durable provisional `pending_create` write (the exchange boundary). A thrown error or a `500` before the boundary on a first PUT closes the pair `absent` (`admitNewPair` → `closeRejectedAdmission`), and recovery answers `terminal_without_fill`.
- The entry is a conditional Market order (`orderType: Market` + `triggerPrice`). Bybit reserves no margin for it and cancels it at trigger if margin is short; ABI already treats Rejected/Deactivated/Cancelled as terminal without fill.
- `getWalletBalance` (`bybitAdapter.ts`) already calls `GET /v5/account/wallet-balance`; it is used only by `GET /account/balance`. Reads are allowed in every environment; `liveGuard` blocks writes only.
- Bybit V5 docs (github.com/bybit-exchange/docs, commit 19518b9): `totalWalletBalance` is an account-level USD sum of all coins' wallet balances, without unrealised PnL; "All account wide fields are not applicable to isolated margin"; account totals do not depend on the `coin` filter. `GET /v5/account/info` returns `marginMode`: `ISOLATED_MARGIN`, `REGULAR_MARGIN` (cross) or `PORTFOLIO_MARGIN`; both endpoints are available on demo. `lotSizeFilter.maxMktOrderQty` is the maximum for Market orders, `maxOrderQty` for Limit and PostOnly.

## Decisions

- **D1 Mode is configuration, not environment.** `ABI_POSITION_SIZING_MODE` = `minimum` (default when unset) or `risk`; any other value fails startup. `risk` requires `BYBIT_API_KEY` and `BYBIT_API_SECRET` at startup. The mode is added to the `service_starting` event. Four combinations demo/mainnet × minimum/risk exist; mainnet writes stay blocked by `liveGuard` until a separate decision.
- **D2 Calculator port returns a quantity or a decline.** `calculate(...)` returns `{ kind: "quantity", quantity }` or `{ kind: "declined", reason, message }`. `FixedMinimumPositionSizeCalculator` keeps its formula and always returns a quantity. `server.ts` picks the calculator by mode. Read failures keep being thrown errors.
- **D3 Risk formula, in order, exact-decimal.**
  1. `distance = |planned_entry_price − initial_stop_price|`. `distance = 0`, or the stop on the wrong side (long: stop ≥ entry; short: stop ≤ entry) → `invalid_stop_distance`. Checked first, with no exchange call.
  2. `GET /v5/account/info`: `marginMode` `REGULAR_MARGIN` or `PORTFOLIO_MARGIN` continues; `ISOLATED_MARGIN` or any other value → `margin_mode_not_supported`. No silent switch to a per-coin balance.
  3. `GET /v5/account/wallet-balance` with the configured `BYBIT_ACCOUNT_TYPE`: `totalWalletBalance` must be exact-decimal text; `≤ 0` → `insufficient_balance_for_minimum_quantity`.
  4. `quantity = floorRatioToStep(totalWalletBalance × risk_multiplier / 100, distance, qtyStep)`.
  5. `quantity = 0`, `quantity < minOrderQty`, or `quantity × planned_entry_price < minNotionalValue` → `insufficient_balance_for_minimum_quantity`.
  6. `quantity > maxMktOrderQty` → `quantity_above_exchange_maximum`.
  No cache for steps 2 and 3. Trading rules keep their existing TTL cache.
- **D4 Declined only on the first APPLY.** The declined answer is returned only from `admitNewPair` (the record is `admission_pending`). ABI first moves the record to `absent` with the existing conditional transition, emits the operational event `entry_package_declined` (reason, message), then answers `200 entry_package_declined`. If the `absent` write fails, ABI answers `500 internal_error` (existing rule). The new declined answer is supported only on initial admission. Repeat calls on an existing record keep their existing semantics; this change adds no separate logic for them (Runtime mints a new `trade_cycle_id` for every new attempt and does not repeat an APPLY on the same pair).
- **D5 Unpredictable failures stay errors.** Timeout, network error, Bybit `retCode ≠ 0`, or a malformed or empty answer of either read → thrown → `500 internal_error` before the boundary → `absent`, recovery `terminal_without_fill` (existing path). The owner's rule "no internal_error for predictable refusals" is kept: these are not predictable.
- **D6 Message carries the numbers.** `decline_message` is plain text with the values used, for example `quantity 0.0004 below minOrderQty 0.001 (wallet 1000, risk 1%, distance 250)`. No secrets.
- **D7 Retry recalculates.** Every create recalculates with fresh balance and margin mode, as today.

## Assumption to verify (task 1.1)

The docs say `maxMktOrderQty` applies to Market orders. ABI's entry is a Market order with a trigger; the docs do not say explicitly that the same limit applies to the conditional form. Task 1.1 reads `instruments-info` for BTCUSDT, ETHUSDT, SOLUSDT on demo (read only) and records both limits. The check stays on `maxMktOrderQty`; if 1.1 shows `maxOrderQty < maxMktOrderQty` for a traded symbol, the owner decides whether to use the smaller one.

## Risks

- `totalWalletBalance` counts every coin; if the demo account holds BTC or ETH, the bankroll moves with their price. Documented in the RUNBOOK.
- Net risk: fees and slippage make the real loss larger than the percent. Documented.
- Two more reads per create add latency before the boundary (each bounded by `ABI_BYBIT_REQUEST_TIMEOUT_MS`).
- Several open strategies can together exceed the margin; Bybit then cancels a conditional order at trigger, which ABI already handles as terminal without fill.
