## Context

Current order inside `createOrder` for a new generation:

1. `exchangeInstrumentResolver.resolve(ticker)` — may throw
2. `positionSizeCalculator.calculate(...)` — Bybit instruments info; failure → `500`
3. `effectivePositionBindingMode(...)` — `null` → `500`
4. scope mutex: `classifyScopeAdmission`, hedge `assureBindingBeforeAdmission` — conflict → `500`
5. `save(provisional)` with `status: pending_create` — **first durable write**
6. `executeEntryOrder` (Bybit) — exception → `save(unknown)` → `500`

Any exception anywhere is also caught in `applyLocked` and mapped to `500`.
Steps 1–4 leave no durable record. Recovery-state returns `422` when
`correlationRepository.get` finds nothing. Runtime keeps its marker on `422` by design.

Observed: XRP cycle `63f997ee` — `operation_started` 10:05:24.760, `operation_failed
internal_error` 10:05:25.005 (245 ms), no record, no Bybit order. The stage is unknown
because the event has no cause.

## Goals / Non-Goals

Goals: every PUT that reaches the application service leaves exactly one durable trace for
its pair, and every pre-exchange failure ends in a durable closed fact the existing
recovery rule already maps to `terminal_without_fill`. Failure cause is visible in logs.

Non-goals: see proposal. In particular nothing in Runtime changes.

## Decisions

### D1. Admission intent record is the first action for a new pair

In `handleNonNullDesiredEntry`, when `record === undefined`, before step 1, ABI saves:
`status: admission_pending`, `order_link_id: null`, `order_id: null`,
`exchange_symbol: ""`, `exchange_category: ""`, `desired_entry`, `risk_multiplier`,
`ticker`, `generation: 0`, `pending_action: null`, `current_binding_started_at: null`,
empty history. The empty category already excludes it from
`findActiveRecordsForInstrumentScope`, so it can never block or claim a scope.

If this save throws, ABI returns `500` and writes nothing else (the repository's own
durability/poison rules apply). This is the residual case in the Open question.

Alternative rejected: write only at failure time. A crash between receipt and the failure
write would again leave nothing; the intent record survives a crash and is converted at
startup (D3).

Pairs that already have a record (`absent` → new generation, `order_link_id === null`
retry) keep their existing record as the durable trace; D2 applies to them too.

### D2. Pre-exchange failure is persisted as `absent` before responding

`createOrder` tracks one local flag: `exchangeBoundaryReached`, set immediately before
`save(provisional)` is awaited. Any failure while the flag is false — thrown or returned
as `internal_error` from steps 1–4, including a scope conflict — durably transitions the
pair's record to `absent` (`desired_entry: null`, `order_link_id: null`, `updated_at`
now; for a pre-existing record its prior closed status/history is preserved, i.e. only an
`admission_pending` record is changed). Then ABI returns the same `500 internal_error`.

An exception escaping `createOrder` before the boundary is handled the same way in
`admitNewPair` (still under the pair lock) before it propagates to `applyLocked`, which
maps it to `internal_error` with `failure_stage: "unexpected"`. A record already at `pending_create`
or later is never touched by this path.

Why `absent` and not a new terminal status: `absent` is already durably closed, already
excluded from scope ownership, already resolves `terminal_without_fill`, and already lets
a later PUT start a new generation. No recovery or Runtime contract changes.

Why safe: exchange calls for a generation happen only after `save(provisional)`
(existing requirement "Provisional record exists before the exchange is contacted"). If the
flag is false, this invocation cannot have contacted the exchange for the pair.

If the `absent` write itself fails, the record stays `admission_pending`; D3 converts it
at the next start; until then recovery answers safe `500`.

Invariant (owner review 2026-10-21): the flag is not evidence. It only selects which
error branch runs. The proof that the exchange was never contacted is the durable state:
the transition to `absent` is a conditional write applied only when the pair's current
record, re-read under the pair lock, is still `admission_pending`. Recovery answers
`terminal_without_fill` only from the durable `absent` status. The flag is set before
`save(provisional)` is awaited, so a failed or ambiguous provisional write never leads to
`absent` in this invocation: the record stays `admission_pending` in memory (the store
indexes a record only after its append succeeded), recovery answers safe `500`, and after
a restart replay sees either `pending_create` (bytes reached disk; existing ambiguous-CREATE
recovery applies) or `admission_pending` (D3).

### D3. Startup conversion of leftover `admission_pending`

During correlation replay, before readiness, every `admission_pending` record is
transitioned to `absent` with a durable write. A failed write fails readiness. Rationale:
no in-flight PUT survives a process restart, and none of those records reached the
exchange boundary.

Precondition (existing, not new): exactly one live ABI process writes a given correlation
store. The repository is already documented as a single-writer store
(`EntryPackageCorrelationRepository`), the deployment runs one `abi` service with no
replicas, and a restart stops the old process before the new one replays. D3 relies on
that invariant and adds no distributed locking. Running two ABI processes on one store is
outside the contract: D3 could then close an intent that the other process is still
admitting. The deploy note for this change restates the precondition.

### D4. Recovery-state and open-position behavior

`admission_pending` is not durably closed and has `order_link_id: null`, so the existing
rule already returns safe `500 internal_error` (retry later). Recovery convergence never
writes `admission_pending` and never converges it. Open-position lookup classifies it as
unresolved (safe `500`), exactly like `pending_create`, and never reports a position or a
scope binding.

### D5. Failure cause in logs

`operation_failed` for `entry_package` gains `failure_stage` (one of
`admission_write`, `instrument_resolution`, `quantity_calculation`, `binding_mode`,
`scope_admission`, `provisional_write`, `exchange_create`, `confirmation`, `unexpected`)
and `error_cause` (exception class + message, truncated to 300 chars, with no request or
response bodies and no secrets). The stage is carried in the typed internal result, not
parsed from text. ABI emits `entry_admission_rejected` (`level: warn`, pair ids,
`failure_stage`) exactly once when D2 or D3 persists `absent`.

## Risks / Trade-offs

- One extra fsync per new pair. Acceptable at 5m bar cadence.
- A replay of an older store never contains `admission_pending`; a rollback to an older ABI
  version would reject a store that does. Mitigation: D3 leaves none after a clean start;
  the rollback note goes into the deploy step.
- `500` stays the HTTP answer for pre-exchange rejection, so Runtime still spends one
  recovery tick (30 s) before clearing. Accepted to keep Runtime unchanged.

## Remaining gap (decided 2026-10-21: separate change, not part of this one)

A PUT that never reaches the application service (Runtime timeout before ABI read it, ABI
down, decode rejection after Runtime committed the marker) or whose intent write fails
still leaves nothing, so `422` remains possible. BTC `1e6fb986` may be such a case: no ABI
logs survive for 2026-10-19 08:55Z. ABI already offers a positive way to close it:
a `desired_entry: null` PUT for an unknown pair durably writes `absent` and returns
`entry_package_absent` (`persistAbsentNoHistory`), serialized by the pair lock against any
in-flight PUT. A Runtime-side change could send that CANCEL on `unknown_trade_cycle_binding`
and clear only on exact `entry_package_absent`. That is a separate Runtime change and needs
one more ABI guard: a later non-null PUT arriving after such a tombstone must not create
an order for the same pair. Owner chose this protocol on 2026-10-21 as a separate
change: a recovery tombstone for an unknown pair permanently forbids non-null mutation
of that pair, repeated CANCEL is idempotent, and a delayed non-null PUT arriving after the
CANCEL is a mandatory acceptance test.
