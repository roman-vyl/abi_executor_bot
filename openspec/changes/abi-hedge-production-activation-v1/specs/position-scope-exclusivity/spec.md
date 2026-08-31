## ADDED Requirements

### Requirement: Production admission is binding-aware under hedge policy
ABI SHALL classify all active owners of an instrument by binding geometry and directional slot before admitting a new owner. Under hedge policy, explicit hedge-long and hedge-short owners MAY coexist, including multiple independent owners in either same directional slot. ABI SHALL reject active legacy state, one-way/hedge mixtures, corrupt bindings, and any binding incompatible with deployment policy.

#### Scenario: Opposite hedge slot is admitted
- **WHEN** one explicit hedge-long owner is active and an independent strategy instance requests a hedge-short binding for the same instrument
- **THEN** ABI admits the short owner into the distinct directional slot after all other gates succeed

#### Scenario: Same-slot multi-owner is preserved
- **WHEN** multiple independent pairs request the same directional hedge slot
- **THEN** each pair retains independent ownership and lifecycle attribution

#### Scenario: Geometry mixture is rejected
- **WHEN** active state contains one-way, legacy, or incompatible binding geometry under hedge policy
- **THEN** ABI rejects the new claim before durable write and exchange I/O

#### Scenario: One-way policy retains same-side restriction
- **WHEN** one-way policy is active and an opposite-side owner already exists for an instrument
- **THEN** ABI rejects mixed-side admission as before

### Requirement: Instrument serialization covers assurance classification and claim
Pair serialization SHALL remain the outer boundary and instrument serialization the inner boundary. For an admission that can create a new physical owner, the instrument boundary SHALL cover active-owner lookup, geometry classification, any required fresh mode assurance, and the durable provisional claim; exchange create SHALL occur only after the instrument boundary releases.

#### Scenario: Concurrent opposite first owners
- **WHEN** long and short requests concurrently seek the first hedge claims on one inactive instrument
- **THEN** one instrument-serialized decision durably claims before the other reclassifies the updated owners
- **AND** both may ultimately occupy separate slots only through individually valid decisions

#### Scenario: Different instruments do not block each other
- **WHEN** admissions target different instrument scopes
- **THEN** their instrument admission decisions can proceed independently
