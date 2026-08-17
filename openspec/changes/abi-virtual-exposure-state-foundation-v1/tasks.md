## 1. Predicates (no type changes)

- [ ] 1.1 Export `isFillFactFinal(observation: EarlyExecutionObservation | null): boolean` from
      `src/services/entryPackage/packageConfirmation.ts`, reusing the existing private
      `isTerminalOrderStatus` (design.md Decision 2). Do not add or modify any field on
      `EarlyExecutionObservation` or `EntryPackageExecutionRecord`.

## 2. Repository: monotonicity validation

- [ ] 2.1 In `EntryPackageCorrelationRepository.save()`, before the durable append, compare the
      incoming record's `early_execution_observation.cumulative_filled_qty` against the
      currently-indexed record for the same pair (if any) and reject (throw) if it is smaller
      (exact-decimal comparison via `compareDecimal` from `src/domain/exactDecimal.ts`) — design.md
      Decision 7. Do not add any check on `avg_execution_price` or `observed_at` (design.md
      Decision 7's closing note: no monotonicity requirement on price).
- [ ] 2.2 In `EntryPackageCorrelationRepository.replay()`'s existing per-line Phase 1 loop, add the
      same check immediately before each line's `indexRecord()` call, comparing against the
      previously-indexed record for that same pair; on violation, return `{ok: false, reason: ...}`
      the same way existing structural/schema corruption already does. Do not touch Phase 2
      (`rebuildScopeIndexFromReplay`) — scope-ownership reconstruction is unaffected by this change
      (design.md Decision 5).

## 3. Repository: additive multi-owner-capable query

- [ ] 3.1 Add `findActiveRecordsForScope(category, symbol): EntryPackageExecutionRecord[]` to
      `EntryPackageCorrelationRepository` as a linear scan over `byCompositeKey.values()`, reusing
      `positionScopeKey` and `isDurablyClosedEntryPackageStatus` (design.md Decision 6). Do not add
      a new maintained index and do not modify `byScope`, `findOwnerByScope`,
      `applyScopeClaimOnWrite`, or `rebuildScopeIndexFromReplay`.

## 4. Test suite

- [ ] 4.1 Partial-then-full-fill sequence for one binding (repeat-PUT revalidation observing the
      same order twice): `cumulative_filled_qty` increases across the two observations;
      `avg_execution_price` may change either direction; `isFillFactFinal` is false after the
      partial observation and true after the full-fill observation.
- [ ] 4.2 `save()` rejects a write whose `cumulative_filled_qty` is less than the previously-indexed
      value for the same pair; accepts a write that only increases or holds it steady, regardless of
      how `avg_execution_price` moves.
- [ ] 4.3 Replay: a valid, monotonically-consistent sequence of lines for one pair replays
      successfully. A sequence containing a `cumulative_filled_qty` regression fails replay closed
      with a descriptive reason.
- [ ] 4.4 `isFillFactFinal`: `null` observation → false; observation with a live `order_status`
      (e.g. `PartiallyFilled`, `New`) → false; observation with a terminal `order_status` (`Filled`,
      `Cancelled`, `Rejected`, `Deactivated`) → true.
- [ ] 4.5 `findActiveRecordsForScope`: seeded directly at the repository level (bypassing
      `EntryPackageApplicationService`), two same-side, non-durably-closed records for the same
      scope under two different pairs are both returned; a durably-closed record for that scope is
      excluded; an empty/no-match scope returns an empty array. This proves the repository layer's
      capability without exercising or relying on any production claim-policy change.
- [ ] 4.6 Full regression: existing `entryPackageCorrelationRepository.test.ts`,
      `entryPackageApplicationService.test.ts`, `closeApplicationService.test.ts`,
      `protectionApplicationService.test.ts`, `openPositionResolutionService.test.ts`, and
      `entryCycleRecoveryResolutionService.test.ts` all pass unchanged — none of them read the new
      predicate or the new query method, and no write path's output changes shape.

## 5. Verification

- [ ] 5.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 5.2 Review the diff to confirm: zero fields added to `EntryPackageExecutionRecord` or
      `EarlyExecutionObservation`; no public HTTP DTO, route, or error-code change;
      `byScope`/`findOwnerByScope`/`applyScopeClaimOnWrite`/`rebuildScopeIndexFromReplay`/
      `EntryPackageApplicationService`'s claim logic are byte-for-byte unmodified;
      `CloseApplicationService`, `OpenPositionResolutionService`, `ProtectionApplicationService`, and
      `EntryCycleRecoveryResolutionService` are untouched; no Runtime- or MDS-facing code is touched.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, listed here only so
it is not mistaken for done:

- The quantity-ownership boundary's actual mechanism: a relative-intent close request contract,
  ABI's resolution of it into an absolute Bybit quantity, and (recommended, for V1) restricting that
  first version to full close only (fraction = 1) — `abi-pair-scoped-close-execution-v1`
  (design.md Decision 3).
- A real, independently-decrementable "owned remaining quantity" field, if and when a genuine
  partial-close lifecycle is ever designed — not before, and not this change (design.md Decision 3).
- Investigating what own-order/execution evidence is sufficient for correct entry-strategy-bar
  identity for Engine — `abi-pair-scoped-open-position-resolution-v1` (design.md Decision 0). Not
  `first_fill_at_ms`/`first_observed_at` durably recorded by this change; that field was considered
  and removed from this change's scope.
- Any consumer (`open-position-resolution`, `close-execution`, `entry-cycle-recovery-resolution`,
  `protection-execution`) actually reading `cumulative_filled_qty` / `avg_execution_price` /
  `isFillFactFinal`.
- Evolving `byScope` toward a multi-owner-capable shape, and any relaxation of
  `EntryPackageApplicationService`'s single-owner claim policy — the delivery plan's activation
  change (design.md Decision 5).
- Any change to `position-scope-exclusivity`'s documented behavior.
- Pair-owned protection orders, conditional stop/take orders, or any protection-execution change.
- Any ABI → Runtime fill push/callback, or Runtime holding/echoing an absolute quantity.

Reviewed and decided against for this change (not open, listed for traceability — design.md
Decisions 0, 1, 2, 3, 5):

- A new `first_observed_at` field and a `mergeExposureObservation` helper. Resolved: removed
  entirely — ABI's own observation timing is not a valid proxy for entry-bar identity, and no other
  consumer needs it; recording it would have shipped a value fit for no actual purpose.
- A new stored `physical_side` field. Resolved: derive from `desired_entry.side`, proven safe by the
  verified nulling invariant.
- A new stored "owned remaining quantity" field now. Resolved: specify the contract only; the field
  itself waits for a genuine partial-close need, which may never arrive if V1 close stays full-close
  only.
- A new durable terminality/finality flag. Resolved: derive from the already-durable `order_status`
  via `isFillFactFinal`.
- Evolving `byScope`'s shape in this change. Resolved: defer to the activation change; prove
  multi-owner representability via a separate, additive, non-indexed query instead.
