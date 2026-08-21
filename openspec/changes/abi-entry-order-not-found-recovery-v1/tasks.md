## 1. Narrow eligibility and freshness foundation

- [ ] 1.1 Add a strict ambiguous-CREATE predicate covering only
  `status in {pending_create, unknown}`, `pending_action:create`, non-null desired entry,
  exact non-empty order identity, valid binding start, and no durable observation/fill/
  close identity.
- [ ] 1.2 Add strict Bybit server-time decoding and a post-observation freshness check
  requiring non-negative binding age strictly below the documented seven-day window.
- [ ] 1.3 Reuse the existing paginated exact-own execution resolver so found execution
  blocks absence and ambiguous/incomplete execution evidence fails closed.

## 2. Full-budget recovery outcome

- [ ] 2.1 Accumulate `entry_order_not_found` eligibility across all three existing
  recovery attempts instead of returning after the first order `not_found`.
- [ ] 2.2 Require every attempt to have clean exact-order absence, complete clean
  no-execution evidence, and clean non-contradictory aggregate state; taint the candidate
  permanently within the request on any failed/malformed/mismatched result.
- [ ] 2.3 Preserve positive-state priority so a later live, terminal, or fill finding
  supersedes any earlier clean absence.
- [ ] 2.4 Add the fifth typed/HTTP result with all conditional fields null and keep the GET
  free of exchange writes and absence persistence.

## 3. Corrective CANCEL safety

- [ ] 3.1 For `desired_entry:null` against the ambiguous-CREATE shape, require the same
  full order/execution/freshness gate before clean absence can persist `status:absent` or
  return `EntryPackageAbsent`.
- [ ] 3.2 Preserve existing positive behavior: cancel an exact live order; honor terminal
  or fill evidence; return safe error without absence persistence for ambiguous or
  aged-out evidence.
- [ ] 3.3 Prove other record shapes and ordinary cancellation/terminal confirmation retain
  existing behavior.

## 4. Focused verification

- [ ] 4.1 Test all structural exclusions: applied, pending-cancel, create-failed, legacy
  actions, null identity, invalid/future binding time, durable observation/fill/close.
- [ ] 4.2 Test first/second attempt absence followed by later live/fill, and an early
  failed/malformed/mismatched attempt followed by empty reads.
- [ ] 4.3 Test execution found, execution ambiguity, incomplete pagination, and complete
  no-execution evidence.
- [ ] 4.4 Test ages just below, exactly at, and beyond seven days using validated Bybit
  server time for both GET and corrective CANCEL.
- [ ] 4.5 Test that an observation obtained before expiry cannot produce
  `EntryPackageAbsent` when the corrective CANCEL completes at/after expiry.
- [ ] 4.6 Run `npm test`, `npm run typecheck`, and strict OpenSpec validation.

## 5. Coordinated Phase A verification

- [ ] 5.1 Deploy Runtime first, then ABI, without editing the two incident records.
- [ ] 5.2 If still fresh, capture all three clean order/execution attempts, fifth state,
  corrective CANCEL revalidation, exact absence, and marker clearing for both incidents.
- [ ] 5.3 Confirm no old CREATE is resent and the next genuine bar performs ordinary fresh
  reconciliation; if either binding has aged out, confirm it stays fail-closed instead.
