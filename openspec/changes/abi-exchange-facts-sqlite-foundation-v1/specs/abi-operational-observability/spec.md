## ADDED Requirements

### Requirement: Startup reports the exchange facts store
The `service_starting` event SHALL include `exchange_facts_store` with value
`disabled` or `enabled`. When it is `enabled`, the event SHALL also include
`exchange_facts_schema_version`. A failure to open or migrate an enabled store
SHALL emit `exchange_facts_store_failed` at level `error` with a closed
`reason` and SHALL stop startup.

#### Scenario: Store disabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=false` or unset
- **THEN** `service_starting` includes `exchange_facts_store: "disabled"`
- **AND** no facts database file is created or opened

#### Scenario: Store enabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=true` and the store opens
- **THEN** `service_starting` includes `exchange_facts_store: "enabled"` and `exchange_facts_schema_version: 1`

#### Scenario: Store cannot open
- **WHEN** the store is enabled and opening or migrating fails
- **THEN** ABI emits `exchange_facts_store_failed` with `reason` one of `open_failed`, `exchange_facts_schema_newer`, `exchange_facts_contract_mismatch`
- **AND** the event contains no secrets and no file contents
- **AND** the process exits non-zero without listening
