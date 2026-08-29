## ADDED Requirements

### Requirement: Valid simultaneous hedge slots are production-replayable
After hedge activation, replay SHALL treat active explicit hedge-long and hedge-short records for one instrument as distinct production-supported bindings rather than an unsupported mixed-side policy state. Replay SHALL continue to reject active one-way opposite-side ownership, active legacy records, geometry mixtures, slot corruption, and duplicate pair conflicts.

#### Scenario: Restart with both hedge slots active
- **WHEN** replay reconstructs structurally valid explicit hedge owners in both directional slots and configured-policy plus exchange-mode gates succeed
- **THEN** lifecycle readiness may become true
- **AND** each owner recovers only through its durable binding and own correlation evidence

#### Scenario: Restart finds incompatible geometry
- **WHEN** replay reconstructs active geometry that is legacy, mixed, corrupt, or incompatible with deployment policy
- **THEN** readiness remains false
- **AND** no lifecycle exchange action is authorized

#### Scenario: Restart during any prepared hedge lifecycle phase
- **WHEN** an explicit hedge-bound record restarts pending entry, live entry, partial/full fill, protected exposure, pending/ambiguous close, or terminal convergence
- **THEN** the existing slot-aware lifecycle resumes from its durable binding after readiness gates succeed
- **AND** activation does not introduce a separate recovery state machine
