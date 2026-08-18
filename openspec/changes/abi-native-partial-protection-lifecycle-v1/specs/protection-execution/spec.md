## ADDED Requirements

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
that trade cycle's own stable average entry price, placed on the side of that price consistent with the
trade cycle's own direction, and SHALL NOT derive it from current market price.

#### Scenario: A disabled take reconciles to a surrogate, not a missing leg
- **WHEN** a trade cycle's desired protection state has its take disabled
- **THEN** ABI reconciles the take-profit child to a deterministic surrogate price derived from that
  trade cycle's own average entry price
- **AND** ABI does not attempt to leave the take-profit child absent, cancelled, or otherwise removed as
  a way of representing the disabled take

#### Scenario: An identical disabled-take intent does not move the surrogate
- **WHEN** ABI reconciles a trade cycle whose desired take is disabled and whose average entry price has
  not changed since a previous reconciliation
- **THEN** the computed surrogate take-profit price is identical to the previously computed one
- **AND** ABI does not amend an already-correctly-placed surrogate leg

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

### Requirement: An already-satisfied protection state requires no write
ABI SHALL report a reconciliation attempt as satisfied without sending any amend request when a freshly
resolved observation of the trade cycle's attributable protection state already matches its desired
state exactly.

#### Scenario: A matching observed state short-circuits without a write
- **WHEN** a freshly resolved observation of a trade cycle's attributable protection state already
  matches its desired state on both legs
- **THEN** ABI reports the reconciliation attempt satisfied
- **AND** ABI does not send any amend request
