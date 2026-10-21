## Decisions

### D1. Tombstone = `absent` + `mutation_fenced: true`

`persistAbsentNoHistory` (only reached by a CANCEL for a pair with no record) sets
`mutation_fenced: true`. Every other write path either spreads the existing record (so the
flag survives) or creates a new pair (flag `false`). Replay normalizes a missing key to
`false`; validation accepts only booleans.

### D2. Non-null PUT on a fenced pair

At the top of `handleNonNullDesiredEntry`, before the `absent` branch: if
`record.mutation_fenced === true`, return `internal_error` with diagnostic
`fenced_pair`; no exchange call, no write. `500` keeps the public contract unchanged; the
only legitimate sender of such a PUT is a delayed request for a cycle Runtime already
released.

### D3. Ordering

All entry-package commands for a pair run under the pair mutex. Cases:
1. PUT inside ABI first → it completes (record exists) → CANCEL then uses existing record
   semantics; no tombstone is written.
2. CANCEL first → tombstone → PUT arrives later → refused by D2.
3. PUT never arrives → tombstone stays; harmless.

### D4. Recovery-state

No change: the tombstone is `absent` → `terminal_without_fill` from durable state.

## Acceptance (mandatory)

Delayed non-null PUT after CANCEL: CANCEL for unknown pair → `entry_package_absent`; then
non-null PUT for the same pair → `500`, zero exchange create calls, record still fenced
`absent`. Also with the PUT queued behind the CANCEL on the pair lock.
