## 1. ABI

- [x] 1.1 `packageConfirmation.ts`: `EarlyExecutionObservation` optional `order_id` (D4); the `RecoveryEntryOrderSignal` fill variants carry `orderId` (D5).
- [x] 1.2 `entryPackageExecutionRecord.ts`: validator tolerates an observation without `order_id`; apply-time writers set it from `confirmation.order.orderId` (`""` → `null`).
- [x] 1.3 `openPositionResolutionService.ts` and `domain/openPositionApi.ts`: return `entry_order_link_id` / `entry_order_id` per D1–D3 on every open result, `null` on every other result.
- [x] 1.4 Recovery-state resolution and serialization: the two keys for `position_open` per D5, `null` for other states.
- [x] 1.5 OpenAPI: both documents gain the two required nullable keys with examples; `validate-openapi` passes.
- [x] 1.6 Tests:
  - fresh path open (row `orderId` returned, `""` → `null`);
  - reuse path with stored `order_id`;
  - reuse path with an observation without `order_id` (`entry_order_id: null`, no Bybit call);
  - create-ack `order_id` never returned;
  - recovery `position_open` with and without row `orderId`;
  - every non-open result has both `null`;
  - the number of Bybit calls per lookup is unchanged on every path;
  - existing tests unchanged apart from the two added keys.
- [x] 1.7 `npm test`, `tsc --noEmit`, `validate:openapi`, `openspec validate --all --strict` (1.10.0) green.

## 2. Rollout

- [ ] 2.1 The Runtime change that accepts the two keys merges first; ABI and Runtime are deployed together.
