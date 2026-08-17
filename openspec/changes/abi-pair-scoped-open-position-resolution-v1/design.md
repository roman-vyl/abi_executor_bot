## Context

See `proposal.md` for Why/What. This design implements master-plan Change 3 as corrected by revision v9
(First Fill responsibility boundary) — the earlier v8 framing, which made ABI compute and durably store a
"canonical entry strategy-bar identity," is not implemented here and is explicitly rejected below
(Decision 1). What *is* implemented is the pattern Change 2 already proved for close, applied to the read
side: this cycle's own attributable execution evidence is primary; the shared aggregate position is weak
sanity, never the source of a per-cycle fact.

**Revision note (this document, before any implementation was written).** An earlier draft of this
document sourced `first_fill_at_ms` from the entry order's own `updatedTime` field (via
`order/realtime`/`order/history`, the same endpoints `confirmEntryPackage` already queries). Review found
this insufficient, not merely approximate: `updatedTime` reflects whichever fill ABI's own confirmation
pipeline happened to observe *most recently* as of the query, not necessarily the *first* one. Concretely
— an entry order fills at 12:01, fills again at 12:03, and ABI's own confirmation pipeline first observes
the order at 12:03: `updatedTime` at that observation is 12:03, not the true first-fill time of 12:01.
Durable capture would then make this wrong value permanently, stably wrong — worse than the transient
inaccuracy it replaced, and specifically dangerous for Runtime's downstream strategy-bar normalization if
12:01 and 12:03 straddle a bar boundary. This revision replaces `updatedTime`-based sourcing with
`/v5/execution/list`-based sourcing — the earliest of this order's own individually-timestamped executions
— which answers "when did this order's first fill actually happen" directly, correctly, regardless of how
many fills occurred before ABI's own confirmation pipeline first looked. See Decision 4 below for the full
design; Decisions 1-3 and 5-7 are unaffected by this revision.

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
- Reuse existing primitives (`confirmEntryPackage`, `isFillFactFinal`, the same bounded-retry/signed-request
  shape) wherever they already answer the question at hand; add the minimum new primitive — one adapter
  method and one decoder for `/v5/execution/list` — only where no existing primitive can (Decision 4),
  never a new subsystem.
- Make `first_fill_at_ms` provably the *earliest* attributable fill, not merely *a* fill this observation
  happened to see — correct even when more than one execution occurred before ABI's own confirmation
  pipeline first looks.

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
  adds one flat nullable field, one narrow adapter method, and one decoder — no persistent execution
  history, no background polling, no event sourcing.
- Any change to `execType` handling beyond distinguishing genuine trade fills from non-fill execution
  types Bybit's execution feed can carry (funding settlements, ADL, delivery, block trades) — this change
  reads `execTime` from trade-fill executions attributable to one order and nothing else.
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

### 4. `first_fill_at_ms` is sourced from this order's own executions via `/v5/execution/list`, as `min(execTime)` — not from any order-level "current state" field

**The open question, answered — and answered differently than this document's first draft.** Master-plan
v9 left open whether ABI needs to durably store the raw first-fill timestamp, or can reconstruct it on
demand each time. Durable storage is still required (the reasoning below is unchanged from the first
draft: Runtime needs a value that is **stable across repeated `GET .../open-position` calls**, and nothing
about "current order state" is stable once an order moves past its first fill). What changed is the
*source*: no field on the order-level `order/realtime`/`order/history` response describes "when did this
order's first fill happen" as a standing historical fact — those endpoints describe the order's *current*
state, including a last-update timestamp that moves every time anything about the order changes. The only
Bybit primitive that records each individual fill with its own timestamp is `/v5/execution/list` ("Get
Trade History"), which ABI does not currently query anywhere. This change adds the minimum adapter
primitive and decoder needed to query it, scoped to exactly one order's own executions.

**Why this, and not `order/history`'s `updatedTime`.** The order-level field's fundamental problem: for an
order that has already accumulated more than one fill by the time ABI's own confirmation pipeline first
observes it (own-order re-query only happens on `GET`/repeat-`PUT`, not on every individual fill event),
`updatedTime` reflects the *most recent* observed state, not the *first* fill. `/v5/execution/list`
sidesteps this entirely: it does not describe "current state as of when I asked" at all — it enumerates
every individual execution that has occurred against a given order, each carrying its own `execTime`, so
`min(execTime)` across this order's own executions is the first-fill time regardless of how many fills
happened, in what order ABI later observes them, or how long ABI waited before looking (subject to
Decision 4c's retention window).

**Filtering by this cycle's own order — an existing identity, no new one.** ABI already knows this cycle's
own entry order's deterministic `orderLinkId` (`record.order_link_id`, unchanged from every existing
own-order query in this codebase) and passes it as the query's `orderLinkId` filter — never `orderId`,
deliberately: Bybit's own documented parameter-priority rule for this endpoint is `orderId > orderLinkId >
symbol > baseCoin`, meaning passing both would let `orderId` silently override the intended filter, and
`order_id` is this codebase's established "audit only, never used for lookup" field everywhere else
(`order_id`, `close_order_id`) — this endpoint gets the same treatment, for the same reason.

**A documented Bybit-side quirk this decoder must not fight.** Bybit's own API reference for this endpoint
states that the response's own `orderLinkId` field is reported as an empty string for a maker-side trade,
regardless of the order's real `orderLinkId` — i.e., the response does not reliably echo the identity ABI
filtered by, unlike `order/realtime`/`order/history`'s `orderLinkId`, which `decodeOrderQueryResponse`
already strictly re-checks per item. This decoder therefore does **not** apply that same per-item identity
re-check; it trusts the server-side `orderLinkId` query filter as the attribution mechanism (the same
trust level this codebase's `symbol`/`category` envelope checks already extend to the rest of the
response), and instead validates only structural correctness per item (`symbol`/`category` match the
query, `execTime` is a valid non-negative integer, `execType` is a recognized fill-producing type — see
below). This is a narrower attribution guarantee than `order/history`'s, and is called out explicitly here
rather than silently assumed to be as strong.

**`execType` filtering.** ABI's entry orders are plain triggered market orders — no ADL, delivery, or
block-trade mechanism ever legitimately produces an execution against one. Each decoded item's `execType`
is checked against `"Trade"`; a value other than `"Trade"` is treated as `protocol_failure` (fail closed,
not silently skipped), since an unexpected execution type on an order this pipeline created is a signal
worth surfacing, not filtering past quietly.

**Ties in `execTime` do not matter here.** Bybit's own documentation notes `execTime` alone can be
ambiguous for *sorting* two executions with identical timestamps (recommending a compound sort key). This
proposal never sorts or orders executions — it only computes `min(execTime)` across the full set (Decision
4b), for which an exact tie is simply two candidates for the minimum, both correct; no ordering decision is
made or needed.

#### 4a. New primitive: one adapter method, one decoder — no ledger

- `BybitAdapter` gains `getExecutionList(payload: BybitGetExecutionListPayload): Promise<unknown>`,
  implemented in `RestBybitAdapter` as a `signedGet("/v5/execution/list", ...)` call — the same pattern
  every other read on this adapter already uses — and in `StubBybitAdapter` as the existing `stub(...)`
  placeholder. `BybitGetExecutionListPayload` is `{ category, symbol, orderLinkId, startTime, endTime,
  limit, cursor? }` (`startTime`/`endTime` as millisecond-epoch numeric strings, `limit` as a numeric
  string, mirroring this codebase's existing `URLSearchParams`-based convention).
- A new decoder, `decodeExecutionListResponsePage` (new file, `src/services/entryPackage/executionListResponseDecoder.ts`,
  mirroring `orderQueryResponseDecoder.ts`'s style and per-field validation discipline), validates one
  page's envelope (`result.list` as an array, `result.category` matches, each item's `symbol`/`execType`/
  `execTime` as described above) and returns the page's decoded executions plus `result.nextPageCursor`
  (an empty string on the last page, per Bybit's documented cursor convention).
- A new orchestration function, `resolveFirstAttributableFillAtMs` (`packageConfirmation.ts`, alongside
  the other own-order primitives), pages through `getExecutionList` (Decision 4b), decodes each page, and
  returns the minimum `execTime` across every valid execution found, or a typed failure. This is the one
  function `OpenPositionResolutionService`'s capture path (Decision 5) calls — `determine()` itself never
  queries `/v5/execution/list` at all (see Decision 5's revised split of responsibility).

#### 4b. Pagination: every page is fetched, order is never assumed, a bound protects against runaway paging

Per this change's own requirement (never rely on record order) and Bybit's cursor-pagination convention:
`resolveFirstAttributableFillAtMs` fetches pages in a loop, passing each response's `nextPageCursor` as the
next request's `cursor`, accumulating every decoded execution from every page into one set, and only
computes `min(execTime)` after the loop ends (`nextPageCursor === ""`). It never inspects only the first
page, never assumes ascending or descending time order, and never returns a candidate minimum from a
partial page set. A hard bound (a small constant, e.g. 10 pages at the existing `limit` this codebase
already uses elsewhere) caps the loop; a genuine entry order in this system is expected to produce a
handful of executions at most, so this bound is headroom, not a realistic ceiling — if it is ever reached
without the cursor going empty, the result is `ambiguous` (fail closed), never a `min()` computed over a
known-incomplete set.

#### 4c. Retention/recovery: the endpoint's own 7-day query window is a real, accepted operational limit

Bybit's own documentation for this endpoint states that omitting `startTime`/`endTime` defaults the query
to the most recent 7 days, and that when both are supplied, `endTime - startTime` must not exceed 7 days.
This is a genuine constraint this design must respect, not an implementation detail to abstract away:

- `resolveFirstAttributableFillAtMs` always passes explicit `startTime`/`endTime`: `endTime = now`,
  `startTime = max(record.current_binding_started_at, now - 7 days + a small safety margin)` — the
  binding's own known dispatch time, clamped to the endpoint's own maximum window.
- This function is only ever called once this cycle's own order/history evidence already proves
  `cumulative_filled_qty > 0` (Decision 2/5) — so an empty execution result is never legitimately "no fill
  happened." It can only mean the fill genuinely occurred, but outside the queryable window this request's
  clamped `startTime` could reach. ABI SHALL treat this as a distinct, fail-closed outcome
  (`no_executions_found`, mapped to `internal_error`) — never fabricated as `"0"`, never silently retried
  with a wider window this endpoint does not support, and never treated as though it disproves the fill
  order/history already confirmed.
- **Accepted operational risk, stated plainly**: a trade cycle whose own first-fill capture is attempted
  more than ~7 days after the fill actually happened — realistically, only a pre-existing record from
  before this change ships (Decision 4d's backfill case) that has gone more than a week without any `GET`
  — will permanently fail to produce `first_fill_at_ms` through this pipeline once that window has passed,
  and `GET .../open-position` will return `internal_error` for that pair for as long as it remains open.
  This is a real availability regression for that narrow case, not a false alarm; it is accepted here
  because (a) the realistic exposure window is the interval between this change shipping and a Runtime
  poll for each already-open pair, expected to be far shorter than 7 days in normal operation, and (b) no
  primitive this codebase has, or this change adds, can recover an execution Bybit itself no longer returns
  for the queried window. A future change may widen this (e.g., attempting the query promptly at entry
  confirmation time as a second, earlier capture point, rather than relying solely on `GET`) if operational
  evidence shows the risk is not narrow enough in practice — not built speculatively here.

#### 4d. Where the capture is attempted, and why execution-list sourcing makes timing far less critical than `updatedTime` sourcing would have

Exactly once per pair, from `OpenPositionResolutionService.resolve()` (not `determine()` — see Decision 5),
the first time this cycle's own fill facts show `cumulative_filled_qty > 0` while `record.first_fill_at_ms`
is still `null`. Unlike the rejected `updatedTime`-based design, **when** this first capture attempt
happens no longer determines correctness, only availability: because `/v5/execution/list` enumerates the
order's *entire* execution history up to the moment it is queried (not a snapshot of "current state"), a
capture attempted late (say, `GET` first called two minutes after two fills that happened a minute apart)
still correctly computes `min(execTime)` across both fills — the 12:01-then-12:03 example from this
revision's opening note resolves correctly no matter which of the two fills ABI's confirmation pipeline
happened to see first. The only way lateness matters is Decision 4c's 7-day retention boundary, not
first-fill accuracy. This removes the need this document's first draft had to argue capture should happen
inside `entryPackageApplicationService.ts`'s own confirmation flow for correctness; that remains
unnecessary and out of scope here (this change still does not touch
`entryPackageApplicationService.ts`) — only Decision 4c's retention window is a reason a future change
might reconsider adding an earlier capture point, and it is not reconsidered here.

**Backward-compatible backfill.** A durable record from before this change ships can have an
already-`isFillFactFinal` stored observation (`cumulative_filled_qty > 0`) with no `first_fill_at_ms` at
all (replay normalizes the missing key to `null`, exactly mirroring `close_order_link_id`'s existing
precedent — see Decision 7). Decision 2's "skip the exchange call when already final" optimization is
therefore refined: the entry-order refresh is skipped when the record is already final, exactly as before
(Decision 2 is unchanged); but `resolve()` still separately checks `first_fill_at_ms` and, if it is still
`null`, calls `resolveFirstAttributableFillAtMs` regardless of whether the entry-order observation itself
needed refreshing, so the wire invariant (`position_open: true` implies non-null `first_fill_at_ms`) never
breaks for pre-existing data. Decision 4c's retention window applies to this case with the least slack —
see its accepted-risk note.

**Rejected: keep it purely transient (never durably written), returning a freshly re-derived value on every
`GET`.** Even with execution-list sourcing (which, unlike `updatedTime`, *would* actually return the same
correct value on every call, within the retention window), this still costs one exchange query per `GET`
forever, for a value that — once genuinely first observed — never changes. Durable, one-time capture is
strictly better: same correctness, and it eliminates that recurring cost and the retention-window
dependency for every `GET` after the first successful capture.

### 5. Durable write: a new `KeyedMutex` dependency for `resolve()`; `determine()` itself stays lock-free and never touches `/v5/execution/list`

`determine()` is shared: `ProtectionApplicationService.process()` already calls it directly while already
holding the same pair-level `mutex` for its own entire request (`protectionApplicationService.ts:59-61`
via `mutex.withKeyLock`). If `determine()` itself also tried to acquire that same mutex internally, a
protection request would deadlock against itself (a non-reentrant acquire of the same key from within an
already-held critical section). `determine()` therefore remains exactly as side-effect-free and lock-free
as it is today — Decisions 2-4 above only change what it *computes*, not whether it takes the lock.

This split also settles where the new `/v5/execution/list` query (Decision 4) belongs: `determine()`'s
"open" variant carries `firstFillAtMs: record.first_fill_at_ms` **verbatim** — a pure pass-through of
whatever is already durable on the record passed in, `null` if nothing has been captured yet — and
`determine()` never calls `resolveFirstAttributableFillAtMs` itself. `ProtectionApplicationService` never
reads `firstFillAtMs` from a determination at all (confirmed by inspection — it only destructures
`confirmedStopLoss`/`confirmedTakeProfit`), so this costs protection nothing, and keeps `determine()` fully
unaware of the new adapter primitive.

The durable write — and the one and only call site for `resolveFirstAttributableFillAtMs` in this entire
change — is owned by `resolve()`, the `GET .../open-position` HTTP entry point, which today acquires no
lock at all (a pure read). `resolve()` gains a new `mutex: KeyedMutex` dependency (the same shared instance
`EntryPackageApplicationService`/`ProtectionApplicationService`/`CloseApplicationService` already use,
wired in `server.ts`) and performs the capture like this:

```
record = correlationRepository.get(sid, tcid)        # outer, unlocked read — unknown-pair / bucket triage only
...
if bucket === live_query_admissible:
    result = mutex.withKeyLock(key, () => {
        fresh = correlationRepository.get(sid, tcid)  # re-read INSIDE the lock — authoritative
        if fresh.status is now durably_closed:        # can only have changed via a concurrent close
            return closedResult()
        determination = determine(fresh)              # lock-free; firstFillAtMs is fresh.first_fill_at_ms, verbatim
        if determination.kind !== "open":
            return buildHttpResult(determination)
        if fresh.first_fill_at_ms === null:
            captured = resolveFirstAttributableFillAtMs(bybit, fresh)   # Decision 4 — the only call site
            if captured.kind !== "found":
                return internalErrorResult()
            correlationRepository.save({ ...fresh, first_fill_at_ms: captured.firstFillAtMs, updated_at: now })
            return buildOpenResult(determination.averageEntryPrice, captured.firstFillAtMs)
        return buildOpenResult(determination.averageEntryPrice, fresh.first_fill_at_ms)
    })
```

Both the entry-order refresh inside `determine()` (Decisions 2-3) and, when needed, the
`/v5/execution/list` pagination (Decision 4b) run *inside* this lock — both are read-only against the
exchange, so this only serializes `GET` against other writers for the same pair for the duration of these
bounded queries, the same class of cost `PUT .../protection` already accepts today for its own call to
`determine()`. This is a new cost `GET` did not have before; accepted as the price of correctness for a
durable, first-writer-wins capture — see Risks.

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
(not a monotonic-non-decrease check like quantity's), matching Decision 4d's "captured once, never
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
  now the earliest `execTime` among this cycle's own entry order's own executions, per
  `/v5/execution/list`. For a single owner these are expected to closely coincide (the same underlying fill
  producing the aggregate's own open time), but are not defined to be bit-identical, and the new value is
  strictly more correct — it is this order's own genuine first-execution timestamp, not an aggregate
  snapshot's open time, and is immune to the multi-fill-before-first-observation gap the rejected
  `updatedTime`-based design (this document's first draft) would have had even in the single-owner case.
  This is a genuine, intentional semantic change consistent with the v9-corrected contract and with
  `proposal.md`'s Why.
- **Latency/call volume**: one additional Bybit query (`confirmEntryPackage`'s bounded window) is added to
  `GET .../open-position` exactly when the stored observation is not yet final; a separate, additional
  bounded-pagination query (`resolveFirstAttributableFillAtMs`, Decision 4) is added exactly once per pair,
  the first time `first_fill_at_ms` is captured (including a pre-existing record's one-time backfill,
  Decision 4d) — zero added calls of either kind once a cycle's entry order is final and its
  `first_fill_at_ms` is already captured. The aggregate query, previously unconditional, is now skipped
  entirely when this cycle's own evidence already shows zero fill. `GET` additionally now serializes
  against the pair's mutex for live-query-admissible records, which it did not before (Decision 5) —
  accepted per that decision's reasoning.

## Risks / Trade-offs

- [`GET .../open-position` now performs a durable write in some cases, and now serializes against
  `PUT .../entry-package`/`PUT .../protection`/`POST .../close` for the same pair, neither of which was
  true before] → Accepted: this is the direct, minimum cost of making `first_fill_at_ms` durable and
  stable (Decision 4's requirement), and the serialization cost is bounded to a small, fixed number of
  bounded-retry/bounded-pagination exchange queries, the same class of cost `PUT .../protection` already
  accepts calling the same shared `determine()` method.
- [`/v5/execution/list`'s response does not reliably echo `orderLinkId` per item for a maker-side trade
  (a documented Bybit behavior, not an ABI bug), so this decoder cannot apply the same per-item identity
  re-check `decodeOrderQueryResponse` applies to `order/realtime`/`order/history`] → Accepted, explicitly:
  attribution rests on the server-side `orderLinkId` query filter alone for this one endpoint, a narrower
  guarantee than this codebase's other own-order queries, documented in Decision 4 rather than silently
  assumed equivalent.
- [The endpoint's own 7-day default/maximum query window means a first-fill capture attempted more than a
  week after the actual fill can permanently fail to recover it, leaving `GET .../open-position`
  returning `internal_error` for that pair] → Accepted as a narrow, explicitly-scoped operational risk
  (Decision 4c) — realistic exposure is bounded to pre-existing records that go unpolled for over a week
  after this change ships, not normal ongoing operation; no primitive can recover data Bybit itself no
  longer serves for the requested window.
- [Pagination must accumulate every page before computing a minimum, rather than short-circuiting on the
  first page, and is bounded by a fixed page cap that fails closed rather than silently using a partial
  result] → Accepted: the added latency is bounded and, for this system's realistic per-order execution
  counts, expected to be a single page in the overwhelming majority of cases; failing closed on the (very
  unlikely) bound-exceeded case is strictly safer than guessing from an incomplete set.
- [One new field added directly to `EntryPackageExecutionRecord`, one new adapter method plus one new
  decoder for `/v5/execution/list`, plus one new repository dependency for `OpenPositionResolutionService`]
  → Accepted: each is additive, mirrors an existing precedent (`close_order_link_id`'s field-tolerance
  pattern, `resolveOwnExposure`'s query pattern, `PUT .../protection`'s mutex-wrapped call to
  `determine()`, `orderQueryResponseDecoder.ts`'s per-field validation style), and none touches
  `EntryPackageCorrelationRepository`'s indexing, `byScope`, or any other consumer's code path.

## Migration Plan

Additive to `EntryPackageExecutionRecord` (one nullable field, validator updated to tolerate its absence
on old rows, replay normalizes a missing key to `null`), to `BybitAdapter` (one new method,
`getExecutionList`, implemented identically to every other existing signed-GET method), and one new
decoder file (`executionListResponseDecoder.ts`, alongside the existing `orderQueryResponseDecoder.ts`). No
change to `EntryPackageCorrelationRepository`'s indexing, `byScope`, `findOwnerByScope`, or
`findActiveRecordsForScope`. `ProtectionApplicationService` and `CloseApplicationService` are not modified
and are covered only by regression tests. The public HTTP contract (`GET .../open-position`'s shape) does
not change. Rollback is a plain revert; old durable rows (lacking `first_fill_at_ms`) replay correctly
against the corrected validator either way, and a rolled-back `OpenPositionResolutionService` simply stops
reading/writing the field it no longer knows about (the field itself, once present in the store, is
harmless dead data to a reverted binary, since nothing else reads it). Bybit's own execution-list retention
window (Decision 4c) is an external constraint, not something rollback needs to account for.
