## Context

`serializeTradeCycleClosed`/`CloseConfirmation` already exist in `positionManagementApi.ts`, but
nothing constructs a `CloseConfirmation` today — the route always returns `internal_error`. Close is a
terminalization pipeline, not a single read-write-verify cycle like protection: it must neutralize a
still-live source of new exposure, then measure and close whatever is actually there, then commit a
terminal fact that a different pair's future scope acquisition will rely on.

## Decision 1: Neutralize the current entry order before measuring or closing the position

Reading the live position first and closing it, then cancelling the residual entry order afterward,
leaves a window in which that order could still trigger between the two steps and reopen exposure
ABI just reported as closed. Cancelling first and confirming it non-live closes that window: nothing
can add to the position anymore, so the subsequent position read and close operate against exposure
that can only ever get smaller (via the exchange's own protection triggering) between the read and
the close, never larger.

## Decision 2: A partial fill observed while cancelling is not by itself proof the remainder is dead

Entry-package execution's existing cancel-confirmation building block was written to answer "is
anything left of this order," and folds any observed fill — full or partial — into one
`filled_before_cancel` outcome, on the reasoning that a fill means a position now exists and cancel
was moot. Close needs a strictly stronger fact: not "did some quantity fill," but "can no further
quantity fill." A partially filled conditional order does not always leave the exchange in the same
state a fully filled one does — the unfilled remainder can still be live and order-book-resident
rather than automatically voided. Reusing the existing confirmation building block is right (no
parallel order-management model), but its termination condition for close's purposes must be
"observed status is unambiguously terminal for the order as a whole" (fully filled, or the exchange's
own terminal-with-partial-fill outcome, or cleanly cancelled), not merely "a fill was observed." Where
the exchange's own status vocabulary distinguishes a still-open partial fill from a terminal one, that
distinction — not fill-vs-no-fill — is what neutralization must key on; this is a minimal correction
to the existing classification, not a new confirmation architecture.

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

## Decision 5: A new terminal status, not the existing "absent"

`absent` currently means "this pair holds no exposure, and a later non-null entry-package request may
open a new one" — entry-package execution's own null-desired-entry handling deliberately allows that.
Reusing `absent` for a trade cycle that was deliberately, terminally closed by this pipeline would
make that same trade cycle eligible for a brand-new entry, effectively resurrecting a finished cycle
under its own identity. A distinct `terminal_closed` status preserves the existing meaning of `absent`
(never held exposure, or exposure was cancelled before ever existing) and gives "held exposure, now
provably and permanently closed" its own durable, non-resurrectable meaning — while still being
folded into the same durably-closed bucket `absent` and `terminal_unfilled` already share for scope
release and open-position resolution, since all three durably prove no live exposure.

One consequence: a null-`desired_entry` (cancel-intent) request against an already `terminal_closed`
pair must acknowledge absence without reverting the record to `absent` or attempting to cancel an
order that no longer exists — the existing null-desired-entry path's fallback-to-cancel branch must
not be allowed to downgrade a terminal-closed record.

## Decision 6: The durable terminal write is the scope-release point, not a separate step

Physical scope release already happens as a side effect of durably saving a record whose status is
in the durably-closed set — no separate release step or lock exists today, and none is introduced.
This is exactly why the terminal write must be the last thing this pipeline does after both
postconditions are confirmed: writing it any earlier would release the scope while exposure or a live
order might still exist, and writing it any later would report success without the release a
different pair's future acquisition depends on.

## Decision 7: The existing per-pair lock is reused; the scope-level lock is not

Close mutates the correlation record's terminal status and, through that write, the scope-ownership
index — the same write path an entry-package cancel already uses. It needs the same per-pair
serialization entry-package and protection already share, so a concurrent command for the same pair
never observes partial close state. It does not need the separate scope-acquisition lock: that lock
exists to arbitrate two different pairs racing to claim a scope neither yet owns, and release-by-the-
current-owner is not that race — the existing repository write path already handles it.

## Decision 8: Post-close verification is bounded, not timed by contract

A market close, unlike a position-level protection write, is not guaranteed to settle by the time the
order-placement call returns. Verification must retry a bounded number of times rather than trust a
single read or poll indefinitely — but the exact attempt count and delay are an implementation choice
tuned for this operation, not a public contract, and may reasonably differ from protection's own
bounded read-back.

## Decision 9: Retry and crash recovery reuse re-derivation, not new idempotency state

Close introduces no pending-close correlation status and no command ID. Every fact the pipeline needs
— is the entry order still live, is the position still open, is the record already terminal — is
either already durable or freshly re-queried on every attempt, so a repeated `DELETE` after a crash or
timeout naturally skips whatever step's fact is already established true and fails closed on whatever
remains genuinely ambiguous, without needing to remember which step it was on.

## Non-goals restated

No shared/virtual scope ownership. No partial close. No account-wide or symbol-wide cancel. No new
correlation store or field beyond the one additive status value. No change to
`abi-position-management-api`'s public contract.
