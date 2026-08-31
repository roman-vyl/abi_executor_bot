## Purpose

Define the operational and runtime gates that safely activate explicit Bybit linear Hedge Mode bindings while keeping mode switching outside ABI.

## ADDED Requirements

### Requirement: Hedge activation has a closed internal deployment policy
ABI SHALL have one internal deployment setting selecting the expected position geometry for linear instruments as `one_way` or `hedge`, defaulting to `one_way`. The setting SHALL NOT be supplied or overridden through a Runtime request. Non-linear instruments SHALL remain one-way under this change.

#### Scenario: Default deployment remains one-way
- **WHEN** the deployment setting is absent
- **THEN** ABI selects one-way geometry for new linear production bindings

#### Scenario: Hedge policy is internal
- **WHEN** Runtime submits an entry-package request
- **THEN** no public field can select or override position geometry

#### Scenario: Spot remains outside Hedge Mode activation
- **WHEN** an instrument resolves to the spot category while linear hedge policy is selected
- **THEN** ABI uses one-way geometry for that binding

### Requirement: Real-flat lifecycle evidence is a hard activation prerequisite
ABI SHALL NOT authorize the first production hedge-bound durable write until `abi-hedge-lifecycle-readiness-v1` tasks 1.1, 1.2, and 3.2 have been completed with accepted real flat Bybit Hedge Mode evidence. Synthetic tests SHALL NOT substitute for this release prerequisite.

#### Scenario: Evidence tasks remain incomplete
- **WHEN** any of predecessor tasks 1.1, 1.2, or 3.2 lacks accepted real-flat evidence
- **THEN** production activation SHALL remain disabled
- **AND** no production hedge-bound record is written

### Requirement: Startup readiness validates replayed bindings and exchange geometry
With hedge policy selected, ABI SHALL keep correlation-backed lifecycle readiness false until replay succeeds, every active binding is compatible with the configured policy, and read-only exchange assurance succeeds for every instrument having an active binding. Inactive historical records SHALL retain their stored provenance without blocking activation solely because their geometry differs.

#### Scenario: Active one-way or legacy state blocks hedge startup
- **WHEN** replay finds an active one-way binding or discriminator-less legacy record under hedge policy
- **THEN** lifecycle readiness remains false
- **AND** no correlation-backed lifecycle route acts on the state

#### Scenario: Replayed hedge bindings match exchange geometry
- **WHEN** all active records are explicit hedge bindings and assurance verifies Hedge Mode for every active instrument
- **THEN** the mode gate permits lifecycle readiness to become true

#### Scenario: Mode evidence is unavailable or mismatched
- **WHEN** assurance cannot prove Hedge Mode or proves incompatible geometry for any active instrument
- **THEN** lifecycle readiness remains false and exchange writes remain unauthorized

#### Scenario: Inactive one-way history coexists with hedge activation
- **WHEN** replay contains inactive one-way history but no active incompatible binding
- **THEN** history is not reinterpreted
- **AND** it does not by itself block hedge readiness

### Requirement: First admission on an inactive instrument is assured before durable ownership
Under hedge policy, the first admission for an instrument with no active owner SHALL perform a fresh successful read-only Hedge Mode assurance inside the instrument-serialized decision before persisting a provisional binding. A previous success from an earlier drained generation SHALL NOT authorize a later first admission.

#### Scenario: Freshly verified first hedge owner
- **WHEN** an inactive linear instrument is admitted and current evidence verifies Hedge Mode
- **THEN** ABI may durably claim the requested directional slot

#### Scenario: Lazy assurance fails closed
- **WHEN** fresh assurance is unavailable, malformed, or mismatched
- **THEN** ABI writes no provisional correlation record and sends no entry create

#### Scenario: Drained scope is checked again
- **WHEN** an instrument previously had an assured owner but all owners became inactive
- **THEN** its next first admission requires new exchange evidence

### Requirement: ABI verifies but never switches Bybit position mode
ABI SHALL use authenticated read-only exchange evidence for startup and admission assurance and SHALL NOT call a Bybit position-mode mutation operation. Operators SHALL own the external mode switch and account preparation.

#### Scenario: Mode mismatch is observed
- **WHEN** expected and observed position geometry differ
- **THEN** ABI reports a fail-closed readiness or admission outcome
- **AND** ABI does not attempt to switch or repair exchange mode

### Requirement: Activation and rollback obey a drain boundary
Before hedge policy is enabled, operators SHALL stop admission, drain all active legacy and explicit one-way bindings, verify relevant ABI-owned orders and positions are flat, switch Bybit mode outside ABI, and verify Hedge Mode. After the first durable production hedge record, rollback SHALL use a hedge-aware build; return to one-way policy SHALL require a new stop, drain, flat verification, external mode switch, and successful one-way assurance.

#### Scenario: Safe activation sequence
- **WHEN** admission is stopped, incompatible bindings are drained, relevant exchange state is verified flat, the operator switches mode, and ABI verifies Hedge Mode
- **THEN** the deployment may enable hedge admission

#### Scenario: Rollback before first hedge record
- **WHEN** no production hedge-bound record has been durably written
- **THEN** operators may restore the previous one-way deployment according to the ordinary safe rollout procedure

#### Scenario: Rollback after first hedge record
- **WHEN** at least one hedge-bound record has been durably written
- **THEN** a build that cannot replay and execute hedge bindings is prohibited
- **AND** one-way reactivation requires all hedge activity to be drained first

### Requirement: Existing execution safety guards remain authoritative
Hedge activation SHALL preserve durable-before-exchange, pair-scoped attribution, idempotent order identity, fail-closed recovery, dry-run behavior, demo/testnet live guards, and the mainnet execution block.

#### Scenario: Hedge policy does not bypass live guard
- **WHEN** hedge policy is selected but live execution is not otherwise authorized
- **THEN** ABI does not send an exchange write
