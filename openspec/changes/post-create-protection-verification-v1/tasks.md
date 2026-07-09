## 1. Domain and service types

- [ ] 1.1 Define `ProtectionCheckStatus` exactly as `not_run_dry_run`, `pending_order_verified`, `pending_order_not_found`, `pre_existing_position_found`, `position_open_no_stop_requested`, `position_open_stop_not_breached`, `position_open_stop_breached`, `emergency_close_sent`, `emergency_close_failed`, `unsafe_manual_required`, and `exchange_query_failed`.
- [ ] 1.2 Define `ProtectionCheckAction` values for at least `none` and `close_position_market_reduce_only`.
- [ ] 1.3 Define `ProtectionCheckResult` with operator-safe fields for status, action, signal id, instance id, symbol, side, orderLinkId, requested protection, pre-create position state, post-create order/position state, observed price, reason, attempts, emergency close metadata, and error metadata.
- [ ] 1.4 Define the input shape for pre-create snapshot and post-create verification, including intent identifiers, execution plan protection, entry `orderLinkId`, side, symbol, and live/dry-run context.

## 2. Pure decision logic

- [ ] 2.1 Implement `protectionDecision.ts` as a pure function that maps pre-create snapshot, post-create order/position/price state, and close outcome to a status and action.
- [ ] 2.2 Cover pre-create position open: return `pre_existing_position_found`, action `none`, normal guarded create not blocked solely by the snapshot, and emergency close forbidden.
- [ ] 2.3 Cover pre-create position query failure: return `exchange_query_failed`, action `none`, and live create forbidden by the create flow.
- [ ] 2.4 Cover no-position states: pending order found returns `pending_order_verified`, pending order missing returns `pending_order_not_found`, and neither closes.
- [ ] 2.5 Cover post-create open position without requested stop: return `position_open_no_stop_requested` and action `none`.
- [ ] 2.6 Cover long stop breach after pre-create zero: observed price less than or equal to stop loss returns `position_open_stop_breached` and close-position action.
- [ ] 2.7 Cover short stop breach after pre-create zero: observed price greater than or equal to stop loss returns `position_open_stop_breached` and close-position action.
- [ ] 2.8 Cover stop not breached after pre-create zero: return `position_open_stop_not_breached`, action `none`, and do not imply active exchange-side protection is proven.
- [ ] 2.9 Cover price/query failure states: return `exchange_query_failed` or `unsafe_manual_required` and never choose blind close.
- [ ] 2.10 Cover emergency close accepted as final `emergency_close_sent` and emergency close failure as final `emergency_close_failed`.

## 3. Exchange adapter and guarded execution

- [ ] 3.1 Identify and reuse existing position lookup by symbol for the pre-create snapshot, or add a narrow adapter method if missing.
- [ ] 3.2 Identify and reuse existing entry order query by `orderLinkId`, or add a narrow adapter method if missing.
- [ ] 3.3 Identify and reuse existing post-create position lookup by symbol, or add a narrow adapter method if missing.
- [ ] 3.4 Add or reuse a ticker/market-price lookup for the symbol when the newly opened position branch requires stop-breach evaluation.
- [ ] 3.5 Add or reuse a guarded market reduce-only close helper for the exact open position quantity and opposite side.
- [ ] 3.6 Ensure emergency close goes through the existing live guard and cannot bypass mainnet blocking, credential checks, demo/testnet gates, or disabled live trading.
- [ ] 3.7 Ensure close failure returns operator-safe metadata without API secrets.

## 4. Verification service

- [ ] 4.1 Implement the pre-create position snapshot call before live create when verification is enabled.
- [ ] 4.2 If pre-create snapshot query fails, return `exchange_query_failed` and do not send the live create request.
- [ ] 4.3 If pre-create snapshot finds an open/non-zero position, record `pre_existing_position_found`, continue the normal guarded create if otherwise allowed, and ensure emergency close is disabled for this create flow.
- [ ] 4.4 Implement `verifyPostCreateProtection.ts` to coordinate bounded retry, order query, post-create position query, optional price query, decision logic, and optional emergency close.
- [ ] 4.5 Keep retry short and bounded for read-after-write consistency after Bybit acknowledgement.
- [ ] 4.6 Do not require Bybit pending-order responses to echo attached TP/SL fields for v1 success.
- [ ] 4.7 Return `not_run_dry_run` without exchange queries when called in dry-run context.
- [ ] 4.8 Do not call `/v5/position/trading-stop` or any repair path in this change.
- [ ] 4.9 Do not implement watcher, timer, daemon, restart recovery, or post-amend verification.

## 5. Create-flow integration and API response

- [ ] 5.1 Integrate pre-create snapshot and post-create verification in the existing `POST /signals` use-case flow only.
- [ ] 5.2 Preserve failed-create behavior: live create failure must not run post-create order/position verification.
- [ ] 5.3 Preserve dry-run behavior: dry-run must not query Bybit or send emergency close and must report `not_run_dry_run`.
- [ ] 5.4 Include `protectionCheck` in create responses for dry-run, pre-create snapshot failures, pre-existing-position results, and successful live create verification results.
- [ ] 5.5 Ensure a pre-create snapshot failure blocks live create and returns `exchange_query_failed`.
- [ ] 5.6 Leave `PUT /intents/:signalId`, cancel flow, and operator endpoints unchanged except for any shared types needed by compilation.

## 6. Journal events

- [ ] 6.1 Append `protection_check_started` when pre-create or post-create verification begins.
- [ ] 6.2 Append `protection_check_completed` with the final protection check result.
- [ ] 6.3 Append `protection_check_failed` when exchange queries or verification orchestration fail.
- [ ] 6.4 Append `emergency_close_sent` when Abi sends a guarded reduce-only market close.
- [ ] 6.5 Append `emergency_close_failed` when guarded execution or Bybit close fails.
- [ ] 6.6 Ensure journal payloads do not contain API secrets.

## 7. Tests

- [ ] 7.1 Add pure decision tests for pre-create position exists, pre-create query failed, pending order found/no position, pending order missing/no position, no stop/no close, long breached close, short breached close, stop not breached, query failure/no blind close, close sent, and close failed.
- [ ] 7.2 Add service tests with fake exchange adapter for pre-create snapshot blocking create on query failure.
- [ ] 7.3 Add service tests proving pre-existing position returns `pre_existing_position_found` and forbids emergency close.
- [ ] 7.4 Add service tests for pre-create zero followed by post-create pending order verified, newly opened position with no stop, newly opened long breached, newly opened short breached, newly opened stop not breached, and price query failure.
- [ ] 7.5 Add create-flow tests proving dry-run does not query exchange and failed create does not verify post-create state.
- [ ] 7.6 Add response-shape tests proving `protectionCheck` contains operator-safe pre-create, post-create, attempt, and failure metadata.
- [ ] 7.7 Add guard tests proving emergency close uses the guarded execution layer and reports `emergency_close_failed` when the guard blocks writes.

## 8. Verification and smoke boundaries

- [ ] 8.1 Run `npm test`.
- [ ] 8.2 Run `npm run build`.
- [ ] 8.3 Keep existing fake contract smoke green, including create/query/amend/cancel matrix behavior.
- [ ] 8.4 Do not add or run a real Bybit demo emergency-close smoke unless separately authorized with explicit guard, tiny quantity, and cleanup checks.
- [ ] 8.5 Document that `position-trading-stop-repair-v1` or `protection-repair-v1` is the future change for automatic repair.
