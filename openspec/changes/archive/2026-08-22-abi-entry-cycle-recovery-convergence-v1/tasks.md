## 1. Convergence policy (pure)

- [x] 1.1 Add `RecoveryConvergencePolicy`/`ConvergenceDecision` (exact names per
  implementation) in `src/services/entryCycleRecovery/`, taking the already-resolved
  outcome, the current `EntryPackageExecutionRecord`, and a caller-supplied `now` timestamp
  (for `binding_history` entries), returning `no_change` or a patch — no HTTP, no Bybit
  adapter, no mutex, no repository access, and no internal clock read (`now` is an
  argument, never read via `Date.now()`/`new Date()` inside the policy).
- [x] 1.2 Implement the `entry_order_live`/`position_open` → `applied` decision, including
  the `pending_action ∈ {null, "create"}` guard, the `order_id`-non-null guard applied
  identically to BOTH `entry_order_live` and `position_open` (not `entry_order_live`
  alone), and the `pending_action:"create" → null` clear.
- [x] 1.3 Implement the `terminal_without_fill` → `terminal_unfilled` decision, including
  the `pending_action ∈ {null, "create"}` guard and the `binding_history` append via the
  existing `closeBindingFrom(record, "exchange_terminal", now)` helper.
- [x] 1.4 Implement the `terminal_after_fill` → `terminal_closed` decision, including the
  `pending_action === null` guard, reusing `close-execution`'s existing terminal-closed
  write shape, and the `first_fill_at_ms` capture-if-missing call.
- [x] 1.5 Implement the `entry_order_not_found` → `absent` decision, reusing the existing
  successful-CANCEL `status:"absent"` write shape exactly (`order_link_id`, `order_id`,
  `pending_action` all cleared to `null`).
- [x] 1.6 Confirm durably-closed statuses and Resolution's own fail-safe path never reach
  the policy at all (structural — no code path exists for either today; add a defensive
  unit test proving it, not new gating logic).

## 2. Application-layer wiring

- [x] 2.1 Extend `EntryCycleRecoveryResolutionService`'s existing locked finalize/write
  call site(s), for every one of the five outcomes (not only `position_open`), to: acquire
  the per-pair `KeyedMutex` → re-read the record fresh under the lock → evaluate the
  convergence policy against that fresh record → apply any returned patch via the existing
  `correlationRepository.save()` call. The fresh re-read MUST happen before policy
  evaluation, not only before the write (mirrors and generalizes the existing
  `resolvePositionOpenResultLocked` pattern).
- [x] 2.1a Add the binding-continuity guard between the fresh re-read and policy evaluation:
  compare `fresh.generation`/`fresh.order_link_id` against the same two fields on the record
  the outcome was originally resolved against (the pre-lock snapshot the application layer
  already holds); on any mismatch, skip evaluation entirely and return the existing
  fail-safe `internal_error` response, leaving the fresh (new) binding completely untouched.
  Applies uniformly to all five outcomes, including `entry_order_not_found`.
- [x] 2.2 Preserve the existing HTTP response shape, with corrected crash-safety behavior:
  when the convergence decision changes `status`/`pending_action` and the durable write
  fails, return the existing fail-safe `internal_error` response — NOT the positive
  resolved outcome — leaving the record unconverged for the next attempt. The pre-existing,
  unmodified `first_fill_at_ms`-only capture (no lifecycle field changing) keeps its
  existing best-effort behavior unchanged.

## 3. Focused verification

- [x] 3.1 Live-incident regression: `status:"unknown"` + proven `position_open` converges to
  `applied` in the same write that captures `first_fill_at_ms`; a subsequent
  `GET .../open-position` for the same pair succeeds.
- [x] 3.2 Idempotency: repeated recovery while insufficient → no writes; repeated recovery
  after convergence → `no_change`.
- [x] 3.3 In-flight guards: `pending_action:"cancel"` never converges for any of
  `entry_order_live`/`position_open`/`terminal_without_fill`; legacy `pending_action` never
  reaches convergence for `entry_order_live`/`position_open` (Resolution's own existing
  refusal).
- [x] 3.4 `pending_action:"create"` mirror case: `entry_order_live`/`position_open`
  converges to `applied` with `pending_action` cleared.
- [x] 3.5 Deferred boundary: `pending_create` (`order_id: null`) + `entry_order_live` AND
  `pending_create` (`order_id: null`) + `position_open` both do NOT converge — explicit
  tests for both outcomes proving the deliberate, symmetric deferral.
- [x] 3.5a Write-failure fail-closed: for each of the five outcomes' status-changing
  convergence, a simulated `correlationRepository.save()` failure returns `internal_error`
  (never the positive outcome), and the record remains unconverged for a subsequent retry.
- [x] 3.5b Write-failure unaffected case: a simulated `first_fill_at_ms`-only capture
  failure (status already `applied`) still returns `position_open`, unchanged from today.
- [x] 3.5c Race-ordering: a `pending_action`/`order_id` change between Resolution's outer
  read and lock acquisition is honored by re-evaluating convergence against the fresh,
  under-lock record — not the outer snapshot.
- [x] 3.5d Binding-continuity guard: an outcome resolved against `generation` N /
  `order_link_id` A, where the fresh under-lock record has advanced to `generation` N+1 /
  `order_link_id` B before the lock is acquired, MUST NOT converge — `internal_error`, no
  write, fresh binding left untouched. Test at least one live-truth outcome and
  `entry_order_not_found` specifically (its own eligibility gate is evaluated against the
  pre-lock record and does not by itself prove anything about the post-lock binding).
- [x] 3.6 `terminal_without_fill` convergence's `binding_history` entry is shape-identical
  to `entry-package-execution`'s own existing `terminal_without_fill` write.
- [x] 3.7 `terminal_after_fill` convergence's write is shape-identical to
  `close-execution`'s own existing terminal-closed write.
- [x] 3.8 `entry_order_not_found` convergence's write is shape-identical to the existing
  successful-CANCEL `status:"absent"` write, and is unreachable for any record with durable
  fill/close identity (boundary confirmation of the sibling change's existing gate, not a
  new gate).
- [x] 3.9 Durably-closed statuses: prove no write of any kind occurs via this path.
- [x] 3.10 Full existing `entry-cycle-recovery-resolution` suite continues passing
  unchanged.
- [x] 3.11 Run `npm test`, `npm run typecheck`, and strict OpenSpec validation.
