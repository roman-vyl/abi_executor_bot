## ADDED Requirements

### Requirement: Physical sanity for open-position resolution follows the stored binding
For a live-query-admissible record with positive own fill evidence, ABI SHALL query and validate the
physical position binding stored on that record. One-way records SHALL retain one-way semantics;
explicit hedge records SHALL consult only their derived directional slot. Own entry-order fill
facts SHALL remain the source of owner-attributed quantity, average entry price, and first-fill
time.

#### Scenario: Hedge owner has own fills and target-slot exposure
- **WHEN** an explicit hedge record has positive own attributable fill evidence and its expected
  directional slot reports compatible exposure
- **THEN** ABI may resolve that owner's position as open using its own fill facts

#### Scenario: Only opposite slot has exposure
- **WHEN** an explicit hedge record has positive own fill evidence but only the opposite slot
  reports exposure
- **THEN** ABI fails closed on the contradiction
- **AND** it does not report the owner open from the opposite slot

#### Scenario: One-way behavior is preserved
- **WHEN** an explicit one-way record is resolved
- **THEN** ABI applies the existing strict one-way position geometry and own-fill attribution rules

### Requirement: Target-slot protection fields never come from the opposite slot
When open-position determination supplies confirmed stop-loss or take-profit values to protection
handling, those fields SHALL come only from the validated row for the record's expected physical
binding.

#### Scenario: Long and short slots report different protection values
- **WHEN** the target hedge slot and opposite slot report different stop-loss or take-profit values
- **THEN** ABI returns only the values from the target slot to the owning lifecycle

