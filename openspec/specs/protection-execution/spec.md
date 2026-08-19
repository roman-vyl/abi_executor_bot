# protection-execution Specification

## Purpose
Define how ABI executes a validated `PUT .../protection` command for one Runtime-owned
`(strategy_instance_id, trade_cycle_id)` pair: confirming the pair still owns a live position before
touching Bybit, writing the new stop/take, and verifying the write by read-back before reporting
success.
## Requirements
### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`; a known pair whose record already durably proves no position exists
(the same durable-absence condition `position-scope-exclusivity` treats as releasing that pair's
own active ownership) returns `position_not_open` directly, with no ownership check — such a pair's
scope may already be actively held, in whole or in part, by someone else, so ownership must not be
checked first. Every other pair SHALL have its active ownership of the scope its own record names
independently reconfirmed against the scope's full set of active owners, via
`position-scope-exclusivity`'s existing multi-owner-aware lookup — never inferred from the record's
mere existence, and never from a single-pointer "current owner" answer that cannot represent more
than one active owner. If the requesting pair is not among that scope's active owners, ABI returns
`internal_error`. If the requesting pair is among the scope's active owners but is not its only
active owner, ABI returns `shared_scope_protection_unsupported` — this scope currently has more
than one active owner, and `PUT .../protection`'s single position-level write cannot be attributed
to just one of them. This shared-scope check runs before the live-position check below and before
any exchange call. Only when the requesting pair is confirmed to be the scope's sole active owner
does ABI proceed to the live-position check.

`position-scope-exclusivity`'s own admission requirement continues to admit at most one active
owner per scope through ABI's ordinary write paths — the shared-scope case this requirement
describes is real, tested logic, but is reachable today only via a scope whose active-owner set
was not produced by ABI's own admission path (this capability's own test fixtures use this
technique, the same way `position-scope-exclusivity`'s own replay tests do). It becomes reachable
through genuine traffic only once a later change relaxes that admission requirement.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: Durably absent pair skips the ownership check
- **WHEN** the requested pair's record durably proves no position exists
- **THEN** ABI returns `position_not_open` without checking scope ownership

#### Scenario: Confirmed sole active ownership proceeds
- **WHEN** a non-durably-absent pair is currently the scope's only active owner
- **THEN** ABI proceeds to the live-position check

#### Scenario: An ownership mismatch fails closed
- **WHEN** the scope named by a non-durably-absent pair's record has no active owner matching that
  pair at all
- **THEN** ABI returns `internal_error`

#### Scenario: A shared scope fails closed with a distinct, actionable code before any exchange call
- **WHEN** a non-durably-absent pair is confirmed to be one of a scope's active owners, but that
  scope currently has more than one active owner
- **THEN** ABI returns `shared_scope_protection_unsupported`
- **AND** ABI does not proceed to the live-position check
- **AND** ABI sends no request of any kind to the exchange for this attempt

#### Scenario: Single-owner behavior is unchanged
- **WHEN** a scope has exactly one active owner and it is the requesting pair — the only
  production-reachable state today
- **THEN** ABI's behavior from this point forward (live-position check, already-satisfied
  short-circuit, write, read-back) is identical to its behavior before this capability's ownership
  lookup was changed to a full active-set check

### Requirement: A live position must be confirmed before any write, using the existing resolution logic
ABI SHALL determine whether a live position exists for the pair's owned scope by delegating entirely
to `open-position-resolution`'s existing determination (category restriction, query validation, side
match) rather than a second implementation. Only a confirmed open position proceeds to the write;
every other outcome maps directly to the matching protection error (`position_not_open`,
`unsupported_exchange_scope`, or `internal_error`) and sends no write.

#### Scenario: A confirmed open position proceeds to the write
- **WHEN** `open-position-resolution`'s determination for the pair's owned scope is an open position
- **THEN** ABI proceeds to send the protection write

#### Scenario: Any other determination blocks the write
- **WHEN** that determination is closed, unsupported, or a query failure
- **THEN** ABI returns the matching protection error and sends no write

### Requirement: The protection write replaces both legs together
ABI SHALL send the accepted `stop_price` and `take_price` as a single write covering both legs,
scoped to the pair's own owned scope. An accepted `take_price` of `null` SHALL clear any previously
set take-profit leg rather than leaving it unchanged.

#### Scenario: A null take_price clears the take-profit leg
- **WHEN** the accepted request's `take_price` is `null`
- **THEN** the single write includes both legs, and clears any existing take-profit leg

### Requirement: Execution boundaries: no state mutation, and per-pair serialization
Applying protection SHALL NOT change which pair owns the resolved scope and SHALL NOT write any
record to the correlation store. ABI SHALL serialize a protection command against any concurrent
entry-package command (create/replace/cancel) for the same pair, so neither observes the other's
partial state; protection commands for different pairs SHALL NOT be serialized against each other.

#### Scenario: State is unchanged by a protection write
- **WHEN** ABI successfully applies protection for a pair
- **THEN** that pair's scope ownership is unchanged and no correlation record is written

#### Scenario: Same-pair commands never interleave
- **WHEN** a protection command and an entry-package command for the same pair are submitted
  concurrently
- **THEN** ABI processes them one at a time for that pair, and no different pair waits on either

### Requirement: Success requires a verified desired protection state
ABI SHALL NOT report `protection_applied` when a write was attempted but skipped by the live-execution
guard entry-package execution already enforces. Success SHALL follow one of two paths:

- **Already satisfied**: after the live-position confirmation, if the confirmed exchange stop-loss and
  take-profit are already numerically equal (exact-decimal comparison, a confirmed leg reading as
  numeric zero satisfying an accepted `take_price: null`) to the accepted request values, ABI SHALL
  NOT send a protection write, and SHALL return `protection_applied` with the accepted request's exact
  strings. This path SHALL still fail closed under the live-execution guard: if live execution is not
  currently permitted, ABI returns `internal_error` even though the desired state already matches.
- **Update required**: when at least one requested leg differs, ABI SHALL send exactly one protection
  write, then re-query the pair's owned scope over a bounded number of fresh attempts — never
  resending the write — and verify, by exact-decimal numeric comparison, that the confirmed stop-loss
  and take-profit equal the accepted request values before returning `protection_applied`.

Both paths use the same exact-decimal equality semantics; ABI SHALL NOT special-case any particular
exchange response code to convert a rejected write into success.

#### Scenario: Already-equal confirmed protection is accepted without a write
- **WHEN** the live-position confirmation's confirmed stop-loss and take-profit are already
  numerically equal to the accepted request's `stop_price`/`take_price`
- **THEN** ABI sends no protection write and returns `protection_applied` with the accepted request's
  exact strings

#### Scenario: Already-equal confirmed protection still fails closed under the live-execution guard
- **WHEN** the confirmed protection already matches but the live-execution guard reports live
  execution is not permitted
- **THEN** ABI returns `internal_error`, sends no protection write, and does not report
  `protection_applied`

#### Scenario: Verified read-back allows success
- **WHEN** the confirmed stop-loss or take-profit differs from the accepted request values, a
  protection write is sent, and a read-back attempt's confirmed values are numerically equal to the
  accepted request values
- **THEN** ABI returns `protection_applied` with the accepted request's exact strings

#### Scenario: A skipped live write fails closed
- **WHEN** at least one leg differs and the live-execution guard reports live execution is not
  permitted
- **THEN** ABI returns `internal_error` and does not report `protection_applied`

#### Scenario: Read-back exhausts its attempts without confirming
- **WHEN** every read-back attempt after a write fails to confirm the accepted values, or the
  read-back query itself fails
- **THEN** ABI does not return `protection_applied` or any other `2xx`

### Requirement: A native Partial protection reconciliation lifecycle exists, in-place only, and never runs in production
ABI SHALL provide a reconciliation lifecycle that brings a trade cycle's actually attributable native
Partial protection children into agreement with its desired protection state by amending existing
children in place, and SHALL NOT create or cancel an order to do so. ABI SHALL NOT invoke this
reconciliation lifecycle from `PUT .../protection`'s production-decision path as a result of this
capability alone.

#### Scenario: Reconciliation only ever amends existing children
- **WHEN** a trade cycle's actual attributable native Partial protection state differs from its desired
  state
- **THEN** ABI brings it into agreement only by amending the existing attributed stop and/or take child
  in place, identified by its own order identity
- **AND** ABI does not create a new order or cancel an existing one to achieve this

#### Scenario: Production protection handling is unaffected
- **WHEN** a client calls `PUT .../protection` after this capability exists
- **THEN** ABI's handling of that request is identical to what it was before this capability existed,
  including which write it performs and which guard, if any, applies for a multi-owner scope

### Requirement: A disabled take is represented as a deterministic dormant surrogate, never an absent leg
ABI SHALL represent a trade cycle's desired protection state with a take-profit leg always present, and
SHALL NOT attempt to represent "take disabled" as the absence of an attached take-profit child. When the
client's desired take is disabled, ABI SHALL compute a deterministic surrogate take-profit price from
that trade cycle's own immutable planned entry price — a reference fixed once for the life of the trade
cycle's current generation and never affected by any later partial fill — placed on the side of that
price consistent with the trade cycle's own direction, and SHALL NOT derive it from current market price.
This requirement does not assert that the resulting price is proven valid against any particular exchange
price-bound mechanism — validity is established only by the exchange's own acceptance or rejection of the
amend that carries it.

#### Scenario: A disabled take reconciles to a surrogate, not a missing leg
- **WHEN** a trade cycle's desired protection state has its take disabled
- **THEN** ABI reconciles the take-profit child to a deterministic surrogate price derived from that
  trade cycle's own immutable planned entry price
- **AND** ABI does not attempt to leave the take-profit child absent, cancelled, or otherwise removed as
  a way of representing the disabled take

#### Scenario: An identical disabled-take intent does not move the surrogate
- **WHEN** ABI reconciles a trade cycle whose desired take is disabled, including across a reconciliation
  where that trade cycle's own cumulative filled quantity has changed since a previous reconciliation
- **THEN** the computed surrogate take-profit price is identical to the previously computed one
- **AND** ABI does not amend an already-correctly-placed surrogate leg

### Requirement: Reconciliation targets a trade cycle's current own filled quantity, without waiting for its entry to finish filling
ABI SHALL resolve the quantity a reconciliation attempt targets from the trade cycle's own currently
known filled quantity, including a quantity known only from a still-live, partially filled entry order,
and SHALL NOT require that entry order to have reached a terminal fill state before reconciling
protection for the quantity already filled. ABI SHALL fail a reconciliation attempt closed, without
targeting a zero or assumed quantity, when it cannot obtain any own fill evidence at all for that trade
cycle.

#### Scenario: A live partial fill is an immediately usable protection target
- **WHEN** a trade cycle's own entry order is still live with only part of its quantity filled
- **THEN** ABI reconciles protection for that trade cycle to the quantity currently filled, without
  waiting for the entry order to reach a terminal fill state
- **AND** ABI does not cancel or otherwise modify the entry order's own live remainder as part of this
  reconciliation

#### Scenario: A later additional fill is reflected on the next reconciliation
- **WHEN** a trade cycle's own entry order receives an additional fill between two reconciliation
  attempts
- **THEN** the next reconciliation attempt targets the entry order's new, larger cumulative filled
  quantity

#### Scenario: No own fill evidence at all fails closed
- **WHEN** ABI cannot obtain any evidence that a trade cycle's own entry order has filled at all
- **THEN** ABI fails the reconciliation attempt closed
- **AND** ABI does not reconcile protection toward a zero or otherwise assumed quantity

### Requirement: Reconciliation acts only on freshly observed evidence
ABI SHALL determine a trade cycle's actual attributable native Partial protection state from a freshly
resolved observation immediately before amending it, and SHALL independently re-resolve that state after
amending, rather than trusting the amend request's own acknowledgment as proof of the resulting state.

#### Scenario: A stale observation is never amended against
- **WHEN** ABI plans a reconciliation amend
- **THEN** the write-plan is derived from an attribution observation resolved for that same
  reconciliation attempt, not from an earlier or cached one

#### Scenario: A successful amend acknowledgment alone does not confirm the outcome
- **WHEN** ABI has sent an amend request that Bybit acknowledges
- **THEN** ABI performs an independent, freshly resolved observation of the trade cycle's attributable
  state before reporting the reconciliation successful
- **AND** a successful acknowledgment alone is not treated as sufficient evidence of the resulting state

### Requirement: Reconciliation fails closed on any non-clean attribution, race, or unconfirmed result
ABI SHALL fail a reconciliation attempt closed, without amending anything further, when the trade cycle's
attributable state is not cleanly attributed before amending, when an amend request is rejected, or when
the post-amend observation does not confirm the desired state. ABI SHALL NOT guess at, partially accept,
or silently retry past any such outcome within a single reconciliation attempt.

#### Scenario: A non-attributed or ambiguous starting state fails closed
- **WHEN** ABI resolves a trade cycle's attributable protection state before planning a reconciliation and
  the result is not a clean attributed pair
- **THEN** ABI fails the reconciliation attempt closed without sending any amend request

#### Scenario: A rejected amend fails the whole attempt closed
- **WHEN** any amend request within a reconciliation attempt is rejected by Bybit
- **THEN** ABI fails that reconciliation attempt closed
- **AND** ABI does not report partial success for the legs whose amend requests were separately accepted

#### Scenario: An unconfirmed post-amend state fails closed
- **WHEN** ABI's post-amend observation does not match the desired protection state on either leg
- **THEN** ABI fails the reconciliation attempt closed
- **AND** ABI does not report the reconciliation successful

### Requirement: A terminal leg is never read as active, satisfied protection coverage
ABI SHALL NOT treat a trade cycle's attributable protection leg as active, satisfied coverage when that
leg's own order status is terminal, even when its last-known trigger price and quantity numerically match
the desired protection state. This applies both before ABI decides whether any amend is needed, and after
ABI has amended and freshly re-observed the trade cycle's attributable protection state.

#### Scenario: A terminal leg matching desired values does not short-circuit as already satisfied
- **WHEN** ABI resolves a trade cycle's attributable protection state before planning a reconciliation, and
  a leg's order status is terminal even though that leg's trigger price and quantity already numerically
  match the desired protection state
- **THEN** ABI does not report the reconciliation attempt satisfied on the strength of that terminal leg
- **AND** ABI does not create, cancel, or otherwise replace that leg to work around it

#### Scenario: A terminal leg matching desired values after amend does not count as reconciled
- **WHEN** ABI's post-amend, freshly resolved observation shows a leg whose order status is terminal, even
  though that leg's trigger price and quantity match the desired protection state
- **THEN** ABI does not report the reconciliation attempt successful
- **AND** ABI does not create, cancel, or otherwise replace that leg to work around it

### Requirement: An already-satisfied protection state requires no write
ABI SHALL report a reconciliation attempt as satisfied without sending any amend request when a freshly
resolved observation of the trade cycle's attributable protection state already matches its desired
state exactly on both legs, and neither leg's order status is terminal.

#### Scenario: A matching observed state short-circuits without a write
- **WHEN** a freshly resolved observation of a trade cycle's attributable protection state already
  matches its desired state on both legs, and neither leg's order status is terminal
- **THEN** ABI reports the reconciliation attempt satisfied
- **AND** ABI does not send any amend request

### Requirement: A trading-rules dependency failure on the disabled-take path fails the reconciliation closed, not the caller's Promise
When the client's desired take is disabled, ABI SHALL resolve instrument trading rules to compute the
surrogate take-profit price, and SHALL fail the reconciliation attempt closed — reported as a typed
outcome, not a thrown exception or a rejected Promise — when that resolution fails.

#### Scenario: A trading-rules failure resolves to a typed fail-closed outcome
- **WHEN** ABI cannot resolve instrument trading rules while reconciling a trade cycle whose desired take
  is disabled
- **THEN** ABI reports the reconciliation attempt failed closed as an ordinary typed outcome
- **AND** ABI does not throw an exception or leave the caller's request unresolved
- **AND** ABI does not resolve the trade cycle's attributable protection state or send any amend request
  for this attempt
