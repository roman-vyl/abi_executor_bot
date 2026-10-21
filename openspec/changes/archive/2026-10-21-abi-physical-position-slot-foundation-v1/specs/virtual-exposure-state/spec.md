## MODIFIED Requirements

### Requirement: A trade cycle's side is specified from its own desired entry, not independently stored
ABI SHALL specify a trade cycle's exposure side from that cycle's own desired entry without a
second stored side field. When the binding geometry is hedge, ABI SHALL also derive the cycle's
directional physical slot from that same side. The durable binding-geometry discriminator SHALL
state only whether the binding is one-way or hedge and SHALL NOT duplicate which side or slot it
uses.

#### Scenario: Side is read from the cycle's own desired entry
- **WHEN** ABI or a lifecycle consumer needs the side a trade cycle's exposure belongs to
- **THEN** ABI reads it from that trade cycle's own stored desired entry
- **AND** ABI does not maintain a separate stored side field

#### Scenario: Side and hedge slot derive from desired entry
- **WHEN** ABI needs the side and physical slot for a hedge-bound trade cycle
- **THEN** ABI reads the side from that cycle's own stored desired entry
- **AND** derives the corresponding directional slot from it

#### Scenario: One-way geometry does not fabricate a hedge slot
- **WHEN** ABI needs the physical binding for a trade cycle durably marked one-way
- **THEN** it uses the cycle's desired entry for virtual exposure side
- **AND** does not claim that the physical binding occupied a directional hedge slot

### Requirement: The correlation repository can represent multiple active records sharing one physical scope, independent of ownership policy
ABI's correlation repository SHALL represent and enumerate multiple active records sharing an
instrument scope, multiple owners sharing one directional physical slot, and distinct directional
slots under one instrument. Repository representation SHALL remain independent of production
admission policy: during this foundation, mixed-side ownership remains fail-closed even though the
records and their distinct slots are structurally distinguishable.

#### Scenario: The repository can enumerate synthetic multi-owner state without activating it
- **WHEN** multiple active records sharing an instrument scope are seeded directly for a
  repository-level test
- **THEN** the appropriate instrument and directional-slot queries enumerate them without dropping
  siblings
- **AND** this representation alone does not relax production admission policy

#### Scenario: Multiple owners share one directional slot
- **WHEN** two active hedge records for different owner pairs have the same instrument and desired
  entry side
- **THEN** a slot-scoped repository query returns both records

#### Scenario: Instrument query returns both directional sets
- **WHEN** synthetic active hedge records exist on both long and short slots of one instrument
- **THEN** an instrument-scoped repository query returns both records
- **AND** separate slot-scoped queries return only their matching owners

#### Scenario: Representation does not relax admission
- **WHEN** the repository can distinguish synthetic long and short slot owners
- **THEN** ordinary production admission still rejects creation of that mixed-side active state
  during this foundation phase
