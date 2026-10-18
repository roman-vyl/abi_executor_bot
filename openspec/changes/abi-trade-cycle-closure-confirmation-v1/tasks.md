## 1. abi_executor_bot

- [ ] 1.1 Decoder: child `cumExecQty` on `BybitChildOrderCandidate` and `AttachedProtectionLeg`; protection class mapping per D1.
- [ ] 1.2 `proveOwnCycleCompletion` per D2, with the execution-list sum for a filled protection leg and `order_id` from the own close order's read-back row.
- [ ] 1.3 Correlation record: four nullable closure fields written only with `terminal_closed`; D3 answers for new and legacy records; `persistTerminal` writes `runtime_signal` on the existing close success.
- [ ] 1.4 Open-position resolution per D4; response `closure` per D6; OpenAPI.
- [ ] 1.5 Close per D5: first proof after steps 1–3; protection class gate; re-resolution after cancels with no acceptance of `none`; postconditions require neutralized; close success `closure`; OpenAPI.
- [ ] 1.6 Tests: demo stop shape of cycle `2beec9fd`; take-profit; runtime_signal found while a sibling holds the slot; history lag; partial leg; both legs filled; execution sum mismatch; filled leg with the other still live; stop fills during neutralization; `none` after accepted cancel; sibling same-side with own partial stop (no order); repeated lookup and Close answer from the record with no exchange call; legacy `terminal_closed` records; unchanged normal close with active protection.

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Deploy after Runtime accepts `closure`. One demo cycle exits by stop or take-profit; the lookup returns the closure with the child `order_id` from Bybit demo Orders and no further `500`.
