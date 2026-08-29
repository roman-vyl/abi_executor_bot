## Why

The physical-position-slot foundation can represent one-way and directional hedge bindings, but
ABI's production lifecycle still assumes one symbol-wide `positionIdx = 0` position. Writing even
one real hedge-bound record before entry confirmation, position reads, protection, close, recovery,
and replay understand the same slot would leave ABI unable to manage or recover that exposure
safely.

## What Changes

- Make ABI's internal Bybit order and position evidence strict and binding-aware for explicit
  one-way, hedge-long, and hedge-short geometry, while keeping numeric `positionIdx` inside the
  exchange boundary.
- Prepare entry confirmation, open-position resolution, native protection, pair-scoped close,
  ambiguous-create resolution, entry-cycle recovery, and restart/replay to operate on the physical
  binding stored on a correlation record and to fail closed on any slot mismatch.
- Preserve own-order, own-fill, parent-linked protection, and pair-scoped close attribution as the
  primary ownership truth; target-slot position evidence remains only physical sanity and never
  borrows evidence from the opposite hedge slot.
- Add read-only Bybit position-mode assurance with strict mismatch behavior, startup and lazy
  verification responsibilities, and a Demo contract-evidence task for the actual flat hedge-mode
  position response shape. ABI does not switch account or symbol mode.
- Preserve legacy replay truth: inactive discriminator-less history remains historical one-way,
  active legacy state requires drain, one-way history is never reinterpreted as hedge, and binding
  mode remains immutable within a generation.
- Keep production activation closed. The ordinary provisional writer continues to persist
  `position_binding_mode = "one_way"`; production entry create continues using one-way geometry;
  mixed-side admission and mixed-side readiness remain rejected. Explicit hedge geometry is
  reachable only through controlled internal/test paths in this change.
- Preserve dry-run behavior, Demo/testnet live guards, the mainnet prohibition, risk sizing,
  pair-scoped idempotency, durable-before-exchange ordering, same-side multi-owner behavior, and
  all existing public Runtime-facing contracts.
- Defer the actual Bybit Hedge Mode cutover, first production hedge record, mixed-side activation,
  deployment mode switch, and end-to-end Hedge Mode smoke to a separate activation change.

## Capabilities

### New Capabilities

- `binding-aware-exchange-evidence`: define internal order, position, protection-child, and close
  evidence validation for one-way and directional hedge bindings without exposing `positionIdx`.
- `bybit-position-mode-assurance`: define read-only verification of the expected Bybit position
  geometry, fail-closed mismatch behavior, verification timing, and evidence requirements.

### Modified Capabilities

- `entry-package-execution`: make internal mapping, confirmation, ambiguous-create handling, and
  retry semantics capable of explicit hedge geometry while production writes remain one-way.
- `open-position-resolution`: replace the one-row `positionIdx = 0` assumption with binding-specific
  target-slot physical sanity.
- `native-partial-protection-attribution`: require attributed native children to be compatible with
  their owner's physical binding.
- `protection-execution`: use slot-aware ownership and open-position gates for explicit hedge
  records without activating mixed-side production behavior.
- `close-execution`: close and recover the same stored physical binding, keeping close side distinct
  from the slot being reduced.
- `entry-cycle-recovery-resolution`: make every recovery state and ambiguous outcome binding-aware
  and restart-safe.
- `position-scope-exclusivity`: separate structurally valid directional ownership from the retained
  production policy gates that still reject mixed-side admission and readiness.

## Impact

- Affects internal exchange payload/decoder contracts, entry-package confirmation and absence
  evidence, position-query primitives, open-position, protection, close, recovery, correlation
  replay policy, readiness composition, configuration, and focused unit/integration/restart tests.
- Depends on `abi-physical-position-slot-foundation-v1`, including `InstrumentPositionScope`,
  `DirectionalPositionSlot`, durable `position_binding_mode`, slot-aware repository queries, and
  `encodeBybitPositionIdx()`.
- Adds no public route or DTO field, no Strategy Runtime or Strategy Engine change, no risk-sizing
  change, no ownership store, no multi-account model, and no automatic Bybit mode mutation.
- Production execution remains behavior-preserving one-way after this change. No real Hedge Mode
  order or production mixed-side state is authorized by these artifacts.
