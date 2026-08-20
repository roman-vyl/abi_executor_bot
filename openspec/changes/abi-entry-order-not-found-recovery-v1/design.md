## Context

The recovery resolver already queries one correlation record's exact `order_link_id` in
realtime and history and reduces the result to `OrderRecoverySignal`. Its internal union
already contains `not_found`, but `resolveRecoveryState()` currently maps neither
`not_found` nor `inconclusive` to a public outcome; both exhaust the bounded retry loop
and become `internal_error`. The public codec is a closed four-state union.

The entry-package CANCEL path already provides the safe write boundary needed after the
new observation: for `desired_entry:null` it revalidates the same exact identity, cancels
only if live, confirms terminal/absent state, and refuses to report absence when fill or
ambiguous evidence is found. The coordinated Runtime proposal will invoke that existing
contract explicitly.

## Goals / Non-Goals

**Goals:**

- Preserve `not_found` as a typed recovery outcome distinct from query failure and from
  terminal evidence.
- Extend the public closed union and conditional-field validation without weakening exact
  identity checks.
- Keep every recovery GET exchange-read-only and correlation-write-free for this outcome.
- Make the two existing stuck bindings naturally recoverable after coordinated rollout,
  without editing their durable records.

**Non-Goals:**

- Resending CREATE or reconstructing an expired desired entry.
- Treating elapsed time or aggregate flatness as terminal proof.
- Calling CANCEL from the recovery GET.
- Changing entry-package CANCEL semantics, correlation schema, protection, Runtime state,
  or safety gates.
- Logging `createOrder()` exceptions; that is a separate observability micro-change.

## Decisions

### 1. Promote only the existing strict `not_found` classification

`classifyOrderForRecovery()` remains the authority for the observation. It yields
`not_found` only after both the realtime exact-identity query and the history
exact-identity query decode successfully and return no matching order. `query_failed`,
malformed envelopes, identity mismatches, and unrecognized positive rows remain
`inconclusive` and continue to fail closed.

This is preferred over deriving the outcome from aggregate position state: aggregate
state can contain sibling exposure and cannot prove the fate of this exact order.

### 2. Resolve `entry_order_not_found` before aggregate position interpretation

Once the exact order signal is `not_found`, `resolveRecoveryState()` returns the new
outcome independent of the aggregate position query. The outcome says only what the two
exact-order reads observed. A position row cannot attribute a fill to this order, and it
must not turn exact absence into `position_open`; conversely it must not prevent Runtime
from invoking the revalidating neutralization contract.

The implementation may avoid the position query for this branch, or retain it for a
minimal-diff control flow, but its result has no bearing on the outcome. Tests must assert
the semantic independence rather than incidental call count unless the implementation
chooses the early return explicitly.

### 3. Keep observation and durable terminal fact separate

`entry_order_not_found` is returned with `applied_entry_package:null`,
`first_fill_at_ms:null`, and `average_entry_price:null`. The resolver does not change the
correlation record. Only the subsequent entry-package CANCEL can produce the existing
formal `EntryPackageAbsent` result and durable `absent` status after fresh revalidation.

This is preferred over mapping clean absence to `terminal_without_fill`, which would
overstate what bounded history proves and would bypass the safety value of the second
identity check at the write boundary.

### 4. Extend the existing result/HTTP union; introduce no endpoint

Add one result variant and one codec branch to the existing recovery service and GET
route. No new HTTP route, command, repository method, or exchange adapter primitive is
needed. The GET remains side-effect-free; Runtime owns whether to act on the observation.

### 5. Coordinate deployment with Runtime decoder support

An old Runtime decoder rejects the new closed-union member as a protocol error and leaves
the marker intact, which is safe but does not restore liveness. Deploy ABI and the paired
Runtime change as one coordinated rollout (Runtime-first or atomically is preferred).
Runtime-first is backward compatible because it continues to handle the existing four
states until ABI begins emitting the fifth.

## Risks / Trade-offs

- [Bounded history can age out a real prior order] → The outcome is deliberately
  non-terminal and triggers a separate CANCEL that revalidates the exact identity and
  fails closed on fill/ambiguity.
- [Order appears between GET and CANCEL] → The CANCEL path performs fresh exact-identity
  reads and cancels it if live; no decision relies on the earlier snapshot staying true.
- [A fill becomes visible between GET and CANCEL] → The CANCEL path does not return
  `EntryPackageAbsent`; Runtime retains the marker and a later recovery GET can resolve
  `position_open` when evidence is sufficient.
- [ABI deploys before Runtime] → Old Runtime treats the fifth state as protocol failure
  and leaves state unchanged; coordinated rollout avoids prolonged non-recovery.
- [Repeated observations cause repeated CANCEL attempts] → Each Runtime polling attempt
  performs at most one existing idempotent corrective CANCEL, and only exact
  `EntryPackageAbsent` clears the marker.

## Migration Plan

1. Deploy the paired Runtime decoder/resolver change.
2. Deploy this ABI change without modifying existing correlation records.
3. Observe both incident bindings resolve through
   `entry_order_not_found → corrective CANCEL → EntryPackageAbsent`.
4. Confirm each Runtime marker clears and the next genuine bar follows normal fresh
   reconciliation.

Rollback is code-only. If either side is rolled back before a marker clears, the marker
remains durable and no CREATE is resent. Already-confirmed `absent` records remain valid
under the pre-change four-state contract as `terminal_without_fill`.
