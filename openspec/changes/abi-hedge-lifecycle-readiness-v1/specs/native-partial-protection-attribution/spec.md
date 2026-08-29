## ADDED Requirements

### Requirement: Exact-parent protection attribution also enforces physical binding
After filtering native protection candidates by the owner's exact parent entry identity, ABI SHALL
validate that every candidate belongs to the same expected physical binding as that entry. Binding
validation SHALL supplement, not replace, exact parent linkage, order identity, and role
classification.

#### Scenario: Clean hedge protection pair
- **WHEN** exactly one stop and one take child match the owner's parent entry and both report the
  expected directional binding
- **THEN** ABI may classify them as the owner's attributed protection pair

#### Scenario: One child reports a different slot
- **WHEN** exact parent linkage matches but either protection child reports one-way or opposite-slot
  geometry
- **THEN** ABI returns a fail-closed ambiguous attribution outcome

#### Scenario: Matching slot without matching parent is not ownership
- **WHEN** a protection child reports the expected slot but not the owner's exact parent identity
- **THEN** ABI does not attribute that child to the owner

