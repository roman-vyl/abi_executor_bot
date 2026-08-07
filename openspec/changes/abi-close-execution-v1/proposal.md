## Why

`DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`'s
public contract, DTOs, and error vocabulary already exist (`abi-position-management-api`), but the
route ends in a transport-only stub: any valid request unconditionally returns `internal_error`
without touching the exchange. Runtime can decide a trade cycle must end, but ABI cannot yet carry
that decision to a physically closed, durably terminal state.

Protection execution (`protection-execution`) and scope exclusivity (`position-scope-exclusivity`)
already give ABI the pieces close needs: proven per-pair scope ownership, a validated live-position
query, and the confirmation machinery entry-package execution uses to tell a live order from a
terminal one. What is still missing is the terminalization pipeline itself, and the one piece of
correlation state that lets ABI tell "this trade cycle was simply never entered, or was cancelled
before ever being asked to close" apart from "Runtime explicitly asked to end this trade cycle, and
ABI proved it done" — the second of which must never again accept a new entry for the same trade
cycle, regardless of whether the trade cycle ever actually held exposure.

## What Changes

- Wire `DELETE .../open-position` to real execution: neutralize the trade cycle's current entry order
  so it can no longer add exposure, read the live position directly, close whatever remainder
  actually exists, and confirm both facts are true immediately before committing a terminal record —
  never before.
- Introduce a new durable trade-cycle outcome — reached only via an explicit close request, never
  automatically — for a trade cycle Runtime has asked to end and ABI has proven ended, whether or not
  it ever actually held exposure. This is distinct from the existing "never entered" outcome, which
  stays open to a later new entry; the new outcome never is. That distinction is what stops a closed
  trade cycle from being revived by a later entry-package request for the same pair, including a pair
  whose entry was cancelled before this change and that never held any exposure at all.
- Release of the trade cycle's physical position scope happens strictly after, and only as a
  consequence of, that terminal record being durably committed — never speculatively, and never
  before both the position and the entry order are confirmed dead.
- Reuse existing infrastructure throughout: the same per-pair serialization lock entry-package and
  protection already use, the same live-query validation open-position-resolution already defines,
  the same order-confirmation building blocks entry-package execution already uses to tell a live
  order from a terminal one, and the same reduce-only market-close primitives already present but
  unused in the execution layer. No new lock, no new durable store, no command-ID or pending-state
  machinery beyond what already exists.

Non-goals: no change to the public `DELETE .../open-position` contract, DTOs, or error vocabulary —
the existing contract already fully covers this execution; no partial close (Runtime never supplies a
quantity, and none is introduced); no shared/virtual ownership of one physical scope by multiple trade
cycles; no webhook- or polling-driven detection of an externally closed position outside a close
request; no account-wide or symbol-wide cancel operation.

## Capabilities

### New Capabilities
- `close-execution`: the application/execution behavior that turns a validated `DELETE
  .../open-position` request into a proven terminal trade-cycle state.

### Modified Capabilities
- `entry-package-execution`: a trade cycle terminally closed by `close-execution` is treated the same
  as a terminal-without-fill one for the purpose of refusing to resurrect it with a new entry.
- `position-scope-exclusivity`: the durably-closed condition that releases a physical scope now also
  includes this new terminal-closed outcome, alongside the two that already exist.
- `open-position-resolution`: the durably-closed status bucket (no live query needed) now also
  includes this new terminal-closed outcome.

`abi-position-management-api` is unchanged: its existing route, DTOs, and error-code table already
fully describe this behavior's public surface.

## Impact

- Public HTTP contract: none. Same route, same response shapes, same error codes.
- Correlation store: one new, additive value for the trade cycle's existing status field; no new
  field, no new store, no schema-breaking change to any already-written record.
- Trading safety: a trade cycle is only ever reported closed after both postconditions — its current
  entry order proven unable to add exposure, and its live position proven zero — are established and
  a durable terminal record is written, even when a record already durably proved both trivially (no
  exposure ever existed); the physical scope is never freed ahead of that write, so a different pair
  can never be let onto the same scope while this one might still hold exposure, and this one can
  never be resurrected by a later entry request once the write completes.
- Dry-run / live guard: identical gating to entry-package and protection execution — a skipped write
  never produces a success acknowledgement.
