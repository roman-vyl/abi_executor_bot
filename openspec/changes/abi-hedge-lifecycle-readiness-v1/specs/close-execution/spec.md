## ADDED Requirements

### Requirement: Pair-scoped close reduces the record's stored physical binding
ABI SHALL derive a close operation's expected physical binding from the owner's correlation record.
For hedge geometry, the close order SHALL carry the position index of the original directional
slot while its exchange order side SHALL be opposite the entry side. The two concepts SHALL NOT be
derived from each other.

#### Scenario: Close a hedge long owner
- **WHEN** a hedge-long owner with positive own exposure is closed
- **THEN** the market close side is Sell
- **AND** the order targets the hedge-long physical slot

#### Scenario: Close a hedge short owner
- **WHEN** a hedge-short owner with positive own exposure is closed
- **THEN** the market close side is Buy
- **AND** the order targets the hedge-short physical slot

### Requirement: Close sanity and confirmation are target-slot specific
Before dispatch, ABI SHALL compare own attributable exposure only with the aggregate exposure of the
same physical binding. After dispatch or restart, the pair-scoped close identity SHALL be accepted
only when its order evidence reports the same binding and the exact expected filled quantity.
Opposite-slot exposure SHALL not veto or satisfy either check.

#### Scenario: Opposite slot remains open after own close
- **WHEN** the owner's close order exactly closes its own attributable quantity in the target slot
  while the opposite hedge slot remains open
- **THEN** opposite-slot exposure does not prevent the owner from reaching terminal close

#### Scenario: Close identity reports a different slot
- **WHEN** the exact close `orderLinkId` is found with a physical binding different from the owner's
  stored binding
- **THEN** ABI fails close recovery closed
- **AND** it does not resend or mark the owner terminal from that evidence

### Requirement: Close retains durable-before-exchange and sibling safety
ABI SHALL durably persist the pair-scoped close identity before sending a hedge close, SHALL reuse
that identity after ambiguity or restart, and SHALL continue neutralizing only the owner's own
entry remainder and parent-linked protection. No price, time, side-only, or aggregate-position
heuristic SHALL replace own identity.

#### Scenario: Crash after durable close identity and before response
- **WHEN** ABI restarts after recording a close identity but before persisting the exchange response
- **THEN** it resolves that same close identity and expected binding before any resend

