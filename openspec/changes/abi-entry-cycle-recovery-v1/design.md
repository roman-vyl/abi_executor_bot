## Context

Two independent findings converged on the same fix during design review of a Runtime-side
recovery mechanism (tracked separately as the paired Runtime change,
`runtime-pending-entry-recovery-v1`):

1. **In-place amend cannot be safely confirmed or safely recovered.** `confirmEntryPackage`
   compares only quantity (`ExpectedPackageFields = { qty: string }`) against the live
   order, because `abi-entry-package-exchange-canonical-confirmation-v1` correctly treats
   Bybit's read-back `triggerPrice`/`stopLoss`/`takeProfit` as authoritative and
   intentionally not equal to raw desired-entry text. `replaceAmend` targets the *same*
   `order_link_id` as the prior binding. Combined, this means an ambiguous amend has no
   reliable signal to distinguish "the new desired entry B is what's live" from "the old
   entry A is still live and happens to have the same quantity" — and if quantity differs,
   the found-but-mismatched order can never become `not_found`, so `shouldResendPendingAction`
   (which only resends on a clean `not_found`) never fires and the binding is stuck in
   `unknown` forever.
2. **`cancelLiveOrder` is the one exchange-mutating path without symmetric ambiguity
   handling.** Every other path (`createOrder`, the cancel step inside the now-removed
   `replaceCancelAndCreate`) durably records `status: "unknown"` in its catch block before
   returning a safe error. `cancelLiveOrder`'s catch block does not, and
   `handleNullDesiredEntry` dispatches straight into `cancelLiveOrder` without the
   preflight revalidation `repeatPutRevalidate` already performs for the non-null path.

Both findings point the same direction: stop trying to make in-place amend and atomic
replace safely recoverable, and instead make CANCEL — the one operation with an
unambiguous postcondition ("nothing live under this order identity") — the sole physical
mechanism for changing an existing entry, then fix CANCEL's own two gaps so it is safe to
serve as that sole mechanism.

The building blocks for the new recovery-read endpoint already exist and are already
durable: `EntryPackageExecutionRecord` holds `desired_entry`, `calculated_quantity`, and
`current_binding_started_at`; `confirmEntryPackage`'s history branch already has the
fill-priority classification (`hasFilledQty` checked before terminal-without-fill);
`queryPositionForInstrument` already answers the position question;
`CloseApplicationService.verifyBothPostconditions` already demonstrates the
bounded-retry, dual-query (order + position) combination this endpoint needs. Nothing here
requires a new confirmation architecture — only a new read-only composition of existing
pieces, governed by one rule none of the existing pieces individually enforce end-to-end:
a terminal outcome is reported only on positive evidence, never inferred from an empty or
unavailable query.

## Goals / Non-Goals

**Goals:**
- Make CANCEL the sole physical mechanism for changing or removing an existing entry, and
  make it safe to resend after an ambiguous outcome.
- Give a caller a bounded, read-only way to learn the ground truth of one trade cycle
  after an ambiguous mutation, without requiring ABI to resume or complete the original
  mutation.
- Never report a terminal outcome (`terminal_without_fill`/`terminal_after_fill`) except
  from positive evidence. An empty or unavailable query result is never treated as proof
  of absence — it fails safe, exactly like any other inconclusive query already does
  elsewhere in this capability.

**Non-Goals:**
- A general retry/resend framework. The only corrective action this change introduces is:
  if the recovery read finds the entry order still live while the caller's intent was
  its removal, resend CANCEL. No other command is ever resent from this path.
- Resuming an in-flight, not-yet-confirmed *new* desired entry. A trade cycle whose entry
  changed is expected to reach a fresh, independent CREATE — this change does not attempt
  to reconstruct or resume the old "B" that a caller may have had in mind.
- Changing `GET open-position` or its fail-closed behavior on an unresolved status. The
  new endpoint is additive; the normal-path lookup is untouched.
- Any wall-clock recovery horizon. This endpoint does not bound how long a recovery
  attempt may take to resolve, and does not compute or compare timestamps to decide
  whether it can still answer. Whether it can resolve depends entirely on whether the
  required evidence is currently available, not on elapsed time — which means recovery
  from a very long outage or a restart after which the relevant Bybit history is no
  longer practically retrievable is explicitly out of scope: the endpoint returns its
  safe-error response in that case, and the caller remains unresolved indefinitely rather
  than receiving a guessed answer. Automatic reconciliation targets short-lived ambiguous
  outcomes, not disaster recovery.
- Any change to first-fill webhook delivery or `apply_first_fill`-equivalent semantics.

## Decisions

### 1. Physical replace = CANCEL only; no amend, no cancel-and-create

Any PUT that specifies a non-null `desired_entry` different from the currently stored one,
for a trade cycle with a live or confirmed order, is now handled identically to an
explicit CANCEL: ABI cancels the existing order and returns `entry_package_absent`. It
does **not** create a new order in the same request. A new desired entry is only applied
by a later PUT for a trade cycle with no existing binding (an ordinary CREATE).

This is a deliberate simplification, not an optimization: it trades a brief window in
which the entry order is absent (between the CANCEL taking effect and a caller's next
CREATE decision) for eliminating the entire "which step did the ambiguity interrupt"
state machine that amend and cancel-and-create required. `replaceAmend`,
`replaceCancelAndCreate`, `amendEntryOrder` (`execution.ts`), and `bybitAdapter.amendOrder`
become dead code and are removed rather than left unused.

### 2. `cancelLiveOrder` gets the same ambiguity symmetry every other path has

Two fixes, both scoped to the CANCEL path:

- The transport-exception catch block durably records `status: "unknown"` (with
  `pending_action` left as `"cancel"`) before returning a safe error, exactly like
  `createOrder`'s catch block already does.
- Before resending `cancelEntryOrder` for a repeat null-`desired_entry` PUT against a
  binding that is not already known-absent or terminal-without-fill, ABI first queries the
  exchange for the order's current state (reusing `classifyEntryOrderTerminality`/
  `confirmEntryOrderNeutralized` from `close-execution` — read-only re-classification
  logic that already exists and is already proven for this exact question). ABI resends
  cancel only if that query confirms the order is still live; if the order is already
  terminal, ABI records the confirmed outcome without resending; if the query itself is
  inconclusive, ABI records `unknown` without resending.

### 3. Recovery-state resolution is a new composition, not a new confirmation architecture

`entry-cycle-recovery-resolution` combines two existing queries — order (realtime +
history, using `confirmEntryPackage`'s existing `FILLED_STATUSES` /
`PARTIAL_FILL_STATUSES` / `TERMINAL_WITHOUT_FILL_STATUSES` classification, with
`hasFilledQty` checked before terminal-without-fill exactly as it is today) and position
(`queryPositionForInstrument`) — with bounded retry on the same pattern
`CloseApplicationService.verifyBothPostconditions` already uses. Neither query alone ever
answers the question: `position_open` and `terminal_after_fill` both require the order
query's fill observation **and** the position query's confirmation to agree; a fill signal
by itself — including an order found `PartiallyFilled` — is never sufficient on its own to
resolve either state. A `PartiallyFilled` order (live, already carrying a fill) resolves
`position_open` only once the position query positively confirms a real position is open;
if the position query instead confirms flat while the order still has a live remainder,
that combination is contradictory (a fill was observed but no position and no terminal
order to explain it) and ABI fails safe rather than guessing which signal to trust. The
same dual-positive-confirmation requirement applies to `terminal_without_fill`: a
zero-fill terminal order finding is only resolved when the position query positively
confirms flat (no open position) — not merely when it fails to contradict the order-side
finding. A position query that fails, times out, or is otherwise inconclusive does not
satisfy this; "didn't contradict" and "positively confirmed" are different things, and
only the latter is sufficient. ABI never resolves a state by silently picking one signal
over a disagreeing (or absent) other — contradictory or incomplete evidence is itself a
fail-safe condition, exactly like an empty or unavailable query, not a case to be
tie-broken by rule.

### 4. Absence of evidence is never treated as evidence of absence — no wall-clock horizon

This capability carries no time-based gate. There is no `HORIZON_MS`, no age computed
from `current_binding_started_at`, and no `recovery_horizon_exceeded` state. In its place,
one evidentiary rule governs every classification decision: **`terminal_without_fill` and
`terminal_after_fill` are returned only when ABI has positively established that
outcome** — a definitively observed terminal-without-fill order status (`Cancelled`/
`Rejected`/`Deactivated` actually found, with zero cumulative filled quantity), or a
definitively observed fill (a `Filled`/`PartiallyFilled` status, or `cumExecQty > 0`,
actually found). A query that comes back clean-but-empty everywhere it looked — no live
order on realtime, no match in history, no open position — proves nothing about what
happened; Bybit's history could simply no longer show the record for reasons entirely
outside ABI's control. That case is classified exactly like a genuine query failure: ABI
returns its existing safe-error response (the same `500 internal_error` shape already
used for a failed or malformed query — see "A query failure or malformed response is
never treated as confirming evidence" in `entry-package-execution`), never a fabricated
`terminal_without_fill`.

Order-history queries use no special `startTime`/`endTime` window tied to a horizon —
they use the same bounded realtime-plus-history query pattern `confirmEntryPackage`
already uses elsewhere in this codebase, with no time-based narrowing introduced by this
change.

The direct, accepted consequence: if Bybit's evidence for a trade cycle has genuinely aged
out (a very long outage, a restart long after the fact), the endpoint has no way to
positively resolve it and will keep returning its safe-error response indefinitely — not
because of an elapsed-time check, but because it never receives anything it is permitted
to act on. See Non-Goals.

### 5. `unknown_trade_cycle_binding` stays a fail-closed ownership mismatch, never a `recovery_state`

A missing correlation record for the requested pair is treated exactly the way
`open-position-resolution` already treats it: an ownership/invariant mismatch, reported as
`422 unknown_trade_cycle_binding`, not as any `recovery_state`. This capability makes no
inference from that response at all — it does **not** document, imply, or provide any
basis for a caller to treat it as equivalent to `terminal_without_fill` or any other
resolved state.

This is deliberate, not an oversight: `unknown_trade_cycle_binding` means "ABI has no
record of this pair," which is a different and structurally weaker fact than "ABI has a
record and has positively established the entry never filled." A missing record could
reflect a `strategy_instance_id`/`trade_cycle_id` typo, a request against a scope ABI
never owned, or a genuinely lost binding — this endpoint has no way to distinguish those
from here, and none of them license inferring exchange absence. Treating a missing record
as recovery evidence would be exactly the kind of inference-from-silence this capability's
central rule (Decision 4) refuses to make for any other response shape; it is refused here
for the same reason, not carved out as an exception. The caller (`uncertain-exchange-
state-resolver` on the Runtime side) already treats this response as an unresolved
failure — `pending_entry_recovery` untouched, retried later — identically to every other
non-positive response.

## Risks / Trade-offs

- [Removing amend increases order churn: every desired-entry change now cancels and later
  recreates instead of mutating in place] → Accepted. The alternative — keeping amend
  recoverable — would require comparing exchange-canonical prices against raw desired-entry
  text, which is exactly the false-ambiguity problem
  `abi-entry-package-exchange-canonical-confirmation-v1` already eliminated for
  confirmation; reintroducing it here for recovery would be a regression in the opposite
  direction.
- [Between CANCEL confirming and a caller's next CREATE, the trade cycle has no live entry
  order] → Accepted as the caller's (Runtime's) trade-off, not ABI's; ABI's contract does
  not promise continuous order presence across a desired-entry change today either (an
  in-place amend could itself be rejected or fail).
- [An instance whose Bybit evidence has genuinely aged out (very long outage, late
  restart) can never be automatically resolved by this endpoint — it keeps returning its
  safe-error response indefinitely] → Accepted; this is the direct, intended consequence
  of Decision 4's evidentiary rule, not a gap. The alternative — inferring absence from
  silence past some elapsed-time threshold — is exactly the false-negative risk this
  design refuses to take. Recovering that instance is explicit operator/manual action,
  out of scope for this change.
- [`cancelLiveOrder`'s new preflight query adds one extra bounded exchange query to every
  repeat cancel-intent PUT] → Accepted; this mirrors the cost already paid by
  `repeatPutRevalidate` on the non-null path, and prevents a blind resend to an
  already-terminal order.
