## Purpose

Define the durable, per-trade-cycle fill-fact contract ABI derives from its own entry order's
confirmed observations — sourced only from that cycle's own order, never from Bybit's aggregate
position — its monotonicity invariant, how a consumer decides whether it is final, the
quantity-ownership architectural boundary the program tracked in
`docs/virtual-exposure-ownership-delivery-plan.md` is built on, and what later capabilities (pair-
scoped close, pair-scoped open-position resolution, recovery attribution, and same-side ownership)
may and may not yet build on it. This capability changes no observable production behavior on its
own; it is a prerequisite the program builds on.

## ADDED Requirements

### Requirement: A trade cycle's fill facts are sourced only from its own entry order
ABI SHALL derive a trade cycle's cumulative filled quantity, average execution price, and order
status from queries scoped to that cycle's own entry order identity, and SHALL NOT derive any of
these facts from Bybit's aggregate physical-position query.

#### Scenario: Fill facts come from the order query, not the position query
- **WHEN** ABI durably records a trade cycle's fill facts at any of its existing observation points
  (initial create confirmation, repeat-PUT revalidation, or a cancel attempt that discovers a fill)
- **THEN** the recorded cumulative filled quantity, average execution price, and order status are
  read from that cycle's own order response
- **AND** no aggregate physical-position query result is used to produce or override any of these
  values

### Requirement: Fill facts are durably recorded only at existing observation points
ABI SHALL update a trade cycle's durable fill facts only at points where it already legitimately
queries that cycle's own entry order today, and SHALL NOT introduce a background poller, scheduler,
or reconciliation process to keep them fresh.

#### Scenario: Recovery does not write fill facts
- **WHEN** ABI resolves a trade cycle's recovery state by querying that cycle's own order
- **THEN** ABI does not durably update that cycle's fill facts as a result of the recovery query
- **AND** recovery remains read-only with respect to durable correlation state, unchanged from its
  existing behavior

### Requirement: Cumulative filled quantity never regresses
ABI SHALL reject, both when durably writing a live update and when replaying its durable log, any
record whose cumulative filled quantity for a trade cycle's binding is less than that same binding's
previously durably recorded cumulative filled quantity. ABI SHALL NOT require the average execution
price recorded alongside it to move in any particular direction.

#### Scenario: A live write with a smaller cumulative quantity is rejected
- **WHEN** ABI attempts to durably record a new fill observation for a binding whose cumulative
  filled quantity is less than the quantity already durably recorded for that same binding
- **THEN** ABI rejects the write and does not durably persist it

#### Scenario: A replayed sequence with a smaller cumulative quantity fails startup readiness closed
- **WHEN** ABI replays its durable correlation log at startup and finds, for the same trade cycle
  binding, a later record whose cumulative filled quantity is less than an earlier record's
- **THEN** ABI fails startup readiness closed with a descriptive reason
- **AND** ABI does not silently accept the smaller value

#### Scenario: A changed average execution price alongside a valid quantity update is not rejected
- **WHEN** ABI durably records a new fill observation whose cumulative filled quantity is greater
  than or equal to the previously recorded value, and whose average execution price differs from the
  previous observation in either direction
- **THEN** ABI accepts the write

### Requirement: A trade cycle's fill-fact finality is derived from its durably recorded order status
ABI SHALL determine whether a trade cycle's recorded fill facts are final (its own entry order can no
longer add exposure) from that binding's durably recorded order status, and SHALL NOT introduce a
separate durable finality flag that duplicates the same fact.

#### Scenario: A terminal recorded order status makes fill facts final and trustworthy without re-querying
- **WHEN** a trade cycle binding's durably recorded order status is one ABI already classifies as
  terminal (fully filled, or terminal without a live remainder)
- **THEN** ABI treats that binding's recorded cumulative filled quantity and average execution price
  as final
- **AND** a consumer of those facts is not required to re-query the exchange before trusting them

#### Scenario: A live recorded order status means fill facts are a snapshot, not final
- **WHEN** a trade cycle binding's durably recorded order status is one ABI already classifies as
  live (including a still-open partially-filled state)
- **THEN** ABI does not treat that binding's recorded cumulative filled quantity or average execution
  price as final
- **AND** a consumer requiring an authoritative current value must re-verify the binding's order
  status before treating the recorded quantity as settled

### Requirement: A trade cycle's side is specified from its own desired entry, not independently stored
ABI SHALL specify which side a trade cycle's exposure belongs to as the side of that cycle's own
desired entry, without introducing a second stored field for this fact.

#### Scenario: Side is read from the cycle's own desired entry
- **WHEN** ABI or a future consumer needs the side a trade cycle's exposure belongs to
- **THEN** ABI reads it from that trade cycle's own stored desired entry side
- **AND** ABI does not maintain a separate stored field for this fact

### Requirement: Per-cycle absolute exposure quantity is ABI-private state; management intent is relative
ABI SHALL treat a trade cycle's absolute exposure quantity as state private to ABI's own per-cycle
fill facts, and SHALL NOT require Runtime to determine, hold, or supply an absolute exchange
quantity when expressing a future position-management intent for a trade cycle.

#### Scenario: A cycle's currently-owned exposure is resolved by ABI, not supplied by Runtime
- **WHEN** ABI needs to determine how much of a trade cycle's exposure it currently owns
- **THEN** ABI resolves that quantity from its own recorded cumulative filled quantity for that
  cycle's own entry order, once that binding's fill facts are final
- **AND** ABI does not require this value to have been supplied by Runtime

### Requirement: This capability introduces no new durable store and no public HTTP contract change
ABI SHALL represent every fact this capability defines using only the existing entry-package
correlation record and its existing durable log, and SHALL NOT change any public HTTP route, request
schema, response schema, or error code as a result of this capability. ABI SHALL NOT push fill data to
Runtime, and SHALL NOT change Runtime or MDS, as a result of this capability.

#### Scenario: No new durable store
- **WHEN** ABI needs to reconstruct a trade cycle's fill facts after a restart
- **THEN** ABI reconstructs them entirely from replaying the existing entry-package correlation log
- **AND** no additional file, database, or store is read

#### Scenario: No public contract change
- **WHEN** a client calls any existing ABI HTTP endpoint after this capability is implemented
- **THEN** the request and response shapes, and the set of possible error codes, are identical to
  before this capability existed

### Requirement: The correlation repository can represent multiple active records sharing one physical scope, independent of ownership policy
ABI's correlation repository SHALL be able to represent and enumerate more than one active, non-
durably-closed record sharing the same physical position scope, and this capability SHALL NOT itself
change whether `EntryPackageApplicationService` permits more than one trade cycle to actually hold a
given physical scope at a time.

#### Scenario: The repository can enumerate synthetic multi-owner state without activating it
- **WHEN** two active, non-durably-closed records for two different trade cycles, both resolving to
  the same physical scope, exist in the correlation repository (for example, seeded directly for a
  repository-level test)
- **THEN** a repository query over that scope returns both records
- **AND** this capability does not change the existing behavior that prevents
  `EntryPackageApplicationService` from creating such a state through its own normal operation
