## ADDED Requirements

### Requirement: Entry-package internals preserve one physical binding through mapping and confirmation
ABI SHALL be able to map and confirm an entry against an explicitly supplied internal one-way or
directional hedge binding. The binding used for the create payload, realtime confirmation,
historical confirmation, cancellation, retry, and ambiguous-create evidence SHALL be the binding
durably associated with that generation. A mismatch SHALL fail closed.

#### Scenario: Controlled internal hedge entry mapping
- **WHEN** a controlled internal or test path maps an explicit hedge-long or hedge-short binding
- **THEN** the Bybit create payload contains the corresponding exchange slot encoding
- **AND** every confirmation query expects the same physical binding

#### Scenario: Retry cannot change binding
- **WHEN** an unresolved create is retried for the same generation
- **THEN** ABI reuses the record's existing physical binding
- **AND** it does not select a binding from current account configuration or fresh side inference
  that could disagree with the record

### Requirement: Ambiguous-create absence is target-binding specific
When own order and execution evidence are absent for an ambiguous create, ABI SHALL consult only
the record's expected physical binding for physical sanity. Exposure or flatness in the opposite
hedge slot SHALL neither prove nor disprove whether the target create occurred. Same-slot sibling
exposure SHALL remain compatible with clean absence of this owner's own create.

#### Scenario: Opposite slot is open while target create is absent
- **WHEN** own order and execution evidence are cleanly absent and only the opposite hedge slot is
  open
- **THEN** ABI does not attribute that opposite exposure to the target create

#### Scenario: Same-slot sibling exists
- **WHEN** own order and execution evidence are cleanly absent while attributable owners already
  contribute exposure to the same directional slot
- **THEN** that aggregate same-slot exposure alone does not prevent clean absence convergence for
  this owner

### Requirement: Production entry remains one-way after lifecycle readiness
This change SHALL NOT authorize the ordinary production provisional writer to persist a hedge
binding and SHALL NOT authorize the ordinary production entry path to send a directional hedge
position index. Existing dry-run, Demo/testnet guards, and mainnet blocking behavior SHALL remain
unchanged.

#### Scenario: Ordinary production provisional write
- **WHEN** the production entry service creates a new provisional record after this change
- **THEN** it durably writes `position_binding_mode = "one_way"`
- **AND** the corresponding production create uses one-way exchange geometry

#### Scenario: Internal hedge capability does not activate production
- **WHEN** hedge mapping and confirmation primitives are exercised by controlled tests
- **THEN** that capability does not make a Runtime entry request create a hedge-bound record or
  hedge order

