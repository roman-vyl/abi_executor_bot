## MODIFIED Requirements

### Requirement: Startup reports the exchange facts store
The `service_starting` event SHALL include `exchangeFactsStore` with value
`disabled`, `enabled` or `unavailable`, computed after the open attempt. When
it is `enabled`, the event SHALL also include `exchangeFactsSchemaVersion`. A
failure to open or check an enabled store SHALL emit
`exchange_facts_store_failed` at level `error` with a closed `reason`, and
startup SHALL continue without the store.

#### Scenario: Store disabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=false` or unset
- **THEN** `service_starting` includes `exchangeFactsStore: "disabled"`
- **AND** no facts database file is created or opened
- **AND** the SQLite native module is not loaded

#### Scenario: Store enabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=true` and the store opens
- **THEN** `service_starting` includes `exchangeFactsStore: "enabled"` and `exchangeFactsSchemaVersion: 1`

#### Scenario: Store cannot open
- **WHEN** the store is enabled and opening or checking fails
- **THEN** ABI emits `exchange_facts_store_failed` with `reason` one of `open_failed`, `exchange_facts_driver_unavailable`, `exchange_facts_environment_mismatch`, `exchange_facts_unknown_database`, `exchange_facts_schema_newer`, `exchange_facts_dedup_rule_unknown`
- **AND** the event contains no secrets and no file contents
- **AND** `service_starting` includes `exchangeFactsStore: "unavailable"`
- **AND** ABI listens and serves every trading route as with the store disabled

## ADDED Requirements

### Requirement: Health reports the exchange facts store
`GET /health` SHALL include `exchangeFactsStore` with the startup state
(`disabled`, `enabled` or `unavailable`) and, when `unavailable`,
`exchangeFactsStoreReason` with the failure reason. The store state SHALL NOT
change `ok` or the HTTP status of `/health`.

#### Scenario: Unavailable store keeps health status
- **WHEN** the store is `unavailable` and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true`, `exchangeFactsStore: "unavailable"` and `exchangeFactsStoreReason`

#### Scenario: Disabled store
- **WHEN** the store is disabled
- **THEN** `/health` includes `exchangeFactsStore: "disabled"` and no `exchangeFactsStoreReason`
