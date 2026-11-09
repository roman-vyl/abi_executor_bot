## ADDED Requirements

### Requirement: Recovery lookup reports pre-admission execution unavailability
ABI SHALL return the existing closed error envelope with HTTP `503`, code `execution_not_ready`, and a safe non-empty message when a valid recovery lookup cannot be admitted because execution is not ready. No recovery_state SHALL be inferred from this response.

#### Scenario: Locked ABI cannot resolve a cycle
- **WHEN** Runtime requests recovery state before authorization or activation completes
- **THEN** ABI returns execution_not_ready without exchange requests or durable execution changes
- **AND** Runtime retains any existing uncertainty marker for its ordinary resolver
