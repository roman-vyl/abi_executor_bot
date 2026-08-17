## Context

See `proposal.md` for Why/What. This design implements master-plan Change 3 as corrected by revision v9
(First Fill responsibility boundary) — the earlier v8 framing, which made ABI compute and durably store a
"canonical entry strategy-bar identity," is not implemented here and is explicitly rejected below
(Decision 1). What *is* implemented is the pattern Change 2 already proved for close, applied to the read
side: this cycle's own attributable execution evidence is primary; the shared aggregate position is weak
sanity, never the source of a per-cycle fact.

**Corroborating evidence for the v9 boundary, found during this design's own investigation, not assumed
from the master plan alone**: `openspec/specs/abi-open-position-lookup-api/spec.md`'s "OpenAPI describes
only the external contract" requirement already states, predating this entire program
(`abi-open-position-lookup-v1`, the capability's original change), that the OpenAPI document "SHALL NOT
define ... Runtime lifecycle fields (such as `entry_bar_open_time_ms`)." The capability's very first
version already anticipated that a bar-identity concept belongs to Runtime, not ABI's public contract —
v8's mistake was proposing to compute that value inside ABI even though it was never meant to be named in
ABI's own contract either.

## Goals / Non-Goals

**Goals:**
- Make `position_open` correct while this cycle's own entry order is live and partially filled, sourced
  from this cycle's own evidence rather than an aggregate existence check that can lag or (later,
  multi-owner) belong to a sibling.
- Make `average_entry_price` this cycle's own cumulative average execution price, never the aggregate
  `avgPrice`, which cannot distinguish owners once a scope is shared.
- Give `first_fill_at_ms` a coherent, durable, stable meaning ABI can actually produce correctly: a
  trustworthy raw timestamp of this cycle's own first attributable fill — nothing about strategy
  timeframe, grid, or bar boundaries.
- Preserve `PUT .../protection`'s existing contract and behavior exactly: it reuses `determine()` today
  for its own live-position gate and for the aggregate's confirmed stop/take values, and must continue to
  work unmodified.
- Reuse existing primitives (`confirmEntryPackage`, `isFillFactFinal`, the same bounded-retry query shape)
  rather than inventing new query mechanics — the same discipline Change 1 and Change 2 already
  established.

**Non-Goals:**
- Any strategy timeframe/interval/grid concept inside ABI, or any candle-grid normalization logic inside
  ABI, now or later in this program (v9, explicit and final).
- Computing or storing a canonical entry-bar/strategy-bar identity inside ABI. That is Runtime's
  responsibility, via its own `FrozenExecutedReceipt` lifecycle, which this repository does not implement
  and this change does not model.
- Any wire-contract shape change to `GET .../open-position` — same three fields, same names, same types,
  same nullability rule, no quantity/size field.
- `abi-entry-cycle-recovery-attribution-v1` (Change 4) — `EntryCycleRecoveryResolutionService` has its own
  independent dual-query logic and is not touched here.
- Same-side production activation (Change 5), pair-owned protection redesign (Changes 6-8), close-order
  identity/retry semantics (already delivered by Change 2).
- A generic execution ledger, fill-level dedup subsystem, or WebSocket execution ingestion. This change
  adds one flat nullable field and one decoded response field, reusing existing confirmation primitives.
- Cross-owner aggregate reconciliation as an observability check independent of a single request's own
  gate (same non-goal Change 2 already stated for the equivalent concern on the write side).

## Decisions

### 1. `first_fill_at_ms` is ABI's own raw attributable timestamp — never a canonical bar identity (v9, restated as an implementation decision, not reopened)

Rejected, explicitly, because it was this program's own prior (v8) design and the mistake this proposal
corrects: computing "which strategy bar contains this fill" inside ABI, and durably storing that
normalized value under a name like `entry_bar_open_time_ms`. ABI has no timeframe/interval/grid concept
anywhere in its codebase (confirmed by direct search across `DesiredEntryDto`, `EntryPackageCommand`,
`AbiConfig`, and every exchange adapter — see `proposal.md`'s Why) and this change does not add one. The
value this change captures and returns as `first_fill_at_ms` is exactly what Bybit's own order-query
response says about *this cycle's own entry order* — nothing derived from any strategy configuration.
Runtime, which already owns timeframe/grid, is responsible for any bar normalization and for freezing the
result into its own `FrozenExecutedReceipt` lifecycle — a Runtime-side concept, out of scope for any ABI
OpenSpec change, including this one.

### 2. Own-cycle fill sourcing for `position_open` and `average_entry_price`, reusing `confirmEntryPackage`

`determine()`'s live-query-admissible branch resolves this cycle's own fill facts first, before touching
the aggregate at all:

```
if isFillFactFinal(record.early_execution_observation):
    ownFacts = record.early_execution_observation   # no exchange call
else:
    ownFacts = confirmEntryPackage(bybit, ownEntryOrderIdentity, expected: { qty: record.calculated_quantity })
               -> map to { cumulative_filled_qty, avg_execution_price, order_status } exactly as
                  toObservation() already does inside packageConfirmation.ts
```

This is the same primitive and the same "already final -> reuse stored value; otherwise refresh" shape
Change 2's `resolveOwnExposure` established for close, applied here for a read instead of a write.
`record.calculated_quantity === null` or `record.order_link_id === null` (a structurally-inconsistent
live-query-admissible record) is `internal_error`, the same defensive posture `resolveOwnExposure`
already uses.

`position_open = compareDecimal(ownFacts.cumulative_filled_qty, "0") > 0`. When `ownFacts.cumulative_filled_qty`
is `"0"`: `{ kind: "closed" }` is returned immediately — **no aggregate query is made**, both because
nothing the aggregate could say would change this cycle's own answer, and because skipping it removes a
concrete false-positive risk (a stale or, later, sibling aggregate row happening to side-match while this
cycle's own order has not filled).

`average_entry_price = ownFacts.avg_execution_price`. If `cumulative_filled_qty > 0` but
`avg_execution_price` is absent (Bybit's own `avgPrice` field can be legitimately empty at some
transitional states, per `toObservation()`'s existing `if (item.avgPrice !== "" && ...)` guard) — this is
a structurally-impossible-to-serve state for this capability's wire contract, which requires a non-null
`average_entry_price` whenever `position_open` is `true`. `internal_error`; never fabricated as `"0"` or
omitted.

**Rejected: always refresh, even when the stored observation is already final.** Unlike Close (which
refreshes unconditionally because it runs immediately after forcing the entry order terminal, so a fresh
read is cheap and already-in-flight), `GET` is a passive, potentially frequent poll. Reusing an
already-`isFillFactFinal` stored observation with no exchange call keeps repeated polling free once a
cycle's own entry order has reached a terminal state — a real latency/rate-limit concern this capability
did not have before and should not introduce needlessly.

### 3. The aggregate query becomes conditional: weak sanity plus protection's existing needs, never a source of a per-cycle fact

Retained requirement (unchanged from today, restated): "the symbol+side check is a plausibility check
against this record's own declared intent, not proof of attribution" (`open-position-resolution` spec,
"V1 position attribution" requirement) — this proposal does not weaken or strengthen that documented
precondition; it only stops treating the aggregate as a source of *values*.

When `ownFacts.cumulative_filled_qty > 0`, `determine()` still queries `queryPositionForInstrument`
exactly as today, for two purposes only:

- **Weak sanity**: the returned row must exist and its `side` must match `record.desired_entry.side`
  (unchanged check, same as today). Disagreement — own evidence proves a fill, but the aggregate has no
  row, or has one on the wrong side — is `internal_error`. This is one-directional: the aggregate showing
  a matching-side position while this cycle's own fill is zero is **not** a disagreement (that is exactly
  what a synthetic multi-owner sibling's exposure looks like from this cycle's perspective, and is also
  simply unreachable today since the query is skipped in that branch per Decision 2).
- **`PUT .../protection`'s existing, unchanged needs**: `confirmedStopLoss`/`confirmedTakeProfit`, read
  from the same row, exactly as `PositionDetermination`'s "open" variant already carries them today.
  Protection still operates at the physical-position level (pair-owned protection is Changes 6-8, not
  reached yet) and genuinely needs these aggregate-sourced values; this proposal does not change that.

**No quantity comparison of any kind is introduced** — restated from Change 2's Decision 5 for the same
underlying reason: a shared aggregate size cannot prove which owner's activity produced it, so it is never
compared against this cycle's own resolved quantity, with or without a tolerance.

### 4. `first_fill_at_ms`: durable, captured once, sourced from the order's own `updatedTime` — resolving the master plan's open question

**The open question, answered.** Master-plan v9 left open whether ABI needs to durably store the raw
first-fill timestamp, or can reconstruct it on demand each time. This design answers: **durable storage is
required**, because the only field ABI's existing own-order query primitives can supply —
`updatedTime` on the `order/realtime`/`order/history` response — is *not* a stable historical fact. It is
the order's *current* last-update time. For an order that fills in one execution (this system's normal
case — entry orders are aggressive market/limit orders expected to fill promptly), `updatedTime` at the
moment that fill is first observed genuinely is the first-fill time. But once any further update to the
same order occurs — a second partial fill, a later cancel/terminal transition unrelated to filling further
— `updatedTime` moves, and the original moment is gone from these endpoints. Runtime needs
`first_fill_at_ms` to be **stable across repeated `GET .../open-position` calls** for correct bar-boundary
normalization on its side; a value that could silently shift between polls would be worse than not
providing one.

**Where it is decoded.** `BybitOrderView` (`orderQueryResponseDecoder.ts`) gains `updatedTimeMs: number`,
decoded from the existing `order/realtime`/`order/history` response envelope
`confirmEntryPackage`/`classifyEntryOrderTerminality` already query — no new Bybit endpoint, no new
adapter method. Validated the same way every other field on this decoder is: present, a numeric string,
parses to a non-negative integer; anything else is `protocol_failure` with a new reason,
`invalid_updated_time` — consistent with this decoder's existing "malformed field is a protocol failure,
never silently coerced" discipline.

**Where it is captured.** Exactly once per pair, the first time `determine()`'s own-cycle refresh (Decision
2) observes `cumulative_filled_qty > 0` while `record.first_fill_at_ms` is still `null` — using that same
query response's `updatedTimeMs`. This can happen either because the stored observation was not yet final
(a genuine live-to-filled transition just observed) or because of the backward-compat case below. Once
captured, the value is immutable: a later observation never overwrites it, whether or not it agrees with
the newly observed `updatedTimeMs` (which, per the above, will typically differ once the order has moved
on).

**Rejected: capture it inside `entryPackageApplicationService.ts`'s existing observation-writing points
(create confirmation, repeat-PUT revalidation) instead of here.** Would work for a trade cycle Runtime
keeps re-`PUT`-ing after the fill, but the normal expected usage pattern for a filled cycle is the
opposite — Runtime polls `GET .../open-position`, not repeat `PUT`s, to detect and confirm a fill. Capturing
only in `entryPackageApplicationService.ts` would leave `first_fill_at_ms` chronically uncaptured (falling
back to some other value, or simply absent) for the dominant real-world usage pattern, not a rare edge
case. This capability's own targeted refresh (Decision 2) is already the code path most likely to be the
*first* to observe the fill in practice, and is the natural, sufficient place to also capture the
timestamp. `entryPackageApplicationService.ts` is not touched by this change.

**Rejected: keep it purely transient (never durably written), returning a freshly re-derived value on every
`GET`.** Directly contradicts the stability requirement above — `updatedTime` is not a stable source once
the order state moves past the first fill.

**Backward-compatible backfill.** A durable record from before this change ships can have an
already-`isFillFactFinal` stored observation (`cumulative_filled_qty > 0`) with no `first_fill_at_ms` at
all (replay normalizes the missing key to `null`, exactly mirroring `close_order_link_id`'s existing
precedent — see Decision 5). Decision 2's "skip the exchange call when already final" optimization is
therefore refined: the exchange call is skipped only when the record is already final **and**
`first_fill_at_ms` is already non-null. When the record is already final but `first_fill_at_ms` is still
`null`, one fresh query still runs — not to re-derive `cumulative_filled_qty`/`avg_execution_price` (the
stored values are used as-is, already proven final), but specifically to backfill `first_fill_at_ms` from
that query's `updatedTimeMs`, so the wire invariant (`position_open: true` implies non-null
`first_fill_at_ms`) never breaks for pre-existing data. This is expected to be a one-time cost per
pre-existing record, since capture makes the field permanently non-null afterward.

### 5. Durable write: a new `KeyedMutex` dependency for `resolve()`, `determine()` itself stays lock-free

`determine()` is shared: `ProtectionApplicationService.process()` already calls it directly while already
holding the same pair-level `mutex` for its own entire request (`protectionApplicationService.ts:59-61`
via `mutex.withKeyLock`). If `determine()` itself also tried to acquire that same mutex internally, a
protection request would deadlock against itself (a non-reentrant acquire of the same key from within an
already-held critical section). `determine()` therefore remains exactly as side-effect-free and lock-free
as it is today — Decisions 2-4 above only change what it *computes*, not whether it takes the lock.

The durable write is instead owned by `resolve()` — the `GET .../open-position` HTTP entry point, which
today acquires no lock at all (a pure read). `resolve()` gains a new `mutex: KeyedMutex` dependency (the
same shared instance `EntryPackageApplicationService`/`ProtectionApplicationService`/
`CloseApplicationService` already use, wired in `server.ts`) and performs the capture like this:

```
record = correlationRepository.get(sid, tcid)        # outer, unlocked read — unknown-pair / bucket triage only
...
if bucket === live_query_admissible:
    result = mutex.withKeyLock(key, () => {
        fresh = correlationRepository.get(sid, tcid)  # re-read INSIDE the lock — authoritative
        if fresh.status is now durably_closed:        # can only have changed via a concurrent close
            return closedResult()
        determination = determine(fresh)               # lock-free, reused as-is
        if determination.kind === "open"
           and fresh.first_fill_at_ms === null
           and determination.firstFillAtMs !== null:
            correlationRepository.save({ ...fresh, first_fill_at_ms: determination.firstFillAtMs, updated_at: now })
        return buildHttpResult(determination)
    })
```

The exchange query inside `determine()` (Decisions 2-3) runs *inside* this lock — it is read-only against
the exchange, so this only serializes `GET` against other writers for the same pair for the duration of a
bounded confirmation query, the same cost `PUT .../protection` already accepts today for the identical
reason (it also calls `determine()` from inside its own lock). This is a new cost `GET` did not have
before; accepted as the price of correctness for a durable, first-writer-wins capture — see Risks.

**Rejected: double-checked locking with the exchange query outside the lock.** Would reduce time-under-lock,
but this capability's own query volume and this codebase's existing precedent (protection already pays
the full in-lock exchange-query cost) do not justify the added complexity of a second, narrower lock scope
and a second staleness re-check.

**Rejected: skip the mutex and accept a benign race on the write.** `EntryPackageCorrelationRepository.save()`
takes a full record and replaces the previous one; an unserialized `GET` write racing a concurrent `PUT`
revalidation write (which updates `early_execution_observation`) could silently revert that write's result
using a stale copy read before the race. This is exactly the class of bug the existing pair-level mutex
exists to prevent everywhere else in this codebase.

**Failure mode of the write itself.** If the durable `save()` fails (a disk error, not a logic error), this
request still returns the freshly-observed, truthful `determination` to the caller (an already-successful
HTTP response is not converted into an error because of a failed *cache-in*, since the returned value is
still correct in the moment) — the next `GET` for the same pair will retry the same capture from a fresh
query, since `first_fill_at_ms` was never durably set. This narrow window of instability (bounded to
"until the next successful write") is accepted; it does not affect `position_open` or
`average_entry_price` correctness in that window.

### 6. `first_fill_at_ms` immutability is enforced the same way `cumulative_filled_qty`'s monotonicity already is

`fillFactRegression` (`entryPackageCorrelationRepository.ts`) — already checked on both live `save()` and
`replay()` — gains a sibling check: if the previous record for a pair has a non-null `first_fill_at_ms`
and the incoming record's `first_fill_at_ms` differs (including differing to `null`), this is corruption,
rejected the same way a `cumulative_filled_qty` regression already is. This is a strict immutability check
(not a monotonic-non-decrease check like quantity's), matching Decision 4's "captured once, never
overwritten" contract, and catching any future write path that might attempt to touch the field
incorrectly, not only this change's own single writer.

### 7. Replay/validator tolerance for pre-existing durable rows, mirroring `close_order_link_id`'s precedent

`isValidEntryPackageExecutionRecord` accepts `first_fill_at_ms` as `undefined`, `null`, or a non-negative
integer — the same three-way tolerance `close_order_link_id`/`close_order_id` already established for
exactly the same reason (rows written before this change shipped lack the key entirely, and this codebase
has no schema-migration subsystem). `replay()` normalizes a missing key to `null` before validation,
exactly mirroring `normalizeLegacyCloseIdentityFields`'s existing pattern — a new
`normalizeLegacyFirstFillField` (or an extension of the existing normalizer) performs the equivalent
one-key normalization.

## Regression analysis: what changes observably for today's only production-reachable case (single owner)

- **`position_open`**: unchanged in every case except one narrow gap this change fixes — a live
  `PartiallyFilled` entry order whose fill has not yet propagated to (or briefly disagrees with) the
  aggregate position read. Before this change, that race could report `position_open: false` for a cycle
  that has, in fact, already filled; after this change, the answer is correct because it is sourced from
  the same order Change 1's own fill-fact discipline already tracks. Every other case (fully filled,
  fully unfilled, terminally closed) already agreed between the two sources and continues to.
- **`average_entry_price`**: byte-for-byte unchanged once an entry order is final — the same underlying
  fill produces the same cumulative average whether read from the aggregate `avgPrice` or from this
  cycle's own `avg_execution_price`, since for a single owner these describe the same execution. Not
  bitwise-guaranteed identical *during* a still-live partial fill window (own-cycle evidence can be
  fresher than a since-superseded aggregate snapshot) — this is the same class of correctness improvement
  as `position_open`'s fix, not a regression.
- **`first_fill_at_ms`**: previously the aggregate row's `openTime` (Bybit's own position-open timestamp);
  now this cycle's own order's `updatedTimeMs` at first-fill observation. For a single owner these are
  expected to closely coincide in the common single-execution-fill case, but are not defined to be
  bit-identical — this is a genuine, intentional semantic change (this field now means "this cycle's own
  order's fill time," not "this physical position's open time"), consistent with the v9-corrected contract
  and with `proposal.md`'s Why.
- **Latency/call volume**: one additional Bybit query (`confirmEntryPackage`'s bounded window) is added to
  `GET .../open-position` exactly when the stored observation is not yet final, or when a pre-existing
  record needs its one-time `first_fill_at_ms` backfill (Decision 4) — zero added calls once a cycle's
  entry order is final and its `first_fill_at_ms` has been captured. The aggregate query, previously
  unconditional, is now skipped entirely when this cycle's own evidence already shows zero fill. `GET`
  additionally now serializes against the pair's mutex for live-query-admissible records, which it did not
  before (Decision 5) — accepted per that decision's reasoning.

## Risks / Trade-offs

- [`GET .../open-position` now performs a durable write in some cases, and now serializes against
  `PUT .../entry-package`/`PUT .../protection`/`POST .../close` for the same pair, neither of which was
  true before] → Accepted: this is the direct, minimum cost of making `first_fill_at_ms` durable and
  stable (Decision 4's requirement), and the serialization cost is bounded to a single bounded-retry
  exchange query, the same cost `PUT .../protection` already accepts calling the same shared method.
- [`updatedTimeMs`, sourced from the order's own `updatedTime`, is not guaranteed to be the exact
  first-execution timestamp for an order that fills across more than one separate execution before ABI's
  own confirmation pipeline first observes it] → Accepted as a documented V1 approximation: this system's
  entry orders are aggressive market/limit orders expected to fill in a single execution in the normal
  case; an exact per-execution timestamp would require integrating Bybit's execution-list endpoint
  (`/v5/execution/list`), which this change deliberately does not add (see Non-Goals) absent evidence the
  approximation is operationally insufficient.
- [A pre-existing durable record with an already-final observation still costs one exchange query the
  first time this change's code runs against it, purely to backfill `first_fill_at_ms`] → Accepted,
  one-time per pre-existing record, in exchange for never breaking the wire invariant that `position_open:
  true` implies non-null `first_fill_at_ms`.
- [One new field added directly to `EntryPackageExecutionRecord`, plus one new decoded field on
  `BybitOrderView`, plus one new repository dependency for `OpenPositionResolutionService`] → Accepted:
  each is additive, mirrors an existing precedent (`close_order_link_id`'s field-tolerance pattern,
  `resolveOwnExposure`'s query pattern, `PUT .../protection`'s mutex-wrapped call to `determine()`), and
  none touches `EntryPackageCorrelationRepository`'s indexing, `byScope`, or any other consumer's code path.

## Migration Plan

Additive to `EntryPackageExecutionRecord` (one nullable field, validator updated to tolerate its absence
on old rows, replay normalizes a missing key to `null`) and to `BybitOrderView` (one new decoded field,
sourced from a response shape already being fetched). No change to
`EntryPackageCorrelationRepository`'s indexing, `byScope`, `findOwnerByScope`, or
`findActiveRecordsForScope`. `ProtectionApplicationService` and `CloseApplicationService` are not modified
and are covered only by regression tests. The public HTTP contract (`GET .../open-position`'s shape) does
not change. Rollback is a plain revert; old durable rows (lacking `first_fill_at_ms`) replay correctly
against the corrected validator either way, and a rolled-back `OpenPositionResolutionService` simply stops
reading/writing the field it no longer knows about (the field itself, once present in the store, is
harmless dead data to a reverted binary, since nothing else reads it).
