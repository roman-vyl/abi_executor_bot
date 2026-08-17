## 1. Correlation record: one new nullable field, additive only

- [ ] 1.1 Add `first_fill_at_ms: number | null` to `EntryPackageExecutionRecord`
      (`src/correlation/entryPackageExecutionRecord.ts`), documented as this cycle's own raw attributable
      first-fill timestamp — never a canonical strategy-bar value — design.md Decision 1/4.
- [ ] 1.2 Update `isValidEntryPackageExecutionRecord` to accept `first_fill_at_ms` as `undefined`, `null`,
      or a non-negative integer — explicitly tolerating the key being entirely absent, mirroring
      `close_order_link_id`'s existing validator clause — design.md Decision 7.
- [ ] 1.3 In `EntryPackageCorrelationRepository.replay()`, normalize a missing `first_fill_at_ms` key to
      `null` before validation, mirroring `normalizeLegacyCloseIdentityFields`'s existing pattern —
      design.md Decision 7.

## 2. Correlation repository: immutability check

- [ ] 2.1 Extend `fillFactRegression` (or add a sibling check called alongside it, in both `save()` and
      `replay()`) to reject a record whose `first_fill_at_ms` differs from the previous record's non-null
      `first_fill_at_ms` for the same pair — design.md Decision 6. Do not touch the existing
      `cumulative_filled_qty` monotonicity check.

## 3. Exchange response decoding: `updatedTimeMs`

- [ ] 3.1 Add `updatedTimeMs: number` to `BybitOrderView` (`src/services/entryPackage/orderQueryResponseDecoder.ts`),
      decoded from the existing `order/realtime`/`order/history` response envelope's `updatedTime` field —
      no new Bybit endpoint or adapter method — design.md Decision 4.
- [ ] 3.2 Validate `updatedTime` is present, a numeric string, and parses to a non-negative integer; add
      `"invalid_updated_time"` to `OrderQueryProtocolFailureReason` and return it as a `protocol_failure`
      for anything else, matching this decoder's existing per-field validation style.

## 4. `OpenPositionResolutionService.determine()`: own-cycle fill sourcing (lock-free, unchanged signature)

- [ ] 4.1 Before any aggregate query, resolve this cycle's own fill facts: if
      `isFillFactFinal(record.early_execution_observation)` is true **and** `record.first_fill_at_ms !==
      null`, reuse the stored observation with no exchange call. Otherwise (not final, or final but
      `first_fill_at_ms` still null — the backward-compat backfill case), call `confirmEntryPackage` against
      this cycle's own entry order (`record.order_link_id`, `expected: { qty: record.calculated_quantity }`)
      — `internal_error` if either is `null` — design.md Decisions 2 and 4's backfill note.
- [ ] 4.2 Map `confirmEntryPackage`'s outcome the same way `resolveOwnExposure` already does:
      `full_fill`/`partial_fill` → the returned observation; `terminal_without_fill` → treat as zero fill
      (no observation fields needed); `not_found`/`ambiguous`/`pending_confirmed` → `internal_error`
      (unreachable in practice here, not assumed away).
- [ ] 4.3 If own cumulative filled qty is `"0"`: return `{ kind: "closed" }` immediately — do not query the
      aggregate — design.md Decision 2.
- [ ] 4.4 If own cumulative filled qty is greater than `"0"` but no usable `avg_execution_price` is
      available from the resolved own facts: return `{ kind: "error" }` — design.md Decision 2's
      structurally-impossible-state note.
- [ ] 4.5 Otherwise, query the aggregate (`queryPositionForInstrument`, unchanged call) for weak sanity
      (existence + `sideMatches`, unchanged check) and for `confirmedStopLoss`/`confirmedTakeProfit`
      (unchanged extraction) — design.md Decision 3. Aggregate query failure/no-row/side-mismatch →
      `{ kind: "error" }`, same as today.
- [ ] 4.6 Compute the value to report as `firstFillAtMs`: `record.first_fill_at_ms` if already non-null,
      otherwise the just-observed `updatedTimeMs` from task 4.1's query (not yet durably written — that is
      task 5's job). Return `{ kind: "open", firstFillAtMs, averageEntryPrice, confirmedStopLoss,
      confirmedTakeProfit }`.
- [ ] 4.7 Do not add a `mutex` parameter to `determine()` itself and do not perform any durable write from
      within it — `ProtectionApplicationService.process()` calls it directly while already holding the pair
      mutex; an internal acquire would deadlock — design.md Decision 5.

## 5. `OpenPositionResolutionService.resolve()`: durable first-fill capture under the pair mutex

- [ ] 5.1 Add `mutex: KeyedMutex` to `OpenPositionResolutionServiceDeps` — the same shared instance
      `EntryPackageApplicationService`/`ProtectionApplicationService`/`CloseApplicationService` already use.
- [ ] 5.2 In `resolve()`, keep the existing outer, unlocked `correlationRepository.get()` for the
      unknown-pair check and initial bucket classification (durably-closed/unresolved outcomes need no
      lock and are unchanged).
- [ ] 5.3 For a live-query-admissible record, wrap the remainder of resolution in
      `mutex.withKeyLock(correlationRecordKey(...), async () => { ... })`: re-read the record fresh inside
      the lock, re-check its status (a concurrent close may have durably closed it since the outer read —
      if so, return the closed result with no further work), then call `determine(freshRecord)` — design.md
      Decision 5.
- [ ] 5.4 If `determination.kind === "open"` and the fresh record's `first_fill_at_ms` is still `null` and
      `determination.firstFillAtMs` is non-null: durably `save({ ...freshRecord, first_fill_at_ms:
      determination.firstFillAtMs, updated_at: <now> })` before returning the HTTP result. A `save()`
      failure does not convert an otherwise-successful determination into an error response — the next
      `GET` retries the capture — design.md Decision 5's failure-mode note.
- [ ] 5.5 Do not change `resolve()`'s behavior for the `durably_closed`/`unresolved`/`unsupported_scope`
      outcomes in any way — no lock, no write, byte-for-byte the same code paths as today.

## 6. Wiring

- [ ] 6.1 In `src/app/server.ts`, pass the existing shared `mutex` instance into
      `OpenPositionResolutionService`'s constructor.

## 7. Documentation (prose only, no schema change)

- [ ] 7.1 In `openspec/specs/abi-open-position-lookup-api/spec.md`, clarify (in the existing "Successful
      response..." and "average_entry_price is exact-decimal text..." requirements' prose, or a small
      addition) that `first_fill_at_ms` and `average_entry_price` reflect this trade cycle's own execution
      evidence, not the aggregate physical position — no schema, route, or nullability change.
- [ ] 7.2 If `docs/openapi/abi-open-position-lookup-api-v1.json` carries any prose description of
      `first_fill_at_ms`/`average_entry_price` that describes aggregate-position sourcing, update it to
      match — schema (types/required/nullability) unchanged.

## 8. Test suite

- [ ] 8.1 Single-owner regression: every existing `test/unit/openPositionResolutionService.test.ts` case
      passes with observably identical results, except where task 8.2 below documents an intentional fix.
- [ ] 8.2 **Live partial-fill correctness (the gap this change fixes):** own entry order is `PartiallyFilled`
      with `cumulative_filled_qty > 0`, but a stubbed aggregate query would (if consulted) report
      `no_position` or a side-mismatched row — `position_open: true` is still returned, sourced from own
      evidence, and the aggregate stub is never called for this scenario (assert call count).
- [ ] 8.3 **Zero own fill skips the aggregate query entirely:** own entry order shows `cumulative_filled_qty
      === "0"` (live, unfilled) — `position_open: false`, aggregate query never invoked.
- [ ] 8.4 **Already-final observation needs no exchange call when `first_fill_at_ms` is already set:** a
      record with `isFillFactFinal` true and `first_fill_at_ms` already non-null resolves with zero calls to
      `confirmEntryPackage`.
- [ ] 8.5 **Backward-compat backfill:** a record with `isFillFactFinal` true, `cumulative_filled_qty > 0`,
      but `first_fill_at_ms === null` (simulating pre-existing data) triggers exactly one
      `confirmEntryPackage` call, durably captures `first_fill_at_ms` from its `updatedTimeMs`, and returns
      it in the response.
- [ ] 8.6 **First capture is durable and stable across repeated `GET`s:** the first `GET` for a
      newly-filled cycle durably writes `first_fill_at_ms`; a second `GET` (stubbed with a *different*
      `updatedTimeMs` this time, simulating further order movement) returns the *original* captured value
      unchanged, with no second write attempted (assert `save()` call count).
- [ ] 8.7 **Immutability at the repository layer:** `save()` and `replay()` both reject a record whose
      `first_fill_at_ms` differs from the previously stored non-null value for the same pair.
- [ ] 8.8 **Own fill without a usable average price fails closed:** own evidence shows
      `cumulative_filled_qty > 0` with no `avg_execution_price` available — `internal_error`, no fabricated
      price.
- [ ] 8.9 **Aggregate/own-evidence disagreement fails closed:** own evidence proves a fill, but the
      aggregate query returns `no_position` or a side-mismatched row — `internal_error`.
- [ ] 8.10 **`PUT .../protection` regression, full suite:** `protectionApplicationService.test.ts` passes
      unchanged — its already-satisfied short-circuit and its live-position gate both still receive
      `confirmedStopLoss`/`confirmedTakeProfit` and the correct `kind` from `determine()`.
- [ ] 8.11 **Concurrency:** a `GET` for a live-query-admissible record and a concurrent `PUT
      .../entry-package` repeat-revalidation for the same pair are serialized by the shared mutex — neither
      write is lost (construct via the existing `KeyedMutex` test harness pattern, if one exists, or a
      controlled-interleaving stub).
- [ ] 8.12 Replay backward-compatibility: a durable row written without a `first_fill_at_ms` key at all
      replays successfully, reading as `null`.
- [ ] 8.13 Full regression: `entryPackageCorrelationRepository.test.ts`, `entryPackageApplicationService.test.ts`,
      `closeApplicationService.test.ts`, `entryCycleRecoveryResolutionService.test.ts` all pass unchanged in
      observable behavior.

## 9. Verification

- [ ] 9.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 9.2 Review the diff to confirm: `EntryPackageCorrelationRepository`'s indexing, `byScope`,
      `findOwnerByScope`, `findActiveRecordsForScope` are byte-for-byte unmodified; `entryPackageApplicationService.ts`
      and `closeApplicationService.ts` are untouched; `ProtectionApplicationService` is untouched (its
      regression passes solely because `determine()`'s external contract is preserved); no quantity/size
      field is added anywhere in `GET .../open-position`'s response shape.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, or to a future change if
real operational evidence demonstrates the need — listed here only so it is not mistaken for done:

- Any strategy timeframe/interval/grid concept inside ABI, or bar-normalization logic inside ABI — v9,
  explicit and final; not a deferred item so much as a permanently rejected one, restated here for
  visibility.
- Exact, per-execution first-fill timestamp sourcing via Bybit's execution-list endpoint
  (`/v5/execution/list`), superseding the `updatedTime`-based approximation (design.md Risks) — not
  introduced speculatively.
- `abi-entry-cycle-recovery-attribution-v1` (Change 4) — independent sibling of this change, not touched
  here.
- Same-side production activation (`abi-same-side-virtual-exposure-ownership-v1`, Change 5).
- Pair-owned protection orders (Changes 6-8).

Reviewed and decided against for this change (not open, listed for traceability — design.md Decisions
1-7, Risks):

- Computing/storing a canonical entry strategy-bar identity inside ABI. Resolved: this was v8's actual
  mistake; ABI has no timeframe/grid concept and does not gain one here.
- Capturing `first_fill_at_ms` inside `entryPackageApplicationService.ts`'s existing observation-writing
  points instead of `OpenPositionResolutionService`. Resolved: would leave the field chronically
  uncaptured for the dominant real-world usage pattern (Runtime polls `GET`, does not repeat-`PUT`).
- Reconstructing `first_fill_at_ms` fresh on every `GET`, never durably storing it. Resolved: the only
  available source (`updatedTime`) is not stable once the order moves past the first fill; Runtime needs
  stability across polls.
- A quantity/drift comparison between own evidence and the aggregate. Resolved: same reasoning as Change
  2's Decision 5 — a shared aggregate cannot prove whose activity produced it.
- Double-checked locking (exchange query outside the mutex, re-check inside). Resolved: added complexity
  not justified given `PUT .../protection` already accepts the full in-lock query cost for the same
  underlying call.
