## Context

`PUT .../protection` is fully specified in `abi-position-management-api` (validation, response
shapes, error codes, the exact-numeric-equality confirmation rule) but the route
(`positionManagementRoutes.ts::handleProtection`) always returns `internal_error` after validation —
`ProtectionCommand` is built and then discarded. `ProtectionConfirmation` and
`serializeProtectionApplied` already exist in `positionManagementApi.ts` but nothing constructs a
`ProtectionConfirmation` today. This design wires the missing execution path.

## Decision 1: A new `ProtectionApplicationService`, not an extension of `EntryPackageApplicationService`

Protection has no order identity, no generations, no binding history, and writes nothing to the
correlation store — it only reads an existing record and talks to Bybit. Folding it into
`EntryPackageApplicationService` would mix an order-lifecycle state machine with a stateless
read-verify-write-verify operation. A dedicated service (`src/services/protection/
protectionApplicationService.ts`) keeps both simple, matching the existing separation between
`EntryPackageApplicationService` (writes correlation state) and `OpenPositionResolutionService`
(reads only).

## Decision 2: Ownership is re-verified independently, not assumed from the record's mere existence

`position-scope-exclusivity` already guarantees that a non-durably-closed record's
`(exchange_category, exchange_symbol)` is the scope it owns. Protection execution calls
`correlationRepository.findOwnerByScope(record.exchange_category, record.exchange_symbol)` and
checks the result is this exact pair before doing anything else. Under a correctly functioning
invariant this can never fail for a live record — the check exists so that if the invariant is ever
violated (a future bug, a bad migration, manual correlation-file edits), protection fails closed
instead of silently trusting a stale assumption. This is the concrete form of "pair → stored scope →
current scope owner == pair" from the task description. A mismatch returns `internal_error`; it is
not given its own error code, matching how `position-scope-exclusivity` itself already reuses
`internal_error` for its own conflict case.

## Decision 3: The live-position gate reuses `OpenPositionResolutionService`, not a second query path

Re-deriving Bybit position-envelope validation a second time would duplicate
`open-position-resolution`'s already-exhaustive rules (envelope shape, cardinality, `positionIdx`,
side match, zero-size handling). Instead, `OpenPositionResolutionService.resolve()` is split into its
existing HTTP-shaping wrapper plus a new internal method returning a small discriminated result
(`open` / `closed` / `unsupported_scope` / `error`) that both the `GET .../open-position` route and
`ProtectionApplicationService` call. No behavior changes for the existing GET endpoint — its own test
suite must pass unchanged. Protection maps `closed` → `position_not_open`, `unsupported_scope` →
`unsupported_exchange_scope`, `error` → `internal_error`, and only `open` proceeds to the write.

## Decision 4: The Bybit write is a full-state position-level trading-stop, not an order amend

Bybit's `POST /v5/position/trading-stop` (`category`, `symbol`, `positionIdx=0`, `tpslMode=Full`,
`stopLoss`, `takeProfit`) sets the whole current stop-loss/take-profit state for the position, not a
delta. `take_price: null` in the request maps to `takeProfit: ""` (Bybit's own "clear this leg"
convention) — the request body is already a closed object requiring both fields, so a PUT is always a
full replace of both legs, never a partial patch. Trigger price source reuses the existing
`config.bybitTriggerBy` (default `LastPrice`), the same source entry-package execution's legacy
attached-protection mapping used. `SetTradingStopInput`/`BybitAdapter.setTradingStop` (currently an
unused stub with the wrong shape — no `category`, `positionIdx`, or `tpslMode`) is replaced with a
correctly-shaped method; nothing else calls the old stub today (`placeMarketOrder`/`setTradingStop`
have zero callers outside `bybitAdapter.ts` and the fakes).

## Decision 5: Live-execution guard reuses `execution.ts`'s existing pattern

`getLiveExecutionMode(config).canExecuteLive === false` (dry-run, live trading disabled, missing
credentials, or mainnet) must produce `internal_error`, exactly like `executeEntryOrder`'s
`skipped_live_execution` branch does today for entry creation — never a fabricated
`protection_applied` for a write that never reached Bybit. A new `executeProtectionUpdate` helper in
`execution.ts` mirrors the existing `executeEntryOrder`/`amendEntryOrder` shape.

## Decision 6: Read-back reuses the same validated query, extended with two fields

Rather than a second, protection-specific position query, `ValidatedOpenPositionRow` gains
`stopLoss`/`takeProfit` (Bybit's raw exact-decimal strings, `""` meaning "not set", validated the
same way `avgPrice` already is when size > 0). The read-back step re-runs the same
`queryPositionForInstrument` used for the pre-write gate — a fresh call, not the pre-write result —
and compares via the existing `isNumericallyEqualExactDecimal` (`positionManagementApi.ts`), matching
the already-specified "string formatting differences don't block confirmation, numeric differences
do" rule. `take_price: null` in the request compares against an empty/unset `takeProfit` on the
read-back row.

## Decision 7: Concurrency reuses the existing per-pair `mutex`; `scopeMutex` is not involved

`ProtectionApplicationService` takes the same `KeyedMutex` instance already passed to
`EntryPackageApplicationService` as a dependency and wraps its whole operation in
`mutex.withKeyLock(correlationRecordKey(strategyInstanceId, tradeCycleId), ...)` — the identical key
space, so a protection PUT and a concurrent entry-package PUT for the same pair (e.g. a REPLACE
changing `exchange_symbol`) always serialize against each other and never interleave. `scopeMutex` is
irrelevant here: protection never claims or releases a scope, only reads the existing ownership
index, so acquiring it would add coordination cost without protecting anything.

## Decision 8: Readiness gate reuses the existing entry-package readiness signal

Protection reads the same recovered correlation store `open-position-resolution` and
`entry-package-execution` already depend on. The route gates on the same `EntryPackageReadiness`
signal (`isReady()`) already wired for entry-package and open-position routes in `app/server.ts`,
returning `internal_error` when not ready, rather than introducing a second readiness concept.

## Non-goals restated

No new durable field on `EntryPackageExecutionRecord`: Runtime, not ABI, owns
`latest_confirmed_management_protection`. No scope release: the pair's scope stays held exactly as
`position-scope-exclusivity` already conservatively defines, until a future close-execution change
proves the trade cycle is durably done. No change to `DELETE .../open-position`, still a
transport-only stub. No command IDs or new retry bookkeeping — a repeated PUT with the same values
simply re-runs the same read-verify-write-verify sequence; idempotency here means "re-applying is
always safe," not "a duplicate is detected and skipped."
