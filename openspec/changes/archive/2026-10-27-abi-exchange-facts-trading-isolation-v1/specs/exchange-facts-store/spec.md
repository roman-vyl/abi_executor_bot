## ADDED Requirements

### Requirement: Store isolated from order execution
The exchange facts store SHALL NOT be able to stop or block Runtime ↔ ABI
trading. No order execution, position lookup, recovery or protection path
SHALL depend on the store being enabled or available. The SQLite native
module SHALL be loaded only when an enabled store is opened, and a failure to
load it SHALL be an open failure with reason
`exchange_facts_driver_unavailable`.

#### Scenario: Native module cannot load
- **WHEN** the store is enabled and loading the SQLite native module throws
- **THEN** opening fails with `exchange_facts_driver_unavailable`
- **AND** ABI starts and trades with the store `unavailable`

#### Scenario: Native module missing with store disabled
- **WHEN** the store is disabled and the SQLite native module cannot be loaded
- **THEN** ABI starts normally and never attempts to load it

#### Scenario: Trading with an unavailable store
- **WHEN** the store is `unavailable`
- **THEN** entry package, open-position, position management and recovery routes behave exactly as with the store disabled
