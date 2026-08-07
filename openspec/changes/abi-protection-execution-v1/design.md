## Context

`ProtectionConfirmation`/`serializeProtectionApplied` already exist in `positionManagementApi.ts`, but
nothing constructs a `ProtectionConfirmation` today — `handleProtection` always returns
`internal_error`. This design wires the missing execution path.

## Decision 1: A new `ProtectionApplicationService`

Protection has no order identity, no generations, no binding history, and writes nothing to the
correlation store. A dedicated service (`src/services/protection/protectionApplicationService.ts`)
keeps that stateless read-verify-write-verify shape separate from
`EntryPackageApplicationService`'s order-lifecycle state machine.

## Decision 2: Durable-absence is checked before ownership, not after

`position-scope-exclusivity` releases a pair's scope once its record reaches `absent` or
`terminal_unfilled` — a different pair may already own that scope by the time a stale protection
command for the closed pair arrives. An ownership lookup run first for such a record could
legitimately return "no owner" or "a different pair," which is not a violation, just a closed
position. The pipeline checks durable-absence first (`position_not_open`, done) and only reaches the
ownership check for a record in any other, scope-holding status.

## Decision 3: Ownership is re-verified independently, not assumed from the record's existence

For a non-durably-absent record, the pipeline explicitly checks the current owner of
`(exchange_category, exchange_symbol)` in `position-scope-exclusivity`'s ownership index, rather than
proceeding on the assumption that having a record implies ownership. Under a correctly functioning
invariant this can never fail — it exists so a future bug, bad migration, or manual correlation-file
edit fails closed (`internal_error`) instead of silently trusting a stale assumption.

## Decision 4: The live-position gate reuses `OpenPositionResolutionService`

Re-deriving Bybit position-envelope validation would duplicate `open-position-resolution`'s
already-exhaustive rules. `OpenPositionResolutionService.resolve()` is split into its existing
HTTP-shaping wrapper plus a new internal method returning a small discriminated result (`open` /
`closed` / `unsupported_scope` / `error`), used by both the GET route and this service, with no
behavior change for the existing GET endpoint.

## Decision 5: The write is a full-state trading-stop; clearing take-profit sends "0"

`POST /v5/position/trading-stop` (`category`, `symbol`, `positionIdx=0`, `tpslMode=Full`, `stopLoss`,
`takeProfit`) replaces the whole protection state, not a delta. Bybit's convention for removing a leg
on this endpoint is the numeric value `"0"`, not an empty string; `take_price: null` is sent as
`takeProfit: "0"`. Trigger price source reuses `config.bybitTriggerBy`. The old
`SetTradingStopInput`/`BybitAdapter.setTradingStop` stub (wrong shape, zero real callers) is replaced.

## Decision 6: Read-back is a bounded re-query treating numeric zero as "leg not set"

A single immediate re-query risks observing stale state and reporting a false `internal_error` for a
write that did apply. Read-back reuses the bounded-retry shape `packageConfirmation.ts` already uses
elsewhere in ABI (a small fixed number of attempts, short delay between them) — re-reading only, never
resending the write, so this is not a new retry mechanism.

Bybit's `/v5/position/list` reports an unset leg as a numeric zero (e.g. `"0.00"`), not necessarily
the string the write used. Read-back classifies confirmed values by numeric zero-ness, not string
match: zero satisfies an accepted `take_price: null`; a non-zero value must be exact-decimal
numerically equal to the accepted request value. `stopLoss`/`takeProfit` are added to the validated
position-query row as raw, optional fields — not required-positive like `avgPrice`, since a
legitimately unset leg is zero — so the existing query's pass/fail behavior for `GET
.../open-position` is unaffected.

## Decision 7: No new concurrency or readiness infrastructure

The service takes the same `KeyedMutex` instance already passed to `EntryPackageApplicationService`
and wraps its operation in the identical `correlationRecordKey` lock, so a protection PUT and a
concurrent entry-package command for the same pair always serialize. The scope-level lock is not
used: protection only reads the ownership index, never claims or releases a scope. The route gates on
the existing `EntryPackageReadiness` signal already wired for entry-package and open-position routes.

## Non-goals restated

No new durable field on `EntryPackageExecutionRecord` — Runtime, not ABI, owns
`latest_confirmed_management_protection`. No scope release — deferred to a future close-execution
change. No change to `DELETE .../open-position`. No command IDs or retry bookkeeping beyond the
bounded read-back in Decision 6.
