# Explore report — `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`

> Status: exploration only. No code, tests, OpenSpec proposal, or route was created as part of
> this report. This documents current-state findings intended to seed a future OpenSpec change.
>
> **Revision note (v4):** the target architecture changed. Runtime will pass the full ownership
> pair `(strategy_instance_id, trade_cycle_id)`, not `strategy_instance_id` alone. That pair is
> already `EntryPackageExecutionRecord`'s composite key
> (`correlationRecordKey`, `src/correlation/entryPackageExecutionRecord.ts:74`), so ABI performs a
> **direct composite lookup** — `correlationRepository.get(strategy_instance_id, trade_cycle_id)`
> — and never has to determine "which cycle is current" on its own. This removes, entirely, from
> the target model, gap analysis, lookup flow, implementation surface, decisions, and OpenSpec
> boundary: lookup by `strategy_instance_id` alone, any secondary index on
> `strategy_instance_id`, zero/one/multiple-record cardinality handling, any record-selection
> logic (by status, timestamp, or otherwise), any notion of a "current trade cycle" pointer, and
> any change to the entry-package PUT flow. Where those topics were previously discussed, they do
> not appear below except where explicitly noted as removed.

Read-only investigation of `abi_executor_bot` plus the Runtime-side consumer at
`../strategy_runtime` (present on disk at exploration time, so the contract below was read
directly rather than assumed).

---

## 1. Identity model

```
strategy_instance_id
  = a long-lived strategy instance (Runtime-owned, spans many trade cycles over time)

trade_cycle_id
  = one specific Runtime trade lifecycle (Runtime-owned, opaque to ABI)

(strategy_instance_id, trade_cycle_id)
  = the complete ownership key of one specific ABI EntryPackageExecutionRecord
```

ABI accepts both values as opaque foreign keys, exactly as it already does for the entry-package
PUT route (`openspec/specs/abi-entry-package-api/spec.md:49-55`, "Runtime ownership and market
values remain opaque"). ABI does not create, interpret, or reconstruct Runtime's trade-cycle
lifecycle — it only stores and looks up records keyed by this pair. Nothing in this report asks
ABI to determine which `trade_cycle_id` is "current" for a `strategy_instance_id`; Runtime already
knows that and supplies it directly.

---

## 2. Current state

**`EntryPackageCorrelationRepository` already supports the exact lookup this route needs — no
repository or index change required.**
`get(strategyInstanceId, tradeCycleId)` (`src/correlation/entryPackageCorrelationRepository.ts:83-85`)
is a direct `Map` lookup keyed by `correlationRecordKey(strategyInstanceId, tradeCycleId)`
(`src/correlation/entryPackageExecutionRecord.ts:74-76`) — the same composite key the
entry-package PUT route already writes under
(`src/services/entryPackage/entryPackageApplicationService.ts:51-52,64`). This route reuses that
existing method as-is. No secondary index, no `strategy_instance_id`-only lookup, and no
cardinality handling (zero/one/many records) is needed or relevant, because the pair is always a
single-record key by construction.

**`status` is an ABI-workflow state, not a position-truth state.**
The eight `EntryPackageExecutionStatus` values (`src/correlation/entryPackageExecutionRecord.ts:4-12`:
`pending_create`, `applied`, `pending_replace`, `pending_cancel`, `absent`, `create_failed`,
`unknown`, `terminal_unfilled`) describe *ABI's command lifecycle*. `"applied"` covers three very
different exchange realities: pending-unfilled, partially filled, fully filled — see
`persistConfirmationOutcome` in `src/services/entryPackage/entryPackageApplicationService.ts:616-668`,
which writes `status: "applied"` for `pending_confirmed`, `full_fill`, *and* `partial_fill` alike.
The record can only be used to identify *which binding to ask the exchange about* — never as
direct evidence of a currently open position.

**`early_execution_observation` is a historical snapshot and must not be used as current position
truth.**
`EarlyExecutionObservation` (`src/correlation/entryPackageExecutionRecord.ts:21-27`) is written
once, during PUT confirmation (`src/services/entryPackage/packageConfirmation.ts:259-278`), and
never refreshed afterward. A position could close (stop/take hit) minutes later and this field
would still show it open. This route must always re-check Bybit live rather than trust this
field.

**Current position truth must always be read live from Bybit — nothing durable is authoritative
for "is it open right now."**
This follows directly from the previous two points: neither `status` nor
`early_execution_observation` can answer the route's core question, so the route's only source of
truth for `position_open`/`avgPrice`/`openTime` is a live Bybit query at request time.

**Current Bybit adapter: global category, and discarded fields.**
`getOpenPositions()` (`src/exchange/bybitAdapter.ts:106-114`) builds its request with `category:
this.config.bybitCategory` — the deployment's **global** configured category, never an explicit
one supplied by the caller. This route must instead query using the specific
`record.exchange_category` stored on the looked-up record. Separately, the official
`/v5/position/list` response includes `avgPrice` and `openTime` (confirmed against the official
Bybit v5 API docs) in addition to `size`/`side`/`symbol`/`positionIdx`, but `readOpenPosition()`
(`src/exchange/bybitAdapter.ts:348-377`) extracts only `symbol/side/size/positionIdx`, and the
`BybitPosition` type (`bybitAdapter.ts:16-21`) has no fields for the other two. Both are adapter
gaps — the facts this route needs are already in Bybit's documented response; the ABI adapter
just needs to accept an explicit category and stop discarding two fields it already receives.

**No open-position route, DTO, or use case exists anywhere in ABI today.**
`grep` across `src/`, `docs/`, `openspec/` for `open-position`, `OpenPositionLookup`,
`position_open`, `entry_bar_open_time_ms`, `executed_entry_price` returns zero ABI-side hits
outside of the unrelated `position_open_*` protection-verification statuses (a different,
already-shipped capability — `openspec/specs/post-create-protection-verification/spec.md`).
Routing is a flat if-chain per file (`src/app/server.ts:60-75`,
`src/routes/accountRoutes.ts:24-40`) — adding a GET route with two path segments is structurally
straightforward, matching the existing two-segment pattern already used by the entry-package PUT
route's matcher (`src/routes/entryPackageRoutes.ts:104-146`).

**The already-implemented Runtime client uses the old instance-only path and the old response
field names — it needs a coordinated change, not an ABI-side workaround.**
`../strategy_runtime` currently ships:
- Spec: `openspec/specs/abi-open-position-lookup-client/spec.md`
- Adapter: `src/strategy_runtime/infrastructure/abi/http_open_position.py`
- Codec: `src/strategy_runtime/infrastructure/abi/open_position_codec.py`
- Domain: `src/strategy_runtime/runtime/open_position/models.py`,
  `src/strategy_runtime/runtime/open_position/resolver.py`

(Paths relative to the `strategy_runtime` repo root.) As currently implemented:
`OpenPositionLookupRequest` (`open_position/models.py:9-15`) carries only `strategy_instance_id`,
and `resolver.py:18` builds the request from `state.strategy_instance_id` alone, with no
`trade_cycle_id`. The success DTO's two entry facts are named `entry_bar_open_time_ms` and
`executed_entry_price` (`open_position/models.py:18-36`). Both of these — the path shape and the
two field names — need to change on the Runtime side to match the target architecture in this
report (§6). What remains valid and unchanged from the existing Runtime contract: it's a closed,
cross-validated success object (both facts non-null together or both null together); `404` is
explicitly documented as invalid, never "no position"
(`abi-open-position-lookup-client/spec.md:66-69`); only `400`/`422` are documented business-error
statuses, with `5xx` decoding as "unavailable"; and price fields must be exact-decimal JSON
strings, never JSON numbers. These transport-level rules are expected to carry forward unchanged
under the new path and field names.

**Why the price/time facts must be raw exchange values, not bar-aligned ones — `base_timeframe`
is a Runtime/Engine concept ABI does not have.**
Per the Runtime identifier audit
(`runtime-identifier-normalization-and-refactoring-audit-2026-07-22.md:92-94`):
> `source_plan_bar_open_time_ms` — "Target/source bar on which the side plan was produced...
> Records the origin bar of a concrete entry side plan" (**Strategy Engine**-owned).
> `entry_bar_open_time_ms` — "**Bar containing actual entry execution**... Anchors open-trade
> bar-to-bar replay" (ABI-as-fact-provider, Runtime-stored lifecycle fact).

These are two different bars, and neither is something ABI can compute: aligning a raw execution
timestamp to a bar boundary requires `base_timeframe`, which ABI is never given and has never
needed elsewhere in this codebase. ABI can only honestly report the *raw* Bybit fact
(`openTime`), never a bar-aligned one — and must never substitute
`desired_entry.source_plan_bar_open_time_ms` for it, since that is a different fact (the plan's
origin bar, not the fill's bar) that would misreport whenever a fill doesn't land on the plan's
origin bar. Master plan §22 (`runtime-abi-entry-reconciliation-master-plan.md:612-629`)
independently states the preferred contract for the price fact is the exchange's *current*
average price, consistent with treating both entry facts as raw exchange values Runtime
post-processes on its own side. This is addressed by the wire response in §6.

---

## 3. Gaps

| # | Gap | Why it matters for this route |
|---|---|---|
| G1 | **`status`/`early_execution_observation` cannot serve as current position truth.** | The route must always re-check Bybit live; nothing in the stored record proves a position is open *now*. |
| G2 | **`getOpenPositions()`/`getPosition()` always use the global configured category, never an explicit one.** | The route must query using the specific `exchange_category` stored on the record, not the deployment's global default. |
| G3 | **`BybitPosition` doesn't carry `avgPrice` or `openTime`, though Bybit's response already does.** | Both facts this route needs to report are already in the documented Bybit response; the ABI adapter simply discards them today. |
| G4 | **The already-implemented Runtime `abi-open-position-lookup-client` uses the old instance-only path and old field names.** | Requires a coordinated, separately-agreed Runtime-side change (§6, §8) before the two sides can interoperate; not something the ABI-side change can paper over. |
| G5 | **No open-position route, DTO, or application use case exists in ABI.** | This is greenfield on the ABI side: new domain result type, new application service, new HTTP route, new composition wiring. |

None of these is a "data doesn't exist" or "lookup mechanism doesn't exist" gap — the composite
lookup ABI needs already exists (§2), and G2/G3 are adapter gaps where Bybit's documented response
already contains what's needed. G4 is a wire-contract coordination gap, not a data problem.

---

## 4. Target ABI model (minimal, not prescriptive of implementation)

```
(strategy_instance_id, trade_cycle_id)
  → EntryPackageCorrelationRepository.get(strategy_instance_id, trade_cycle_id)   [existing method]
      → EntryPackageExecutionRecord | undefined                                   [existing type]
          → exchange_category
          → exchange_symbol
          → desired_entry.side
          → order_link_id / order_id
          → status
```

**No new persisted state, no new index, no cardinality handling.** The pair is already the
record's composite key; the lookup either finds the one record for that exact pair or it doesn't.
There is no scenario in this model where more than one record matches, so no selection logic is
needed or designed.

**Live-queried, not persisted, at lookup time:**
- Bybit `/v5/position/list` for the record's exact `(exchange_category, exchange_symbol)` — the
  sole source of `position_open`, `avgPrice`, and `openTime`. Nothing about current position
  truth is read from the correlation store.

**Explicitly out of scope for this model** (removed from this revision, not designed elsewhere in
this report):
- Any lookup or index keyed on `strategy_instance_id` alone.
- Any notion of a "current trade cycle" for an instance — Runtime supplies the exact
  `trade_cycle_id` directly.
- Any record-selection rule (by status, timestamp, or otherwise) — there is exactly one record per
  supplied pair, or none.
- `spot` category and any hedge-mode position state — both fail closed (§5), not modeled.
- Any change to the entry-package PUT flow.

---

## 5. Lookup flow (algorithm sketch, not code, v1 scoped to `linear` one-way mode)

```
1.  HTTP route decodes and validates two non-empty opaque path identifiers:
    strategy_instance_id, trade_cycle_id.
    → either is missing/empty/malformed: 422 validation_failed

2.  Direct lookup: correlationRepository.get(strategy_instance_id, trade_cycle_id).
    (The existing composite-key method — no index, no cardinality handling.)

3.  Record not found:
    → fail closed as an ownership/invariant mismatch. Do NOT return
      position_open=false, and do NOT treat this as a 404-means-closed
      case — Runtime's own client contract already forbids coercing an
      unexpected absence into a closed-position answer.

4.  Record durably and provably describes no exchange binding
    (e.g. confirmed absent, or terminal-without-fill with nothing live):
    → 200 { position_open: false, first_fill_at_ms: null,
            average_entry_price: null }

5.  Record is in an unresolved ABI workflow state (e.g. "unknown", or any
    other mid-flight/ambiguous status that doesn't durably prove absence):
    → fail closed rather than guessing false.

6.  Require record.exchange_category === "linear".
    → anything else (including "spot"): fail closed with a distinct,
      documented error — never interpreted as "no position".

7.  Query Bybit /v5/position/list using the record's explicit
    exchange_category + exchange_symbol (never the global config category
    — see G2).

8.  Timeout, network failure, malformed response, or ambiguous position
    rows: fail closed. Never emit position_open:false on a query failure
    (mirrors confirmEntryPackageCancelled's existing "query_failed proves
    nothing" discipline, packageConfirmation.ts:205).

9.  No position row, or size == 0:
    → 200 { position_open: false, first_fill_at_ms: null,
            average_entry_price: null }

10. Positive size: a partial fill already counts as an open position — no
    need to wait for full execution.

11. Validate before trusting the row as this binding's position:
    - positionIdx matches Bybit one-way mode (0) — anything else
      (hedge-mode rows, unexpected positionIdx) fails closed, not
      interpreted as absence;
    - position side matches record.desired_entry.side;
    - avgPrice is present and a positive exact-decimal string;
    - openTime is present and a positive integer timestamp.
    Any validation failure here fails closed.

12. All checks pass: return open-position facts sourced directly from this
    query's avgPrice/openTime (§6).
```

`early_execution_observation` is not read anywhere in this flow. `/v5/execution/list`, any fill
ledger, any current-cycle pointer, any account model, and any cross-instance enforcement are not
part of this flow.

---

## 6. Wire response

```
position_open: bool
first_fill_at_ms: int | null
average_entry_price: exact decimal text | null
```

**Open position:**
```
position_open = true
first_fill_at_ms = Bybit position openTime
average_entry_price = Bybit position avgPrice
```

**Closed / absent position:**
```
position_open = false
first_fill_at_ms = null
average_entry_price = null
```

Runtime already owns `base_timeframe` and performs, on its own side:
```
first_fill_at_ms → entry_bar_open_time_ms
```

ABI never receives `base_timeframe` and never computes a bar-aligned timestamp.

---

## 7. Runtime behavior around the new pair-addressed contract

Runtime calls the open-position lookup only when a current trade cycle actually exists:

```
if runtime_state.current_trade_cycle is not None:
    call ABI GET .../strategy-instances/{runtime_state.strategy_instance_id}
                /trade-cycles/{runtime_state.current_trade_cycle.trade_cycle_id}
                /open-position
else:
    position_open = false   (decided locally by Runtime, no ABI call)
    → live-entry branch
```

This is a deliberate first-stage boundary: when Runtime has no current trade cycle recorded, it
does not call ABI at all, and locally treats the position as closed. This keeps the ABI-side
contract simple (it is only ever asked about a pair it can look up directly) and pushes the
"is there a current cycle" question entirely to Runtime, which already owns that fact.

**Documented crash-window limitation (temporary, not part of this change's scope):**

```
Runtime reserves trade_cycle_id
→ ABI applies the entry package
→ ABI responds success
→ Runtime persists current_trade_cycle
```

If Runtime crashes after ABI's success response but before persisting `current_trade_cycle`, it
loses its record of that `trade_cycle_id`. For the current smoke/Live V1 scope, automatic recovery
of this case is not implemented. This is a **documented limitation of Runtime's current
lifecycle**, not something this open-position lookup change is responsible for solving. A future
durable Runtime would need to persist the *intent* to call ABI before making the call — reserving
`trade_cycle_id`, durably saving the pending cycle/action, then calling ABI, then durably applying
the acknowledgement — so the pair can always be reconstructed after a crash. That sequencing is
named here only as a short follow-up architectural gate; no schema, outbox pattern,
compare-and-swap protocol, or recovery mechanism is designed in this report.

---

## 8. Required implementation surface (layers only, no code)

### ABI

- **Request/path validation:** two non-empty opaque path identifiers
  (`strategy_instance_id`, `trade_cycle_id`), following the existing validation pattern in
  `src/domain/entryPackageApi.ts` and `src/routes/entryPackageRoutes.ts`.
- **Response DTO:** `{ position_open, first_fill_at_ms, average_entry_price }` per §6.
- **Application lookup service:** implements the flow in §5 — direct composite `get()`, category
  check, live Bybit query, validation, response assembly, fail-closed branches.
- **Repository:** reuse the existing composite `EntryPackageCorrelationRepository.get()` as-is —
  no index, no new persisted state.
- **Bybit adapter:** (1) extend `BybitPosition`/`readOpenPosition()` to carry `avgPrice` and
  `openTime` from the already-available raw response (G3); (2) accept an explicit category
  parameter in the position query instead of always using `config.bybitCategory` (G2).
- **HTTP route:** new GET route for
  `/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`,
  matching the existing two-path-segment pattern already used by the entry-package PUT route.
- **Composition/readiness:** wire into `server.ts`'s route chain; gate on `EntryPackageReadiness`
  since it reads the same correlation store.
- **Tests:** unit tests for the application lookup service (each branch in §5), route-matching
  tests for the new path shape, contract tests for the response DTO, and fake-Bybit integration
  tests for the position-query/validation branches.
- **OpenAPI:** a new operation for this route, following the existing pattern in
  `docs/openapi/abi-entry-package-api-v1.json`.

**Not proposed:** any repository index or new persisted state, any record-selection logic, and any
change to the entry-package PUT flow.

### Runtime (separate, coordinated change — not part of the ABI change)

- Add `trade_cycle_id` to `OpenPositionLookupRequest`.
- Build the new nested path
  `/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`.
- Do not call ABI when `current_trade_cycle` is `None`; decide `position_open = false` locally and
  proceed to the live-entry branch (§7).
- Replace the response fields with `first_fill_at_ms` and `average_entry_price`.
- Compute `entry_bar_open_time_ms` inside Runtime, using its own `base_timeframe`.
- Update the codec, domain models, adapter, resolver, OpenSpec spec, and contract tests
  accordingly.

---

## 9. Decisions (things code and stated boundaries cannot resolve — need an owner's call)

**D1 — The wire/path contract change (§6, §7) must be agreed with the Runtime owner before either
side implements**, since it changes an already-archived Runtime OpenSpec capability
(`abi-open-position-lookup-client`) and its shipped implementation, not just something internal to
ABI.

**D2 — Error-code vocabulary for this route's fail-closed cases** (record not found, unresolved
ABI workflow state, non-`linear` category, non-one-way position state, exchange query failure).
The existing `EntryPackageErrorCode` set (`malformed_json`, `unsupported_media_type`,
`validation_failed`, `internal_error`) doesn't distinguish these specific cases from a generic
internal failure. Whether this route reuses the existing codes only, or introduces distinct
documented codes for one or more of them, is an open choice — Runtime's codec already generically
handles any `400`/`422` closed-envelope error and any `5xx` as "unavailable," so ABI has latitude
here.

---

## 10. OpenSpec boundary

### ABI change

- **Proposed change name:** `abi-open-position-lookup-v1`
- **New capabilities:** `abi-open-position-lookup-api` (public HTTP contract) and
  `open-position-resolution` (internal lookup behavior), mirroring the existing
  `abi-entry-package-api`/`entry-package-execution` split.
- **Capabilities NOT modified:** `entry-package-execution` is not touched — this change performs
  only a read via the existing `get()` method and never writes to the correlation store or the PUT
  flow.
- **In scope:** the pair-addressed GET route; the direct composite record lookup (§4); live
  `linear` Bybit position query using the record's explicit category/symbol; partial fill counting
  as open; sourcing `first_fill_at_ms`/`average_entry_price` from Bybit's `openTime`/`avgPrice`;
  one-way `positionIdx` and side validation; fail-closed handling for every branch in §5; readiness
  wiring; tests; OpenAPI.
- **Not in scope:** any repository index or lookup keyed on `strategy_instance_id` alone; any
  record-selection logic; any current-trade-cycle pointer; any change to the entry-package PUT
  flow; `/v5/execution/list` or any execution-history read; any account or cross-instance
  ownership model; any durable Runtime persistence design.

### Runtime dependency (separate change, coordinated but not part of the ABI change's scope)

The existing `abi-open-position-lookup-client` capability must be changed to: accept
`trade_cycle_id` in the request, build the new nested path, skip the ABI call entirely when
`current_trade_cycle` is `None`, and decode the new `first_fill_at_ms`/`average_entry_price`
response fields, computing `entry_bar_open_time_ms` itself.

The OpenSpec change itself was **not created** as part of this exploration.

---

## 11. Self-check against this revision's constraints

Re-read in full after editing to confirm:
- The title/header route is the new nested path
  (`.../strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`).
- Nowhere claims the lookup is performed by `strategy_instance_id` alone.
- No index on `strategy_instance_id` is proposed anywhere.
- No record counting, selection, or cardinality handling (zero/one/many) appears anywhere.
- No current-trade-cycle pointer appears anywhere.
- The direct composite `correlationRepository.get(strategy_instance_id, trade_cycle_id)` is the
  only record lookup described.
- Runtime does not call ABI when `current_trade_cycle` is `null` (§7).
- The crash-window gap (§7) is stated only as an accepted, temporary, documented limitation — not
  as something this change solves.
- The future durable Runtime design is mentioned only as a short follow-up gate (§7), with no
  schema, outbox, CAS, or recovery protocol designed.
- The ABI response contains `first_fill_at_ms` and `average_entry_price` (§6).
- The OpenSpec boundary (§10) includes no entry-package PUT changes and no persistence-schema
  changes.
