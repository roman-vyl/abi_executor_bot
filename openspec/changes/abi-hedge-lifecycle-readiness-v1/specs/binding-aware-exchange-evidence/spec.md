## Purpose

Define strict ABI-internal exchange evidence for one-way and directional hedge physical bindings so every lifecycle observes and acts on the same physical position geometry.

## ADDED Requirements

### Requirement: Every bound exchange operation has one expected physical binding
ABI SHALL resolve an expected exchange binding from the correlation record before validating order,
position, protection, or close evidence. An explicit `one_way` record SHALL expect the one-way
binding. An explicit `hedge` record SHALL derive its expected long or short directional slot from
its own immutable `desired_entry.side`. ABI SHALL fail closed when an active record cannot produce
exactly one expected binding.

#### Scenario: One-way record resolves the one-way binding
- **WHEN** an active record is explicitly bound as `one_way`
- **THEN** ABI expects only Bybit one-way exchange evidence for that owner
- **AND** ABI does not derive a directional slot from the record's side

#### Scenario: Hedge record resolves its directional slot
- **WHEN** an active `hedge` record has immutable desired-entry side `long` or `short`
- **THEN** ABI derives the corresponding directional physical slot
- **AND** no second durable slot direction is required

#### Scenario: Unusable hedge binding fails closed
- **WHEN** an active `hedge` record has no usable immutable desired-entry side
- **THEN** ABI rejects lifecycle resolution for that record
- **AND** ABI does not guess its slot from exchange observations

### Requirement: Own order evidence must match the expected physical binding
ABI SHALL validate the physical binding reported by realtime and historical order evidence for an
owner's entry and close identities. Evidence from an unexpected one-way or directional slot SHALL
be treated as ambiguous or invalid and SHALL NOT confirm create, fill, cancellation, close, or
recovery success.

#### Scenario: Entry evidence matches the expected hedge slot
- **WHEN** ABI queries an explicitly hedge-bound entry order by its own `orderLinkId`
- **THEN** only an order row reporting the position index corresponding to that record's derived
  directional slot is admissible

#### Scenario: Entry evidence reports a different slot
- **WHEN** the exact entry `orderLinkId` is returned with a physical binding different from the
  record's expected binding
- **THEN** ABI fails the confirmation closed
- **AND** ABI does not update the record to match the observed slot

#### Scenario: Close evidence retains the original slot
- **WHEN** ABI validates a close order whose exchange side is opposite the entry side
- **THEN** the close evidence must still report the position index of the original physical slot
- **AND** ABI does not derive the close slot from the close order's exchange side

### Requirement: Position evidence is selected by expected binding
ABI SHALL decode a symbol-scoped Bybit position response against an explicit expected binding. A
one-way query SHALL accept only the established one-way response geometry. A hedge query SHALL
select only the expected directional slot and SHALL ignore the opposite directional slot as
evidence for the target owner. Duplicate, contradictory, malformed, or unexpected binding rows
SHALL fail closed.

#### Scenario: Opposite hedge exposure does not prove target exposure
- **WHEN** the opposite directional slot has positive exposure but the target slot does not
- **THEN** ABI does not report the target owner open from the opposite slot

#### Scenario: Opposite hedge absence does not prove target absence
- **WHEN** the opposite directional slot is flat or omitted from an otherwise admissible response
- **THEN** ABI does not use that fact to prove the target slot absent

#### Scenario: Duplicate target rows fail closed
- **WHEN** a response contains more than one row claiming the expected physical binding
- **THEN** ABI rejects the response as ambiguous

#### Scenario: Binding-incompatible response fails closed
- **WHEN** a one-way query receives directional hedge rows, or a hedge query receives a one-way row
- **THEN** ABI reports binding mismatch
- **AND** no lifecycle state is inferred from the response

### Requirement: Admissible flat hedge response shapes require contract evidence
ABI SHALL NOT assume that a flat hedge-mode symbol always returns a fixed number of rows unless
that shape has been established against Bybit Demo and locked by a contract test. The hedge
position decoder SHALL enumerate the admitted flat and live response shapes explicitly; any
unproven omission or cardinality SHALL fail closed rather than be interpreted as no position.

#### Scenario: Documented Demo shape is accepted
- **WHEN** a hedge-mode position response matches an exact shape captured by the maintained Demo
  contract evidence
- **THEN** ABI decodes the expected target slot according to that tested shape

#### Scenario: Unproven missing target row is not absence
- **WHEN** the expected directional row is missing in a response shape not admitted by the Demo
  contract evidence
- **THEN** ABI fails closed
- **AND** ABI does not report the target slot flat

### Requirement: Attributed native protection remains binding-compatible
ABI SHALL continue to attribute native protection children only through exact parent-order linkage.
For a bound owner, every attributed child SHALL also be compatible with the owner's expected
physical binding. A child from a different slot SHALL invalidate the attributed protection result.

#### Scenario: Parent matches but slot differs
- **WHEN** a protection child has the expected parent entry identity but reports a different
  physical binding
- **THEN** ABI fails protection attribution closed
- **AND** ABI does not amend or cancel that child as the owner's protection

### Requirement: Exchange slot numbers remain private to the Bybit boundary
Numeric position indexes SHALL be decoded, compared, and encoded only in ABI's Bybit-facing
boundary. Domain services SHALL consume one-way or directional binding semantics, and no existing
public request or response SHALL expose a numeric position index or binding mode.

#### Scenario: Existing public contracts remain slot-number free
- **WHEN** any Runtime-facing entry, open-position, protection, close, or recovery payload is
  serialized
- **THEN** it contains no `positionIdx`, directional-slot number, or `position_binding_mode`

