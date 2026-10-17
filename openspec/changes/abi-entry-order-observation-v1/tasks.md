## 1. abi_executor_bot

- [ ] 1.1 Decode `orderId` and `side` optionally in `orderQueryResponseDecoder.ts`; no change to classification.
- [ ] 1.2 Add a `CycleExecutionState` type and mapper from `BybitOrderView` (D1, D2); stop-loss/take-profit empty or zero maps to `null`.
- [ ] 1.3 Carry the read item through `confirmEntryPackage` outcomes and through recovery signals; add `cycle_execution_state` to applied and recovery `entry_order_live`/`position_open` responses.
- [ ] 1.4 Add `executed_quantity` to the open-position `position_open: true` response from the cycle's own fill facts.
- [ ] 1.5 Update `docs/openapi/*.json` for the three APIs.
- [ ] 1.6 Tests: pending, partial fill, full fill, cancel-with-fill unchanged, recovery states, open-position; aggregated position row with a different size/SL/TP never appears in any response; no extra Bybit calls (adapter call counts unchanged).

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Runtime change deployed first. ABI on Bybit demo.
- [ ] 2.2 One strategy, three real 5m bars with an entry change; the `order_id` in the response matches the order in Bybit demo Orders.
