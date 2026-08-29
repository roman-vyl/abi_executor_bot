## Why

ABI currently treats one configured-account `category + symbol` as a single Bybit one-way
position with implicit `positionIdx = 0`. That model cannot distinguish the independent long and
short physical slots required for future opposite-side ownership, even though pair-scoped virtual
ownership and same-side multi-owner attribution already exist.

## What Changes

- Introduce an ABI-internal physical-position model that separates an instrument scope from its
  directional long or short position slot.
- Define the physical slot canonically from the trade cycle's existing immutable
  `desired_entry.side`; do not add a second durable side/slot truth when the slot is derivable.
- Keep Bybit's `long -> positionIdx 1` and `short -> positionIdx 2` encoding inside the exchange
  boundary. Domain and correlation APIs use directional slots, not exchange integers.
- Make correlation ownership queries, derived indexes, and replay reconstruction slot-aware while
  continuing to derive them from the existing correlation log rather than a new ownership store.
- Define safe legacy replay semantics: durably closed one-way records remain historical and need no
  slot migration; any active legacy record created against real `positionIdx = 0` blocks hedge-slot
  readiness and requires an operational drain before the foundation can be activated.
- Preserve production behavior during this foundation: ordinary admission still rejects mixed-side
  active owners for one instrument before any exchange write, and all existing entry writes and
  position lifecycle paths continue using one-way execution semantics.
- Preserve same-side multi-owner behavior, pair-scoped correlation/order/fill attribution,
  durable-before-exchange ordering, fail-closed behavior, dry-run behavior, Demo/testnet guards, and
  the mainnet live guard.
- Add no public route, DTO, Runtime, Engine, risk-sizing, or multi-cycle-per-instance change.
- Document the later sequence needed to cut over account-mode assurance, entry execution,
  open-position resolution, protection, close, recovery, and finally mixed-side admission. Those
  production cutovers are explicitly outside this change.

## Capabilities

### New Capabilities

- `physical-position-slot-model`: define ABI's internal instrument-scope and directional physical-slot
  identities, exchange-boundary encoding, derived correlation binding, and legacy durable-state
  transition rules.

### Modified Capabilities

- `position-scope-exclusivity`: make ownership reconstruction and queries slot-aware while retaining
  the current instrument-level mixed-side admission prohibition until later lifecycle cutovers.
- `virtual-exposure-state`: specify that a virtual owner's physical directional slot is derived from
  its own immutable desired-entry side without duplicating durable truth or exposing exchange slot
  details publicly.

## Impact

- Affects internal domain types around `PositionScope`, correlation repository derived indexes and
  replay validation, entry admission plumbing, and internal exchange slot mapping foundations.
- Requires focused unit/replay tests for long/short slot identity, multiple owners in one slot,
  distinct slots under one instrument, and active versus inactive legacy records.
- Requires an operational drain precondition before enabling the new foundation against an existing
  correlation log with active one-way bindings; no active `positionIdx = 0` exposure is automatically
  reinterpreted as a hedge slot.
- Does not yet change Bybit entry/open-position/protection/close/recovery production behavior or
  permit simultaneous opposite-side trading.
- Does not change ABI's public HTTP/OpenAPI contracts, Runtime, Engine, risk sizing, durable owner
  identity, or safety guards.
