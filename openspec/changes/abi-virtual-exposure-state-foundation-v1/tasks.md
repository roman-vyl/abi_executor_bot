## 1. Domain type and predicates

- [ ] 1.1 Add `first_observed_at: string | null` to `EarlyExecutionObservation`
      (`src/correlation/entryPackageExecutionRecord.ts`). Update `isValidEarlyExecutionObservation`
      to accept it as optional/nullable on read (design.md Decision 2).
- [ ] 1.2 Add `mergeExposureObservation(priorObservation, freshObservation)` to
      `src/services/entryPackage/packageConfirmation.ts`, next to `toObservation` (design.md
      Decision 2).
- [ ] 1.3 Export `isFillFactFinal(observation)` from `packageConfirmation.ts`, reusing the existing
      private `isTerminalOrderStatus` (design.md Decision 5). Export `isTerminalOrderStatus` itself
      only if needed by 1.2/1.3's own tests — do not export it speculatively otherwise.

## 2. Wire the merge into the two existing observation write sites

- [ ] 2.1 In `EntryPackageApplicationService.persistConfirmationOutcome`'s `full_fill`/`partial_fill`
      branch (`entryPackageApplicationService.ts:605-614`), replace
      `early_execution_observation: confirmation.observation` with
      `early_execution_observation: mergeExposureObservation(record.early_execution_observation,
      confirmation.observation)`.
- [ ] 2.2 In `EntryPackageApplicationService.confirmCancelOutcomeAndPersist`'s `filled_before_cancel`
      branch (`entryPackageApplicationService.ts:550-561`), apply the same change.
- [ ] 2.3 Confirm (read, do not modify) that no other write site sets
      `early_execution_observation` to a non-null value — `persistAbsentNoHistory` and
      `persistTransitionToAbsent` continue to set it to `null` unchanged, and every "unresolved
      outcome" branch (`unknown`, ambiguous, cancelled-with-no-fill) continues to leave it untouched
      via the existing `...record` spread. Add one comment at 2.1 and 2.2 stating why no third call
      site needs the merge (design.md Context, "three observation points" trace).

## 3. Repository: monotonicity/immutability validation

- [ ] 3.1 In `EntryPackageCorrelationRepository.save()`, before the durable append, compare the
      incoming record's `early_execution_observation` against the currently-indexed record for the
      same pair (if any) and reject (throw) on either violation from design.md Decision 8:
      `cumulative_filled_qty` decreasing (exact-decimal comparison via `compareDecimal`), or
      `first_observed_at` changing after being set non-null.
- [ ] 3.2 In `EntryPackageCorrelationRepository.replay()`'s existing per-line Phase 1 loop, add the
      same two checks immediately before each line's `indexRecord()` call, comparing against the
      previously-indexed record for that same pair; on violation, return `{ok: false, reason: ...}`
      the same way existing structural/schema corruption already does (design.md Decision 8). Do not
      touch Phase 2 (`rebuildScopeIndexFromReplay`) — scope-ownership reconstruction is unaffected by
      this change (design.md Decision 6).

## 4. Repository: additive multi-owner-capable query

- [ ] 4.1 Add `findActiveRecordsForScope(category, symbol): EntryPackageExecutionRecord[]` to
      `EntryPackageCorrelationRepository` as a linear scan over `byCompositeKey.values()`, reusing
      `positionScopeKey` and `isDurablyClosedEntryPackageStatus` (design.md Decision 7). Do not add
      a new maintained index and do not modify `byScope`, `findOwnerByScope`,
      `applyScopeClaimOnWrite`, or `rebuildScopeIndexFromReplay`.

## 5. Test suite

- [ ] 5.1 `first_observed_at` lifecycle: first observation of a binding sets it (equal to that
      observation's own `observed_at`); a second, later observation of the same binding (via
      repeat-PUT revalidation) leaves it unchanged while `cumulative_filled_qty`/
      `avg_execution_price` may change.
- [ ] 5.2 Partial-then-full-fill sequence for one binding: `cumulative_filled_qty` increases across
      the two observations; `first_observed_at` is identical across both; `isFillFactFinal` is false
      after the partial observation and true after the full-fill observation.
- [ ] 5.3 `filled_before_cancel` also runs the merge (a fill discovered mid-cancel gets the same
      `first_observed_at` treatment as a fill discovered via revalidation).
- [ ] 5.4 `save()` rejects a write whose `cumulative_filled_qty` is less than the previously-indexed
      value for the same pair; rejects a write whose `first_observed_at` differs from an
      already-set previous value; accepts a write that only increases `cumulative_filled_qty` or
      that leaves `first_observed_at` unchanged.
- [ ] 5.5 Replay: a valid, monotonically-consistent sequence of lines for one pair replays
      successfully and reconstructs the final `early_execution_observation` (including
      `first_observed_at`) correctly. A sequence containing a regression (decreasing
      `cumulative_filled_qty`, or a changed `first_observed_at`) fails replay closed with a
      descriptive reason.
- [ ] 5.6 Backward-compatibility replay: a line whose `early_execution_observation` predates this
      change (no `first_observed_at` key at all) replays successfully with `first_observed_at`
      read as `null`; a line with no `early_execution_observation` at all (pre-fill or never-bound
      record) is unaffected.
- [ ] 5.7 `isFillFactFinal`: `null` observation → false; observation with a live `order_status`
      (e.g. `PartiallyFilled`, `New`) → false; observation with a terminal `order_status` (`Filled`,
      `Cancelled`, `Rejected`, `Deactivated`) → true.
- [ ] 5.8 `findActiveRecordsForScope`: seeded directly at the repository level (bypassing
      `EntryPackageApplicationService`), two same-side, non-durably-closed records for the same
      scope under two different pairs are both returned; a durably-closed record for that scope is
      excluded; an empty/no-match scope returns an empty array. This proves the repository layer's
      capability without exercising or relying on any production claim-policy change.
- [ ] 5.9 Full regression: existing `entryPackageCorrelationRepository.test.ts`,
      `entryPackageApplicationService.test.ts`, `closeApplicationService.test.ts`,
      `protectionApplicationService.test.ts`, `openPositionResolutionService.test.ts`, and
      `entryCycleRecoveryResolutionService.test.ts` all pass unchanged — none of them read the new
      field, the new predicates, or the new query method.

## 6. Verification

- [ ] 6.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 6.2 Review the diff to confirm: no public HTTP DTO, route, or error-code change; no new
      top-level field on `EntryPackageExecutionRecord`; `byScope`/`findOwnerByScope`/
      `applyScopeClaimOnWrite`/`rebuildScopeIndexFromReplay`/`EntryPackageApplicationService`'s claim
      logic are byte-for-byte unmodified; `CloseApplicationService`, `OpenPositionResolutionService`,
      `ProtectionApplicationService`, and `EntryCycleRecoveryResolutionService` are untouched.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, listed here only so
it is not mistaken for done:

- A real, independently-decrementable "owned remaining quantity" field, and the close-time logic that
  decrements it — `abi-pair-scoped-close-execution-v1` (design.md Decision 4).
- Any consumer (`open-position-resolution`, `close-execution`, `entry-cycle-recovery-resolution`,
  `protection-execution`) actually reading `cumulative_filled_qty` / `avg_execution_price` /
  `first_observed_at` / `isFillFactFinal` — the next three changes in the delivery plan, and beyond.
- Evolving `byScope` toward a multi-owner-capable shape, and any relaxation of
  `EntryPackageApplicationService`'s single-owner claim policy — the delivery plan's activation
  change (design.md Decision 6).
- Any change to `position-scope-exclusivity`'s documented behavior.
- Pair-owned protection orders, conditional stop/take orders, or any protection-execution change.

Reviewed and decided against for this change (not open, listed for traceability — design.md
Decisions 1, 3, 4, 5, 6):

- Five new parallel top-level fields on `EntryPackageExecutionRecord`. Resolved: extend the existing
  `EarlyExecutionObservation` instead.
- A new stored `physical_side` field. Resolved: derive from `desired_entry.side`, proven safe by the
  verified nulling invariant.
- A new stored "owned remaining quantity" field now. Resolved: specify the contract; store it only
  when Change 2 first needs a value that can diverge from `cumulative_filled_qty`.
- A new durable terminality/finality flag. Resolved: derive from the already-durable `order_status`
  via `isFillFactFinal`.
- Evolving `byScope`'s shape in this change. Resolved: defer to the activation change; prove
  multi-owner representability via a separate, additive, non-indexed query instead.
