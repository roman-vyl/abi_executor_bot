## Purpose

Define read-only assurance that each Bybit instrument uses the physical position geometry ABI expects before a future activation can create or recover hedge-bound exposure.

## ADDED Requirements

### Requirement: Position-mode assurance receives one explicit internal geometry expectation
The read-only assurance primitive SHALL evaluate one instrument against an explicit closed internal
expectation of one-way or hedge geometry supplied by its ABI caller. This readiness change SHALL
NOT add a deployment-selectable binding policy, an enabled hedge configuration, or a
Runtime-selectable geometry field. The ordinary production lifecycle SHALL continue selecting
one-way geometry directly; the later activation change will own the deployment policy and
production wiring that can supply a hedge expectation.

#### Scenario: Runtime cannot select Hedge Mode
- **WHEN** Runtime submits an otherwise valid entry-package request
- **THEN** no request field can select one-way or hedge account geometry
- **AND** the request cannot supply or override the assurance primitive's expected geometry

#### Scenario: Readiness release adds no hedge deployment policy
- **WHEN** this change is deployed normally
- **THEN** ABI's production provisional records and entry writes continue using one-way geometry
- **AND** there is no deploy-time setting that can activate hedge geometry

#### Scenario: Controlled assurance can evaluate hedge geometry
- **WHEN** a controlled internal test invokes assurance with an explicit hedge expectation
- **THEN** the primitive can classify the instrument evidence against hedge geometry
- **AND** that invocation does not change production configuration or authorize an entry write

### Requirement: Position-mode assurance is read-only and fail closed
ABI SHALL verify expected Bybit position geometry using authenticated read-only exchange evidence.
ABI SHALL NOT call the Bybit position-mode switching operation. A transport failure, malformed
response, unproven response shape, or geometry mismatch SHALL produce an unavailable assurance
result and SHALL authorize no exchange write.

#### Scenario: Expected mode is verified
- **WHEN** read-only exchange evidence unambiguously matches the expected position geometry for an
  instrument
- **THEN** assurance succeeds for that instrument and observation

#### Scenario: Mode mismatch blocks action
- **WHEN** read-only evidence reports one-way geometry while hedge is expected, or hedge geometry
  while one-way is expected
- **THEN** assurance fails closed
- **AND** ABI sends no entry create because of that failed assurance

#### Scenario: ABI never switches position mode
- **WHEN** position-mode assurance fails
- **THEN** ABI reports or records the mismatch for operations/readiness
- **AND** ABI does not attempt to repair it by mutating account or symbol configuration

### Requirement: Hedge activation requires active-binding assurance before lifecycle readiness
Before any deployment is authorized to produce hedge-bound records, startup SHALL verify, after
correlation replay, that each active instrument's exchange geometry is compatible with its active
records before lifecycle readiness can become true. Inactive historical records SHALL NOT require
current account mode to match their historical geometry. This readiness change SHALL provide and
test that assurance path without adding the current one-way deployment's startup exchange
dependency; wiring it as a production readiness prerequisite belongs to the later activation.

#### Scenario: Restart with an active binding and matching mode
- **WHEN** an assurance-enabled future activation replays successfully and read-only assurance
  matches every active instrument binding
- **THEN** mode assurance does not prevent readiness

#### Scenario: Restart with an active binding and mismatched mode
- **WHEN** an assurance-enabled future activation reconstructs an active binding whose instrument
  mode does not match
- **THEN** lifecycle readiness remains false
- **AND** no correlation-backed lifecycle route acts on the binding

#### Scenario: Current one-way startup remains behavior-preserving
- **WHEN** this readiness change runs with its production activation gate closed
- **THEN** startup readiness retains the existing correlation-replay behavior
- **AND** the new assurance primitive does not add an exchange dependency to current one-way startup

#### Scenario: Inactive one-way history under a future hedge deployment
- **WHEN** replay contains only durably inactive one-way history for an instrument
- **THEN** that history is not reinterpreted as hedge
- **AND** it does not require the instrument's current mode to remain one-way

### Requirement: A previously unseen instrument requires fresh lazy assurance
An instrument not assured during startup SHALL require a fresh successful read-only mode check
inside its serialized admission decision before a future activation may durably claim a binding or
send an entry create. A cached success SHALL NOT authorize a different instrument.

#### Scenario: First admission for a new instrument
- **WHEN** a future hedge activation receives the first entry request for an instrument with no
  active replayed owner
- **THEN** ABI verifies that instrument's actual position geometry before its durable provisional
  claim

#### Scenario: Concurrent first admissions share one serialized decision
- **WHEN** different pairs concurrently seek first admission on the same instrument
- **THEN** their mode check, ownership classification, and durable claim are serialized by the
  instrument boundary

### Requirement: Future activation requires an operational drain and controlled mode switch
Before a future production activation selects hedge geometry, operators SHALL stop new admission,
drain every active legacy or explicit one-way binding, verify no relevant open orders or positions
remain, switch Bybit mode outside ABI, and then verify the resulting mode. After any hedge record is
durably written, rollback SHALL use only a hedge-aware build.

#### Scenario: Active one-way binding blocks future hedge activation
- **WHEN** an instrument or account still has an active one-way correlation binding
- **THEN** it is not eligible for production hedge activation

#### Scenario: Rollback after first hedge record
- **WHEN** any production hedge record has been durably written
- **THEN** rollback to a decoder or lifecycle that ignores hedge binding geometry is prohibited
