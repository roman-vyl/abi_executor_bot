## Why

Runtime change `runtime-unknown-binding-fence-v1` closes a permanent
`unknown_trade_cycle_binding` by sending a CANCEL (`desired_entry: null`) for the pair.
ABI already answers such a CANCEL for an unknown pair by durably writing `absent`
(`persistAbsentNoHistory`) and returning `entry_package_absent`. But an ordinary `absent`
lets a later non-null PUT for the same pair start a new generation. If the original PUT
was only delayed in the network, it could arrive after Runtime released the cycle and
create an order for a cycle Runtime no longer tracks. That race is unacceptable.

## What Changes

- A CANCEL for a pair with no correlation record durably writes `absent` with a new
  durable flag `mutation_fenced: true` (a recovery tombstone), under the pair lock, and
  returns `entry_package_absent` as today.
- A non-null PUT for a fenced pair is refused before any exchange call and without any
  correlation write: `500 internal_error` with `failure_stage: "fenced_pair"` in the log.
- A repeated CANCEL for a fenced pair returns `entry_package_absent` again (idempotent),
  without a new write.
- Recovery-state, open-position, protection and close treat the tombstone exactly like
  any `absent` (recovery: `terminal_without_fill`).
- An ordinary `absent` (confirmed cancel, pre-exchange rejection, startup closing of an
  admission intent) is unchanged and may still start a new generation.

## Non-goals

- No new recovery-state value, no HTTP contract change, no new public error code.
- No change to CANCEL on an existing record.
- No fencing of ordinary `absent`.

## Safety, idempotency, recovery, correlation store

- The fence is written under the pair lock, so it is ordered against any PUT for the same
  pair already inside ABI: such a PUT finishes first and the CANCEL then follows existing
  semantics for the record it left.
- One optional durable field; replay treats a missing field as `false`. The field is
  never cleared once true.
- No effect on dry-run, Demo/testnet gates or the mainnet guard.

## Capabilities

### Modified Capabilities

- `entry-package-execution`: recovery tombstone for an unknown pair; fenced pairs refuse
  non-null mutation.

## Impact

`entryPackageApplicationService.ts` (`handleNullDesiredEntry`, `handleNonNullDesiredEntry`,
`persistAbsentNoHistory`), `entryPackageExecutionRecord.ts` (field, validation, replay
normalization), observability failure stage, focused tests including the mandatory
delayed-PUT acceptance test. Builds on `abi-entry-admission-durable-outcome-v1`.
