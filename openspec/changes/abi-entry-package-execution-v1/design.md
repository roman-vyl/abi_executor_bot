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
`bybitAdapter.ts` has no `instruments-info` method. The legacy `/signals` + `/intents/*`
contour remains fully in place and unmodified by this change.

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

**Non-Goals:** (see `proposal.md` for the full list; design-level additions only)
- No feature-flagging or staged rollout mechanism — the codebase has no existing
  precedent for one (live/dry-run is already gated by `ABI_DRY_RUN`/
  `ABI_LIVE_TRADING_ENABLED`, which this change does not touch or need to extend).
- No general-purpose mutex/lock library — a minimal in-process primitive is sufficient
  (see Decisions) because multi-process ABI is out of scope.
- No decimal-arithmetic library evaluation beyond confirming one is needed — the exact
  library or manual implementation is a task-level choice, not a design-level one.

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
src/exchange/exchangeSymbolResolver.ts   ticker→symbol seam (see Decision 9 — prerequisite, not designed here)
src/risk/positionSizeCalculator.ts       PositionSizeCalculator port + FixedMinimumPositionSizeCalculator (audit §6)
src/services/entryPackage/packageConfirmation.ts        PackageConfirmationComponent (audit §10/§26)
src/services/entryPackage/entryPackageApplicationService.ts   orchestrator (audit §16)
```

Modified existing files (all already `REUSE_WITH_ADAPTATION` or explicitly extended per
the disposition table):

```
src/exchange/bybitAdapter.ts        + getInstrumentInfo(symbol) method on BybitAdapter,
                                       RestBybitAdapter, StubBybitAdapter
src/exchange/bybitOrderMapper.ts    + a new entry-package payload builder that reuses
                                       mapSide/mapTriggerDirection; mapExecutionPlanToBybit
                                       itself is untouched and uncalled by new code
src/routes/entryPackageRoutes.ts    calls EntryPackageApplicationService instead of
                                       unconditional internalErrorResult()
src/app/server.ts                   composition root: constructs and wires the new
                                       correlation repository, rules provider, calculator,
                                       mutex, application service; legacy route wiring
                                       (signalRoutes/intentRoutes/accountRoutes) unchanged
src/config/config.ts                + ABI_ENTRY_PACKAGE_CORRELATION_PATH (new file path,
                                       sibling to journalPath, not reusing it),
                                       + instrument-rules cache TTL config
test/fakes/fakeBybitAdapter.ts      + fake getInstrumentInfo
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

Exactly the audit §8 shape, TypeScript types in `entryPackageExecutionRecord.ts`:

```
strategy_instance_id, trade_cycle_id: string        (immutable)
created_at, updated_at: string (ISO)
desired_entry: DesiredEntryDto | null
calculated_quantity: string | null
order_link_id: string | null
order_id: string | null
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
  started_at: string
  ended_at: string | null
  end_reason: "replaced" | "cancelled" | "superseded" | null
}>
```

`binding_history` is append-only within the record and is never truncated (audit §13).

### 6. Keyed mutex: `Map<string, Promise<void>>` chain, in-process only

A minimal utility: `withKeyLock(key: string, fn: () => Promise<T>): Promise<T>` that
chains promises per key in a `Map`. No timeout, no external dependency, no
distributed-lock semantics — audit §25 explicitly justifies this as sufficient because
multi-process ABI is a non-goal. Exact timeout/cleanup policy for a stuck lock is
deliberately left to `tasks.md`/implementation (audit §28h — non-blocking, design-level).

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

### 9. Ticker → Bybit symbol resolution: explicit prerequisite, not designed or implemented here

Per `proposal.md` and both audits, this is a real ABI-wide dependency this change's
`EntryPackageApplicationService`, `InstrumentTradingRulesProvider`, and the Bybit payload
builder all need, but which this change does not own. Concretely: a narrow seam,
`ExchangeSymbolResolver` (`resolve(ticker: string): string`), is defined and injected
wherever a resolved `symbol` is needed — the same dependency-injection shape every other
collaborator in this design already uses (`bybit`, `config`, the repository). **This
change does not implement `ExchangeSymbolResolver`.** Implementation of tasks in this
change assumes a resolver is available by the time task block 5 (Bybit payload/adapter
extensions) is implemented; if no such resolver exists yet elsewhere in the codebase at
that time, providing one is prerequisite work outside this OpenSpec change's task list,
not a design decision this document makes. Tests use a trivial fake resolver
(identity/no-op), which is a test double, not a production design choice.

### 10. `PackageConfirmationComponent`: new code, not a call into `verifyPostCreateProtection`

Per the disposition table, `verifyPostCreateProtection.ts` is `REUSE_WITH_ADAPTATION`,
not `REUSE_AS_IS` — its bounded-retry *mechanics* (poll `getOrderByLinkId` +
position/order-state a fixed number of times with a fixed delay) are the template, but
the new component is new code because: (a) it must diff returned order fields
(`triggerPrice`/`qty`/`stopLoss`/`takeProfit`) against the desired package, which
`verifyPostCreateProtection` never does; (b) it classifies into the five audit §26
outcomes (pending confirmed / full fill / partial fill / rejected-deactivated /
ambiguous), not `verifyPostCreateProtection`'s position-breach-focused outcomes; (c) its
journal coupling is the new `CorrelationRepository`, not `Journal`. The bounded-retry
constants (`2` attempts, `300ms` delay) are a reasonable starting point copied from the
existing code, not a hard requirement — tunable at the task level.

### 11. `EntryPackageApplicationService`: orchestration, owns nothing else

Exact flow (audit §16, §9, §12):

```
1. acquire keyed mutex for (strategy_instance_id, trade_cycle_id)
2. load correlation record (or none)
3. classify: CREATE | REPLACE (amend | cancel-and-create) | CANCEL | CONFIRM-ABSENT
   | repeat-PUT revalidation (including terminal_unfilled fail-closed path)
4. if a new/changed order is needed:
   a. call EntryOrderSemanticsMapper(side)
   b. call PositionSizeCalculator
   c. build Bybit payload (bybitOrderMapper.ts additions)
   d. persist provisional record (durable write, before any Bybit call)
   e. call execution.ts's guarded create/amend/cancel (as-is)
   f. run PackageConfirmationComponent
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
`FakeBybitAdapter` (extended per Decision 7) plus a new `FakeInstrumentTradingRulesProvider`
(disposition explicitly names this as the pattern to follow, modeled on
`test/fakes/fakeBybitAdapter.ts`). A new entry-package smoke script
(`scripts/smoke-entry-package-contract-matrix.sh` or similar, exact name a task-level
choice) exercises apply/replace/cancel/confirm end-to-end against demo/testnet, mirroring
`smoke-sandbox-contract-matrix.sh`'s structure without touching that file. This new smoke
script is additive; it does not replace or modify any existing legacy smoke script (per
disposition, that migration happens in a later, separate cleanup pass, not in this
change).

## Risks / Trade-offs

- [Explicit `fsync` on every correlation write adds per-request disk-flush latency] →
  Accepted: entry-package PUT is not a high-frequency path; correctness (durable-before-
  acknowledge) outweighs raw throughput here, matching audit §11's own conclusion.
- [In-process keyed mutex provides no protection if ABI ever runs multi-process] →
  Accepted: multi-process ABI is an explicit non-goal (audit §17); revisit only if that
  changes.
- [`ExchangeSymbolResolver` has no production implementation inside this change] → The
  application service and rules provider cannot reach real Bybit endpoints for any
  ticker until a resolver exists. Mitigation: the seam is explicit and injected, so a
  resolver landing later (from prerequisite work) requires no further change to this
  change's code — only a new implementation of one narrow interface.
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

## Migration Plan

Purely additive — no existing data migrates. `entryPackageRoutes.ts`'s only behavior
change is that previously-guaranteed-failing valid requests can now succeed; the request/
response DTOs are unchanged, so no client-visible migration is needed. Rollback is a
plain revert of the route-wiring and composition-root commits; the legacy `/signals` +
`/intents/*` contour and its smoke coverage are untouched throughout and require no
rollback consideration. The new correlation file is created on first write; deleting it
(only ever appropriate in a non-production environment) simply resets entry-package
execution state with no effect on the legacy journal or legacy flows.

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
