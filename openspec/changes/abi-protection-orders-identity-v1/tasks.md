## 1. ABI

- [ ] 1.1 `nativeProtectionReconciliation.ts`: `already_satisfied` and `reconciled` carry the proving `stop` and `take` legs per D2.
- [ ] 1.2 `positionManagementApi.ts`: `ProtectionConfirmation` gains both legs; `serializeProtectionApplied` writes `protection_orders` per D1/D3 and returns `internal_error` on a malformed leg.
- [ ] 1.3 `protectionApplicationService.ts` passes the legs from the outcome.
- [ ] 1.4 OpenAPI: `ProtectionAppliedResponse` gains required `protection_orders` with closed `stop`/`take` schemas and an example; `validate:openapi` passes.
- [ ] 1.5 Tests:
  - `reconciled` returns the read-back legs, not the initial ones or the write plan;
  - `already_satisfied` returns the initial legs, no write;
  - `take_price: null` returns the surrogate take leg;
  - Bybit strings returned unchanged (trailing zeros kept);
  - malformed leg gives `internal_error`;
  - Bybit call count per protection call unchanged;
  - existing tests unchanged apart from the added key.
- [ ] 1.6 `npm test`, `tsc --noEmit`, `validate:openapi`, `openspec validate --all --strict` green.

## 2. Rollout (on owner's word only)

- [ ] 2.1 The Runtime change `runtime-open-trade-journal-v1` merges first; ABI and Runtime are deployed together.
