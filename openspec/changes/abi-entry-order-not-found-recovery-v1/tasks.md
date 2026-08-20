## 1. Recovery outcome and HTTP contract

- [ ] 1.1 Add `entry_order_not_found` to the typed recovery result and closed HTTP
  response union with all conditional fields null.
- [ ] 1.2 Map only the existing strict exact-own-order `not_found` signal to the new
  outcome while preserving `inconclusive` and all query failures as `internal_error`.
- [ ] 1.3 Keep the new branch read-only: do not persist a correlation transition and do
  not invoke any exchange write primitive.

## 2. Focused verification

- [ ] 2.1 Add resolution tests proving clean realtime+history exact-identity absence
  returns `entry_order_not_found` independently of aggregate position state.
- [ ] 2.2 Add negative tests proving one failed/malformed/mismatched order query remains
  `internal_error`, and a later positive finding resolves through the existing state.
- [ ] 2.3 Add route/codec tests for the fifth closed-union member, null-field invariants,
  and unchanged behavior of the existing four members.
- [ ] 2.4 Assert the GET path issues no create/amend/cancel call for
  `entry_order_not_found`.

## 3. Coordinated rollout validation

- [ ] 3.1 Run `npm test`, `npm run typecheck`, and strict OpenSpec validation.
- [ ] 3.2 After the paired Runtime change is deployed, repeat Phase A without manually
  editing the two stuck correlation records and capture
  `entry_order_not_found → corrective CANCEL → EntryPackageAbsent` for both cycles.
- [ ] 3.3 Confirm both Runtime pending markers clear, no old CREATE is resent, and the next
  genuine bar resumes ordinary fresh reconciliation.
