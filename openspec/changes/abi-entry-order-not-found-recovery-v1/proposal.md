## Why

An ambiguous entry-package CREATE can leave a durable ABI binding whose exact own
`orderLinkId` is cleanly absent from both bounded realtime and history reads. ABI already
classifies that observation internally as `not_found`, but collapses it into `500
internal_error`; Runtime therefore cannot initiate the existing explicit neutralization
contract and can retain `pending_entry_recovery` indefinitely.

## What Changes

- Add `entry_order_not_found` as a fifth successful recovery-state observation, returned
  only when the existing bounded exact-own-order realtime and history queries both
  complete successfully and cleanly find no matching order.
- Keep this outcome narrower than `terminal_without_fill`: it reports current bounded
  absence of the exact identity and authorizes no inference that the original CREATE
  never existed or never reached Bybit.
- Return the new state with no applied entry package and no fill facts, so a caller can
  explicitly neutralize the same trade cycle through the existing entry-package CANCEL
  contract (`desired_entry: null`).
- Preserve fail-closed behavior for malformed, failed, timed-out, contradictory, or
  otherwise inconclusive reads, and preserve all existing four-state semantics.
- Keep recovery GET strictly read-only. It does not create, cancel, or amend an order and
  does not mutate the correlation record merely because it observed `not_found`.
- Do not resend an old CREATE, introduce time-based inference, change correlation identity,
  or modify dry-run/mainnet safety gates.
- Coordinate the public-contract addition with Runtime change
  `runtime-entry-order-not-found-neutralization-v1`.
- Exclude create-order exception diagnostics from this change; that observability fix is
  a separate micro-change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `entry-cycle-recovery-resolution`: expose clean exact-own-order `not_found` as a distinct
  actionable observation while keeping it separate from terminal evidence.
- `abi-entry-cycle-recovery-api`: extend the closed success union with
  `entry_order_not_found` and define its null-field/read-only contract.

## Impact

- Affects the recovery resolution service, recovery HTTP result/codec, route-boundary
  tests, and focused resolution tests.
- Changes the Runtime-facing response union and therefore requires the coordinated
  Runtime decoder/resolver update before deployment.
- Does not change entry-package write behavior, the durable correlation schema, order
  identity, position/protection logic, dry-run behavior, Demo/testnet write gates, or the
  mainnet live guard.
