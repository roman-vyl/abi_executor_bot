## ADDED Requirements

### Requirement: New production bindings use the selected instrument geometry
For a newly admitted production entry, ABI SHALL select one-way geometry for spot and the configured deployment geometry for linear instruments, persist that selection in the provisional correlation record before exchange I/O, and use the persisted binding for create and confirmation. A retry or restart SHALL reuse the durable binding rather than current configuration.

#### Scenario: New linear hedge binding
- **WHEN** linear hedge policy is active, assurance succeeds, and a new entry is admitted
- **THEN** the provisional record durably stores `position_binding_mode = "hedge"`
- **AND** entry create and confirmation target the directional slot derived from the record's immutable desired side

#### Scenario: Durable binding survives configuration change
- **WHEN** a hedge-bound generation is retried or recovered after deployment configuration changes
- **THEN** ABI uses that generation's durable hedge binding
- **AND** it does not remap the generation as one-way

#### Scenario: Position index remains internal
- **WHEN** a hedge entry is mapped to Bybit
- **THEN** the exchange adapter derives the directional `positionIdx` internally
- **AND** no public ABI request or response gains a position-index field

### Requirement: No hedge provisional write precedes assurance
ABI SHALL complete binding compatibility checks and required position-mode assurance inside serialized admission before durably persisting a new hedge provisional record. Failure before that write SHALL leave no claimed owner and SHALL authorize no exchange create.

#### Scenario: Assurance mismatch before provisional write
- **WHEN** a candidate hedge entry cannot prove compatible exchange geometry
- **THEN** no provisional hedge record is appended
- **AND** no create order is submitted
