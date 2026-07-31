## Context

See `proposal.md` - Why. Two authoritative artifacts govern this design and are treated
as binding, not re-litigated here:

- `docs/ENTRY_PACKAGE_EXECUTION_AUDIT.md` (status: `READY FOR /opsx:propose`) — the
  architecture/execution authority. Every decision below traces to a specific section of
  that file; where this design elaborates an implementation detail the audit left open
  (exact file paths, exact function signatures), that elaboration is this document's own
  and is called out as such.
- `docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md` — the reuse/retirement authority. Every
  "reuse as-is" / "reuse with adaptation" / "do not reuse" decision below matches that
  file's per-module table exactly; this design does not re-decide reuse questions it
  already answered.

Current repository state: `entryPackageRoutes.ts` fully validates transport and then
unconditionally returns `internal_error` (`entryPackageRoutes.ts:79-84`). `serializeApplied
EntryPackageResponse`/`serializeAbsentEntryPackage` already exist in `entryPackageApi.ts`
but are not yet called. No database dependency exists in `package.json`; the only existing
durable-storage pattern is the legacy `Journal`'s append-only JSONL file. No mutex/
concurrency primitive exists anywhere in the codebase. No Bybit WebSocket client exists.
`bybitAdapter.ts` has no `instruments-info` method and no order-history method. The legacy
`/signals` + `/intents/*` contour remains fully in place and unmodified by this change.

## Goals / Non-Goals

**Goals:**
- Implement every component named in audit §16 (Component Ownership) as a concrete,
  ABI-internal module, wired so `entryPackageRoutes.ts` produces real, correlated,
  confirmed Bybit state instead of `internal_error`.
- Match `LEGACY_SIGNAL_INTENT_DISPOSITION.md`'s reuse table exactly: call
  `execution.ts`, `liveGuard.ts`, and `app/http.ts` unmodified; extend `bybitAdapter.ts`,
  `bybitOrderMapper.ts`, `Journal`'s low-level I/O pattern (not the class), and
  `verifyPostCreateProtection.ts`'s bounded-retry pattern; never call
  `createSignalIntent.ts`, `updateIntent.ts`, `cancelIntent.ts`, `parseSignalIntent`,
  `checkSignalRisk`, `calculatePositionSize`, `buildOrderLinkId`, or `Journal`'s
  signal-shaped query methods.
- Keep the new correlation store, mutex, and application service entirely additive:
  zero edits to any file the disposition marks `LEGACY_ONLY`.
- Make this change's own boundary honest: where a real ABI-internal dependency
  (ticker→symbol resolution) is genuinely required for production behavior, declare it
  as a blocking prerequisite rather than half-building it here.

**Non-Goals:** (see `proposal.md` for the full list; design-level additions only)
- No feature-flagging or staged rollout mechanism — the codebase has no existing
  precedent for one (live/dry-run is already gated by `ABI_DRY_RUN`/
  `ABI_LIVE_TRADING_ENABLED`, which this change does not touch or need to extend).
- No general-purpose mutex/lock library — a minimal in-process primitive is sufficient
  (see Decisions) because multi-process ABI is out of scope.
- No decimal-arithmetic library evaluation beyond confirming one is needed — the exact
  library or manual implementation is a task-level choice, not a design-level one.
- No design or implementation of `ExchangeSymbolResolver` — see Decision 9. That
  responsibility belongs entirely to a separate prerequisite change.

## Decisions

### 1. New module layout

New source files, none of which touch any file `LEGACY_SIGNAL_INTENT_DISPOSITION.md`
marks `LEGACY_ONLY`:

```
src/domain/entryOrderSemantics.ts        EntryOrderSemanticsMapper (audit §5/§16)
src/domain/entryPackageOrderIdentity.ts  per-cycle/generation order identity (audit §7)
src/correlation/entryPackageExecutionRecord.ts   record + status types (audit §8)
src/correlation/entryPackageCorrelationRepository.ts   durable store (audit §11)
src/concurrency/keyedMutex.ts            per-key in-process serialization (audit §25)
src/exchange/instrumentTradingRulesProvider.ts   Bybit instruments-info-backed rules (audit §6)
src/risk/positionSizeCalculator.ts       PositionSizeCalculator port + FixedMinimumPositionSizeCalculator (audit §6)
src/services/entryPackage/packageConfirmation.ts        PackageConfirmationComponent (audit §10/§26)
src/services/entryPackage/entryPackageApplicationService.ts   orchestrator (audit §16)
```

**Not in this list:** `src/exchange/exchangeSymbolResolver.ts`. Per Decision 9, that file
(interface **and** production implementation) is created by the prerequisite change
`abi-exchange-instrument-identity-v1`, not by this one. This change's Decision 11 flow and
group-5 tasks import and consume it once that prerequisite has landed in this same
repository.

Modified existing files (all already `REUSE_WITH_ADAPTATION` or explicitly extended per
the disposition table):

```
src/exchange/bybitAdapter.ts        + getInstrumentInfo(symbol), + getOrderHistory(payload)
                                       methods on BybitAdapter, RestBybitAdapter, StubBybitAdapter
src/exchange/bybitOrderMapper.ts    + a new entry-package payload builder that reuses
                                       mapSide/mapTriggerDirection, + BybitGetOrderHistoryPayload
                                       type; mapExecutionPlanToBybit itself is untouched and
                                       uncalled by new code
src/routes/entryPackageRoutes.ts    calls EntryPackageApplicationService instead of
                                       unconditional internalErrorResult(); checks the
                                       entry-package readiness flag (Decision 13)
src/routes/systemRoutes.ts          GET /health gains an entryPackageReady field
                                       (Decision 13); no existing field changes
src/app/server.ts                   composition root: constructs and wires the new
                                       correlation repository, rules provider, calculator,
                                       mutex, application service, and readiness flag;
                                       legacy route wiring (signalRoutes/intentRoutes/
                                       accountRoutes) unchanged
src/app/index.ts                    kicks off the async correlation replay alongside
                                       server startup, per Decision 13
src/config/config.ts                + ABI_ENTRY_PACKAGE_CORRELATION_PATH (new file path,
                                       sibling to journalPath, not reusing it),
                                       + instrument-rules cache TTL config
test/fakes/fakeBybitAdapter.ts      + fake getInstrumentInfo, + fake getOrderHistory
test/fixtures/config.ts             + new config fields' defaults
```

Rationale for a new `src/correlation/` and `src/concurrency/` top-level directory rather
than nesting under `src/services/entryPackage/`: the correlation store and the mutex are
each a single, self-contained concern with their own tests, matching the existing
top-level separation (`src/journal/`, `src/exchange/`, `src/execution/`). Nesting them
under `services/entryPackage/` would make `entryPackageApplicationService.ts` and its true
collaborators harder to tell apart from its infrastructure dependencies.

### 2. `EntryOrderSemanticsMapper` — pure function, not a class

Per audit §16: `map(side: "long" | "short") -> { exchange_side: "Buy" | "Sell",
trigger_direction: "rises_to" | "falls_to" }`. Implemented as a single pure function, not
a class with state — there is no state to hold. V1 body is a direct table lookup
(`long → Buy, falls_to`; `short → Sell, rises_to`), with a code comment stating the
geometry it depends on (per spec requirement "V1 execution scope is limited to the
currently supported entry geometry") so a future reader is not tempted to generalize it
silently. No market-price parameter exists in its signature — this is how the spec
requirement "mapping is stable regardless of the current market price" is enforced
structurally, not just by convention.

### 3. Order identity: deterministic hash, generation stored in the correlation record

`order_link_id = hash(strategy_instance_id, trade_cycle_id, "entry", generation)`,
following the same `sha256(...).slice(0, N)` + prefix pattern as the legacy
`buildOrderLinkId` (audit §7 confirms this stays comfortably under Bybit's documented
36-character limit). `generation` is **not** re-derived from the hash input each time —
it is read from the correlation record's `generation` field (1-based, reserved before the
external create call per audit §7/§9) and passed as an explicit hash input. This is why
`entryPackageOrderIdentity.ts` takes `generation` as a parameter rather than computing it:
the record is the single source of truth for "which generation are we on," not the hash
function.

### 4. Correlation repository: single JSONL file, full-snapshot lines, explicit fsync

Implements the exact durable write sequence from audit §11 (serialize complete record →
append + `"\n"` as one `write()` → `fsync` via `fsPromises.open` → `handle.appendFile` →
`handle.sync()` → `handle.close()` → update in-memory indexes → only then allow the HTTP
response). File path: new `ABI_ENTRY_PACKAGE_CORRELATION_PATH` config value, default
sibling to `journalPath` (e.g. `./var/abi_entry_package_correlation.jsonl`) — a new file,
not appended to the existing journal file.

Two separate serialization primitives, matching audit §11's explicit distinction:
- The keyed mutex (Decision 6) serializes *business logic* per `(strategy_instance_id,
  trade_cycle_id)`.
- The repository itself holds an internal FIFO write queue serializing *physical
  appends* across all keys, because they share one file descriptor.

In-memory indexes built at startup replay and kept current on every write: composite key
→ record, `order_link_id` → record (including historical bindings from
`binding_history[]`), `order_id` → record (same). Startup replay reuses the same
truncated-tail-tolerant / non-final-corruption-fails-readiness split behavior specified
in audit §11's crash matrix — implemented as its own replay routine, not by importing
`Journal`'s `readEvents`, because the failure-handling policy deliberately diverges
(readiness-fails-closed vs. `Journal`'s advisory skip-and-continue).

**Why not extend `Journal`:** confirmed by both audits — `Journal`'s public query surface
is signal-shaped and its lenient corruption handling is wrong for a correctness-critical
store. Only the low-level "open, append one line, replay skipping bad trailing lines"
*pattern* is shared; no code or class is imported from `journal.ts`.

**Why not SQLite:** no new dependency is justified — single-process, mutex-serialized
writes and full-file replay give the same guarantees `package.json` today gets from
JSONL, at zero added dependency weight. Revisit only if query complexity or true
multi-writer concurrency ever materializes (out of scope here).

### 5. `EntryPackageExecutionRecord` schema

Exactly the audit §8 shape, extended per this design with `ticker`, `exchange_symbol`,
and `risk_multiplier` — a correlation record must durably capture the intent it acted on
(what ticker, what resolved symbol, what sizing input) before any exchange call, not only
the outcome. TypeScript types live in `entryPackageExecutionRecord.ts`:

```
strategy_instance_id, trade_cycle_id: string        (immutable)
ticker: string                                       (immutable — fixed at first
                                                        application to this trade cycle)
exchange_symbol: string                              (mutable — currently resolved
                                                        Bybit symbol)
created_at, updated_at: string (ISO)
desired_entry: DesiredEntryDto | null                (mutable)
risk_multiplier: string                              (mutable — sizing provenance,
                                                        recorded as received on each
                                                        applied request)
calculated_quantity: string | null                   (mutable)
order_link_id: string | null                         (mutable)
order_id: string | null                              (mutable)
generation: number                                   (1-based; 0 = sentinel "no order yet")
status: "pending_create" | "applied" | "pending_replace" | "pending_cancel"
       | "absent" | "create_failed" | "unknown" | "terminal_unfilled"
early_execution_observation: {
  order_status: string
  cumulative_filled_qty: string
  remaining_qty: string
  avg_execution_price?: string
  observed_at: string
} | null
binding_history: Array<{
  order_link_id: string
  order_id: string | null
  generation: number
  role: "entry"
  exchange_symbol: string
  started_at: string
  ended_at: string | null
  end_reason: "replaced" | "cancelled" | "superseded" | "exchange_terminal" | null
}>
```

`ticker` is fixed the moment a trade cycle is first recorded; a later request supplying a
different ticker for the same trade cycle is rejected before any exchange call (Decision
11) — this is why it needs its own field rather than being read out of `desired_entry`,
which can be null. `exchange_symbol` is stored explicitly on both the top-level record and
each `binding_history` entry, rather than re-derived from `ticker` on every read, so that
a query or cancellation against an old binding after a restart does not depend on the
resolver producing the same answer today that it did when that binding was created.
`risk_multiplier` is recorded so the correlation record captures the sizing input that
produced `calculated_quantity`, not just the output. `binding_history` gains
`exchange_terminal` as a fourth `end_reason`, distinct from `cancelled` (ABI-initiated)
and `replaced`/`superseded` (part of a REPLACE) — it marks a binding the exchange
terminated on its own, without an ABI cancel action, which is exactly the
`terminal_unfilled` case (Decision 11).

`binding_history` is append-only within the record and is never truncated (audit §13).

### 6. Keyed mutex: `Map<string, Promise<void>>` chain, in-process only

A minimal utility: `withKeyLock(key: string, fn: () => Promise<T>): Promise<T>` that
chains promises per key in a `Map`. No timeout, no external dependency, no
distributed-lock semantics — audit §25 explicitly justifies this as sufficient because
multi-process ABI is a non-goal. Exact timeout/cleanup policy for a stuck lock is
deliberately left to `tasks.md`/implementation (audit §28h — non-blocking, design-level).
The lock is released in a `finally` block regardless of whether `fn` resolves or rejects —
this is a correctness requirement, not an optimization: a lock that leaked on a failed
request would permanently wedge that trade cycle for every subsequent PUT.

### 7. `InstrumentTradingRulesProvider` + `bybitAdapter.ts` extension

New `getInstrumentInfo(symbol: string): Promise<unknown>` method calling
`GET /v5/market/instruments-info` (public, unauthenticated — no signing required, unlike
every other `bybitAdapter.ts` method). `InstrumentTradingRulesProvider` wraps this with:
lazy per-resolved-`symbol` lookup, an in-memory TTL cache (exact TTL is a task-level
constant, not fixed here — audit §6 marks it design-level/non-blocking), and parses
`lotSizeFilter.minOrderQty` / `.qtyStep` / `.minNotionalValue` into the
`InstrumentTradingRules` shape. A failure to fetch rules for a given symbol fails only
that command (`internal_error`), never the whole-service `/health` readiness — this
mirrors the audit's explicit distinction from correlation-store readiness.

### 8. `PositionSizeCalculator` port + `FixedMinimumPositionSizeCalculator`

Port signature exactly as audit §6: `calculate(ticker, planned_entry_price,
initial_stop_price, risk_multiplier, context) -> calculated_quantity`.
`FixedMinimumPositionSizeCalculator` implements the formula:

```
qty_by_min      = ceil_to_step(min_order_qty, qty_step)
qty_by_notional = ceil_to_step(min_notional_value / planned_entry_price, qty_step)
calculated_quantity = max(qty_by_min, qty_by_notional)
```

All arithmetic exact-decimal — no `Number()` conversion at any step, including the
division for `qty_by_notional` (round-up division to the needed precision). The exact
decimal implementation (small hand-rolled helper vs. a library) is a task-level choice;
this design only fixes that it must not go through binary floating point, matching the
discipline already established in `entryPackageApi.ts`'s `isExactDecimalText`.
`risk_multiplier` is accepted and threaded through the call but does not affect this
formula — a code comment marks this as the V1 placeholder boundary, matching the
audit's explicit disclosure requirement.

### 9. Ticker → Bybit symbol resolution: blocking prerequisite, owned entirely by a separate change

This is a real ABI-internal (non-cross-repo) dependency that
`EntryPackageApplicationService`, `InstrumentTradingRulesProvider`, and the Bybit payload
builder all need — none of them can make a correct real Bybit call without a resolved
`symbol`. Earlier drafting of this design treated it as a seam this change would define
(interface only) while leaving the implementation to "whoever." **That framing is
rejected.** Defining the interface here without a production implementation would leave
this change structurally unable to deliver the production execution behavior
`proposal.md` promises — a half-built dependency is not meaningfully different from an
undeclared one.

**Decision:** a separate, prerequisite OpenSpec change — proposed name
`abi-exchange-instrument-identity-v1` — owns `src/exchange/exchangeSymbolResolver.ts` in
full: the `ExchangeSymbolResolver` interface (`resolve(ticker: string): string`) **and**
its production implementation (e.g. Bybit-symbol normalization such as stripping a `.P`
suffix, whatever that change's own design decides). This change does not create that
file, does not define the interface, and does not implement any part of the resolution
logic. Once the prerequisite has landed in this same repository, this change's group-5
tasks import `ExchangeSymbolResolver` from it and inject a concrete instance at the
composition root (`app/server.ts`), exactly like every other collaborator
(`bybit`, `config`, the correlation repository) is already injected.

**Consequence for sequencing:** tasks in groups 1-4 and 6 do not need a resolved symbol
and may be implemented and tested independently. Tasks in group 5 (and the
symbol-dependent parts of group 7) are blocked on the prerequisite change landing first —
see `tasks.md` group 0. Unit tests throughout this change may still use a trivial
test-only resolver double (identity function or a hardcoded mapping) — that is a test
fixture, not a stand-in production design, and it does not reduce or replace the
blocking dependency for production behavior.

### 10. `PackageConfirmationComponent`: new code, two-step exchange query, not a call into `verifyPostCreateProtection`

Per the disposition table, `verifyPostCreateProtection.ts` is `REUSE_WITH_ADAPTATION`,
not `REUSE_AS_IS` — its bounded-retry *mechanics* (poll a fixed number of times with a
fixed delay) are the template, but the new component is new code because: (a) it must
diff returned order fields (`triggerPrice`/`qty`/`stopLoss`/`takeProfit`) against the
desired package, which `verifyPostCreateProtection` never does; (b) it classifies into
the five audit §26 outcomes, not `verifyPostCreateProtection`'s position-breach-focused
outcomes; (c) its journal coupling is the new `CorrelationRepository`, not `Journal`;
(d) it queries two Bybit endpoints, not one.

**Two-step query, not realtime-only.** `getOrderByLinkId` queries only
`/v5/order/realtime`, which shows live/pending orders — it cannot see an order that has
already fully filled and closed, been rejected, or been terminated by the exchange,
because Bybit moves those out of the realtime set. Confirming `full fill`,
`rejected/deactivated`, and `terminal_unfilled` outcomes correctly therefore requires a
second query when the realtime lookup comes back empty or reports a terminal status:
`bybitAdapter.ts` gains a new `getOrderHistory(payload)` method calling
`GET /v5/order/history` (by `orderLinkId`, mirroring `getOrderByLinkId`'s existing
payload shape). The confirmation flow becomes:

```
query /v5/order/realtime by orderLinkId
if found and live/pending → diff fields against desired package → classify
if not found, or found but reporting a terminal status →
  query /v5/order/history by orderLinkId
  if history shows a fill → classify as full/partial fill (audit §26)
  if history shows rejected/cancelled/deactivated with no fill → classify as
    rejected/deactivated before any fill
  if neither query yields a conclusive result within the bounded retry budget →
    classify as ambiguous
```

This stays within the existing bounded-retry envelope (same attempt count/delay pattern
as `verifyPostCreateProtection`) — the history query is a fallback branch within one
confirmation attempt, not an additional unbounded retry loop. Individual fills and
execution-history reconstruction remain explicitly out of scope (audit §8/§17); the
history query is used only to classify the aggregate outcome, never to enumerate fills.

### 11. `EntryPackageApplicationService`: orchestration, owns nothing else

Exact flow (audit §16, §9, §12), extended with the classification branches this
correction pass adds:

```
1. acquire keyed mutex for (strategy_instance_id, trade_cycle_id); release in a
   finally block so a failed request never leaves the lock held (Decision 6)
2. load correlation record (or none)
3. classify:
   - ticker differs from the record's stored ticker → reject with a safe error,
     no exchange call (Decision 5)
   - only source_plan_bar_open_time_ms/locked_exit_profile differ from the
     stored desired_entry (side/price/qty/stop/take unchanged) → durably update
     the stored desired_entry, run bounded revalidation of the existing order,
     no amend/create request sent
   - otherwise: CREATE | REPLACE (amend | cancel-and-create) | CANCEL |
     CONFIRM-ABSENT | repeat-PUT revalidation (including terminal_unfilled
     fail-closed path)
4. if a new/changed order is needed:
   a. call EntryOrderSemanticsMapper(side)
   b. call PositionSizeCalculator
   c. build Bybit payload (bybitOrderMapper.ts additions), using the resolved
      symbol from ExchangeSymbolResolver (Decision 9)
   d. persist provisional record — including ticker, exchange_symbol,
      risk_multiplier — durable write, before any Bybit call
   e. call execution.ts's guarded create/amend/cancel (as-is); if it reports
      skipped_live_execution, treat this as a non-success and return
      internal_error — never entry_package_applied or entry_package_absent
   f. run PackageConfirmationComponent (Decision 10)
   g. persist confirmed/failed state (durable write)
5. release mutex
6. serialize result via existing serializeAppliedEntryPackage/serializeAbsentEntryPackage
```

The HTTP route (`entryPackageRoutes.ts`) calls only this service; it does not touch the
correlation repository, Bybit, or the mutex directly — continuing the boundary already
established (and already a completed task in the archived `abi-entry-package-api-v1`
change).

### 12. Test and smoke strategy

Unit tests for each new pure/isolated module (mapper, identity, calculator, repository
crash/replay behavior, confirmation classification) mirror existing test file naming
(`test/unit/<module>.test.ts`). Integration tests exercise the full service against
`FakeBybitAdapter` (extended per Decisions 7/10) plus a new
`FakeInstrumentTradingRulesProvider` (disposition explicitly names this as the pattern to
follow, modeled on `test/fakes/fakeBybitAdapter.ts`). A new entry-package smoke script
(`scripts/smoke-entry-package-contract-matrix.sh` or similar, exact name a task-level
choice) exercises apply/replace/cancel/confirm end-to-end against demo/testnet, mirroring
`smoke-sandbox-contract-matrix.sh`'s structure without touching that file. This new smoke
script is additive; it does not replace or modify any existing legacy smoke script (per
disposition, that migration happens in a later, separate cleanup pass, not in this
change).

### 13. Startup readiness gating (entry-package only, not the whole server)

`startServer`/`app/index.ts` starts the correlation repository's replay asynchronously at
startup and tracks a composition-root-owned `entryPackageReady: boolean` flag (with an
optional `reason` string), set to `true` only once replay succeeds. `server.listen(...)`
is **not** delayed for this — legacy `/signals`, `/intents/*`, and `/account/*` routes are
unaffected by correlation-store health and must keep working even if entry-package replay
is slow or fails, matching the disposition's independence of the legacy contour.
`entryPackageRoutes.ts` checks this flag before calling `EntryPackageApplicationService`:
when not ready, it returns the existing safe `internal_error` response — no new error
code. `systemRoutes.ts`'s `GET /health` is extended with an additional
`entryPackageReady` field surfacing this state for operators, without altering any
existing `/health` field. This scopes the audit's fail-closed startup requirement
(`ready=true` with an unreadable store: no) to entry-package specifically, applying the
same "don't take down unrelated capabilities" principle Decision 7 already applies to
instrument-rules failures, one level up at startup.

## Risks / Trade-offs

- [Explicit `fsync` on every correlation write adds per-request disk-flush latency] →
  Accepted: entry-package PUT is not a high-frequency path; correctness (durable-before-
  acknowledge) outweighs raw throughput here, matching audit §11's own conclusion.
- [In-process keyed mutex provides no protection if ABI ever runs multi-process] →
  Accepted: multi-process ABI is an explicit non-goal (audit §17); revisit only if that
  changes. The lock is always released via `finally` (Decision 6), so a failing request
  cannot wedge a trade cycle even within the single-process model.
- [This change cannot send any real Bybit request for any ticker until the prerequisite
  change `abi-exchange-instrument-identity-v1` lands, since that change owns
  `ExchangeSymbolResolver` in full] → Not treated as a risk to mitigate within this
  change — it is an explicit, declared blocking dependency (proposal.md, Decision 9).
  Group-5 tasks are sequenced behind that prerequisite merging first; this change's own
  tasks and tests do not attempt to work around its absence with a partial or placeholder
  production implementation.
- [Realtime-only order queries cannot observe orders that have already left the
  open/pending set] → Mitigated by the order-history fallback query (Decision 10).
- [`terminal_unfilled` can leave a trade cycle stuck until an explicit `CANCEL` arrives] →
  Accepted per audit §12 decision B: automatic resurrection was rejected as unvalidated
  business semantics. Whether Runtime reliably sends that `CANCEL` is outside ABI's
  control (audit §12); a future recovery-UX mechanism is explicitly deferred (audit
  §28j), not designed here.
- [New `min_notional_value`-aware sizing formula is still not real risk-based sizing] →
  Disclosed, unchanged from audit §6: an explicit mainnet/live-readiness launch gate, not
  a silent gap.
- [Generation-aware `order_link_id` derivation depends on the correlation record already
  holding the correct `generation` before the hash is computed] → Mitigated by Decision 3
  and Decision 4's durable-write-before-external-call ordering: the record is written
  with its reserved generation before the hash is used in any Bybit call.
- [Synchronous server startup could otherwise accept entry-package requests before
  correlation replay completes] → Mitigated by the entry-package-scoped readiness flag
  (Decision 13), which does not block legacy or account routes.

## Migration Plan

Purely additive — no existing data migrates. `entryPackageRoutes.ts`'s only behavior
change is that previously-guaranteed-failing valid requests can now succeed; the request/
response DTOs are unchanged, so no client-visible migration is needed. Rollback is a
plain revert of the route-wiring and composition-root commits; the legacy `/signals` +
`/intents/*` contour and its smoke coverage are untouched throughout and require no
rollback consideration. The new correlation file is created on first write; deleting it
(only ever appropriate in a non-production environment) simply resets entry-package
execution state with no effect on the legacy journal or legacy flows.

**Deployment ordering:** this change's group-5/7 tasks that require a resolved Bybit
symbol cannot be completed against production Bybit until the prerequisite change
`abi-exchange-instrument-identity-v1` has merged. Groups 1-4, 6, and the non-symbol-
dependent parts of 8-9 may still be implemented and tested (using a test-only resolver
double) before that prerequisite lands, but this change as a whole is not deployable to
production until it has.

## Open Questions

These do not change the spec, the approach, or the task breakdown — each already has an
audit-documented default that implementation may proceed with:

- Exact keyed-mutex timeout/cleanup policy for a stuck lock (audit §28h).
- Eager vs. lazy startup reconciliation for `pending`/`unknown` correlation records
  beyond what audit §14 already requires as mandatory (lazy is the documented default;
  audit §28c).
- Whether a dedicated recovery endpoint is ever added for unblocking `terminal_unfilled`
  beyond the required explicit-`CANCEL` path (audit §28j).
- Exact instrument-rules cache TTL value (audit §6 — a constant, not an architectural
  choice).
- Exact `getOrderHistory` query parameters (pagination/limit) beyond looking up by
  `orderLinkId` — a task-level REST call detail, not an architectural choice.
