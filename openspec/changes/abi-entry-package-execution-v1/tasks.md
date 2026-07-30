## 1. Internal domain types and semantics mapper

- [ ] 1.1 Add `src/domain/entryOrderSemantics.ts`: pure `mapEntryOrderSemantics(side: "long" | "short") -> { exchangeSide: "Buy" | "Sell", triggerDirection: "rises_to" | "falls_to" }` implementing the V1 table (`long → Buy, falls_to`; `short → Sell, rises_to`), with no market-price parameter in its signature and a comment noting it is scoped to the currently supported EMA-pullback entry geometry (design.md §2).
- [ ] 1.2 Add `src/correlation/entryPackageExecutionRecord.ts`: `EntryPackageExecutionRecord` type, `status` union (including `terminal_unfilled`), `EarlyExecutionObservation` type, `BindingHistoryEntry` type, per design.md §5.
- [ ] 1.3 Unit tests for the mapper: long→Buy/falls_to, short→Sell/rises_to, no market-price dependency in the function signature, deterministic across repeated calls with the same input.

## 2. Correlation repository and durability

- [ ] 2.1 Add `src/correlation/entryPackageCorrelationRepository.ts` implementing the durable write sequence from design.md §4: serialize full record → single `write()` with trailing newline → explicit `fsync` (`fsPromises.open` → `handle.appendFile` → `handle.sync()` → `handle.close()`) → update in-memory indexes → resolve.
- [ ] 2.2 Implement an internal FIFO write queue serializing all physical appends across keys (design.md §4), independent of the keyed mutex from group 6.
- [ ] 2.3 Implement startup replay: read the correlation file, keep only the last valid line per composite key, tolerate a truncated final line, fail readiness on any non-final corrupt line (design.md §4, audit §11/§14).
- [ ] 2.4 Build in-memory indexes at replay/write time: composite key → record, `order_link_id` → record (including historical `binding_history` entries), `order_id` → record.
- [ ] 2.5 Add `ABI_ENTRY_PACKAGE_CORRELATION_PATH` to `src/config/config.ts` (new file path, sibling to `journalPath`, not reusing it).
- [ ] 2.6 Unit tests: durable write sequence ordering, crash-during-append (truncated tail) recovery, non-final corruption fails readiness, composite/`order_link_id`/`order_id` lookups including historical bindings, restart restores current and historical bindings.

## 3. Order identity/generation

- [ ] 3.1 Add `src/domain/entryPackageOrderIdentity.ts`: `buildEntryPackageOrderLinkId(strategyInstanceId, tradeCycleId, role, generation) -> string`, following the existing `sha256(...).slice(0, N)` + prefix pattern, verified to stay under Bybit's documented 36-character `orderLinkId` limit.
- [ ] 3.2 Encode the generation rules from design.md §3 / audit §7 in the application service (group 7): generation is read from the correlation record, not re-derived; first create reserves generation 1; amend-in-place keeps the same generation; cancel-and-create reserves the next generation; retry of an ambiguous/timed-out attempt reuses the already-reserved generation.
- [ ] 3.3 Unit tests: distinct trade cycles of the same strategy instance produce distinct identities; identical inputs are deterministic; identity changes only with generation, not with any other field.

## 4. Instrument rules and placeholder sizing

- [ ] 4.1 Add `getInstrumentInfo(symbol: string): Promise<unknown>` to the `BybitAdapter` interface, `RestBybitAdapter` (unsigned `GET /v5/market/instruments-info`), and `StubBybitAdapter`.
- [ ] 4.2 Add `src/exchange/instrumentTradingRulesProvider.ts`: `InstrumentTradingRulesProvider` port and a Bybit-backed implementation parsing `lotSizeFilter.minOrderQty`/`.qtyStep`/`.minNotionalValue`, with lazy per-resolved-symbol lookup and an in-memory TTL cache (design.md §7).
- [ ] 4.3 Failure to fetch rules for a symbol surfaces as `internal_error` for that command only, never as a whole-service readiness failure (design.md §7).
- [ ] 4.4 Add `src/exchange/exchangeSymbolResolver.ts`: define the `ExchangeSymbolResolver` interface (`resolve(ticker: string): string`) as an injected seam. Do not implement production resolution logic in this change (design.md §9) — this task defines the interface only, so callers in groups 5/7 can depend on it via injection.
- [ ] 4.5 Add `src/risk/positionSizeCalculator.ts`: `PositionSizeCalculator` port (`calculate(ticker, plannedEntryPrice, initialStopPrice, riskMultiplier, context) -> calculatedQuantity`) and `FixedMinimumPositionSizeCalculator` implementing `max(qty_by_min, qty_by_notional)` with round-up-to-`qty_step` exact-decimal arithmetic (design.md §8), no `Number()` conversion at any step.
- [ ] 4.6 Add `test/fakes/fakeInstrumentTradingRulesProvider.ts` and a trivial test-only `ExchangeSymbolResolver` fake (identity/no-op), modeled on `test/fakes/fakeBybitAdapter.ts`.
- [ ] 4.7 Extend `test/fakes/fakeBybitAdapter.ts` with a fake `getInstrumentInfo`; extend `test/fixtures/config.ts` with defaults for the new config fields.
- [ ] 4.8 Unit tests: min-qty-only case, min-notional-driven case (qty_by_notional > qty_by_min and vice versa), exact-decimal division correctness (no float conversion), rules-unavailable fails only the current command, `risk_multiplier` is accepted and threaded through without affecting the V1 result, no hardcoded quantity literal appears in the application service (static/contract check).

## 5. Bybit payload/adapter extensions

- [ ] 5.1 Add a new entry-package payload builder in `src/exchange/bybitOrderMapper.ts` (or an adjacent new file) that reuses `mapSide`/`mapTriggerDirection` and constructs Bybit create/amend/cancel payloads from entry-package inputs (desired entry, calculated quantity, resolved symbol, order identity) — without calling or modifying `mapExecutionPlanToBybit` or the legacy `ExecutionPlan` type.
- [ ] 5.2 Wire the `ExchangeSymbolResolver` seam (task 4.4) into this payload builder and into `InstrumentTradingRulesProvider` lookups: both consume an already-resolved `symbol`, never a raw `ticker`.
- [ ] 5.3 Unit tests: payload builder produces correct `triggerDirection`/`side`/`tpslMode`/quantity fields for representative long/short, with/without take-profit cases; confirms `mapExecutionPlanToBybit` is not called by any new code path (static/contract check).

## 6. Package confirmation

- [ ] 6.1 Add `src/services/entryPackage/packageConfirmation.ts`: bounded-retry confirmation (starting from the existing `2`-attempt/`300ms` pattern in `verifyPostCreateProtection.ts`, tunable) that queries `getOrderByLinkId` and diffs the returned `triggerPrice`/`qty`/`stopLoss`/`takeProfit` against the desired package.
- [ ] 6.2 Classify into the five audit §26 outcomes: pending order confirmed, full fill before acknowledgement, partial fill before acknowledgement, rejected/deactivated before any fill, ambiguous observation.
- [ ] 6.3 On full/partial fill, extract and return an aggregate `EarlyExecutionObservation` (`order_status`, `cumulative_filled_qty`, `remaining_qty`, `avg_execution_price?`, `observed_at`) without reconstructing individual fills.
- [ ] 6.4 On ambiguous observation, surface a result that the application service (group 7) maps to `internal_error`, never a success.
- [ ] 6.5 Unit tests for each of the five outcomes, and confirmation of cancel (expects not-found or terminal-cancelled status).

## 7. EntryPackageApplicationService

- [ ] 7.1 Add `src/concurrency/keyedMutex.ts`: `withKeyLock(key, fn)` chaining promises per key in a `Map`, in-process only (design.md §6).
- [ ] 7.2 Add `src/services/entryPackage/entryPackageApplicationService.ts` implementing the flow from design.md §11: acquire keyed mutex → load correlation record → classify CREATE/REPLACE/CANCEL/CONFIRM-ABSENT/repeat-PUT → (for CREATE/REPLACE) map semantics → calculate quantity → build payload → persist provisional record → call guarded `execution.ts` function → confirm → persist confirmed/failed state → release mutex → serialize result.
- [ ] 7.3 Implement REPLACE routing: amend-in-place when only price/qty/stop/take change; cancel-and-create (new generation) when side changes.
- [ ] 7.4 Implement repeat-PUT bounded revalidation for `status = "applied"`: classify into pending-matches / fill-observed / terminal-without-fill / contradictory, per spec's "Repeat requests ... truthfully revalidated" requirement.
- [ ] 7.5 Implement the `terminal_unfilled` fail-closed path: non-null repeat PUT while `terminal_unfilled` returns `internal_error` without creating a new order; a `desired_entry: null` PUT while `terminal_unfilled` is permitted and transitions to `absent`; a subsequent non-null PUT after confirmed `absent` starts a normal CREATE with a new generation.
- [ ] 7.6 Ensure every non-success path (transport failure, confirmation failure, ambiguous state, durability write failure) returns one of the existing public error responses and never a fabricated `entry_package_applied`/`entry_package_absent`.
- [ ] 7.7 Unit/integration tests (against `FakeBybitAdapter` + fakes from group 4): first APPLY, identical repeated APPLY, REPLACE via amend, REPLACE via cancel-and-create, successful CANCEL, already-absent CANCEL, create transport failure, create accepted but confirmation failed, terminal-without-fill fail-closed then CANCEL then fresh CREATE, concurrent identical PUT produces one exchange order, concurrent differing PUT does not interleave.

## 8. Route/composition wiring

- [ ] 8.1 Update `src/routes/entryPackageRoutes.ts` to call `EntryPackageApplicationService` instead of unconditionally returning `internalErrorResult()`, using the existing `serializeAppliedEntryPackage`/`serializeAbsentEntryPackage` for output.
- [ ] 8.2 Update `src/app/server.ts` to construct and wire the new correlation repository, instrument rules provider, position size calculator, keyed mutex, and application service, leaving `signalRoutes`/`intentRoutes`/`accountRoutes`/`systemRoutes` wiring unchanged.
- [ ] 8.3 Gate startup: the correlation repository's replay must complete successfully before the server reports ready / begins accepting entry-package requests, per design.md §4 / spec's startup-readiness requirement.
- [ ] 8.4 Verify (by reading the diff, not just by tests passing) that `entryPackageRoutes.ts` does not touch correlation state, Bybit, or the mutex directly.

## 9. Tests and new entry-package smoke scripts

- [ ] 9.1 Run the full unit/integration suite added in groups 1-8 and confirm coverage of the acceptance-matrix categories in `docs/ENTRY_PACKAGE_EXECUTION_AUDIT.md` §18: identity/concurrency, durability, confirmation, repeated PUT, sizing, readiness boundary, pure mapping, stability, layering, V1 scope.
- [ ] 9.2 Add a new entry-package smoke script (e.g. `scripts/smoke-entry-package-contract-matrix.sh`) exercising apply → replace-via-amend → replace-via-cancel-and-create → cancel → already-absent against demo/testnet or the fake smoke server, mirroring `smoke-sandbox-contract-matrix.sh`'s structure without modifying that file.
- [ ] 9.3 Add the new script's `npm run` entry to `package.json` alongside the existing `smoke:*` scripts, without changing any existing script.
- [ ] 9.4 Confirm the legacy smoke scripts (`smoke:sandbox:contract`, `smoke:contract:fake`, `smoke:sandbox:amend`, `smoke:sandbox:order`/`smoke:testnet:order`, `smoke:sandbox:read`) still pass unmodified, verifying the spec's "legacy signal and intent endpoints remain unaffected" requirement.
- [ ] 9.5 Run `npm test`.
- [ ] 9.6 Run `npm run typecheck`.
- [ ] 9.7 Run `npm run build`.
- [ ] 9.8 Review the full diff to confirm: no edits to any file `docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md` marks `LEGACY_ONLY`; no new fields added to the public entry-package request/response DTOs; no fabricated `2xx` on any error path.
