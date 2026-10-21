## 1. Correlation store

- [ ] 1.1 Add `admission_pending` to `EntryPackageExecutionStatus` and replay validation
  (empty symbol/category, null order identity, generation 0 allowed only for this status).
- [ ] 1.2 Startup conversion: every replayed `admission_pending` is durably moved to
  `absent` before readiness; a failed write fails readiness.

## 2. Entry-package admission

- [ ] 2.1 New pair with non-null desired entry: durable `admission_pending` write before
  instrument resolution.
- [ ] 2.2 `exchangeBoundaryReached` flag in `createOrder`; every pre-boundary failure
  (instrument, quantity, binding mode, scope conflict, hedge assurance) durably writes
  `absent` for an `admission_pending` record, then returns `500 internal_error`.
- [ ] 2.3 `applyLocked` catch: under the pair lock, re-read and apply the same transition
  only when the record is still `admission_pending`.
- [ ] 2.4 Successful path: `save(provisional)` replaces `admission_pending` with
  `pending_create` (same pair, generation 1); `created_at` preserved.

## 3. Recovery and open position

- [ ] 3.1 Recovery-state: `admission_pending` → safe `500`; pre-exchange `absent` →
  `terminal_without_fill` (existing rule); convergence never touches `admission_pending`.
- [ ] 3.2 Open-position lookup: `admission_pending` → no open position, no scope.

## 4. Observability

- [ ] 4.1 `failure_stage` and sanitized `error_cause` on `entry_package`
  `operation_failed`; typed stage carried in the internal result.
- [ ] 4.2 `entry_admission_rejected` event once per persisted pre-exchange `absent`.

## 5. Tests and checks

- [ ] 5.1 Focused tests: each pre-boundary failure → durable `absent`, no Bybit call,
  `500`, recovery `terminal_without_fill`; failure after the boundary unchanged
  (`unknown`); crash simulation with leftover `admission_pending` → startup `absent`;
  in-flight `admission_pending` → recovery `500`; scope finder ignores
  `admission_pending`; failed `absent` write leaves `admission_pending`; event fields
  contain no payloads or secrets.
- [ ] 5.2 `npm test` and `npm run typecheck`.
- [ ] 5.3 Demo check after deploy (on owner's word only): no new orders created by the
  check itself; existing records replay; readiness green.
