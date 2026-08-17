## 1. Order identity: widen the existing role type

- [ ] 1.1 In `src/domain/entryPackageOrderIdentity.ts`, widen `EntryPackageOrderRole` from `"entry"` to
      `"entry" | "close"`. `buildEntryPackageOrderLinkId` itself needs no change — its hash already
      includes `role` — design.md Decision 2.

## 2. Correlation record: two new nullable fields, additive only

- [ ] 2.1 Add `close_order_link_id: string | null` and `close_order_id: string | null` to
      `EntryPackageExecutionRecord` (`src/correlation/entryPackageExecutionRecord.ts`), placed next to
      `order_link_id`/`order_id` with a comment distinguishing them as the close operation's own identity,
      independent of the entry order's — design.md Decision 3.
- [ ] 2.2 Update `isValidEntryPackageExecutionRecord` to accept both new fields as `undefined`, `null`, or
      a string — explicitly tolerating the key being entirely absent, unlike `order_link_id`/`order_id`'s
      stricter clause — so durable rows written before this change ships still replay — design.md
      Decision 3's validator note.
- [ ] 2.3 In `EntryPackageApplicationService.createOrder()`'s `provisional` record literal
      (`entryPackageApplicationService.ts:246-266`, unrelated service, touched only for this one literal),
      add explicit `close_order_link_id: null, close_order_id: null` — proves a new generation never
      inherits a stale close identity from an earlier one, with no other change to that function.

## 3. Exchange payload: optional close-order identity

- [ ] 3.1 Add `orderLinkId?: string` to `BybitMarketCloseOrderPayload`
      (`src/exchange/bybitOrderMapper.ts`) — optional, so the single-owner branch's existing payload
      literal in `closeApplicationService.ts` needs no change.

## 4. Domain: request/response contract (unchanged from the first draft)

- [ ] 4.1 In `src/domain/positionManagementApi.ts`, change `CloseCommand` to
      `{ strategyInstanceId: string; tradeCycleId: string; exposureFraction: string }`.
- [ ] 4.2 Change `validateCloseCommand` to also accept `payload: unknown` (mirroring
      `validateProtectionCommand`'s signature), validate the body is a closed JSON object with exactly
      `exposure_fraction` (required, non-null, exact-decimal text per `isExactDecimalText`, numerically
      equal to `1` per `decimalEquals(value, "1")`).
- [ ] 4.3 Add `"close_execution_incomplete"` to `PositionManagementErrorCode` and a
      `closeExecutionIncompleteResult()` helper (422) — replaces the first draft's
      `position_exposure_drift`/`positionExposureDriftResult()`, not additive to it.
- [ ] 4.4 Do not change `TradeCycleClosedResponse`'s shape.

## 5. Routes: POST /close replacing DELETE /open-position (unchanged from the first draft)

- [ ] 5.1 In `src/routes/positionManagementRoutes.ts`, change `matchCloseRoute` to match `POST` and path
      segment `"close"` (was `DELETE`/`"open-position"`); keep the same 7-segment shape and
      `decodeOpaquePathValue` calls for both path identifiers.
- [ ] 5.2 Change `handleClose` to the same content-type/JSON-parse flow `handleProtection` already uses.
- [ ] 5.3 Delete the now-unused `readRawBody` helper.
- [ ] 5.4 Confirm (no code change expected) that a request to the old `DELETE .../open-position` route
      falls through every route matcher to the server's generic 404.

## 6. `CloseApplicationService`: ownership check and branching (unchanged from the first draft)

- [ ] 6.1 Replace the `findOwnerByScope`-based reconfirmation with a call to
      `correlationRepository.findActiveRecordsForScope(category, symbol)`; assert the requested pair's own
      record is among the results, else `internal_error`.
- [ ] 6.2 When the active-record count is more than one, additionally assert every active record's
      `physical_side` agrees; else `internal_error`.
- [ ] 6.3 Branch on `activeRecords.length`: `=== 1` keeps every subsequent step as the existing,
      unmodified single-owner code (task 7); `> 1` proceeds to tasks 8-10. Do not merge the two branches.

## 7. `CloseApplicationService`: single-owner branch — no changes

- [ ] 7.1 Confirm (as a diff-review step, not a code change) that the single-owner branch's Bybit calls,
      quantity source (`row.size`), and `verifyBothPostconditions` call/signature are byte-for-byte
      identical to the pre-correction code — design.md Decision 1.

## 8. `CloseApplicationService`: multi-owner quantity resolution (unchanged from the first draft)

- [ ] 8.1 After the existing entry-order neutralization step confirms no live remainder, resolve
      `resolvedQty` via a fresh, read-only `confirmEntryPackage` call against the entry order's own
      identity, with `expected: { qty: record.calculated_quantity }` (`internal_error` if
      `calculated_quantity` is null). Map `full_fill`/`partial_fill` → `observation.cumulative_filled_qty`;
      `terminal_without_fill` → `"0"`; `not_found`/`ambiguous` → `internal_error`.
- [ ] 8.2 Do not pass this observation to `correlationRepository.save()` or otherwise write it to the
      record — transient/read-only, reaffirmed by design.md Decision 6.

## 9. `CloseApplicationService`: attributable close-order dispatch and retry resolution

Structured as **one sequential flow per request** — Step 1 (ensure dispatched) followed unconditionally
by Step 2 (always resolve and gate) — not two alternate branches selected once per request. A successful
Step 1 dispatch falls straight through into Step 2 within the same request; a request that finds
`close_order_link_id` already set skips straight to Step 2. See design.md Decision 4's corrected framing
and its explicit crash-window table (A-E).

**Step 1 — ensure dispatched** (this step is a no-op if `record.close_order_link_id !== null` already —
proceed directly to Step 2):
- [ ] 9.1 If `resolvedQty === "0"`: send no close order, write no `close_order_link_id`, proceed directly
      to task 10's durable write — design.md Decision 4, Step 1.2.
- [ ] 9.2 Otherwise, read the live aggregate once (for `side`); if it is `no_position` while
      `resolvedQty !== "0"`, return `internal_error` (a pre-dispatch contradiction, distinct from Step 2's
      post-dispatch outcome) — design.md Decision 4, Step 1.3.
- [ ] 9.3 Compute `closeOrderLinkId = buildEntryPackageOrderLinkId(strategyInstanceId, tradeCycleId,
      "close", record.generation)`. Durably write `close_order_link_id: closeOrderLinkId` (and
      `close_order_id: null`) to the record **before** calling `executeMarketCloseOrder` — design.md
      Decision 4, Step 1.4.
- [ ] 9.4 Send the reduce-only close order for `resolvedQty` on `mapPositionSideToCloseSide(row.side)`,
      `orderLinkId: closeOrderLinkId`. On a thrown exception or `skipped_live_execution`, leave the
      already-written `close_order_link_id` as-is (do not revert it) and return `internal_error`
      immediately, without running Step 2 this request — design.md Decision 4, Step 1.5. On any other
      (successful) response, save `close_order_id` from it (audit only) and **fall straight through into
      Step 2 within this same request** — do not return between Step 1 and Step 2 on a successful dispatch.

**Step 2 — always resolve and gate on the dispatched identity's fate** (runs whenever
`record.close_order_link_id !== null`, whether just set by Step 1 in this same request or found already
set from an earlier one):
- [ ] 9.5 Re-derive `resolvedQty` fresh (task 8.1 again), then call `confirmEntryPackage` on
      `close_order_link_id` with `expected: { qty: resolvedQty }`, and branch exactly per design.md
      Decision 4's Step 2:
      - confirmed quantity equals `resolvedQty` (exact, `decimalEquals`) → proceed to task 10, no new
        order sent.
      - confirmed quantity is less than `resolvedQty` and the order's own terminality
        (`classifyEntryOrderTerminality`) is `terminal` → `close_execution_incomplete`, no order sent.
      - `terminal_without_fill` → `close_execution_incomplete`, no order sent.
      - terminality is `live` → bounded re-poll (reuse the existing bounded-retry shape); still live after
        the bounded window → `internal_error`, no order sent.
      - genuinely `not_found` after the bounded window → return to Step 1's task 9.2 onward, reusing the
        same `close_order_link_id` (no new identity is computed), then fall through into Step 2 again for
        the resulting dispatch.
      - `ambiguous` → `internal_error`, no order sent.
- [ ] 9.6 Do not add a generation-scoped close-identity bump or any automatic resubmission path beyond
      task 9.5's `not_found` case — design.md's explicit V1 scope boundary (Decision 4's closing note).

## 10. `CloseApplicationService`: durable write (multi-owner)

- [ ] 10.1 On success (task 9.1's zero-exposure case, or task 9.5's confirmed-equal case): durably write
      `{ ...record, status: "terminal_closed", pending_action: null, updated_at }` — same shape as the
      single-owner branch's existing write; `close_order_link_id`/`close_order_id` are carried through via
      the spread (audit trail), not reset.

## 11. OpenAPI

- [ ] 11.1 In `docs/openapi/abi-position-management-api-v1.json`, replace the `delete` operation on
      `/v1/.../open-position` with a `post` operation on `/v1/.../close`, with a required `CloseRequest`
      schema (`{ exposure_fraction: string }`) and a `400`/`415` response pair matching the protection
      operation's shape.
- [ ] 11.2 Extend `CloseBusinessError`'s `oneOf` to include a new `CloseExecutionIncompleteError` schema
      (`const: "close_execution_incomplete"`), mirroring `PositionNotOpenError`'s existing shape — not
      `PositionExposureDriftError` (that name is dropped, not renamed in place, since it never shipped in
      code).
- [ ] 11.3 Remove the retired `/v1/.../open-position` `delete` path entry entirely.

## 12. Test suite

- [ ] 12.1 `exposure_fraction` validation — unchanged from the first draft (canonical `"1"`/`"1.0"`
      accepted; non-canonical, malformed, missing, extra-field bodies rejected before any exchange call).
- [ ] 12.2 Single-owner regression: every existing `closeApplicationService.test.ts` case passes
      unmodified — assert the diff added a branch rather than edited existing single-owner code.
- [ ] 12.3 **Scenario A (never dispatched):** multi-owner close for a cycle with `close_order_link_id ===
      null` and a positive `resolvedQty` dispatches exactly one close order under the deterministic
      identity, durably recorded before the exchange call.
- [ ] 12.4 **Scenario B (dispatched, verification lost, actually filled):** seed a record with
      `close_order_link_id` already set and `status` not `terminal_closed`; stub the exchange so a query
      for that identity finds it `Filled` for the full `resolvedQty`. Retrying the close request sends
      **no** new close order, and completes the durable `terminal_closed` write from the recovered
      evidence.
- [ ] 12.5 **Scenario C (dispatched, still live/ambiguous):** stub the exchange so a query for the
      dispatched identity is inconclusive across the bounded retry window. The retry sends no replacement
      order and returns `internal_error`; the record is not durably terminalized.
- [ ] 12.6 **Scenario D (dispatched, definitively zero execution):** stub the exchange so the dispatched
      identity resolves to `terminal_without_fill`. The retry returns `close_execution_incomplete`, sends
      no new order under any identity, and does not durably terminalize.
- [ ] 12.7 **Scenario E (partial execution):** stub the exchange so the dispatched identity resolves
      terminal with a confirmed quantity less than `resolvedQty`. Returns `close_execution_incomplete`,
      does not durably terminalize, and does not treat the partial fill as success.
- [ ] 12.8 **Not-found resend:** stub the exchange so a query for the dispatched identity returns
      genuinely `not_found` across the bounded window. The retry resends a close order reusing the exact
      same `close_order_link_id` (no new identity computed), and a subsequent successful confirmation
      completes the close normally.
- [ ] 12.9 A cycle with zero resolved exposure while a sibling keeps the aggregate positive: no close order
      is sent, no `close_order_link_id` is ever written, and the requested cycle still reaches
      `terminal_closed`; the sibling is untouched.
- [ ] 12.10 `early_execution_observation` (and therefore `avg_execution_price`) for the closed cycle and
      any sibling is bit-for-bit unchanged in the durable store as a result of close, in every scenario
      above.
- [ ] 12.11 A sibling record's `close_order_link_id`/`close_order_id`/status/active-record membership are
      unchanged by closing a different active record for the same scope.
- [ ] 12.12 Replay backward-compatibility: a durable row written without `close_order_link_id`/
      `close_order_id` keys at all (simulating pre-change data) replays successfully, with both fields
      reading as absent/`null`.
- [ ] 12.13 Route/DTO tests for `POST .../close` — unchanged from the first draft (method/path match, old
      `DELETE` route falls through to generic 404, shared error codes reachable).
- [ ] 12.14 `GET .../open-position` — full existing regression, unmodified by this change.
- [ ] 12.15 **Same-request fall-through:** stub the exchange so a freshly dispatched close order settles
      (to full confirmed execution) within the bounded confirmation window. A single close request both
      dispatches the order and completes the durable `terminal_closed` write — assert no second HTTP
      request is needed, i.e. `apply()` returns the success result directly from the request that
      performed the dispatch — design.md Decision 4's crash-window table, window D/E collapsed into one
      request.
- [ ] 12.16 **Conflicting entry-package mutation during an unresolved close:** seed a multi-owner record
      with `close_order_link_id` already set, `status` not `terminal_closed`, and its entry order showing
      a recorded fill (as it always does once a close identity exists). Send a null-desired-entry
      (cancel-intent) `PUT .../entry-package` for the same pair — assert it returns `internal_error`
      (via `confirmEntryPackageCancelled`'s existing `filled_before_cancel` path), does **not** transition
      the record to `absent`, and leaves `close_order_link_id`/`close_order_id` unchanged. Repeat for a
      non-null `PUT .../entry-package` carrying a desired entry different from the one currently stored —
      design.md Decision 8; this exercises existing, unmodified `entryPackageApplicationService.ts` code,
      not new logic.
- [ ] 12.17 Full regression: `entryPackageCorrelationRepository.test.ts`,
      `entryPackageApplicationService.test.ts` (including the `createOrder()` provisional-literal change
      from task 2.3), `protectionApplicationService.test.ts`, `openPositionResolutionService.test.ts`,
      `entryCycleRecoveryResolutionService.test.ts` all pass unchanged in observable behavior.

## 13. Verification

- [ ] 13.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 13.2 Review the diff to confirm: `EntryPackageCorrelationRepository`'s indexing/replay/`byScope`,
      `findOwnerByScope`, `applyScopeClaimOnWrite`, `rebuildScopeIndexFromReplay`,
      `EntryPackageApplicationService`'s claim logic (the `createOrder()` provisional literal aside),
      `OpenPositionResolutionService`, `ProtectionApplicationService`, and
      `EntryCycleRecoveryResolutionService` are byte-for-byte unmodified; no field is added to
      `EarlyExecutionObservation`; `AbiConfig` gains no new field; the single-owner branch of
      `CloseApplicationService` is a pure addition of a branch point, not an edit to the pre-existing
      sequential code.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, or to a future change if
real operational evidence demonstrates the need — listed here only so it is not mistaken for done:

- The coordinated Runtime `ClosePositionCommand`/HTTP-client change and the cross-repo rollout mechanism.
- A generation-scoped close-identity bump enabling automatic resubmission after a definitive
  zero/partial-execution outcome (design.md Decision 4's closing note) — not introduced speculatively.
- Cross-owner aggregate reconciliation as an observability/consistency check independent of any single
  close request's own success gate (design.md Decision 5's closing note) — not introduced speculatively.
- `exposure_fraction < 1` / partial-close execution; a mutable durable "owned remainder" field.
- Same-side production activation (`abi-same-side-virtual-exposure-ownership-v1`).
- `abi-pair-scoped-open-position-resolution-v1`, `abi-entry-cycle-recovery-attribution-v1` — independent
  siblings of this change, not touched here.
- Pair-owned protection orders and close cancelling them on close (delivery plan Changes 6-8) — though
  Change 6 is expected to reuse the same `EntryPackageOrderRole` widening pattern this change establishes.

Reviewed and decided against for this change (not open, listed for traceability — design.md Decisions
1-7, Risks):

- Comparing aggregate-position delta against an ABI-resolved quantity as the multi-owner success proof.
  Resolved: this was the original draft's actual safety bug — replaced with the requested cycle's own
  close-order confirmed execution as the exclusive gate.
- A configurable global drift-tolerance quantity (`AbiConfig.positionExposureDriftToleranceQty`).
  Resolved: removed entirely, not defaulted or renamed — the redesign eliminates the independently-derived
  comparison that tolerance existed to absorb.
- A close-specific order-identity hash function, separate from `buildEntryPackageOrderLinkId`. Resolved:
  reuse the existing role-parameterized function; it was already built for this kind of reuse.
- A generic order-attempt ledger, or a new correlation store, for close attempts. Resolved: two flat
  nullable fields on the existing record are sufficient; a trade cycle has at most one close identity ever
  in V1.
- Automatic resubmission under a fresh identity after a definitive zero/partial-execution outcome.
  Resolved: fail closed for V1, per explicit instruction not to invent retry behavior the codebase does
  not already have; reusing an already-used `orderLinkId` is unsafe regardless.
- Applying any of this correction's new machinery to the single-owner branch "for consistency." Resolved:
  single-owner is already safe for structurally different reasons (Context, design.md) and is left
  completely untouched, preserving the byte-for-byte regression guarantee from the original draft.
