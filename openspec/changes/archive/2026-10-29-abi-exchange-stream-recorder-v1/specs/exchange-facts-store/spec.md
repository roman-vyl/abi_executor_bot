## MODIFIED Requirements

### Requirement: Versioned internal storage schema
The database SHALL contain `schema_meta` with `storage_schema` =
`abi-exchange-facts-storage`, `schema_version` = `2`, `dedup_key_version` =
`1` and `snapshot_key_version` = `1`, and the tables `exchange_facts`,
`order_links`, `account_snapshots` and `stream_connection_log`. Opening a
version 1 database SHALL add the two new tables and set the new versions in
one transaction, keeping every existing row. ABI SHALL refuse a database with
a higher `schema_version` or an unknown `dedup_key_version` or
`snapshot_key_version`.

#### Scenario: New file
- **WHEN** the store opens a path with no database
- **THEN** it creates the version 2 schema and `schema_meta` in one transaction

#### Scenario: Existing v1 file
- **WHEN** the store opens a database with `schema_version` `1` of its own environment
- **THEN** it keeps all rows, adds `account_snapshots` and `stream_connection_log`, and records `schema_version` `2`

#### Scenario: Existing v2 file
- **WHEN** the store opens a database with `schema_version` `2` of its own environment
- **THEN** it opens without changes

#### Scenario: Newer schema
- **WHEN** the database has `schema_version` greater than `2`
- **THEN** opening fails with `exchange_facts_schema_newer` and no row is changed

## ADDED Requirements

### Requirement: Account snapshots
The store SHALL keep `position` and `wallet` records as account snapshots
with their raw record, source, receive time and exchange time, deduplicated
by `snapshot_key_version` 1: position by `symbol`, `positionIdx` and Bybit
`seq`; wallet by `accountType`, frame `creationTime` and a hash of the raw
record. Snapshots SHALL carry no trade cycle attribution.

#### Scenario: Same position update twice
- **WHEN** a `position` record with the same `symbol`, `positionIdx` and `seq` is written twice
- **THEN** one snapshot exists

### Requirement: Stream connection log
The store SHALL append connection log rows (time, event, `conn_id`, detail)
with a monotonic `log_seq` in the same transaction as the records of the same
flush.

#### Scenario: Log row with records
- **WHEN** a flush holds two facts and one `disconnected` row
- **THEN** all three are stored or none
