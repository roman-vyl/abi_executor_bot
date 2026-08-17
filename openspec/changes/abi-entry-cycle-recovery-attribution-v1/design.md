## Context

See `proposal.md` for Why/What. This design implements master-plan Change 4 as corrected by revision v10
(after Change 3's actual implementation, not the original v3-era Change 4 text). It applies the pattern
Change 2 (close) and Change 3 (open-position) already proved — own-cycle evidence primary, aggregate weak
sanity — to the one place in recovery where that pattern was not yet followed: how `position_open`'s two
fill facts are sourced.

**What this design explicitly does NOT do.** It does not rewrite `resolveRecoveryState`'s state-resolution
grid, does not change the dual-query bounded-retry shape, does not touch the durably-closed-status fast
path, and does not touch the legacy `pending_action` guard. Investigation found the master plan's original
framing of this change ("aggregate side-match no longer proves attribution") was not, on inspection, a real
gap: the order-query signal recovery already uses to decide which of the four states applies is filtered
by this record's own `order_link_id` (`getEntryOrderPayload`/`getEntryOrderHistoryPayload`,
`entryCycleRecoveryResolutionService.ts:126-127`) — it was already own-cycle-scoped before this change, for
the same reason Change 3's order-query classification always was. The actual, narrower bug — confirmed by
direct comparison against Change 3's already-shipped fix for the identical pattern — is that
`resolveRecoveryState`'s `position_open` branch, once both signals agree, extracts its two fill facts from
the aggregate row (`row.openTime`, `row.avgPrice`) instead of this cycle's own evidence. This design fixes
exactly that, and nothing else.

## Goals / Non-Goals

**Goals:**
- Make `position_open`'s `average_entry_price` this cycle's own value, sourced from the same own-order
  query recovery already performs — never the aggregate `avgPrice`, which cannot distinguish owners once a
  scope is shared.
- Make `position_open`'s `first_fill_at_ms` reuse Change 3's exact durable-capture-once value and
  mechanism — never a second implementation, never the aggregate `openTime`.
- Preserve every existing passing/failing combination of `resolveRecoveryState`'s dual-query grid exactly
  as it is today — this design changes only what happens *after* `position_open` is resolved, not whether
  it is resolved.
- Preserve the "never causes an exchange side effect" invariant, with its scope (order-mutating actions
  only) made explicit rather than implicit.

**Non-Goals:**
- Rewriting the dual-query agreement rule, the absence-of-evidence rule, or any of
  `entry_order_live`/`terminal_without_fill`/`terminal_after_fill`'s existing resolution logic.
- Any new adapter primitive, decoder, or Bybit endpoint. `resolveFirstAttributableFillAtMs`
  (`packageConfirmation.ts`) is reused verbatim; this design adds a second call site, not a second
  implementation.
- Any change to the four-state HTTP contract, `entryCycleRecoveryApi.ts`'s validation, or the OpenAPI
  document for recovery (none exists to change — recovery's OpenAPI surface, if any, is unaffected).
- Bybit's own execution-history query/history constraints are not designed around here, for the same
  reason Change 3 already gave and does not repeat: the durable, immutable, capture-once design this
  change reuses means no code path ever needs to reconstruct a fill that was never captured at the time.

## Decision 1 — `average_entry_price` is sourced from the already-fetched own-order response, not a new query

`classifyOrderForRecovery` already queries `getOrderByLinkId` and, when needed, `getOrderHistory` — both
filtered to this record's own `order_link_id` — once per attempt, decoding the response into a
`BybitOrderView` (`orderQueryResponseDecoder.ts:3-11`) that already includes `avgPrice`. Today, after
classifying the response into an `OrderRecoverySignal` `kind`, the rest of the decoded item — including
`avgPrice` — is discarded.

`OrderRecoverySignal`'s two fill-carrying variants are extended:

```ts
type OrderRecoverySignal =
  | { kind: "live_unfilled" }
  | { kind: "live_with_fill"; averageEntryPrice: string }
  | { kind: "terminal_with_fill"; averageEntryPrice: string }
  | { kind: "terminal_without_fill" }
  | { kind: "not_found" }
  | { kind: "inconclusive" };
```

`classifyOrderForRecovery` populates `averageEntryPrice` from whichever query (realtime or history)
positively found the order in a fill-carrying state, using that response's own `avgPrice` field — the
same field `orderQueryResponseDecoder.ts` already validates as a positive-or-empty exact-decimal string
(`invalid_average_price` otherwise). This is zero new exchange calls: the data is already in hand every
attempt this classification already runs.

**Why not reuse `confirmEntryPackage`/`resolveOwnFillFacts`-style refresh, the way Change 3's
`OpenPositionResolutionService` does?** Change 3 needed that refresh path because `determine()` answers
from a stored `early_execution_observation` that may not yet be final, requiring a fresh query only when
it isn't. Recovery has no equivalent stored observation to consult first — it always queries the order
fresh, every attempt, as part of `classifyOrderForRecovery`'s own classification work. Reusing that
already-in-flight response is strictly less code and strictly fewer exchange calls than adding a second,
independent fill-facts query alongside it; it is not a shortcut that trades away correctness, since it is
the exact same response Change 3's equivalent path would have had to fetch anyway.

**Empty `avgPrice` from a fill-carrying result.** `orderQueryResponseDecoder.ts` treats a present-but-empty
`avgPrice` field as valid (`isPositiveOrEmptyExactDecimal` allows `""`), matching how Bybit's API can omit
this field in some transient states. If a `live_with_fill`/`terminal_with_fill` result carries an empty
`avgPrice`, `resolveRecoveryState`'s `position_open` branch cannot construct a valid
`average_entry_price` and fails closed (`internal_error`) — mirroring Change 3's own "a fill with no
usable average price fails closed" requirement exactly, not a new failure philosophy.

## Decision 2 — `first_fill_at_ms` reuses Change 3's exact mechanism, called from a second site under the same mutex

Change 3 already established the complete, tested mechanism for this value: reuse
`record.first_fill_at_ms` if already durable; otherwise call `resolveFirstAttributableFillAtMs` (pages
`/v5/execution/list` to completion, `min(execTime)` across every attributable Trade execution, bounded page
cap, fails closed on any protocol/transport failure or unresolved pagination) and durably save the result
exactly once, under the pair's `KeyedMutex` lock.

This design adds a second call site for that exact mechanism, inside
`EntryCycleRecoveryResolutionService`, structured identically to
`OpenPositionResolutionService.resolveLiveQueryAdmissible`'s existing block:

```ts
// Inside resolveRecoveryState's position_open path, under this pair's mutex lock:
if (record.first_fill_at_ms !== null) {
  firstFillAtMs = record.first_fill_at_ms; // reuse, no exchange call
} else {
  const captured = await resolveFirstAttributableFillAtMs({ bybit, category, symbol, orderLinkId });
  if (captured.kind !== "found") {
    return internalErrorResult(); // no_executions_found or ambiguous — never fabricated
  }
  await correlationRepository.save({ ...record, first_fill_at_ms: captured.firstFillAtMs, updated_at: ... });
  firstFillAtMs = captured.firstFillAtMs;
}
```

**Why under the mutex, and why the same shared instance.** `EntryPackageCorrelationRepository`'s
`fillFactRegression` check (Change 3) already rejects a second write of a *different* non-null
`first_fill_at_ms` for the same pair as corruption — so an un-serialized race between a concurrent
`GET .../open-position` and `GET .../recovery-state` for the same pair, both observing `null` and both
computing (deterministically, from the same executions) the same correct value, could not corrupt the
value itself. What the mutex actually prevents is a narrower but real hazard: `EntryPackageCorrelationRepository.save()`
is a read-modify-write over the whole record (`{...record, first_fill_at_ms: ..., updated_at: ...}`) — two
concurrent, un-serialized callers each holding their own stale in-memory `record` snapshot could race on
*other* fields of the same record (e.g. one capturing `first_fill_at_ms` while the other durably closes the
same pair concurrently), each overwriting the other's otherwise-valid write. This is exactly the hazard the
existing pair-level `KeyedMutex` already exists to prevent for every other durable write in this codebase,
and Change 3 already established it for this exact field. Introducing a second, independent lock scoped
only to recovery would not close this hazard — it would only serialize recovery against itself, leaving
the open-position/recovery race open. The design therefore requires the same shared `KeyedMutex` instance,
keyed the same way (`correlationRecordKey(strategyInstanceId, tradeCycleId)`), as a new
`EntryCycleRecoveryResolutionServiceDeps.mutex` dependency, wired from `server.ts` to the same instance
already passed to `OpenPositionResolutionService`/`ProtectionApplicationService`/`CloseApplicationService`.

**Where the lock is acquired.** `EntryCycleRecoveryResolutionService.process()` already runs its bounded
retry loop unlocked (each attempt performs a fresh order query and a fresh position query with no lock
held in between). Acquiring the mutex for the *entire* bounded-retry loop would hold a pair-level lock
across up to `RECOVERY_ATTEMPTS` (3) sleeps of `RECOVERY_RETRY_DELAY_MS` (300ms) each — up to ~900ms of
held lock time per recovery request, unnecessarily blocking any concurrent `GET .../open-position` or
`PUT .../protection` for the same pair for the entire duration, even on attempts that do not resolve
`position_open` at all. Instead, the lock is acquired narrowly, only around the point where
`position_open` has already been positively resolved by the dual-query grid and a durable capture may be
needed — mirroring `OpenPositionResolutionService.resolve()`'s own narrow locking (it locks only
`resolveLiveQueryAdmissible`, not its own outer unlocked classification). Concretely: `resolveRecoveryState`
itself stays a pure, lock-free function (unchanged signature and behavior for every state except what it
returns for `position_open`'s two fields, which become inputs already carried by the order signal, plus a
placeholder that the caller fills in under the lock). The caller (`process()`), upon receiving a
`position_open`-shaped resolution from `resolveRecoveryState`, acquires the mutex only for the
short capture-or-reuse step before building the final HTTP result.

**Re-reading the record under the lock.** Exactly as `OpenPositionResolutionService.resolveLiveQueryAdmissible`
re-reads the record fresh once the lock is held (rather than trusting the outer, unlocked read), this
design's locked section re-reads `correlationRepository.get(...)` once more before checking
`first_fill_at_ms`/writing it — a concurrent close could have durably closed the pair in the interval
between the unlocked dual-query resolution and acquiring the lock. If the freshly re-read record is now
durably closed, the locked section returns the correct terminal result for that status instead of
proceeding with a stale `position_open` capture — reusing the same `isDurablyClosedEntryPackageStatus`
branch `process()`'s own outer check already uses, not a new code path.

## Decision 3 — the dual-query grid, and every other requirement, is unchanged

`resolveRecoveryState`'s existing state combinations (`entry_order_live`, `terminal_without_fill`,
`terminal_after_fill`, and every fail-closed combination for contradictory or inconclusive evidence) are
untouched. The order-query signal already carries this record's own `order_link_id`-scoped evidence for
every state, not only `position_open`; the aggregate position query's role as existence/side sanity for
`entry_order_live`/`terminal_without_fill`/`terminal_after_fill` is unchanged, and is not further narrowed
or removed. This design's only change to `resolveRecoveryState`'s inputs/outputs is: (a) the
`live_with_fill`/`terminal_with_fill` signal variants now carry `averageEntryPrice`, threaded through to
the `position_open` outcome instead of `row.avgPrice`; (b) the `position_open` outcome's `firstFillAtMs`
becomes a signal to the caller that a durable capture-or-reuse step is needed, resolved by `process()`
under the mutex as described in Decision 2, instead of being computed inline as `row.openTime`.

## Decision 4 — "never causes an exchange side effect" is clarified, not weakened

The existing requirement's own scenario already states its actual scope precisely: "ABI SHALL NOT send any
create, amend, or cancel request to the exchange as part of that resolution." Read-only `GET` queries
(recovery already issues two or three per attempt) and ABI's own local durable write are outside that
scope both by the requirement's literal text and by recovery's own existing behavior, which already relies
on both. This design adds one new explicit scenario stating this in the spec delta, rather than leaving it
an implicit reading a future author could mistake for a broader prohibition — the same kind of
clarification Change 3 added for its own analogous "Bybit's own execution-history constraints" note
(non-normative for behavior, load-bearing for future readers).

## Regression analysis (single-owner, today's only production-reachable state)

For a scope with exactly one owner:
- `average_entry_price`: this cycle's own order and the aggregate position necessarily reflect the same
  single fill, so the value recovery now reports is numerically identical to what it reported before —
  same underlying Bybit fact, different (now correct) extraction path. No observable change.
- `first_fill_at_ms`: recovery's previous value (`row.openTime`, the aggregate's `openTime`) and the new
  value (the durable, own-execution-derived capture) are the same underlying real-world moment for a
  single-owner scope's only fill, but are not guaranteed byte-identical — Bybit's aggregate `openTime` and
  the earliest own-execution `execTime` are not documented as the identical field. This is the one place
  single-owner behavior can observably change. It is a fix, not a regression: `GET .../open-position`
  already reports the own-execution-derived value for the same pair (Change 3), and this change makes
  `GET .../recovery-state` agree with it instead of disagreeing — the previous behavior (two different
  first-fill values for the same trade cycle depending which endpoint answered) was itself already a
  latent inconsistency this change removes.
- Every other recovery_state (`entry_order_live`, `terminal_without_fill`, `terminal_after_fill`) and
  every fail-closed combination: byte-for-byte unchanged, since `resolveRecoveryState`'s grid is untouched.

## Required tests

1. `position_open`'s `average_entry_price` matches the own-order query's `avgPrice`, verified with a test
   fixture where the own-order and aggregate `avgPrice` deliberately differ — the response must reflect
   the own-order value, never the aggregate's.
2. `position_open`'s `first_fill_at_ms`: already-durable `record.first_fill_at_ms` is reused with zero
   calls to `getExecutionList`.
3. `position_open`'s `first_fill_at_ms`: not yet durable — `resolveFirstAttributableFillAtMs` is called
   once, the result is durably saved, and a second `resolve()`/recovery call for the same pair reuses the
   saved value with no further call.
4. Capture failure (`no_executions_found` / `ambiguous`) on the first attempt → `internal_error`,
   `position_open` is never resolved with a fabricated or omitted `first_fill_at_ms`.
5. A fill-carrying order signal with an empty `avgPrice` → `internal_error`, mirroring Change 3's
   equivalent scenario.
6. Concurrency: a `GET .../recovery-state` and a `GET .../open-position` for the same pair, both racing to
   capture `first_fill_at_ms` for the first time, are serialized by the shared mutex; the durable value is
   written exactly once and both responses agree on it.
7. A concurrent close durably closing the pair between recovery's unlocked dual-query resolution and its
   locked capture step is detected by the locked section's fresh re-read, and resolves the correct
   terminal state instead of a stale `position_open`.
8. Full regression of every existing `entryCycleRecoveryResolutionService.test.ts` scenario for
   `entry_order_live`, `terminal_without_fill`, `terminal_after_fill`, every fail-closed combination, the
   durably-closed-status fast path, and the legacy `pending_action` guard — unchanged behavior.
9. Multi-owner synthetic fixtures (same style as Change 1/2/3's tests): recovery for cycle B, sharing a
   scope with cycle A, never reports cycle A's fill facts as its own — B's `position_open` (when it
   resolves) always carries B's own `average_entry_price`/`first_fill_at_ms`, never A's, even though both
   share the same aggregate row.
