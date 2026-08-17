## Purpose

Define the durable, per-trade-cycle fill-fact record ABI derives from its own entry order's
confirmed observations — sourced only from that cycle's own order, never from Bybit's aggregate
position — how it is updated, its immutability and monotonicity invariants, how a consumer decides
whether it is final, and what later capabilities (pair-scoped close, pair-scoped open-position
resolution, recovery attribution, and same-side ownership) may and may not yet build on it. This
capability changes no observable production behavior on its own; it is a prerequisite the program
tracked in `docs/virtual-exposure-ownership-delivery-plan.md` builds on.

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

### Requirement: First-observed time is immutable once recorded and is never fabricated
ABI SHALL record the timestamp of a trade cycle's first confirmed fill observation exactly once per
binding, SHALL NOT change it on any later observation of the same binding, and SHALL NOT derive it
from a pre-existing record's most-recent-observation timestamp for data written before this
capability existed.

#### Scenario: First-observed time is set once
- **WHEN** a trade cycle's entry order is confirmed to have a nonzero cumulative fill for the first
  time
- **THEN** ABI records the first-observed timestamp for that binding

#### Scenario: First-observed time survives later observations unchanged
- **WHEN** the same binding's cumulative fill is observed again at a later point (e.g. via
  repeat-PUT revalidation) and the cumulative filled quantity has increased
- **THEN** the previously recorded first-observed timestamp is carried forward unchanged
- **AND** the cumulative filled quantity and average execution price reflect the new observation

#### Scenario: Pre-existing data never gets a fabricated first-observed time
- **WHEN** ABI replays a durable record whose fill observation was written before this capability
  existed and therefore has no recorded first-observed timestamp
- **THEN** ABI treats that binding's first-observed timestamp as unknown
- **AND** ABI SHALL NOT substitute that observation's most-recent-observation timestamp, or any
  other derived value, as the first-observed timestamp

### Requirement: Cumulative filled quantity never regresses
ABI SHALL reject, both when durably writing a live update and when replaying its durable log, any
record whose cumulative filled quantity for a trade cycle's binding is less than that same binding's
previously durably recorded cumulative filled quantity.

#### Scenario: A live write with a smaller cumulative quantity is rejected
- **WHEN** ABI attempts to durably record a new fill observation for a binding whose cumulative
  filled quantity is less than the quantity already durably recorded for that same binding
- **THEN** ABI rejects the write and does not durably persist it

#### Scenario: A replayed sequence with a smaller cumulative quantity fails startup readiness closed
- **WHEN** ABI replays its durable correlation log at startup and finds, for the same trade cycle
  binding, a later record whose cumulative filled quantity is less than an earlier record's
- **THEN** ABI fails startup readiness closed with a descriptive reason
- **AND** ABI does not silently accept the smaller value

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

### Requirement: A trade cycle's side and currently-owned exposure are specified, not independently stored
ABI SHALL specify which side a trade cycle's exposure belongs to as the side of that cycle's own
desired entry, and SHALL specify a trade cycle's currently-owned exposure quantity, while its fill
facts are not yet final, as its recorded cumulative filled quantity — without introducing a second
stored field for either fact while no consumer can yet cause it to diverge from the field it is
derived from.

#### Scenario: Side is read from the cycle's own desired entry
- **WHEN** ABI or a future consumer needs the side a trade cycle's exposure belongs to
- **THEN** ABI reads it from that trade cycle's own stored desired entry side
- **AND** ABI does not maintain a separate stored field for this fact

### Requirement: This capability introduces no new durable store and no public HTTP contract change
ABI SHALL represent every fact this capability defines using only the existing entry-package
correlation record and its existing durable log, and SHALL NOT change any public HTTP route, request
schema, response schema, or error code as a result of this capability.

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
