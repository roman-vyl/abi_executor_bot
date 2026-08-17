## 1. Config

- [ ] 1.1 Add `positionExposureDriftToleranceQty: string` to `AbiConfig` (`src/config/config.ts`), read
      from `ABI_POSITION_EXPOSURE_DRIFT_TOLERANCE_QTY`, default `"0"`, validated at load time as
      non-negative exact-decimal text (fail startup on a malformed value, mirroring this file's existing
      `readPositiveNumberString`-style validation for other numeric-string fields) — design.md Decision 4.

## 2. Domain: request/response contract

- [ ] 2.1 In `src/domain/positionManagementApi.ts`, change `CloseCommand` to
      `{ strategyInstanceId: string; tradeCycleId: string; exposureFraction: string }`.
- [ ] 2.2 Change `validateCloseCommand` to also accept `payload: unknown` (mirroring
      `validateProtectionCommand`'s signature), validate the body is a closed JSON object with exactly
      `exposure_fraction` (required, non-null, exact-decimal text per `isExactDecimalText`, numerically
      equal to `1` per `decimalEquals(value, "1")`) — design.md Decision 6. Reuse
      `validateClosedObject`/`joinJsonPointer` exactly as `validateProtectionCommand` does; do not add a
      literal-string `"1"` check.
- [ ] 2.3 Add `"position_exposure_drift"` to `PositionManagementErrorCode` and a
      `positionExposureDriftResult()` helper (422), mirroring `positionNotOpenResult()` — design.md
      Decision 7.
- [ ] 2.4 Do not change `TradeCycleClosedResponse`'s shape (design.md Decision 6's rejected-alternative
      note: no `exposure_fraction` echo in V1).

## 3. Routes: POST /close replacing DELETE /open-position

- [ ] 3.1 In `src/routes/positionManagementRoutes.ts`, change `matchCloseRoute` to match `POST` and path
      segment `"close"` (was `DELETE`/`"open-position"`); keep the same 7-segment shape and
      `decodeOpaquePathValue` calls for both path identifiers.
- [ ] 3.2 Change `handleClose` to the same content-type/JSON-parse flow `handleProtection` already uses
      (`isSupportedJsonContentType` → `match.details` → `readJsonBody` → `malformedJsonResult()` on parse
      failure → `validateCloseCommand(path, payload)`), removing the raw-empty-body check entirely.
- [ ] 3.3 Delete the now-unused `readRawBody` helper.
- [ ] 3.4 Confirm (no code change expected) that a request to the old `DELETE .../open-position` route
      falls through every route matcher to the server's generic 404 (`src/app/server.ts`'s
      `writeJson(response, 404, { error: "not_found" })`) — this route is retired, not aliased.

## 4. `CloseApplicationService`: ownership check and branching

- [ ] 4.1 Replace the `findOwnerByScope`-based reconfirmation (`closeApplicationService.ts:100-107`) with
      a call to `correlationRepository.findActiveRecordsForScope(category, symbol)`; assert the requested
      pair's own record (by `correlationRecordKey` equality) is among the results, else `internal_error`
      — design.md Decision 1.
- [ ] 4.2 When the active-record count is more than one, additionally assert every active record's
      `physical_side` (derived from `desired_entry?.side`) agrees; else `internal_error` — design.md
      Decision 1's defensive check.
- [ ] 4.3 Branch immediately after on `activeRecords.length`: `=== 1` keeps every subsequent step as the
      existing, unmodified code (same `queryPositionForInstrument` call, `row.size` used directly, the
      existing `verifyBothPostconditions` call and signature unchanged); `> 1` proceeds to tasks 5-7 —
      design.md Decision 2. Do not merge the two branches into one parameterized code path.

## 5. `CloseApplicationService`: multi-owner quantity resolution

- [ ] 5.1 After the existing entry-order neutralization step confirms no live remainder (shared by both
      branches, unmodified), on the multi-owner branch: assert `record.calculated_quantity !== null`
      (else `internal_error`), then call `confirmEntryPackage` with
      `expected: { qty: record.calculated_quantity }` reusing the existing
      `getEntryOrderPayload`/`getEntryOrderHistoryPayload` — design.md Decision 3.
- [ ] 5.2 Map the outcome: `full_fill`/`partial_fill` → `resolvedQty = observation.cumulative_filled_qty`;
      `terminal_without_fill` → `resolvedQty = "0"`; `not_found`/`ambiguous` → `internal_error`.
- [ ] 5.3 Do not pass this observation to `correlationRepository.save()` or otherwise write it to the
      record — this call is transient/read-only for this pipeline (design.md Decision 3's rejected
      alternative).

## 6. `CloseApplicationService`: drift check and closing quantity

- [ ] 6.1 Capture `liveAggregateSize` once (from the existing `queryPositionForInstrument` call, `"0"` for
      `no_position`) before computing anything else in the multi-owner branch.
- [ ] 6.2 Compute `excess = resolvedQty - liveAggregateSize` (`subtractDecimal`); if `excess > 0` and
      `excess > config.positionExposureDriftToleranceQty` (`compareDecimal`), return
      `positionExposureDriftResult()` and send no close order — design.md Decision 4.
- [ ] 6.3 Otherwise compute `qtyToClose = resolvedQty <= liveAggregateSize ? resolvedQty : liveAggregateSize`
      (`compareDecimal`). If `qtyToClose === "0"`, send no close order (mirror the existing
      `positionQuery.kind !== "position"` no-op branch) and proceed directly to postcondition
      verification; otherwise send the reduce-only close order for `qtyToClose` on
      `mapPositionSideToCloseSide(row.side)`, exactly as the single-owner branch does for its own
      quantity.

## 7. `CloseApplicationService`: generalized postcondition and durable write

- [ ] 7.1 Add `verifyRequestedCycleExposureClosed` as a new private method (not a parameter on
      `verifyBothPostconditions`), taking a precomputed `expectedAggregateAfterClose =
      subtractDecimal(liveAggregateSize, qtyToClose)`; each bounded attempt accepts `no_position` (only
      when the expected value is `"0"`) or a live position whose size is `decimalEquals` to the expected
      value, plus the existing entry-order-terminality re-check — design.md Decision 5. Leave
      `verifyBothPostconditions` itself untouched, still used verbatim by the single-owner branch.
- [ ] 7.2 On success, the durable write is unchanged: `save({ ...record, status: "terminal_closed",
      pending_action: null, updated_at })` — no new field, same shape as today, for both branches.

## 8. OpenAPI

- [ ] 8.1 In `docs/openapi/abi-position-management-api-v1.json`, replace the `delete` operation on
      `/v1/.../open-position` (`closeTradeCyclePosition`, currently lines ~137-221) with a `post`
      operation on `/v1/.../close`, with a required `CloseRequest` schema (`{ exposure_fraction: string
      }`) and a `400`/`415` response pair matching the protection operation's shape.
- [ ] 8.2 Extend `CloseBusinessError`'s `oneOf` (currently `ValidationFailedError` |
      `UnknownTradeCycleBindingError` | `UnsupportedExchangeScopeError`) to also include a new
      `PositionExposureDriftError` schema (`const: "position_exposure_drift"`), mirroring
      `PositionNotOpenError`'s existing shape.
- [ ] 8.3 Remove the retired `/v1/.../open-position` `delete` path entry entirely — do not leave it
      documented as deprecated (proposal.md: decommission, not a deprecation period).

## 9. Test suite

- [ ] 9.1 `exposure_fraction`: `"1"` (and `"1.0"`, numerically equal) accepted; `"0.5"`, `"0"`, `"2"`,
      `"-1"`, non-exact-decimal text, missing, `null`, and an unknown extra field in the body are all
      rejected as `validation_failed` with `error.details` identifying the offending field/path — before
      any exchange call and before any durable write.
- [ ] 9.2 Single-owner regression: with `findActiveRecordsForScope` seeded/returning exactly one record,
      every existing `closeApplicationService.test.ts` case passes unmodified (same call sequence,
      quantities, and postcondition checks as before this change) — assert the diff added a new branch
      rather than edited the existing one.
- [ ] 9.3 Multi-owner (synthetic fixtures, same seeding technique as
      `entryPackageCorrelationRepository.test.ts:637-665`): closing cycle A does not send a reduce-only
      quantity greater than A's own resolved `cumulative_filled_qty`; the live aggregate may remain
      positive after; cycle B's record is untouched (status, `early_execution_observation`, and
      `findActiveRecordsForScope` membership all unchanged) and remains closeable independently.
- [ ] 9.4 Closing a cycle whose entry order is still `PartiallyFilled` at request time: close first
      neutralizes it (cancel + confirm, as today), then resolves the final `cumulative_filled_qty` from
      the post-neutralization state, and closes exactly that quantity.
- [ ] 9.5 A cycle with zero resolved exposure (its own entry order reached `terminal_without_fill`) while
      a sibling keeps the aggregate positive: no close order is sent; the requested cycle still reaches
      `terminal_closed`; the sibling is untouched.
- [ ] 9.6 Drift: `resolvedQty` exceeding `liveAggregateSize` by more than the configured tolerance returns
      `position_exposure_drift` and sends no close order; within tolerance, the sent quantity clamps to
      `liveAggregateSize`.
- [ ] 9.7 `early_execution_observation` (and therefore `avg_execution_price`) for the closed cycle and for
      any sibling is bit-for-bit unchanged in the durable store as a result of close, in both branches.
- [ ] 9.8 Route/DTO tests for `POST .../close`: correct method/path match, rejection of the old `DELETE`
      route (falls through to generic 404), `unknown_trade_cycle_binding`, `unsupported_exchange_scope`,
      `malformed_json`, `unsupported_media_type` all reachable the same way the existing protection route
      tests already verify for `PUT .../protection`.
- [ ] 9.9 `GET .../open-position` — full existing regression, unmodified by this change.
- [ ] 9.10 Full regression: `entryPackageCorrelationRepository.test.ts`,
      `entryPackageApplicationService.test.ts`, `protectionApplicationService.test.ts`,
      `openPositionResolutionService.test.ts`, `entryCycleRecoveryResolutionService.test.ts` all pass
      unchanged — none of them are touched by this change.

## 10. Verification

- [ ] 10.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 10.2 Review the diff to confirm: `EntryPackageCorrelationRepository`, `byScope`,
      `findOwnerByScope`, `applyScopeClaimOnWrite`, `rebuildScopeIndexFromReplay`,
      `EntryPackageApplicationService`'s claim logic, `OpenPositionResolutionService`,
      `ProtectionApplicationService`, and `EntryCycleRecoveryResolutionService` are byte-for-byte
      unmodified; no field is added to `EntryPackageExecutionRecord` or `EarlyExecutionObservation`; the
      single-owner branch of `CloseApplicationService` is a pure addition of a branch point, not an edit
      to the pre-existing sequential code.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, listed here only so it is
not mistaken for done:

- The coordinated Runtime `ClosePositionCommand`/HTTP-client change and the cross-repo rollout mechanism —
  a separate OpenSpec change outside this repository (proposal.md).
- `exposure_fraction < 1` / partial-close execution; a mutable durable "owned remainder" field (design.md
  Non-Goals).
- Same-side production activation (`abi-same-side-virtual-exposure-ownership-v1`) — the change that
  actually lets a production scope have more than one owner.
- `abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1` — independent
  siblings of this change, not touched here.
- Pair-owned protection orders and close cancelling them on close (delivery plan Changes 6-8).

Reviewed and decided against for this change (not open, listed for traceability — design.md Decisions
1-7):

- Keeping `findOwnerByScope` for ownership reconfirmation. Resolved: replaced with
  `findActiveRecordsForScope` self-membership — `byScope` cannot represent multiple owners.
- A single generalized quantity-resolution/postcondition formula covering both owner counts. Resolved:
  two separate code paths, so single-owner behavior is byte-for-byte unchanged by inspection, not by
  trusting arithmetic to degenerate correctly.
- Durably persisting the multi-owner path's refreshed fill-fact observation. Resolved: transient,
  in-memory only — close stays outside `virtual-exposure-state`'s three existing write points.
- Always clamping a drifted `resolvedQty` down to the live aggregate without failing closed. Resolved:
  fail closed beyond a small configurable tolerance; clamp only within it.
- Hardcoding a nonzero default drift tolerance (e.g. "one qtyStep"). Resolved: default `"0"`; this
  pipeline does not otherwise fetch per-instrument trading rules, and introducing that dependency solely
  for a tolerance default was judged not worth it.
- Requiring literal string `"1"` for `exposure_fraction`. Resolved: numeric equality via `decimalEquals`,
  consistent with every other exact-decimal field this API validates.
- Echoing `exposure_fraction` back in the success response. Resolved: V1 has exactly one canonical value;
  nothing is gained by echoing it.
- Folding `position_exposure_drift` into `internal_error`. Resolved: dedicated code, for observability and
  because the master plan's own test requirements call for a specific code.
