## Why

On 2026-10-19 (BTCUSDT, instance `6072511f…`, cycle `1e6fb986`) and 2026-10-21 (XRPUSDT,
instance `c70e68a6…`, cycle `63f997ee`) Strategy Runtime durably wrote
`pending_entry_recovery` before its entry-package PUT, the PUT ended in a timeout / a
245 ms `500 internal_error`, and ABI left **no** correlation record for the pair. Every
later `GET …/recovery-state` returns `422 unknown_trade_cycle_binding`, which Runtime
correctly refuses to treat as proof of absence, so both instances stayed blocked forever
(evidence: `diag-pending-recovery-20261021/REPORT.md`).

The defect is at the ABI boundary. `createOrder` resolves the instrument, calculates the
quantity, chooses the binding mode and checks scope admission **before** its first durable
write (`save(provisional)`). Any failure there returns `500` and leaves nothing durable.
The protocol therefore has a third state that must not exist: ABI received the PUT,
Runtime already committed uncertainty, and ABI holds no trace. In addition, the
`operation_failed` event carries no failure cause, so the XRP 500 is still unexplained.

## What Changes

- For a non-null PUT on a pair with no correlation record, ABI SHALL durably write an
  admission intent record (`status: admission_pending`, no order identity, no exchange
  scope) as its first action, before any step that can fail with `internal_error`.
- Every failure before the exchange-mutation boundary (the existing provisional
  `pending_create` save) SHALL durably move that record to `absent` before ABI responds.
  The HTTP response stays `500 internal_error`; the recovery-state lookup then answers
  `terminal_without_fill` from the durable `absent` status through the existing rule.
- An `admission_pending` record left by a crashed process SHALL be moved to `absent` during
  startup correlation recovery, before readiness, because no exchange call can have
  happened for it.
- While a PUT is in flight, `admission_pending` resolves like any other non-closed record
  with a null `order_link_id`: safe `500 internal_error` (retry later), never a terminal
  state.
- `admission_pending` never claims a physical position scope and is never reported as an
  open position.
- `operation_failed` for `entry_package` SHALL name the failure stage and a sanitized error
  cause, and ABI SHALL emit one `entry_admission_rejected` event when it persists the
  pre-exchange `absent`.

## Non-goals

- No Runtime change: no TTL, no counting of 422 answers, no inference of absence from
  `unknown_trade_cycle_binding`, no new Runtime pending fields.
- No new recovery-state value and no change to the recovery HTTP contract.
- No change to anything after the provisional save: exchange call, `unknown` on exchange
  exception, confirmation, CANCEL, recovery convergence, close/protection paths.
- No change to dry-run, Demo/testnet write gates or the mainnet live guard.
- Not covered: a PUT that never reached ABI's application service (lost in transit,
  rejected by HTTP decode, process killed before the intent write) and a failed intent
  write itself. These still yield 422; see design.md, Open question.
- The two currently blocked instances are released separately; this change does not
  migrate or rewrite existing records.

## Trading-safety, idempotency, recovery and correlation-store implications

- Safety rests on the existing ordering invariant: ABI never calls the exchange for a
  generation before `save(provisional)`. `absent` is written only when that save was not
  reached in this invocation, so it is ABI's own positive fact, not inferred absence.
- `absent` already does not hold scope and already resolves `terminal_without_fill`.
- A repeat PUT for the same pair after a pre-exchange `absent` follows the existing
  `absent` branch (new generation) — unchanged behavior.
- One new status value in the correlation store; replay must accept it. No other schema
  change.
- Affects demo/testnet live execution and dry-run identically; mainnet guard untouched.

## Capabilities

### Modified Capabilities

- `entry-package-execution`: durable admission intent and durable pre-exchange rejection.
- `entry-cycle-recovery-resolution`: `admission_pending` fails safe; pre-exchange `absent`
  resolves through the existing durably-closed rule.
- `abi-operational-observability`: failure stage and cause on `entry_package`
  `operation_failed`; `entry_admission_rejected` event.

## Impact

`src/services/entryPackage/entryPackageApplicationService.ts` (`createOrder`,
`applyLocked`), `src/correlation/entryPackageExecutionRecord.ts` (status union, replay
validation), `src/correlation/entryPackageCorrelationRepository.ts` (startup conversion),
open-position resolution status handling, `src/observability/events.ts`, focused tests.
