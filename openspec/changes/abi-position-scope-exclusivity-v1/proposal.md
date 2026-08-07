## Why

Runtime's own model already guarantees that one `strategy_instance_id` has at most one current
`trade_cycle_id` at a time, and different strategy instances may each run their own current trade
cycle concurrently. ABI mirrors that pair as the key for everything it durably tracks
(`EntryPackageExecutionRecord`, keyed by `(strategy_instance_id, trade_cycle_id)`). But Bybit does
not know about strategy instances or trade cycles at all — in one-way mode, every order and
position for a given `category`+`symbol` under ABI's configured account lands on the exact same
physical position slot (`positionIdx = 0`), regardless of which pair's command produced it.

Today nothing in ABI enforces that only one pair may act on a given physical scope at a time.
`KeyedMutex` (`src/concurrency/keyedMutex.ts`) already serializes commands for one trade cycle, but
two *different* trade cycles — even from two different strategy instances — that both resolve to
the same Bybit `category`+`symbol` acquire independent mutex slots and can both reach
`EntryPackageApplicationService.createOrder()` concurrently. `OpenPositionResolutionService` and the
`abi-position-management-api` contract already both document this as an unproven "V1 attribution
operating precondition" rather than an enforced guarantee. Before any further work on open-trade
position management (protection, close) can safely resolve "which pair owns this scope", ABI needs
this invariant to actually hold, not merely be assumed.

Target model this change establishes:

```
Runtime:  StrategyInstance          -> at most one CurrentTradeCycle           (already true, external)
ABI:      (strategy_instance_id,
           trade_cycle_id)          -> durable correlation record
                                     -> acquired physical position scope        (this change)
Bybit:    physical scope
          (account/category/symbol/
           positionIdx=0)           -> at most one ABI-owned active trade cycle (this change, V1)
```

Two different pairs may still trade two different scopes fully concurrently (`instance A / cycle
A1 -> BTCUSDT` and `instance B / cycle B1 -> ETHUSDT` at the same time is unaffected and remains
allowed). What changes is that a second pair attempting to acquire a scope another active pair
already holds (`instance A / cycle A1 -> BTCUSDT` and `instance B / cycle B1 -> BTCUSDT`
simultaneously) now fails closed before any exchange write, instead of silently racing.

This is a prerequisite/foundation change only. It does not implement shared same-symbol exposure,
virtual position accounting, or any execution behavior for protection or close — those stay exactly
as deferred today (Issue #3 for shared exposure; the existing `abi-position-management-api`
transport stub for protection/close execution).

## What Changes

- Introduce a single shared notion of **physical position scope** (`category` + `symbol`; account
  and `positionIdx = 0` are implicit V1 constants, not part of the key) and a derived
  owner-lookup over the existing entry-package correlation store — no new durable store, no new
  correlation-record fields, no schema migration.
- Add a second, scope-keyed serialization primitive (reusing the existing `KeyedMutex` class) so
  that acquisition of a scope by two different pairs is atomic, while acquisition attempts on two
  different scopes remain fully independent (no cross-scope blocking).
- Gate `EntryPackageApplicationService.createOrder()` — the single point where a pair first binds to
  a physical scope — behind an ownership check performed under the new scope lock, immediately
  before the existing durable "provisional record before any exchange call" write. A conflicting
  claim fails closed (no correlation write for the losing pair's new binding, no exchange call) and
  reuses the existing `internal_error` response; the current owner's own repeat/retry commands are
  always permitted.
- Extend correlation-store replay to rebuild scope ownership from the latest durable state of every
  pair and fail startup readiness closed if replay discovers two simultaneously active (not
  durably-closed) records claiming the same scope. Sequential historical use of a scope by pairs
  that have since durably closed is not a conflict.
- Define scope release conservatively: a scope is freed only when its owning pair's record reaches
  one of the two states ABI can already durably prove mean "no position exists and none can still
  arrive from this binding" — `absent` or `terminal_unfilled`. Every other status (`pending_create`,
  `unknown`, `create_failed`, `applied`, `pending_replace`, `pending_cancel`) keeps the scope held.
  Release after a fill has occurred (Runtime-commanded close, take-profit, stop-loss, manual
  exchange-side close, liquidation/ADL) is explicitly **not** designed here — the scope stays
  conservatively owned until a future position-termination change durably proves cycle completion
  after a fill.

Non-goals (unchanged from the existing roadmap, restated for this change specifically):
virtual position ledger / shared same-symbol exposure (Issue #3), multiple cycles sharing one
physical scope, protection execution, close execution, partial protection/close, hedge mode, any new
database or durable store beyond the existing correlation file, and any general ABI refactor.

## Capabilities

### New Capabilities

- `position-scope-exclusivity`: Defines the invariant that one physical Bybit position scope
  (account/category/symbol/`positionIdx=0`) is owned by at most one active trade cycle at a time,
  how that ownership is acquired atomically, how it is derived durably from existing correlation
  state, and the (currently conservative) conditions under which it is released.

### Modified Capabilities

None. `entry-package-execution`'s existing requirements (order identity, confirmation, pair-level
serialization, replay-gated readiness) are unchanged in their own text; this change adds a
cross-cutting precondition enforced at the same integration point (`createOrder()`) without altering
any of entry-package-execution's documented behavior for a single pair acting alone.

## Impact

- Public HTTP contract: unchanged. No new route, DTO, or public error code. A scope conflict is
  reported through the existing `internal_error` response already used for other fail-closed
  entry-package outcomes.
- Correlation store: unchanged on-disk shape. No new field on `EntryPackageExecutionRecord`, no new
  file. A new in-memory index (`byScope`) is derived from the same durable records already replayed
  today.
- Concurrency: a new scope-keyed lock is introduced alongside the existing pair-keyed
  `KeyedMutex`, always acquired in a fixed pair-lock-outer / scope-lock-inner order and held only for
  the short check-and-claim step, never across an exchange call.
- Startup readiness: correlation replay gains one new fail-closed condition (conflicting concurrent
  scope ownership across pairs); this reuses the existing `entryPackageReady` gate, no new readiness
  signal.
- Trading safety: closes the concrete gap where two trade cycles could both send a create order for
  the same physical scope concurrently. Does not change behavior for a scope that already has a
  live position from a fill — that scope remains held exactly as conservatively as today's status
  model already implies, pending a future position-termination change.
- Prerequisite relationship: this is the foundation `protection` and `close` execution (still
  transport-only stubs in `abi-position-management-api`) will depend on to trust that a pair's
  stored `exchange_category`/`exchange_symbol` is not concurrently claimed by another pair.
