## 1. Domain and protection model

- [ ] 1.1 Add the explicit `attachedProtection` full-position market model to `ExecutionPlan`, populate it from bbb stop-loss/take-profit prices and the configured trigger source, and retain the existing planned-after-fill fields.
- [ ] 1.2 Update every `buildExecutionPlan` caller and test fixture for the narrow trigger-source input without changing fixed sizing or order identity.
- [ ] 1.3 Add `src/services/protection/protectionTypes.ts` with `ProtectionState`, `ProtectionRepairAction`, and `ProtectionCheckResult` unions/types, and verify that no runtime module consumes or executes repair actions.

## 2. Bybit mapping and API responses

- [ ] 2.1 Extend `BybitCreateOrderPayload` and `mapExecutionPlanToBybit` so create requests include bbb prices as `takeProfit`/`stopLoss`, configured TP/SL trigger sources, `tpslMode: "Full"`, and market TP/SL order types; mapper protection fields must come from `attachedProtection`, never `stopLossAfterFill` or `takeProfitAfterFill`.
- [ ] 2.2 Extend `BybitAmendOrderPayload` with optional supported protection fields and map updated entry, take-profit, stop-loss, and trigger-source values to the existing entry `orderLinkId` without adding unsupported amend fields.
- [ ] 2.3 Add `wouldAttachProtection` to all POST `/signals` success, dry-run, and create-failure responses while preserving existing response fields and journal behavior.
- [ ] 2.4 Add `wouldAttachProtection` to all PUT `/intents/:signalId` success, dry-run, and amend-failure responses while preserving existing response fields, validation, and journal behavior.

## 3. Automated tests

- [ ] 3.1 Expand `bybitOrderMapper.test.ts` to assert the exact long create payload, including Buy side, trigger direction `1`, TP/SL prices, trigger sources, Full mode, and market order types.
- [ ] 3.2 Add short mapper coverage asserting Sell side and unchanged valid short take-profit/stop-loss values.
- [ ] 3.3 Add amend mapper coverage asserting the existing entry `orderLinkId` plus updated `triggerPrice`, `takeProfit`, `stopLoss`, `tpTriggerBy`, and `slTriggerBy`.
- [ ] 3.4 Add route/service dry-run response coverage for `wouldAttachProtection` and the exact create/amend previews while confirming no Bybit calls occur.
- [ ] 3.5 Keep risk-guard, failed-create retry, create/query/amend/cancel, fixed-sizing, and mainnet/live-guard regression tests green; add a focused test if any of those guarantees is not already exercised after the change.

## 4. Documentation and sandbox tooling

- [ ] 4.1 Create `docs/ATTACHED_PROTECTION_V1.md` covering motivation, exact create fields, market-only rationale, safety limitations, and future verify/watcher/repair/emergency-close/partial-limit work.
- [ ] 4.2 Update README, `docs/BBB_CONTRACT.md`, `docs/ROADMAP.md`, and `TESTNET_SMOKE.md` to state that bbb still owns absolute prices, Abi attaches market-only Full TP/SL, the future watcher verifies and repairs rather than performing primary placement, and v1 uses `config.bybitTriggerBy` (default `LastPrice`) while separate entry/TP/SL sources remain future work.
- [ ] 4.3 Add guarded executable `scripts/smoke-sandbox-attached-protection.sh` and the `smoke:sandbox:attached-protection` npm command with explicit confirmation, sandbox mode validation, unique IDs, create/query/cancel flow, optional protection-value output, best-effort failure cleanup, and final active-order reporting.
- [ ] 4.4 Add a bounded order-query retry after create and amend acknowledgements (up to five attempts with 0.5-1 second delay) to attached-protection and amend smoke paths because Bybit acknowledgement is asynchronous; missing TP/SL fields must remain informational and must not fail an otherwise successful create/query/cancel/cleanup flow.
- [ ] 4.5 Validate both affected smoke scripts' shell syntax, bounded retry behavior, success criteria, and refusal paths without running a live sandbox order.

## 5. Verification and handoff

- [ ] 5.1 Run `npm test` and resolve all failures.
- [ ] 5.2 Run `npm run build` and resolve all TypeScript errors.
- [ ] 5.3 Review the final diff for accidental secrets, unrelated refactors, removed compatibility fields, or runtime wiring of future repair types.
- [ ] 5.4 Report changed files and verification results, and explicitly leave the live attached-protection smoke unexecuted pending separate operator authorization.
