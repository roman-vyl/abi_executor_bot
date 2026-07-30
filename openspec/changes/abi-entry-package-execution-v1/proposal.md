## Why

`abi-entry-package-api-v1` shipped the full public transport contract for
`PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`
— route matching, strict DTO validation, exact-decimal parsing, success serializers, and
OpenAPI — but execution was deliberately left unwired. Today every fully valid request
fails safely with `500 internal_error`, by design, because no code turns a validated
`EntryPackageCommand` into a real, correlated, confirmed Bybit order. That is the gap this
change closes.

A two-pass architecture exploration (`docs/ENTRY_PACKAGE_EXECUTION_AUDIT.md`, status
`READY FOR /opsx:propose`) has already resolved every decision needed to wire this
honestly: ABI-owned trigger-direction semantics for the one supported strategy geometry,
per-cycle order identity, durable correlation, bounded field-accuracy confirmation,
truthful repeat-PUT idempotency including fail-closed handling of an order that went
terminal without filling, and honestly-minimum position sizing. A companion reuse audit
(`docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md`) has classified every legacy `/signals` +
`/intents/*` file this change might otherwise be tempted to call, and found the legacy
contour must stay in place — active smoke scripts still depend on it — but must not be
depended upon by the new code. Now is the point where implementation can proceed without
re-litigating architecture mid-build.

## What Changes

- Add `EntryPackageApplicationService`: turns a validated `EntryPackageCommand` into
  APPLY / REPLACE / CANCEL / confirm-absent behavior against Bybit, replacing the current
  unconditional `internal_error` in `entryPackageRoutes.ts`.
- Add `EntryOrderSemanticsMapper`: a pure, deterministic, ABI-owned V1 mapping from
  `DesiredEntry.side` to Bybit `exchange_side` (`Buy`/`Sell`) and `trigger_direction`
  (`rises_to`/`falls_to`) for the currently supported EMA-pullback entry geometry
  (`long → Buy + falls_to`, `short → Sell + rises_to`). No comparison against live market
  price is performed, either to choose direction or to admit/reject sending the create
  request — Bybit alone decides acceptance, immediate execution, or rejection.
- Add per-cycle, per-generation deterministic order identity:
  `order_link_id = hash(strategy_instance_id, trade_cycle_id, role, generation)`,
  1-based generation, reserved and durably persisted before any Bybit call. Replaces
  entry-package's reliance on the legacy `buildOrderLinkId(instanceId, kind)`, which is
  proven to collide across sequential trade cycles of the same strategy instance.
- Add `CorrelationRepository`: a new, ABI-owned, single append-only, fsync-per-write
  durable JSONL store of `EntryPackageExecutionRecord`s (composite `(strategy_instance_id,
  trade_cycle_id)` key, generation, current order binding, embedded append-only binding
  history, aggregate `early_execution_observation`, status). Independent of the legacy
  `Journal`; only its low-level append/replay I/O pattern is reused.
- Add `PackageConfirmationComponent`: bounded field-accuracy verification after
  create/amend — compares the exchange's returned order fields against the desired
  package, classifying into five outcomes (pending confirmed / full fill before ack /
  partial fill before ack / rejected-or-deactivated before any fill / ambiguous
  observation). Extends the existing bounded-retry query mechanics; never returns success
  on partial confirmation.
- Add `PositionSizeCalculator` port and its V1 implementation,
  `FixedMinimumPositionSizeCalculator`, backed by a new `InstrumentTradingRulesProvider`
  (Bybit `GET /v5/market/instruments-info`: `min_order_qty`, `qty_step`,
  `min_notional_value`). `calculated_quantity` is a genuine minimum-executable quantity
  (`max(qty_by_min, qty_by_notional)`, exact-decimal, rounded up to `qty_step`) — not a
  hardcoded literal. `risk_multiplier` is threaded through the port but does not affect
  the V1 formula.
- Add a per-`(strategy_instance_id, trade_cycle_id)` in-process keyed mutex serializing
  concurrent PUTs on the same trade cycle, and a `CorrelationRepository`-internal write
  queue serializing physical file appends across all keys.
- Add truthful, bounded-revalidated idempotency for repeat PUTs on an `applied` record
  (no blind cached no-op), including fail-closed handling of a package that went terminal
  without ever filling: a new `terminal_unfilled` status, `internal_error` on repeat
  non-null PUT, no automatic re-creation in the same trade cycle — unblocking requires an
  explicit `CANCEL` (`desired_entry: null`) first.
- Extend `bybitAdapter.ts` with an `instruments-info` method and extend
  `bybitOrderMapper.ts`'s trigger-direction encoding path; extend the fake adapter and
  config test fixture to match.
- Wire `entryPackageRoutes.ts` and `app/server.ts` composition to use the new service.

**Non-goals (explicit, not silently deferred):**
- Real risk-based position sizing (fixed-minimum sizing is a disclosed, deliberate V1
  limitation and an explicit mainnet/live-readiness launch gate, not this change's job).
- Bybit private WebSocket ingestion, Stage B execution-event delivery to Runtime, or any
  Runtime-facing webhook (Stage A returns a truthful synchronous acknowledgement only).
- Designing or implementing Runtime `ticker` → Bybit `symbol` resolution. This is a real,
  ABI-internal (non-cross-repo) dependency that `EntryPackageApplicationService`,
  `InstrumentTradingRulesProvider`, and `ExchangeGateway` all need — this change fixes it
  as an explicit prerequisite/assumption (see `design.md`) and consumes an already-resolved
  `symbol`, without designing the resolver itself.
- Any cross-repo change to Strategy Engine or Strategy Runtime, or to the public
  `abi-entry-package-api` request/response DTOs.
- Removing, retiring, or modifying any legacy `/signals` + `/intents/*` code, tests, or
  smoke scripts. Per `docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md`, nothing in the legacy
  contour currently qualifies for removal — it stays exactly as-is.

No breaking changes: the public `PUT .../entry-package` route, request DTO, and both
success DTOs (`entry_package_applied`, `entry_package_absent`) are unchanged. Only the
previously-guaranteed `internal_error` outcome for a fully valid request now, correctly,
sometimes returns a truthful `2xx` instead.

## Capabilities

### New Capabilities
- `entry-package-execution`: internal ABI application/execution behavior that turns a
  validated entry-package command into real, correlated, confirmed Bybit exchange state
  and a truthful synchronous acknowledgement or safe failure. Distinct from the existing
  transport-only `abi-entry-package-api` capability.

### Modified Capabilities
None. `abi-entry-package-api`'s requirements (route, request/response DTOs, error
mapping) already describe the correct external behavior; only the previously-missing
implementation is being added. No spec-level behavior of that capability changes.

## Impact

- **New source modules** (exact paths decided in `design.md`, not fixed here): entry
  order semantics mapping, per-cycle/generation order identity, correlation repository,
  package confirmation, instrument trading rules provider, position size calculator port
  + V1 implementation, keyed mutex, the application service itself.
- **Modified existing modules**: `src/routes/entryPackageRoutes.ts` (call the new service
  instead of unconditional `internal_error`), `src/app/server.ts` (composition wiring),
  `src/exchange/bybitAdapter.ts` (+ `StubBybitAdapter`) (new `instruments-info` method),
  `src/exchange/bybitOrderMapper.ts` (reuse of trigger-direction encoding), `src/config/config.ts`
  (new correlation-store path / instrument-rules cache config), `test/fakes/fakeBybitAdapter.ts`,
  `test/fixtures/config.ts`.
- **New durable state**: a new append-only correlation file on disk, independent of the
  existing `journalPath`.
- **Unaffected**: the legacy `/signals` + `/intents/*` route, service, domain, risk,
  journal, and test files — none are called by the new code and none are removed (see
  `docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md` for the full per-file disposition and the
  cleanup ordering that must happen after this change ships and legacy smoke scripts are
  migrated).
- **Trading safety**: no fabricated `2xx` under any failure path; durable-write-before-
  response invariant (`entry_package_applied`/`entry_package_absent` only after
  fsync-confirmed correlation state); mainnet live execution remains blocked by the
  existing live-execution guard, unaffected by this change; sizing remains disclosed
  fixed-minimum, not risk-based, until a separate future change.
- **Idempotency/recovery**: same `(strategy_instance_id, trade_cycle_id)` pair remains
  the sole idempotency key; no new Runtime-owned `command_id`. Startup replay of the
  correlation store is synchronous and fail-closed on corruption, gating readiness.
- **External dependency**: Bybit `GET /v5/market/instruments-info` (public,
  unauthenticated) becomes a new exchange call this service makes.
- **Explicit prerequisite/assumption**: Runtime `ticker` → Bybit `symbol` resolution must
  be available to this change's `EntryPackageApplicationService` (see `design.md`); this
  change consumes it but does not build it.
