## 1. abi_executor_bot

- [ ] 1.1 Decoder: `cumExecQty` on `BybitChildOrderCandidate` and `AttachedProtectionLeg`.
- [ ] 1.2 `proveOwnCycleCompletion` per D1, with the execution-list sum for a filled protection leg.
- [ ] 1.3 Correlation record: four nullable closure fields; durable completion write per D2.
- [ ] 1.4 Open-position resolution and response per D3/D5; OpenAPI.
- [ ] 1.5 Close per D4; `neutralizeOwnProtection` never treats a filled leg as clean absence; close success `closure`; OpenAPI.
- [ ] 1.6 Tests: stop and take-profit proofs from the demo shapes of cycle `2beec9fd`; runtime_signal; history lag; partial leg; both legs filled; execution sum mismatch; sibling same-side position with own stop filled (lookup returns closure, close sends no order); repeated lookup and close answer from the record without exchange calls; legacy `terminal_closed` records.

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Deploy after Runtime accepts `closure`. One demo cycle exits by stop or take-profit; the lookup returns the closure with the child `order_id` from Bybit demo Orders and no further `500`.
