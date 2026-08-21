## Why

An ambiguous entry-package CREATE can leave a fresh durable ABI binding whose exact own
identity remains absent throughout bounded order and execution observations. ABI needs a
narrow actionable observation for that case, but must not turn exchange evidence that
may have aged out of Bybit's documented retention window into proof of absence.

## What Changes

- Add `entry_order_not_found` as a fifth successful recovery-state observation only for
  an unresolved ambiguous CREATE record: `status` is `pending_create` or `unknown`,
  `pending_action` is exactly `create`, a non-empty exact `order_link_id` and valid
  `current_binding_started_at` exist, and no durable fill/terminal fact supersedes it.
- Require all three existing recovery attempts to remain cleanly absent. A positive
  order/fill finding on any later attempt supersedes earlier absence; any failed,
  malformed, mismatched, incomplete, or contradictory observation prevents the fifth
  state.
- Reuse the paginated exact-own `/v5/execution/list` primitive on every candidate attempt:
  any attributable execution prevents `entry_order_not_found`; any ambiguous execution
  read fails closed; only complete clean no-execution evidence remains eligible.
- Apply a strict freshness gate using immutable `current_binding_started_at` and validated
  Bybit server time at completion of the full observation. Eligibility requires
  `0 <= serverNow - bindingStartedAt < 7 days`, grounded in Bybit's documented default
  seven-day order/execution query window and Demo's seven-day order retention.
- Outside that trustworthy window, preserve the existing `500 internal_error` behavior;
  no clean-empty response is actionable at arbitrary age.
- Keep this outcome narrower than `terminal_without_fill`: it reports current bounded
  absence of the exact identity and authorizes no inference that the original CREATE
  never existed or never reached Bybit.
- Return the new state with no applied entry package and no fill facts, so a caller can
  explicitly neutralize the same trade cycle through the existing entry-package CANCEL
  contract (`desired_entry: null`).
- Harden the existing `desired_entry:null` path for this ambiguous-CREATE shape: before
  clean absence may become durable `EntryPackageAbsent`, repeat the same complete
  order/execution/freshness gate. If the binding has aged out, an execution query is
  ambiguous, or any evidence is inconclusive, return safe error and do not persist
  `absent`. Positive live/terminal/fill evidence continues through existing behavior.
- Preserve existing cancellation semantics for all other record shapes and all existing
  four recovery states.
- Keep recovery GET strictly read-only. It does not create, cancel, or amend an order and
  does not mutate the correlation record merely because it observed `not_found`.
- Do not resend an old CREATE, add durable fields, change correlation identity, or modify
  dry-run/mainnet safety gates. Freshness is an ABI evidence-eligibility bound, never a
  time-based terminal inference.
- Coordinate the public-contract addition with Runtime change
  `runtime-entry-order-not-found-neutralization-v1`.
- Exclude create-order exception diagnostics from this change; that observability fix is
  a separate micro-change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `entry-cycle-recovery-resolution`: expose clean exact-own-order `not_found` as a distinct
  actionable observation only for fresh ambiguous CREATE records after the full bounded
  order/execution observation.
- `abi-entry-cycle-recovery-api`: extend the closed success union with
  `entry_order_not_found` and define its null-field/read-only contract.
- `entry-package-execution`: prevent the corrective CANCEL path from turning aged-out
  clean-empty evidence for an ambiguous CREATE into durable absence.

## Impact

- Affects recovery resolution, the recovery HTTP result/codec, exact-own execution
  observation reuse, Bybit server-time validation, and the ambiguous-CREATE branch of
  entry-package CANCEL confirmation.
- Changes the Runtime-facing response union and therefore requires the coordinated
  Runtime decoder/resolver update before deployment.
- Does not change the durable correlation schema, arbitrary/applied/legacy cancellation
  behavior, order identity, position/protection logic, dry-run behavior, Demo/testnet
  write gates, or the mainnet live guard.
