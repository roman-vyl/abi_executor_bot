# Architecture

## Purpose and boundary

Abi is the execution service between Strategy Runtime and Bybit:

```
Strategy Runtime --> Abi --> Bybit
```

Runtime owns strategy and trade-cycle lifecycle decisions. Abi owns everything about turning
one Runtime-issued desired entry package into real exchange state, and everything about
reading back the live truth of that state. Abi never decides what to trade; it only executes
and reports.

## Owned state

Abi owns one durable store: the entry-package correlation store
(`EntryPackageCorrelationRepository`, `ABI_ENTRY_PACKAGE_CORRELATION_PATH`). It is an
append-only JSONL file, single-writer, replayed into an in-memory index
(`EntryPackageExecutionRecord`, keyed by `(strategy_instance_id, trade_cycle_id)`, and
secondarily by `orderLinkId`/`orderId`) on startup. Abi holds no other durable state and no
database.

## External dependencies

- **Bybit REST API** — the only exchange Abi talks to (`src/exchange/bybitAdapter.ts`).
- **Strategy Runtime** — the only HTTP client Abi serves.

## Main components

- **`EntryPackageApplicationService`** (`src/services/entryPackage/`) — applies a desired
  entry package: create, amend, cancel-and-recreate, or cancel, each bounded-confirmed against
  Bybit before acknowledging.
- **`OpenPositionResolutionService`** (`src/services/openPosition/`) — answers "is this trade
  cycle's position open right now," always by a live Bybit query, never from stored status
  alone.
- **`EntryPackageCorrelationRepository`** (`src/correlation/`) — the durable record store both
  services read and write.
- **`BybitExchangeInstrumentResolver`** (`src/exchange/exchangeInstrumentResolver.ts`) — maps a
  Runtime ticker (`BTCUSDT.P` / `BTCUSDT`) to a Bybit `(symbol, category)` pair, deterministically
  and without I/O.
- **`BybitInstrumentTradingRulesProvider`** (`src/exchange/instrumentTradingRulesProvider.ts`) —
  fetches and TTL-caches (`ABI_INSTRUMENT_RULES_CACHE_TTL_MS`) per-symbol Bybit trading rules
  (min qty, qty step, min notional).
- **`FixedMinimumPositionSizeCalculator`** (`src/risk/positionSizeCalculator.ts`) — derives an
  order quantity from those trading rules.
- **`RestBybitAdapter`** (`src/exchange/bybitAdapter.ts`) — the sole Bybit REST client.
- **`KeyedMutex`** (`src/concurrency/keyedMutex.ts`) — in-process per-key serialization.
- **Route handlers** (`src/routes/*.ts`) — thin HTTP boundaries; each validates/decodes and
  hands off to the service or adapter above, never touching correlation state or Bybit directly.

## Entry-package flow

Runtime calls `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`
with either a desired entry or `null` (cancel). `EntryPackageApplicationService.apply()`:

1. Acquires the per-`(strategy_instance_id, trade_cycle_id)` mutex key.
2. Reads the existing correlation record for that pair, if any.
3. Resolves the exchange instrument identity (new record only; an existing record reuses its
   stored identity) and, for a new or growing order, the position size via the trading-rules
   provider.
4. Submits the appropriate Bybit request — create, amend, cancel-and-recreate, or cancel.
5. Bounded-confirms the result against Bybit (`packageConfirmation.ts`) before treating it as
   settled.
6. Persists the outcome to the correlation store *before* returning success to Runtime — the
   store is durable-before-acknowledgement, not best-effort.

The mutex key ensures at most one in-flight apply per trade cycle; concurrent requests for the
same pair serialize rather than race.

## Open-position resolution flow

`GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
resolves through `OpenPositionResolutionService`:

1. Direct composite lookup: `correlationRepository.get(strategy_instance_id, trade_cycle_id)`.
   No secondary index, no cardinality handling — the pair is a single-record key by
   construction.
2. No record → fail closed as an ownership/invariant mismatch (`unknown_trade_cycle_binding`),
   never `position_open: false`.
3. A record whose status durably proves absence (e.g. confirmed-absent, terminal-without-fill)
   resolves closed without querying Bybit.
4. A record in a live-query-admissible status triggers a live Bybit position query, scoped to
   the record's own stored `(exchange_category, exchange_symbol)` — never the deployment's
   global configured category.
5. An unresolved/ambiguous status, or any query failure, fails closed rather than guessing.

Stored status and any historical fill observation are only ever used to decide *whether* and
*how* to query Bybit — never as the position-truth answer itself.

## Persistence and recovery

On startup, `EntryPackageCorrelationRepository.replay()` reads the correlation JSONL file and
rebuilds the in-memory index before the entry-package and open-position routes are marked
ready (`EntryPackageReadiness`, `GET /health`'s `entryPackageReady` field). Replay runs
asynchronously so it never delays `server.listen()` for the account and system routes, which
do not depend on it. A non-final corrupt line fails readiness with a reason; a truncated final
line (crash mid-append) is tolerated and dropped.

## Concurrency model

Two independent serialization mechanisms exist for different reasons:

- **`KeyedMutex`** — one promise chain per `(strategy_instance_id, trade_cycle_id)` key,
  guarding the business logic in `EntryPackageApplicationService.apply()` so two requests for
  the same trade cycle never race each other's create/amend/cancel decision.
- **`EntryPackageCorrelationRepository`'s internal write queue** — a single FIFO promise chain
  serializing physical appends to the one correlation file, independent of which key each
  record belongs to.

Abi is single-process; there is no distributed-lock or multi-instance coordination.

## Failure and safety boundaries

- **Durable-before-success**: an entry-package apply is only acknowledged to Runtime after both
  Bybit confirmation and correlation-store persistence succeed.
- **Fail-closed, not fail-open**: every ambiguous or failed state (query failure, unresolved
  status, unsupported category, missing record) resolves to a safe error or a fail-closed
  answer, never to an optimistic `position_open: false` or a fabricated success.
- **Dry-run / live guard** (`src/execution/liveGuard.ts`, `GET /execution/mode`): live Bybit
  writes require `ABI_DRY_RUN=false`, `ABI_LIVE_TRADING_ENABLED=true`, both Bybit credentials
  configured, and a non-mainnet `BYBIT_ENV`. Any missing condition is reported in
  `blockedReasons` and blocks live execution.

## Sources of truth

- **Wire schema** (request/response shapes, status codes, error codes) — `docs/openapi/**`.
- **Behavioral invariants** (what Abi must/must not do in each scenario) — the canonical specs
  under `openspec/specs/**`, in particular `entry-package-execution`, `open-position-resolution`,
  `abi-entry-package-api`, and `abi-open-position-lookup-api`.
- **Operational procedure** (how to run, verify, and troubleshoot Abi) — `docs/RUNBOOK.md`.
