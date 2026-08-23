## MODIFIED Requirements

### Requirement: ABI applies a new desired entry package by creating a real exchange order
When a valid entry-package command specifies a non-null desired entry and no order currently exists
for that trade cycle, ABI SHALL submit a real create order to the exchange using the one canonical
entry mapper. Every such live order SHALL carry attached stop-loss and take-profit values under
Bybit native `tpslMode="Partial"`, regardless of whether the scope currently has zero, one, or more
same-side active cycles. ABI SHALL NOT select `Full` mode, a legacy mapper, or a different payload
according to owner count. ABI SHALL bounded-confirm the create and acknowledge
`entry_package_applied` only after confirmation succeeds.

#### Scenario: First owner creates native Partial protection
- **WHEN** a PUT request specifies a non-null `desired_entry` for a trade cycle with no existing
  correlation record and no active owner on the resolved scope
- **THEN** ABI submits the create through the canonical mapper with `tpslMode="Partial"` and both
  attached protection prices
- **AND** ABI returns `entry_package_applied` only after bounded confirmation succeeds

#### Scenario: Same-side joining owner uses the identical mapper semantics
- **WHEN** a PUT request specifies a non-null `desired_entry` for a new trade cycle and the resolved
  scope already has one or more active cycles with the same side
- **THEN** ABI uses the same canonical `tpslMode="Partial"` entry payload as for a first owner
- **AND** ABI does not use a `Full` or owner-count-specific mapping path

#### Scenario: Failed create does not acknowledge success
- **WHEN** the create request is rejected or fails at the transport level
- **THEN** ABI SHALL NOT return `entry_package_applied` and SHALL return a safe error
