## ADDED Requirements

### Requirement: Recovery resolves all physical evidence against the durable binding
Entry-cycle recovery SHALL derive one expected physical binding from the record and use it for entry
order, target-position, protection, and close evidence. Own order and execution evidence SHALL
remain authoritative for virtual attribution. Opposite-slot rows and orders SHALL not be borrowed
as evidence for the target owner.

#### Scenario: Accepted create response was lost
- **WHEN** a hedge create may have been accepted but ABI lost the response
- **THEN** recovery queries the exact entry identity and requires the expected slot before
  converging the record

#### Scenario: Target slot is flat while opposite slot is open
- **WHEN** recovery evaluates a target owner whose expected slot is flat and whose opposite slot is
  open
- **THEN** the opposite exposure is not attributed to the target owner

### Requirement: Hedge lifecycle restart phases are recoverable without slot mixing
Controlled restart tests SHALL cover pending create before exchange call, accepted create with lost
response, live unfilled entry, partial fill, full fill, protected open exposure, pending or
ambiguous close, and terminal close for explicit hedge bindings. Each phase SHALL either converge
from own evidence plus target-slot sanity or fail closed without acting on the opposite slot.

#### Scenario: Restart after partial or full fill
- **WHEN** own entry evidence proves a hedge-bound partial or full fill after restart
- **THEN** recovery requires compatible target-slot physical evidence before reporting position open

#### Scenario: Restart with pending or ambiguous close
- **WHEN** a pair-scoped close identity is durable but its outcome is unresolved at restart
- **THEN** recovery checks that exact close order, expected slot, and own expected quantity
- **AND** it does not infer closure from the opposite slot

#### Scenario: Restart after terminal close
- **WHEN** the pair is durably terminal-closed
- **THEN** recovery returns the terminal outcome without reconstructing active slot ownership

### Requirement: Simultaneous synthetic hedge slots survive structural replay
The internal replay model SHALL be capable of reconstructing simultaneous synthetic long-slot and
short-slot hedge records as distinct structurally valid bindings. During this readiness change, the
separate production policy gate SHALL still prevent such state from making lifecycle readiness
true.

#### Scenario: Synthetic long and short replay
- **WHEN** controlled test state contains valid active hedge-long and hedge-short records for one
  instrument
- **THEN** replay reconstructs both directional memberships without a slot collision
- **AND** the retained activation gate reports the mixed-side state unsupported for production

