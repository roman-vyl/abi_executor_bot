## Purpose

Define ABI's internal distinction between an exchange instrument scope and a directional physical
position slot, including safe durable binding and legacy replay rules needed before a later Hedge
Mode execution cutover.

## ADDED Requirements

### Requirement: Instrument scope and directional physical slot are distinct identities
ABI SHALL model the configured account plus exchange `category` and `symbol` as an instrument
scope. For a hedge-capable linear instrument, ABI SHALL model a long physical slot and a short
physical slot as two distinct children of that same instrument scope. A one-way binding SHALL remain
an instrument-scoped binding and SHALL NOT be represented as either directional slot.

#### Scenario: Long and short slots differ under one instrument
- **WHEN** ABI constructs the directional physical slots for long and short exposure under the same
  configured account, category, and symbol
- **THEN** the two slot identities are distinct
- **AND** both retain the same parent instrument scope

#### Scenario: One-way binding is not a directional slot
- **WHEN** ABI reconstructs a binding known to have executed in one-way mode
- **THEN** ABI associates it with the instrument scope
- **AND** ABI does not claim that the binding occupied either the long or short hedge slot

### Requirement: A hedge binding's directional slot is derived from its own immutable side
For a binding known to use directional hedge geometry, ABI SHALL derive the long or short physical
slot from that trade cycle's own non-null stored `desired_entry.side`. ABI SHALL NOT persist a
second long/short slot value that can disagree with the desired-entry side.

#### Scenario: Long desired entry derives the long slot
- **WHEN** a hedge binding's stored desired-entry side is `long`
- **THEN** ABI derives the long physical slot for that binding

#### Scenario: Short desired entry derives the short slot
- **WHEN** a hedge binding's stored desired-entry side is `short`
- **THEN** ABI derives the short physical slot for that binding

#### Scenario: Missing side cannot produce a directional slot
- **WHEN** an active hedge binding has no usable stored desired-entry side
- **THEN** ABI fails closed during reconstruction
- **AND** ABI does not guess a slot from order side, position rows, or other exchange observations

### Requirement: Exchange slot numbers remain inside the Bybit boundary
ABI's domain and durable ownership model SHALL use directional long/short slot semantics and SHALL
NOT use `positionIdx` as a public or business identity. The Bybit boundary SHALL provide the sole
canonical encoding in which long maps to `positionIdx = 1` and short maps to `positionIdx = 2`.
`positionIdx = 0` SHALL represent one-way execution only and SHALL NOT alias either directional
slot.

#### Scenario: Directional slots encode at the exchange boundary
- **WHEN** the Bybit boundary encodes the long and short directional slots
- **THEN** long encodes as `positionIdx = 1`
- **AND** short encodes as `positionIdx = 2`

#### Scenario: Public contracts expose no exchange slot number
- **WHEN** any existing Runtime-facing ABI request or response is serialized
- **THEN** it contains no `positionIdx` or equivalent exchange slot-number field
- **AND** its owner identity remains `(strategy_instance_id, trade_cycle_id)`

### Requirement: Durable binding geometry distinguishes one-way history from hedge history
Every correlation record newly written after this foundation SHALL carry an ABI-internal durable
binding-geometry discriminator identifying whether its exchange binding is `one_way` or `hedge`.
The discriminator SHALL describe actual execution geometry and SHALL NOT duplicate desired-entry
side. A `hedge` record's directional slot SHALL remain derived from its side.

#### Scenario: Current production write remains explicitly one-way
- **WHEN** the behavior-preserving foundation writes a record through the existing one-way entry
  execution path
- **THEN** the record is durably marked `one_way`
- **AND** no hedge execution or directional-slot claim is implied

#### Scenario: Future hedge record is slot-derivable without a stored slot
- **WHEN** a later authorized execution path writes a record durably marked `hedge` with side
  `short`
- **THEN** replay derives its physical slot as short
- **AND** no separate stored short-slot field is required

### Requirement: Legacy records use fail-closed transition semantics
A correlation record lacking the binding-geometry discriminator SHALL be classified as a legacy
one-way record because all such records were created against real `positionIdx = 0`. A durably
closed legacy record SHALL remain valid historical state and SHALL require no rewrite. An active
legacy record SHALL prevent startup readiness for this foundation rather than being automatically
reinterpreted, rewritten, or assigned to a directional hedge slot.

#### Scenario: Inactive legacy record replays without migration
- **WHEN** replay encounters a discriminator-less legacy record whose latest status is durably
  closed
- **THEN** replay preserves it as historical one-way state
- **AND** no correlation-log rewrite is required

#### Scenario: Active legacy record blocks readiness
- **WHEN** replay encounters a discriminator-less legacy record whose latest status is not durably
  closed
- **THEN** ABI fails startup readiness with a legacy-active-state diagnostic
- **AND** it does not assign that record to slot 1 or slot 2

#### Scenario: Explicit one-way record remains replayable after foundation deployment
- **WHEN** replay encounters an active record explicitly marked `one_way`
- **THEN** ABI reconstructs it as active instrument-scoped one-way ownership
- **AND** ordinary one-way operation can resume without treating the record as legacy ambiguity

### Requirement: The foundation does not activate opposite-side production behavior
This capability SHALL permit ABI to represent and query directional physical slots internally, but
ordinary entry admission SHALL continue to reject active long and short owners on the same
instrument before exchange write. Existing open-position, protection, close, and recovery flows
SHALL continue to use their one-way production semantics until separate lifecycle cutovers replace
them.

#### Scenario: Opposite-side request remains rejected
- **WHEN** one active owner is long on an instrument and a different pair requests a short entry on
  that instrument after this foundation is implemented
- **THEN** ABI rejects the request before any correlation or exchange write for the requester

#### Scenario: Foundation mapping is not used by production entry dispatch
- **WHEN** an ordinary entry executes during this foundation phase
- **THEN** it follows the existing one-way exchange path
- **AND** the existence of the directional-slot encoder alone does not enable Hedge Mode execution
