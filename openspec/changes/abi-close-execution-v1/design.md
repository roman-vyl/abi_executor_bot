## Context

`serializeTradeCycleClosed`/`CloseConfirmation` already exist in `positionManagementApi.ts`, but
nothing constructs a `CloseConfirmation` today — the route always returns `internal_error`. Close is a
terminalization pipeline, not a single read-write-verify cycle like protection: it must neutralize a
still-live source of new exposure, then measure and close whatever is actually there, then commit a
terminal fact that a different pair's future scope acquisition — and this same pair's own future
entry-package requests — will rely on.

## Decision 1: Neutralize the current entry order before measuring or closing the position

Reading the live position first and closing it, then cancelling the residual entry order afterward,
leaves a window in which that order could still trigger between the two steps and reopen exposure
ABI just reported as closed. Cancelling first and confirming it non-live closes that window: nothing
can add to the position anymore, so the subsequent position read and close operate against exposure
that can only ever get smaller between the read and the close, never larger.

## Decision 2: Order-level terminal status, not observed fill quantity, determines whether the entry order is still live

Entry-package execution's existing cancel-confirmation building block answers "is anything left of
this order" by folding any observed fill — full or partial — into one `filled_before_cancel` outcome,
correct for its own caller: entry-package's null-desired-entry (CANCEL) flow deliberately refuses to
fabricate absence once any fill is observed, regardless of the order's own status. Close needs a
different, stronger fact: not "did some quantity fill," but "can no further quantity fill." For the
order type ABI creates (a triggered conditional order that executes as a market order once triggered),
the exchange's own order-status vocabulary already answers that directly and does not require treating
fill quantity as a proxy for it: a terminal status (fully filled, or cancelled/rejected/deactivated)
means no live remainder regardless of how much quantity had executed before that status was reached — a
cancelled order that had partially filled is exactly as neutralized as one that never filled at all.
Only a live status (new/untriggered/triggered, or a still-open partially-filled state) leaves a live
remainder requiring a cancel-and-recheck loop.

This means close's neutralization cannot reuse entry-package's existing cancel-confirmation outcome
as-is — that function's `filled_before_cancel` bucket conflates a still-live partially-filled order
with a terminal one that happened to fill before terminating, which is exactly the ambiguity close
cannot afford. The fix is a close-specific classification built from the same underlying order-query
and bounded-retry building blocks entry-package execution already has, reclassified by the order's own
terminal-vs-live status rather than by fill presence — not a new order-management architecture, and no
change to entry-package's own cancel-confirmation behavior, which remains correct for its own caller.

## Decision 3: The close write uses the live position's own side and size, never the recorded intent or calculated quantity

`desired_entry.side` and the stored `calculated_quantity` describe what the trade cycle originally
intended to open, not what is actually open now — partial fills, an exchange-side protection trigger,
or prior manual intervention can all make the two diverge. Runtime never supplies a quantity for this
endpoint by contract; ABI's own record of intent is exactly as untrustworthy here as a Runtime-supplied
number would be. The only trustworthy source for what to close is the live query result itself.

## Decision 4: The live position read reuses open-position-resolution's validation, not its full determination

Open-position-resolution's shared determination exists to answer "is there a position matching this
trade cycle's declared intent," and deliberately fails closed on a side mismatch — correct for
protection, which must refuse to touch a position that does not look like its own. Close's job is the
opposite: prove the pair's owned scope holds no exposure, including exposure on an unexpected side,
which is exactly the state close must still be able to shut down rather than refuse to touch. Close
therefore reuses only the lower-level, already-exhaustive response validation (envelope shape,
category, `positionIdx`, size and side field validity) and skips the side-match filter. Close also
does not need open-position-resolution's three-way status classification (durably-closed /
live-query-admissible / unresolved): once a pair's record is not already durably closed, close always
proceeds through direct entry-order and position determination regardless of which non-terminal
status the record carries, because its own neutralization-then-query pipeline is a strictly stronger
proof than that classification exists to provide.

## Decision 5: A non-durably-closed record is always expected to carry a current entry order identity

Every status other than `absent`, `terminal_unfilled`, and (with this change) `terminal_closed` is
only ever reached after a create request has already durably reserved and stored a current entry order
identity, before any exchange call for it is made. A record that reaches close's neutralization step
(i.e. is not already durably closed) with no current entry order identity therefore does not represent
"nothing to neutralize" — it represents corrupted or contradictory correlation, which
`abi-position-management-api`'s own contract already requires close to fail rather than paper over.
Treating a missing identity as a benign no-op would let such a record slip through to a position close
and a fabricated `trade_cycle_closed`.

## Decision 6: `terminal_closed` means "explicitly and provably ended by a close request," not "once had exposure" — and every other durably-closed status is promoted into it, never shortcut past it

Reusing `absent` for a trade cycle this pipeline ends would be wrong regardless of whether the trade
cycle ever held real exposure: `absent` is, by entry-package execution's own existing contract,
eligible for a brand-new entry. A `terminal_closed` status distinct from `absent` is what makes "Runtime
explicitly asked to end this trade cycle, and ABI proved it done" permanent and non-resurrectable.

The same reasoning applies to `terminal_unfilled`, not only to `absent`. Both already durably prove
this capability's postconditions (no exposure, no live order — the same durable-absence condition
`position-scope-exclusivity` and `open-position-resolution` already rely on), but neither durably
records that Runtime asked to end the trade cycle via a close request. Treating either as an idempotent
shortcut to `trade_cycle_closed` without writing `terminal_closed` leaves it resurrectable:
entry-package execution's own null-desired-entry handling already turns a `terminal_unfilled` record
into `absent` on the next cancel-intent request, and an `absent` record accepts a brand-new entry —
so `terminal_unfilled → (stale null PUT) → absent → (stale non-null PUT) → new generation` is a real
path back to life for a trade cycle ABI already told Runtime was closed, exactly the same shape of bug
as leaving `absent` unpromoted. The fix is that both `absent` and `terminal_unfilled` get the identical
durable promotion to `terminal_closed` a pair that actually went through the full pipeline gets — no
exchange call is needed to justify either, since both facts are already proven, but the write itself is
not optional for either. Only an already-`terminal_closed` record is a true no-write shortcut, because
it alone is already the permanent, non-resurrectable state this pipeline exists to produce.

One consequence for entry-package execution: a null-`desired_entry` (cancel-intent) request against an
already `terminal_closed` pair must acknowledge absence without reverting the record to `absent` or
attempting to cancel an order that no longer exists — the existing null-desired-entry path's
fallback-to-cancel branch must not be allowed to downgrade a terminal-closed record. No further change
to entry-package execution is needed beyond that: once a record is `terminal_closed`, the ADDED
requirement already in that capability's delta blocks resurrection regardless of which status this
pipeline promoted it from.

## Decision 7: The durable terminal write is the scope-release point, not a separate step

Physical scope release already happens as a side effect of durably saving a record whose status is in
the durably-closed set — no separate release step or lock exists today, and none is introduced. This
applies identically to the `absent`/`terminal_unfilled` promotion write and the full-pipeline write in
Decision 6: writing either any earlier would risk releasing the scope before both facts are proven
(moot for the already-proven promotion case, but load-bearing for the full pipeline), and writing it
any later would report success without the release a different pair's future acquisition depends on.

## Decision 8: The existing per-pair lock is reused; no new cross-pair serialization is introduced

Close mutates the correlation record's terminal status and, through that write, the scope-ownership
index — the same write path an entry-package cancel already uses. It needs the same per-pair
serialization entry-package and protection already share, so a concurrent command for the same pair
never observes partial close state. It does not need the separate scope-acquisition lock: that lock
arbitrates two different pairs racing to claim a scope neither yet owns, and release-by-the-current-
owner is not that race. Close's own execution path never blocks a different pair's close on this
pair's; this does not claim the correlation store's own single-writer append ordering (which every
durable write, for any pair, already shares) ceases to exist — that pre-existing, unrelated
serialization is out of scope for this capability to characterize or change, exactly as
`position-scope-exclusivity` already documents for its own scope-acquisition lock.

## Decision 9: Post-close verification is bounded, not timed by contract

A market close, unlike a position-level protection write, is not guaranteed to settle by the time the
order-placement call returns. Verification must retry a bounded number of times rather than trust a
single read or poll indefinitely — but the exact attempt count and delay are an implementation choice
tuned for this operation, not a public contract, and may reasonably differ from protection's own
bounded read-back.

## Decision 10: Retry and crash recovery reuse re-derivation, not new idempotency state

Close introduces no pending-close correlation status and no command ID. Every fact the pipeline needs
— is the entry order still live, is the position still open, is the record already terminal — is
either already durable or freshly re-queried on every attempt, so a repeated `DELETE` after a crash or
timeout naturally skips whatever step's fact is already established true (including either promotion
in Decision 6, since a repeat sees the record already `terminal_closed` and takes the pure shortcut)
and fails closed on whatever remains genuinely ambiguous, without needing to remember which step it
was on.

## Non-goals restated

No shared/virtual scope ownership. No partial close. No account-wide or symbol-wide cancel. No new
correlation store or field beyond the one additive status value. No change to
`abi-position-management-api`'s public contract.
