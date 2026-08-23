## 1. Correlation record: one new nullable field, additive only

- [x] 1.1 Add `first_fill_at_ms: number | null` to `EntryPackageExecutionRecord`
      (`src/correlation/entryPackageExecutionRecord.ts`), documented as this cycle's own raw attributable
      first-fill timestamp — the earliest of this cycle's own entry order's own executions, never a
      canonical strategy-bar value — design.md Decision 1/4.
- [x] 1.2 Update `isValidEntryPackageExecutionRecord` to accept `first_fill_at_ms` as `undefined`, `null`,
      or a non-negative integer — explicitly tolerating the key being entirely absent, mirroring
      `close_order_link_id`'s existing validator clause — design.md Decision 7.
- [x] 1.3 In `EntryPackageCorrelationRepository.replay()`, normalize a missing `first_fill_at_ms` key to
      `null` before validation, mirroring `normalizeLegacyCloseIdentityFields`'s existing pattern —
      design.md Decision 7.

## 2. Correlation repository: immutability check

- [x] 2.1 Extend `fillFactRegression` (or add a sibling check called alongside it, in both `save()` and
      `replay()`) to reject a record whose `first_fill_at_ms` differs from the previous record's non-null
      `first_fill_at_ms` for the same pair — design.md Decision 6. Do not touch the existing
      `cumulative_filled_qty` monotonicity check.

## 3. New Bybit adapter primitive: `/v5/execution/list`

- [x] 3.1 Add `BybitGetExecutionListPayload` (`{ category: string; symbol: string; orderLinkId: string;
      limit: string; cursor?: string }`) — new type, alongside the existing
      `BybitGetOrderByLinkIdPayload`/`BybitGetOrderHistoryPayload` — design.md Decision 4a. Deliberately no
      `orderId` field: Bybit's own documented parameter-priority rule for this endpoint (`orderId >
      orderLinkId > symbol > baseCoin`) means sending both would let `orderId` silently override the
      intended filter.
- [x] 3.2 Add `getExecutionList(payload: BybitGetExecutionListPayload): Promise<unknown>` to the
      `BybitAdapter` interface. Implement in `RestBybitAdapter` via `signedGet("/v5/execution/list",
      new URLSearchParams({ category, symbol, orderLinkId, limit, ...(cursor ? { cursor } : {}) }))` — the
      same pattern every other read on this adapter already uses. Implement in `StubBybitAdapter` via the
      existing `stub(...)` placeholder.

## 4. New decoder: `executionListResponseDecoder.ts`

- [x] 4.1 New file `src/services/entryPackage/executionListResponseDecoder.ts`. Define `BybitExecutionView
      = { execTimeMs: number }` and `ExecutionListProtocolFailureReason = "malformed_envelope" |
      "category_mismatch" | "list_not_array" | "malformed_item" | "symbol_mismatch" | "invalid_exec_type" |
      "invalid_exec_time"`.
- [x] 4.2 `decodeExecutionListResponsePage(input: { response: unknown; expected: { category: string;
      symbol: string } }): { kind: "ok"; executions: BybitExecutionView[]; nextCursor: string } | { kind:
      "protocol_failure"; reason: ExecutionListProtocolFailureReason }`. Validate the envelope
      (`result.list` an array, `result.category` matches expected, `result.nextPageCursor` a string,
      defaulting to `""` only if the key is present and empty — treat a missing key as `protocol_failure`,
      not a silent empty string) — design.md Decision 4a.
- [x] 4.3 Per item: `symbol` must match expected (`symbol_mismatch` otherwise); `execType` must equal
      exactly `"Trade"` (`invalid_exec_type` otherwise — design.md Decision 4's `execType` filtering note);
      `execTime` must be present, a numeric string, and parse to a non-negative integer
      (`invalid_exec_time` otherwise). Attribution rests on the query's own `orderLinkId` filter (this
      cycle's own deterministic, durable identity) — design.md Decision 4. Malformed non-object items →
      `malformed_item`.

## 5. New orchestration: `resolveFirstAttributableFillAtMs`

- [x] 5.1 In `src/services/entryPackage/packageConfirmation.ts`, add
      `resolveFirstAttributableFillAtMs(input: { bybit: BybitAdapter; category: string; symbol: string;
      orderLinkId: string }): Promise<{ kind: "found"; firstFillAtMs: number } | { kind:
      "no_executions_found" } | { kind: "ambiguous" }>` — design.md Decision 4a.
- [x] 5.2 Page through `getExecutionList` in a bounded loop (a small fixed page cap — e.g. 10 pages at the
      existing query `limit` convention this codebase already uses elsewhere), passing each page's
      `nextCursor` as the next request's `cursor`, decoding each page via
      `decodeExecutionListResponsePage`, and accumulating every valid execution across all pages into one
      set — never computing a candidate result from a partial page — design.md Decision 4b.
- [x] 5.3 Any page's `protocol_failure`, or a transport-level failure from `getExecutionList` itself, or
      exceeding the page-cap bound while `nextCursor` is still non-empty → `{ kind: "ambiguous" }` —
      design.md Decision 4b.
- [x] 5.4 After the loop ends (`nextCursor === ""`): if the accumulated set is empty →
      `{ kind: "no_executions_found" }`; otherwise → `{ kind: "found"; firstFillAtMs: min(execTimeMs across
      the set) }` — design.md Decision 4.

## 6. `OpenPositionResolutionService.determine()`: own-cycle fill sourcing (lock-free, unchanged signature, never touches `/v5/execution/list`)

- [x] 6.1 Before any aggregate query, resolve this cycle's own fill facts: if
      `isFillFactFinal(record.early_execution_observation)` is true, reuse the stored observation with no
      exchange call. Otherwise, call `confirmEntryPackage` against this cycle's own entry order
      (`record.order_link_id`, `expected: { qty: record.calculated_quantity }`) — `internal_error` if
      either is `null` — design.md Decision 2.
- [x] 6.2 Map `confirmEntryPackage`'s outcome the same way `resolveOwnExposure` already does:
      `full_fill`/`partial_fill` → the returned observation; `terminal_without_fill` → treat as zero fill
      (no observation fields needed); `not_found`/`ambiguous`/`pending_confirmed` → `internal_error`
      (unreachable in practice here, not assumed away).
- [x] 6.3 If own cumulative filled qty is `"0"`: return `{ kind: "closed" }` immediately — do not query the
      aggregate — design.md Decision 2.
- [x] 6.4 If own cumulative filled qty is greater than `"0"` but no usable `avg_execution_price` is
      available from the resolved own facts: return `{ kind: "error" }` — design.md Decision 2's
      structurally-impossible-state note.
- [x] 6.5 Otherwise, query the aggregate (`queryPositionForInstrument`, unchanged call) for weak sanity
      (existence + `sideMatches`, unchanged check) and for `confirmedStopLoss`/`confirmedTakeProfit`
      (unchanged extraction) — design.md Decision 3. Aggregate query failure/no-row/side-mismatch →
      `{ kind: "error" }`, same as today.
- [x] 6.6 `firstFillAtMs` on the `"open"` variant is `record.first_fill_at_ms`, verbatim — no computation,
      no query, may be `null`. Return `{ kind: "open", firstFillAtMs, averageEntryPrice, confirmedStopLoss,
      confirmedTakeProfit }`.
- [x] 6.7 Do not add a `mutex` parameter to `determine()` itself, do not call
      `resolveFirstAttributableFillAtMs` from within it, and do not perform any durable write from within
      it — `ProtectionApplicationService.process()` calls it directly while already holding the pair mutex,
      and never reads `firstFillAtMs`/`averageEntryPrice` from the result — an internal mutex acquire would
      deadlock, and an internal execution-list query would cost protection nothing it needs — design.md
      Decision 5.

## 7. `OpenPositionResolutionService.resolve()`: durable first-fill capture under the pair mutex

- [x] 7.1 Add `mutex: KeyedMutex` to `OpenPositionResolutionServiceDeps` — the same shared instance
      `EntryPackageApplicationService`/`ProtectionApplicationService`/`CloseApplicationService` already use.
- [x] 7.2 In `resolve()`, keep the existing outer, unlocked `correlationRepository.get()` for the
      unknown-pair check and initial bucket classification (durably-closed/unresolved outcomes need no
      lock and are unchanged).
- [x] 7.3 For a live-query-admissible record, wrap the remainder of resolution in
      `mutex.withKeyLock(correlationRecordKey(...), async () => { ... })`: re-read the record fresh inside
      the lock, re-check its status (a concurrent close may have durably closed it since the outer read —
      if so, return the closed result with no further work), then call `determine(freshRecord)` — design.md
      Decision 5.
- [x] 7.4 If `determination.kind !== "open"`: return its HTTP result directly, no further work.
- [x] 7.5 If `determination.kind === "open"` and `freshRecord.first_fill_at_ms !== null`: build the success
      response from `determination.averageEntryPrice` and `freshRecord.first_fill_at_ms` — no capture, no
      write.
- [x] 7.6 If `determination.kind === "open"` and `freshRecord.first_fill_at_ms === null`: call
      `resolveFirstAttributableFillAtMs({ bybit, category: freshRecord.exchange_category, symbol:
      freshRecord.exchange_symbol, orderLinkId: freshRecord.order_link_id })`. On `"found"`: durably
      `save({ ...freshRecord, first_fill_at_ms: captured.firstFillAtMs, updated_at: <now> })`, then build
      the success response from `determination.averageEntryPrice` and the captured value. On
      `"no_executions_found"` or `"ambiguous"`: `internal_error`, no durable write — design.md Decision 4c.
- [x] 7.7 A `save()` failure (not a logic error — e.g. a disk error) does not convert an otherwise-successful
      determination into an error response — return the freshly-captured value in this response anyway; the
      next `GET` retries the capture, since `first_fill_at_ms` was never durably set — design.md Decision
      5's failure-mode note.
- [x] 7.8 Do not change `resolve()`'s behavior for the `durably_closed`/`unresolved`/`unsupported_scope`
      outcomes in any way — no lock, no write, byte-for-byte the same code paths as today.

## 8. Wiring

- [x] 8.1 In `src/app/server.ts`, pass the existing shared `mutex` instance into
      `OpenPositionResolutionService`'s constructor.

## 9. Documentation (prose only, no schema change)

- [x] 9.1 In `openspec/specs/abi-open-position-lookup-api/spec.md`, clarify (in the existing "Successful
      response..." and "average_entry_price is exact-decimal text..." requirements' prose, or a small
      addition) that `first_fill_at_ms` and `average_entry_price` reflect this trade cycle's own execution
      evidence — specifically, `first_fill_at_ms` is the earliest of this cycle's own entry order's own
      executions, not the aggregate physical position — no schema, route, or nullability change.
- [x] 9.2 If `docs/openapi/abi-open-position-lookup-api-v1.json` carries any prose description of
      `first_fill_at_ms`/`average_entry_price` that describes aggregate-position sourcing, update it to
      match — schema (types/required/nullability) unchanged.

## 10. Test suite

- [x] 10.1 Single-owner regression: every existing `test/unit/openPositionResolutionService.test.ts` case
      passes with observably identical results, except where task 10.2 below documents an intentional fix.
- [x] 10.2 **Live partial-fill correctness (the gap this change fixes):** own entry order is
      `PartiallyFilled` with `cumulative_filled_qty > 0`, but a stubbed aggregate query would (if consulted)
      report `no_position` or a side-mismatched row — `position_open: true` is still returned, sourced from
      own evidence, and the aggregate stub is never called for this scenario (assert call count).
- [x] 10.3 **Zero own fill skips the aggregate query entirely:** own entry order shows
      `cumulative_filled_qty === "0"` (live, unfilled) — `position_open: false`, aggregate query never
      invoked.
- [x] 10.4 **Already-final observation with `first_fill_at_ms` already set needs no exchange call at all:**
      a record with `isFillFactFinal` true and `first_fill_at_ms` already non-null resolves with zero calls
      to `confirmEntryPackage` and zero calls to `getExecutionList`.
- [x] 10.5 **The 12:01/12:03 case: multiple fills before first observation resolve to the true earliest,
      not the most recent.** Stub `getExecutionList` to return two executions for the same order — `execTime`
      12:01 and 12:03 — and `confirmEntryPackage` reporting the order as fully filled. The captured
      `first_fill_at_ms` is 12:01, not 12:03 — the specific gap this revision's sourcing change fixes.
- [x] 10.6 **Pagination is followed to completion, and order is never assumed:** stub `getExecutionList` to
      return two pages, with the earliest `execTime` on the *second* page and a non-empty `nextPageCursor`
      on the first — the captured value is still the true minimum across both pages (assert both pages were
      fetched).
- [x] 10.7 **Bounded pagination fails closed, not silently, when the page cap is exceeded:** stub
      `getExecutionList` to always return a non-empty `nextPageCursor` — the capture returns
      `internal_error`, not a value computed from a partial set.
- [x] 10.8 **No executions found for an order own-evidence already proves filled fails closed.** Stub
      `getExecutionList` to return an empty (fully-paged) result while `confirmEntryPackage`/the stored
      observation shows `cumulative_filled_qty > 0` — `internal_error`, no durable write, no fabricated
      timestamp — design.md Decision 4.
- [x] 10.9 **`execType` filtering:** a page containing one item with `execType: "Trade"` and one with a
      different `execType` — only the `"Trade"` item's `execTime` is considered a candidate; an item whose
      `execType` is present but not `"Trade"` at all in the whole result set is treated as
      `invalid_exec_type` (`internal_error`), not silently skipped.
- [x] 10.10 **First capture is durable and stable across repeated `GET`s:** the first `GET` for a
      newly-filled cycle durably writes `first_fill_at_ms`; a second `GET` (stubbed with additional/different
      executions this time, simulating further order movement) returns the *original* captured value
      unchanged, with no second write attempted and `getExecutionList` never called again (assert call
      counts).
- [x] 10.11 **Backward-compat backfill:** a record with `isFillFactFinal` true, `cumulative_filled_qty > 0`,
      but `first_fill_at_ms === null` (simulating pre-existing data) triggers exactly one
      `getExecutionList`-based capture (no `confirmEntryPackage` re-query, since the stored observation is
      already final), durably captures `first_fill_at_ms`, and returns it in the response.
- [x] 10.12 **Immutability at the repository layer:** `save()` and `replay()` both reject a record whose
      `first_fill_at_ms` differs from the previously stored non-null value for the same pair.
- [x] 10.13 **Own fill without a usable average price fails closed:** own evidence shows
      `cumulative_filled_qty > 0` with no `avg_execution_price` available — `internal_error`, no fabricated
      price.
- [x] 10.14 **Aggregate/own-evidence disagreement fails closed:** own evidence proves a fill, but the
      aggregate query returns `no_position` or a side-mismatched row — `internal_error`.
- [x] 10.15 **`PUT .../protection` regression, full suite:** `protectionApplicationService.test.ts` passes
      unchanged — its already-satisfied short-circuit and its live-position gate both still receive
      `confirmedStopLoss`/`confirmedTakeProfit` and the correct `kind` from `determine()`; `determine()`
      never calls `getExecutionList` on protection's call path (assert call count is zero).
- [x] 10.16 **Concurrency:** a `GET` for a live-query-admissible record and a concurrent `PUT
      .../entry-package` repeat-revalidation for the same pair are serialized by the shared mutex — neither
      write is lost (construct via the existing `KeyedMutex` test harness pattern, if one exists, or a
      controlled-interleaving stub).
- [x] 10.17 `orderLinkId`/`orderId` query construction: `getExecutionList` is called with `orderLinkId` only
      — assert the request never includes an `orderId` param — design.md Decision 4's priority-rule note.
- [x] 10.18 Replay backward-compatibility: a durable row written without a `first_fill_at_ms` key at all
      replays successfully, reading as `null`.
- [x] 10.19 Full regression: `entryPackageCorrelationRepository.test.ts`, `entryPackageApplicationService.test.ts`,
      `closeApplicationService.test.ts`, `entryCycleRecoveryResolutionService.test.ts` all pass unchanged in
      observable behavior.

## 11. Verification

- [x] 11.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [x] 11.2 Review the diff to confirm: `EntryPackageCorrelationRepository`'s indexing, `byScope`,
      `findOwnerByScope`, `findActiveRecordsForScope` are byte-for-byte unmodified; `entryPackageApplicationService.ts`
      and `closeApplicationService.ts` are untouched; `ProtectionApplicationService` is untouched (its
      regression passes solely because `determine()`'s external contract is preserved); no quantity/size
      field is added anywhere in `GET .../open-position`'s response shape; `determine()` contains no
      reference to `getExecutionList`/`resolveFirstAttributableFillAtMs` anywhere in its own call path.

## Deferred follow-up (not this change's scope)

Belongs to a later change in `docs/virtual-exposure-ownership-delivery-plan.md`, or to a future change if
real operational evidence demonstrates the need — listed here only so it is not mistaken for done:

- Any strategy timeframe/interval/grid concept inside ABI, or bar-normalization logic inside ABI — v9,
  explicit and final; not a deferred item so much as a permanently rejected one, restated here for
  visibility.
- A historical-recovery subsystem designed around `/v5/execution/list`'s own query-scoping/history
  constraints (design.md Decision 4's closing note) — not introduced speculatively; this change's normal
  lifecycle captures `first_fill_at_ms` once, promptly, and holds it durable and immutable, so no code path
  needs to reconstruct an old, never-captured fill.
- `abi-entry-cycle-recovery-attribution-v1` (Change 4) — independent sibling of this change, not touched
  here.
- Same-side production activation (`abi-same-side-virtual-exposure-ownership-v1`, Change 5).
- Pair-owned protection orders (Changes 6-8).

Reviewed and decided against for this change (not open, listed for traceability — design.md Decisions
1-7, Risks):

- Computing/storing a canonical entry strategy-bar identity inside ABI. Resolved: this was v8's actual
  mistake; ABI has no timeframe/grid concept and does not gain one here.
- Sourcing `first_fill_at_ms` from the entry order's own `updatedTime` (this proposal's own first draft).
  Resolved: `updatedTime` reflects the most recently observed order state, not necessarily the first fill,
  if more than one fill occurred before ABI's own confirmation pipeline first looked — durable capture
  would make that wrong value permanently, stably wrong. Replaced with `/v5/execution/list`-based
  `min(execTime)` sourcing (design.md Decision 4).
- Capturing `first_fill_at_ms` inside `entryPackageApplicationService.ts`'s existing observation-writing
  points instead of `OpenPositionResolutionService`. Resolved: unlike the rejected `updatedTime` design,
  execution-list sourcing returns the correct value regardless of how late the first capture attempt
  happens — `OpenPositionResolutionService`'s own targeted refresh is a sufficient, correct capture point
  on its own.
- Reconstructing `first_fill_at_ms` fresh on every `GET`, never durably storing it. Resolved: even though
  execution-list sourcing (unlike `updatedTime`) would return the same correct value on every call, this
  still costs one paginated exchange query per `GET` forever, for a value that never changes once genuinely
  first observed — durable, one-time capture is strictly better.
- A quantity/drift comparison between own evidence and the aggregate. Resolved: same reasoning as Change
  2's Decision 5 — a shared aggregate cannot prove whose activity produced it.
- Double-checked locking (exchange query outside the mutex, re-check inside). Resolved: added complexity
  not justified given `PUT .../protection` already accepts the full in-lock query cost for the same
  underlying call.
- Designing a historical-recovery subsystem around `/v5/execution/list`'s own query/history constraints
  (e.g. explicit time-window construction, multi-window traversal, dedicated recovery scenarios). Resolved:
  out of scope for this change — its normal lifecycle captures `first_fill_at_ms` once, promptly, and holds
  it durable and immutable, so it never needs to reconstruct an old fill; see design.md Decision 4's
  closing note.
