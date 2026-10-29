## MODIFIED Requirements

### Requirement: Versioned internal storage schema
The database SHALL contain `schema_meta` with `storage_schema` =
`abi-exchange-facts-storage`, `schema_version` = `3`, `dedup_key_version` =
`1` and `snapshot_key_version` = `1`, and the tables `exchange_facts`,
`order_links`, `account_snapshots`, `stream_connection_log` and
`rest_sync_windows`. Opening a version 1 or 2 database SHALL add the missing
tables and set the new versions in one transaction, keeping every existing
row. ABI SHALL refuse a database with a higher `schema_version` or an unknown
`dedup_key_version` or `snapshot_key_version`.

#### Scenario: New file
- **WHEN** the store opens a path with no database
- **THEN** it creates the version 3 schema and `schema_meta` in one transaction

#### Scenario: Existing v1 file
- **WHEN** the store opens a database with `schema_version` `1` of its own environment
- **THEN** it keeps all rows, adds `account_snapshots`, `stream_connection_log` and `rest_sync_windows`, and records `schema_version` `3`

#### Scenario: Existing v2 file
- **WHEN** the store opens a database with `schema_version` `2` of its own environment
- **THEN** it keeps all rows, adds `rest_sync_windows`, and records `schema_version` `3`

#### Scenario: Existing v3 file
- **WHEN** the store opens a database with `schema_version` `3` of its own environment
- **THEN** it opens without changes

#### Scenario: Newer schema
- **WHEN** the database has `schema_version` greater than `3`
- **THEN** opening fails with `exchange_facts_schema_newer` and no row is changed

## ADDED Requirements

### Requirement: REST coverage windows
`rest_sync_windows` SHALL hold one row per completed REST window: endpoint,
start and end time, completion time, records fetched and records new. Rows
SHALL never be updated or deleted.

#### Scenario: Window completed
- **WHEN** the last page of a window is written
- **THEN** its coverage row is written in the same transaction
