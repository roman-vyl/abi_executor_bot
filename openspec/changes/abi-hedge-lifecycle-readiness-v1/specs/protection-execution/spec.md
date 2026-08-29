## ADDED Requirements

### Requirement: Protection execution re-verifies membership at the binding level
Before reconciling protection for an explicit hedge record, ABI SHALL verify that the pair remains
an active owner of its derived directional slot. Other owners of the same slot and owners of the
opposite slot SHALL not invalidate that membership. An active one-way/hedge geometry conflict or
malformed ownership state SHALL fail closed.

#### Scenario: Opposite hedge owner coexists in controlled lifecycle state
- **WHEN** controlled internal state contains active long-slot and short-slot hedge owners and the
  requested pair remains in its expected slot
- **THEN** the protection lifecycle evaluates only that pair and slot
- **AND** it does not reject solely because the opposite slot has an owner

#### Scenario: Pair is absent from its expected slot
- **WHEN** the record claims hedge geometry but the repository cannot reconstruct the pair in that
  directional slot
- **THEN** ABI performs no protection write

### Requirement: Protection reconciliation preserves own evidence and slot isolation
Protection desired quantity SHALL continue to come from the owner's own attributable fills, and
native children SHALL continue to be selected by exact parent linkage. Hedge support SHALL add
binding validation without using physical slot size, price, or timing as an ownership heuristic.

#### Scenario: Same-slot owners have independent protection
- **WHEN** multiple owners share one directional slot
- **THEN** reconciling one owner's protection uses only that owner's fills and parent-linked children
- **AND** sibling protection is not amended or cancelled

