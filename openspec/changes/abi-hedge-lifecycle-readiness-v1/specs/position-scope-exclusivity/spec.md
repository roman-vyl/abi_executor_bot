## ADDED Requirements

### Requirement: Structural ownership validity is distinct from activation policy
ABI SHALL reconstruct explicit hedge-long and hedge-short owners into separate directional slots
without treating their coexistence as a structural collision. A separate production activation
policy SHALL continue to reject mixed-side active state at admission and readiness throughout this
change.

#### Scenario: Structurally valid but policy-blocked mixed hedge state
- **WHEN** replay finds valid explicit hedge owners in both directional slots of one instrument
- **THEN** both slot memberships are reconstructed
- **AND** production readiness remains false with the retained unsupported-mixed-side policy reason

#### Scenario: Ordinary mixed-side admission remains blocked
- **WHEN** a production entry request asks for the opposite side of an active owner after this
  readiness change
- **THEN** ABI rejects it before a provisional durable write and before exchange I/O

### Requirement: Instrument admission serialization remains the correctness boundary
Admission SHALL continue to serialize on the parent instrument scope, not only the requested
directional slot. The serialized decision SHALL be able to inspect one-way owners and both hedge
slots before committing a claim. Pair serialization SHALL remain the outer lock and instrument
serialization the inner lock.

#### Scenario: Same-instrument opposite requests race during readiness phase
- **WHEN** two production pairs concurrently request opposite sides of one instrument
- **THEN** the instrument-level admission boundary prevents both from committing mixed-side claims

#### Scenario: Different instruments remain independent
- **WHEN** requests target different instrument scopes
- **THEN** the admission mutex does not serialize one instrument behind the other

### Requirement: Active binding geometries never alias or mix
An active one-way binding SHALL remain instrument-scoped and SHALL never alias a directional slot.
An active discriminator-less legacy binding SHALL continue to require drain. Active one-way and
active hedge bindings for the same instrument SHALL be treated as an incompatible geometry state,
not as same-side co-ownership. Binding mode SHALL remain immutable within a generation.

#### Scenario: One-way and hedge owners share a side
- **WHEN** active one-way and hedge records for the same instrument both carry desired side `long`
- **THEN** ABI rejects the geometry mixture despite their matching virtual side

#### Scenario: Inactive historical geometries coexist
- **WHEN** inactive legacy or explicit one-way history precedes a later synthetic hedge binding
- **THEN** replay preserves each record's historical provenance
- **AND** inactive history does not claim a current directional slot

### Requirement: Same-side multi-owner behavior is preserved per physical binding
Multiple active owners of the same one-way scope under current production behavior, and multiple
controlled explicit hedge owners of the same directional slot, SHALL retain independent pair
identity and lifecycle attribution. Releasing one owner SHALL not release or overwrite its siblings.

#### Scenario: Two synthetic owners share one hedge slot
- **WHEN** controlled internal state contains two active records bound to the same directional slot
- **THEN** both are reconstructed as owners of that slot
- **AND** closing one pair does not remove the other's ownership

