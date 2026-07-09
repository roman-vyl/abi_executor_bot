## 1. Domain and service types

- [ ] 1.1 Define `ProtectionCheckStatus`, `ProtectionCheckAction`, and `ProtectionCheckResult` in `src/services/protection/protectionTypes.ts`.
- [ ] 1.2 Define the input shape for `verifyPostCreateProtection`, including intent identifiers, execution plan protection, entry `orderLinkId`, side, symbol, and live/dry-run context.
- [ ] 1.3 Ensure result fields cover operator diagnostics without secrets: status, action, signal id, instance id, symbol, side, orderLinkId, requested protection, order/position found flags, position size, stop loss, observed price, reason, attempts, and emergency close metadata.

## 2. Pure decision logic

- [ ] 2.1 Implement `protectionDecision.ts` as a pure function that maps observed order/position/price state to a status and action.
- [ ] 2.2 Cover long stop breach: open long position with observed price less than or equal to stop loss returns close-position action.
- [ ] 2.3 Cover short stop breach: open short position with observed price greater than or equal to stop loss returns close-position action.
- [ ] 2.4 Cover no-position states: pending order found returns verified, pending order missing returns manual-investigation status, and neither closes.
- [ ] 2.5 Cover open position without requested stop: return no-close status and do not treat entry-only strategies as emergency.
- [ ] 2.6 Cover query failure states: return exchange-failed/manual status and never choose blind close.

## 3. Exchange adapter and guarded execution

- [ ] 3.1 Identify and reuse existing entry order query by `orderLinkId`, or add a narrow adapter method if missing.
- [ ] 3.2 Identify and reuse existing position lookup by symbol, or add a narrow adapter method if missing.
- [ ] 3.3 Add or reuse a ticker/market-price lookup for the symbol when the position branch requires stop-breach evaluation.
- [ ] 3.4 Add or reuse a guarded market reduce-only close helper for the exact open position quantity and opposite side.
- [ ] 3.5 Ensure emergency close goes through the existing live guard and cannot bypass mainnet blocking, credential checks, demo/testnet gates, or disabled live trading.

## 4. Verification service

- [ ] 4.1 Implement `verifyPostCreateProtection.ts` to coordinate bounded retry, order query, position query, optional price query, decision logic, and optional emergency close.
- [ ] 4.2 Keep retry short and bounded for read-after-write consistency after Bybit acknowledgement.
- [ ] 4.3 Do not require Bybit pending-order responses to echo attached TP/SL fields for v1 success.
- [ ] 4.4 Return `not_run_dry_run` or equivalent without exchange queries when called in dry-run context.
- [ ] 4.5 Do not call `/v5/position/trading-stop` or any repair path in this change.

## 5. Create-flow integration and API response

- [ ] 5.1 Integrate verification only after successful live create in the existing `POST /signals` use-case flow.
- [ ] 5.2 Preserve failed-create behavior: live create failure must not run post-create verification.
- [ ] 5.3 Preserve dry-run behavior: dry-run must not query Bybit or send emergency close.
- [ ] 5.4 Include `protectionCheck` in successful live create responses.
- [ ] 5.5 Leave `PUT /intents/:signalId`, cancel flow, and operator endpoints unchanged except for any shared types needed by compilation.

## 6. Journal events

- [ ] 6.1 Append `protection_check_started` when the live post-create verification begins.
- [ ] 6.2 Append `protection_check_completed` with the final protection check result.
- [ ] 6.3 Append `protection_check_failed` when exchange queries or verification orchestration fail.
- [ ] 6.4 Append `emergency_close_sent` when Abi sends a guarded reduce-only market close.
- [ ] 6.5 Ensure journal payloads do not contain API secrets.

## 7. Tests

- [ ] 7.1 Add pure decision tests for long breached close, short breached close, no stop no close, no position no close, and query failure no blind close.
- [ ] 7.2 Add service tests with fake exchange adapter for pending order found, pending order missing, immediate safe position, immediate breached position, and exchange query failure.
- [ ] 7.3 Add create-flow tests proving dry-run does not query exchange and failed create does not verify.
- [ ] 7.4 Add response-shape tests proving successful live create includes `protectionCheck` with operator-safe fields.
- [ ] 7.5 Add guard tests proving emergency close uses the guarded execution layer and remains blocked when the live guard blocks writes.

## 8. Verification and smoke boundaries

- [ ] 8.1 Run `npm test`.
- [ ] 8.2 Run `npm run build`.
- [ ] 8.3 Keep existing fake contract smoke green, including create/query/amend/cancel matrix behavior.
- [ ] 8.4 Do not add or run a real Bybit demo emergency-close smoke unless separately authorized with explicit guard, tiny quantity, and cleanup checks.
- [ ] 8.5 Document that `position-trading-stop-repair-v1` or `protection-repair-v1` is the future change for automatic repair.
