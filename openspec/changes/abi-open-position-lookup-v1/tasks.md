## 1. Domain/request/response/error types

- [ ] 1.1 Add open-position response types to a new domain module (e.g.
      `src/domain/openPositionApi.ts`, mirroring `src/domain/entryPackageApi.ts`'s
      style): `OpenPositionSuccessResponse` (`position_open`, `first_fill_at_ms`,
      `average_entry_price`) with the cross-field invariant enforced at construction time
      (a single constructor/factory that only ever produces the two valid shapes —
      spec `abi-open-position-lookup-api`, "Successful response is a closed object with a
      mandatory cross-field invariant").
- [ ] 1.2 Add `OpenPositionErrorCode = "validation_failed" | "unknown_trade_cycle_binding"
      | "unsupported_exchange_scope" | "internal_error"` and
      `OpenPositionErrorResponse` reusing the existing closed envelope shape
      (`{ error: { code, message, details? } }`) and `EntryPackageValidationDetail`'s
      `{ path, message }` shape for `details` (design.md Decision 6).
- [ ] 1.3 Add path-decoding types/helpers for the two opaque path parameters, reusing the
      existing `decodeURIComponent`-per-segment-with-empty-check approach from
      `src/routes/entryPackageRoutes.ts:104-160` (design.md Decision 7) rather than
      duplicating a divergent implementation.
- [ ] 1.4 Add an internal `OpenPositionResolutionResult` type (or reuse an
      `EntryPackageHttpResult`-style `{ statusCode, body }` shape) that the application
      resolution service (section 2) returns and the HTTP route (section 4) writes
      directly, matching the existing `entryPackageApi.ts` / `entryPackageRoutes.ts`
      split of "domain builds the result, route just writes it".

## 2. Application resolution service

- [ ] 2.1 Add an open-position resolution service (e.g.
      `src/services/openPosition/openPositionResolutionService.ts`) that performs the
      direct composite lookup via the existing
      `EntryPackageCorrelationRepository.get(strategyInstanceId, tradeCycleId)` — no new
      repository method, no index (spec `open-position-resolution`, "Position resolution
      starts from a direct composite correlation lookup").
- [ ] 2.2 Implement the missing-record branch: return `unknown_trade_cycle_binding`, never
      `position_open: false` (design.md Decision 1).
- [ ] 2.3 Implement the three-bucket status classification exactly as design.md Decision 2
      / spec "Record status is classified into durably-closed, live-query-admissible, and
      unresolved buckets": `absent`/`terminal_unfilled` → closed directly, no exchange
      call; `applied`/`pending_replace`/`pending_cancel` → proceed to live query;
      `pending_create`/`create_failed`/`unknown` → `internal_error`, no exchange call.
      `create_failed` is currently unproduced by `entryPackageApplicationService.ts`
      (design.md Context/Decision 2) — classify it defensively for forward
      compatibility, but do not build or test around any specific assumed meaning for
      it beyond "unresolved, fail closed". Do not read `early_execution_observation`
      anywhere in this service.
- [ ] 2.4 Implement the linear-category gate before any exchange call for
      live-query-admissible records: non-`linear` `record.exchange_category` →
      `unsupported_exchange_scope` (design.md Decision 3).
- [ ] 2.5 Call the typed Bybit query (section 3) with `{ category:
      record.exchange_category, symbol: record.exchange_symbol }` — never the global
      configured category (design.md Decision 4/5).
- [ ] 2.6 Implement the side-match check: map the returned row's `side` (`Buy`/`Sell`) to
      `record.desired_entry.side` (`long`/`short`); mismatch → `internal_error`
      (design.md Decision 5, spec "Live position side must match the record's desired
      entry side"). This check validates plausibility against the record's own declared
      intent under the V1 attribution precondition (design.md Decision 9) — it is not a
      cross-check against any Bybit order/execution identity.
- [ ] 2.7 Implement final response assembly: no live row (or all rows `size == 0`) →
      `position_open: false`, both facts `null`; matching row → `position_open: true`,
      `first_fill_at_ms` = row `openTime`, `average_entry_price` = row `avgPrice`
      unmodified (design.md Decision 5). A partial fill (`size > 0`, any amount) already
      counts as open — no full-execution wait.
- [ ] 2.8 Map every adapter-layer failure from section 3 (transport, malformed envelope,
      malformed item, symbol mismatch, missing/invalid/negative size, missing fields on
      a size-positive row, invalid decimal, invalid timestamp, zero/negative price,
      ambiguous rows, hedge row) to `internal_error`, never to `position_open: false`.
- [ ] 2.9 Add a short module-level comment on the resolution service documenting the V1
      attribution/operating precondition (design.md Decision 9): correct attribution
      depends on no overlapping manual/other-strategy exposure existing on the same
      `exchange_symbol` under the deployment's configured API credentials; this is not
      detected, enforced, or verified in code.

## 3. Typed Bybit position query and mapping

- [ ] 3.1 Add `category?: string` to `GetOpenPositionsInput`
      (`src/exchange/bybitAdapter.ts:60-63`), defaulting to `this.config.bybitCategory`
      only when omitted, in `RestBybitAdapter.getOpenPositions()`
      (`bybitAdapter.ts:106-114`) and any other implementer. Confirm every existing call
      site (legacy `/signals`, `/intents/*`, `accountRoutes`, post-create-protection
      verification) keeps omitting it and is behaviorally unaffected (design.md Decision
      4, closes gap G2).
- [ ] 3.2 Add `avgPrice?: string` and `openTime?: number` to `BybitPosition`
      (`bybitAdapter.ts:16-21`) and best-effort-populate them in the existing
      `readOpenPosition()` (`bybitAdapter.ts:348-377`) without changing its existing
      filtering/return behavior for current callers (closes gap G3).
- [ ] 3.3 Add a new adapter method (e.g. `queryPositionForInstrument({ category, symbol })`
      on `BybitAdapter`/`RestBybitAdapter`) that calls `getOpenPositions({ category,
      symbol })` with the explicit category from 3.1 and performs all raw-shape
      validation from design.md Decision 4 / spec "The raw Bybit position response is
      strictly validated before being trusted". This method validates the actual
      response envelope itself (`result` is an object, `result.list` is an array) and
      does **not** reuse `readBybitList()`'s lenient fallback-to-`[]` behavior
      (`bybitAdapter.ts:393-405`), since that would let a malformed envelope silently
      read as "no position". In order: malformed envelope (missing/non-object `result`,
      missing/non-array `result.list`) → failure; non-object list item → failure; item
      `symbol` missing, not a string, or not equal to the exact requested `symbol` →
      failure; item `size` missing, not valid exact-decimal text, non-finite, or negative
      → failure (**never** "no position" — this is the exact case that removes the prior
      contradiction between "missing size fails" and "size is excluded": those are
      disjoint outcomes of parsing the same field); item `size` parsing to **exactly
      zero** → excluded from consideration, and `side`/`positionIdx`/`avgPrice`/
      `openTime` are **not** read or validated on that item at all (Bybit's flat-position
      row carries empty/default values for these on a closed symbol); item `size`
      parsing **greater than zero** → additionally require `side` exactly `Buy`/`Sell`,
      `positionIdx` present and an integer, `avgPrice` present and valid positive
      exact-decimal text (reuse the existing exact-decimal parser from
      `src/domain/entryPackageApi.ts`, extended to accept a zero value for the `size`
      check above; do not reimplement), `openTime` present and a positive integer — any
      violation is a failure; more than one `size > 0` item → ambiguous failure; a
      `size > 0` item with non-zero `positionIdx` and no valid `positionIdx == 0` item →
      hedge-row failure. Returns a discriminated result: a single structurally valid row,
      "no position" (zero `size > 0` items, whether from an empty list or all-zero-size
      items), or a typed failure — this method does not know or check
      `record.desired_entry.side` (design.md Decision 4, explicit boundary).
- [ ] 3.4 Add a typed error/result type for 3.3's failure branches so the application
      service (2.8) can map each to `internal_error` without inspecting adapter
      internals.

## 4. HTTP route and path decoding

- [ ] 4.1 Add a route matcher (e.g. `matchOpenPositionRoute` in a new
      `src/routes/openPositionRoutes.ts`) mirroring `matchEntryPackageRoute`
      (`src/routes/entryPackageRoutes.ts:104-146`): `GET` only, exact 7-segment path
      `/v1/strategy-instances/{id}/trade-cycles/{id}/open-position`, per-segment
      `decodeURIComponent` with empty-value rejection as `validation_failed`
      (design.md Decision 7).
- [ ] 4.2 Add `handleOpenPositionRoutes(...)` following the same
      try/catch-to-`internal_error`, `isReady()`-gated pattern as
      `handleEntryPackageRoutes` (`entryPackageRoutes.ts:33-100`) — no request body is
      read; no content-type check applies (spec `abi-open-position-lookup-api`, "The
      request carries no body").
- [ ] 4.3 Wire the matched, decoded path values into the section-2 resolution service and
      write its result using the same `writeJson`/result-writing helper the entry-package
      route uses.

## 5. Composition/readiness wiring

- [ ] 5.1 In `src/app/server.ts`, construct the section-2 resolution service using the
      existing `correlationRepository` and `bybit` instances already constructed there
      (`server.ts:22,24`) — no new repository, no new adapter instance (design.md
      Decision 8).
- [ ] 5.2 Add `handleOpenPositionRoutes` to the route chain in `server.ts`, gated on the
      same existing `readiness.isReady` used by `handleEntryPackageRoutes`
      (`server.ts:64-73`) — no new readiness signal, no new persistence owner.

## 6. OpenAPI operation

- [ ] 6.1 Add a new OpenAPI 3.1 operation for `GET
      /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
      to the existing OpenAPI document (following the pattern in
      `docs/openapi/abi-entry-package-api-v1.json`), covering the path parameters, the
      closed success DTO with its cross-field invariant, and the four documented error
      responses from spec `abi-open-position-lookup-api` — no internal application types,
      record-state names, or exchange adapter shapes. Note the V1 attribution operating
      precondition (design.md Decision 9) in the operation description in plain,
      external-contract terms (no manual/other-strategy exposure overlapping the same
      symbol under the deployment's credentials), without exposing internal record-state
      or adapter mechanics.

## 7. Unit tests

- [ ] 7.1 Unit test the three-bucket status classification (section 2.3) for all eight
      `EntryPackageExecutionStatus` values individually.
- [ ] 7.2 Unit test the missing-record branch (2.2), the category gate (2.4), and the
      side-match branch (2.6), including both the pass and fail cases for each.
- [ ] 7.3 Unit test response assembly (2.7): open with partial fill, open with full fill,
      closed via no live row, closed via all-`size==0` rows.
- [ ] 7.4 Unit test the typed Bybit query (3.3) directly against constructed raw
      response fixtures for every validation branch in design.md Decision 4: malformed
      envelope (missing `result`, `result.list` missing or not an array), non-object list
      item, symbol mismatch (item `symbol` absent/wrong-typed/not equal to the requested
      symbol), missing `size`, non-exact-decimal or non-finite `size`, negative `size`,
      a valid exact-zero `size` row with empty/default `side`/`avgPrice`/`openTime`
      (asserted as **not** a failure and those fields **not** validated), a `size > 0`
      row missing or with invalid `side`/`positionIdx`/`avgPrice`/`openTime`
      individually, multiple plausible `size > 0` rows, unexpected non-zero
      `positionIdx` on the only `size > 0` row, and the "no position" empty-list case.
- [ ] 7.5 Unit test the route matcher (4.1) for valid paths, missing/empty segments, and
      malformed percent-encoding, mirroring the existing `matchEntryPackageRoute` test
      coverage style.

## 8. Route/contract tests

- [ ] 8.1 Contract-test the success DTO shape and cross-field invariant (closed object,
      no extra fields, both-null vs both-non-null) against
      `abi-open-position-lookup-api`'s spec scenarios.
- [ ] 8.2 Contract-test every documented error response (`validation_failed`,
      `unknown_trade_cycle_binding`, `unsupported_exchange_scope`, `internal_error`) for
      exact HTTP status, `error.code`, and `error.details` presence/absence.
- [ ] 8.3 Contract-test that no response ever contains `404`, raw Bybit response bodies,
      internal exception details, or a stack trace.
- [ ] 8.4 Route-test readiness gating: request before `EntryPackageReadiness` succeeds
      returns `internal_error` without attempting correlation lookup or an exchange call.

## 9. Fake-Bybit integration tests

- [ ] 9.1 Integration test the full happy path against a fake Bybit backend: correlation
      record with `applied` status → fake position with `size > 0`, matching side,
      `positionIdx: 0` → `position_open: true` with `first_fill_at_ms`/
      `average_entry_price` sourced from the fake response.
- [ ] 9.2 Integration test partial fill (`size` less than the record's intended order
      quantity) still reports `position_open: true`.
- [ ] 9.3 Integration test closed-position paths: `absent`/`terminal_unfilled` records
      (no exchange call made — assert the fake Bybit backend is not invoked), and
      `applied`/`pending_replace`/`pending_cancel` records against a fake backend
      reporting no open row.
- [ ] 9.4 Integration test unresolved-status records (`pending_create`, `create_failed`,
      `unknown`) return `internal_error` without invoking the fake Bybit backend.
- [ ] 9.5 Integration test unsupported category (non-`linear` `exchange_category` on the
      record) returns `unsupported_exchange_scope` without invoking the fake Bybit
      backend.
- [ ] 9.6 Integration test exchange-derived failures against the fake backend: simulated
      timeout, malformed envelope (`result`/`result.list` missing or wrong-shaped),
      symbol-mismatched row, missing/invalid/negative `size`, malformed response body,
      wrong side, hedge-mode row (non-zero `positionIdx`) — each returns
      `internal_error`. Include a case with a valid zero-size row carrying empty/default
      `side`/`avgPrice`/`openTime` and confirm it resolves as closed, not a failure.
- [ ] 9.7 Integration test the missing-record case end-to-end: a pair with no correlation
      record returns `unknown_trade_cycle_binding` without invoking the fake Bybit
      backend.

## 10. Full verification and OpenSpec synchronization

- [ ] 10.1 Run `npm test`, `npm run typecheck`, and `npm run build`; fix any failures.
- [ ] 10.2 Run `openspec validate abi-open-position-lookup-v1 --strict` and `openspec
      validate --all --strict`; fix any errors.
- [ ] 10.3 Confirm no diff to `EntryPackageCorrelationRepository`'s schema/index, the
      entry-package PUT route or its application service write paths, legacy
      `/signals`/`/intents/*`/`accountRoutes` behavior, or any file under the
      `strategy_runtime` repository.
- [ ] 10.4 Sync specs and archive this change only after explicit user approval and
      review of the implementation against `proposal.md`, `design.md`, and both delta
      specs.
