## 1. Signal contract and domain model

- [x] 1.1 Make `stop_loss` and `take_profit` optional in the parsed signal model, accept entry-only, stop-only, and stop-plus-take shapes, and reject take-profit-only input.
- [x] 1.2 Make risk validation shape-aware for long and short entry-only, stop-only, and fully protected signals without changing fixed sizing.
- [x] 1.3 Replace `stopLossAfterFill` and `takeProfitAfterFill` with the single `ExecutionPlan.protection` union (`none` or `attached_full_position_market`) and update every builder, reader, fixture, and journal payload guard.

## 2. Bybit mapping and intent responses

- [x] 2.1 Map entry-only plans without any TP/SL fields.
- [x] 2.2 Map stop-only plans with `stopLoss`, `slTriggerBy`, `slOrderType: "Market"`, and `tpslMode: "Full"`, while omitting all take-profit fields.
- [x] 2.3 Map stop-plus-take plans with both prices, both configured trigger sources, both market order types, and Full mode, reading only `ExecutionPlan.protection`.
- [x] 2.4 Update `BybitAmendOrderPayload` and the PUT flow to send the desired entry/protection state on the existing entry `orderLinkId`, including explicit Bybit removal values for omitted protection legs.
- [x] 2.5 Replace planned-after-fill response fields in POST and PUT dry-run, live success, and failure bodies with one protection preview and the exact mapped Bybit payload.

## 3. Automated tests

- [x] 3.1 Add parser and risk tests for entry-only, stop-only, stop-plus-take, invalid take-only, and invalid long/short price ordering.
- [x] 3.2 Add execution-plan tests proving `protection` is the only source of truth and no planned-after-fill fields are produced.
- [x] 3.3 Add mapper tests for entry-only payload without TP/SL fields, stop-only payload, and stop-plus-take payload for long and short sides.
- [x] 3.4 Add amend tests for updating entry/stop/take together and explicitly removing take profit or all protection on PUT.
- [x] 3.5 Add route/service dry-run and failure response tests for the single protection preview, and keep create/query/amend/cancel, failed-create retry, sizing, and guard regressions green.

## 4. Documentation

- [x] 4.1 Create or update `docs/ATTACHED_PROTECTION_V1.md` with the three supported signal shapes, conditional Bybit fields, market-only Full mode, trigger-source behavior, and explicit non-goals.
- [x] 4.2 Update README and `docs/BBB_CONTRACT.md` so bbb owns optional absolute protection prices and take profit requires stop loss in v1.
- [x] 4.3 Update `docs/ROADMAP.md` and `TESTNET_SMOKE.md` to describe `protection-verification-and-repair-v1` as the next separate change; do not add or run verification/retry/watcher/repair logic in this change.

## 5. Verification and handoff

- [x] 5.1 Run `npm test` and resolve all failures.
- [x] 5.2 Run `npm run build` and resolve all TypeScript errors.
- [x] 5.3 Review the final diff for secrets, planned-after-fill remnants, duplicate protection sources, unrelated refactors, or accidental verification/repair runtime behavior.
- [x] 5.4 Report changed files and verification results; do not run live smoke or commit without separate authorization.
