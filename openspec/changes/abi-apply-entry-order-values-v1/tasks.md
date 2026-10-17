## 1. abi_executor_bot

- [ ] 1.1 Carry the decoded order view through the `pending_confirmed`, `full_fill` and `partial_fill` confirmation outcomes.
- [ ] 1.2 Add the four optional fields to `EntryPackageAppliedResponse` and `appliedResult`; empty or zero stop-loss and take-profit become `null`.
- [ ] 1.3 Update `docs/openapi/abi-entry-package-api-v1.json`.
- [ ] 1.4 Tests: pending order, already-filled order, repeat PUT; values equal the order read, not the request; an aggregated position with a different size, stop-loss and take-profit never appears; adapter call counts unchanged; non-applied outcomes unchanged.

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Runtime change deployed first. ABI on Bybit demo.
- [ ] 2.2 One apply on demo; the four values in the response match the order in Bybit demo Orders.
