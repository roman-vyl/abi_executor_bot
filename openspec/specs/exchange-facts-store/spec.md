# exchange-facts-store Specification

## Purpose
ABI-internal SQLite journal of Bybit exchange facts (order states, executions) and orderId -> trade cycle links, kept apart from order execution so that it can never stop or block Runtime <-> ABI trading.

## Requirements

### Requirement: ABI owns an internal SQLite store of exchange facts
ABI SHALL keep exchange facts in a SQLite database opened only by the ABI
process when `ABI_EXCHANGE_FACTS_ENABLED=true`, at `ABI_EXCHANGE_FACTS_DB_PATH`
(default `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3`), using
`better-sqlite3` exactly `12.9.0`. The SQL schema SHALL be internal storage;
no other service SHALL open the file.

#### Scenario: Not an inter-service contract
- **WHEN** the Central Journal needs exchange facts
- **THEN** it uses the future read-only ABI HTTP API and never opens the database file

#### Scenario: Disabled by default
- **WHEN** `ABI_EXCHANGE_FACTS_ENABLED` is unset
- **THEN** ABI opens no facts database and behaves exactly as before this change

#### Scenario: Invalid flag
- **WHEN** `ABI_EXCHANGE_FACTS_ENABLED` is neither `true` nor `false`
- **THEN** configuration loading fails with an error naming the variable

#### Scenario: Pragmas and no shared memory file
- **WHEN** the store opens
- **THEN** it sets `locking_mode=EXCLUSIVE` before `journal_mode=WAL`, uses `synchronous=FULL`
- **AND** no `-shm` file exists next to the database while it is open

#### Scenario: Order execution untouched
- **WHEN** the store is enabled or disabled
- **THEN** the entry, protection, close, recovery and account routes produce the same exchange calls, answers and correlation records as before this change

### Requirement: One database per Bybit environment
A database SHALL record its Bybit environment and category when it is
created, and ABI SHALL refuse to start with the store enabled when they
differ from its configuration. A database SHALL belong to one environment and
one Bybit account; ABI SHALL NOT query the account in this change, and the
RUNBOOK SHALL require moving the old database aside before switching to
another account.

#### Scenario: Environment recorded
- **WHEN** the store creates a new database under `BYBIT_ENV=demo`
- **THEN** `schema_meta` holds `bybit_env` = `demo` and `category` = `linear`

#### Scenario: Wrong environment refused
- **WHEN** ABI runs with `BYBIT_ENV=mainnet` and the configured path holds a database recorded as `demo`
- **THEN** startup fails with `exchange_facts_environment_mismatch` and the database is not changed

#### Scenario: Unknown database refused
- **WHEN** the file has tables but no `schema_meta`
- **THEN** startup fails with `exchange_facts_unknown_database`

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

### Requirement: Facts are raw Bybit records of two forms
Each fact SHALL be one Bybit record of kind `order_state` (an order record,
any order type and status) or `execution` (an execution record of any
`execType`, Funding included), with its indexed identifiers, `exec_type`,
times, and `raw_json` holding the record as received. Empty identifier
strings SHALL be `NULL` in indexed columns only. Facts SHALL carry no trade
cycle attribution.

#### Scenario: Raw record preserved
- **WHEN** recorded `order/history` and `execution/list` rows of trade 6072511f are stored
- **THEN** `raw_json` equals the received record text, with every numeric string unchanged

#### Scenario: Child order with parent link
- **WHEN** an `order_state` record has an empty `orderLinkId` and a non-empty `parentOrderLinkId`
- **THEN** `order_link_id` is `NULL` and `parent_order_link_id` holds the parent value

#### Scenario: Funding is an execution
- **WHEN** an execution record with `execType` `Funding` and empty `orderLinkId` is stored
- **THEN** it is stored with `fact_kind` `execution` and `exec_type` `Funding`
- **AND** it has no link

### Requirement: Deduplication keeps every state change
The store SHALL deduplicate `execution` facts by `execId`, and `order_state`
facts by `orderId`, `updatedTime` and a hash of the fixed state-field list of
`dedup_key_version` 1, after normalizing decimal strings (no trailing
fractional zeros) and treating a missing field as an empty one. A duplicate
SHALL NOT be an error and SHALL NOT change the stored fact. `orderLinkId`
SHALL NOT be a deduplication key.

#### Scenario: Same fill twice
- **WHEN** the same `execId` is written from `ws` and then from `rest`
- **THEN** exactly one fact exists and the second write reports one duplicate

#### Scenario: Same order snapshot from two sources
- **WHEN** the same order state arrives from `ws` and from `rest` with `3.8180` in one and `3.818` in the other
- **THEN** exactly one fact exists

#### Scenario: Stop moved without status change
- **WHEN** two `order_state` records of one order have the same `orderStatus`, `cumExecQty` and `updatedTime` but different `triggerPrice`
- **THEN** both are stored

#### Scenario: Missing key field
- **WHEN** an `execution` record has no `execId`
- **THEN** the write is refused with a typed error and nothing from its batch is stored

### Requirement: One immutable link per exchange order
The store SHALL keep at most one link per Bybit `orderId` (instance, cycle,
role, generation, evidence), written only when the `orderId` is known and
never updated or deleted. A child link SHALL take the cycle and generation of
the `entry` link matching its `parentOrderLinkId`. Aggregated position data
SHALL NOT be evidence.

#### Scenario: Entry and its children
- **WHEN** an entry `orderId` is linked from the create response and its stop loss and take profit are linked through `parentOrderLinkId`
- **THEN** three rows exist for the same cycle with roles `entry`, `stop_loss`, `take_profit`
- **AND** every fact of these orders is attributed by `order_id`

#### Scenario: Identical link twice
- **WHEN** the same link is written twice
- **THEN** one row exists and the second write reports a duplicate

#### Scenario: Conflicting link
- **WHEN** an `orderId` linked to cycle A is written for cycle B
- **THEN** the write fails with `link_conflict` and the link to cycle A is unchanged

#### Scenario: Retry with the same orderLinkId
- **WHEN** two different `orderId`s of the same cycle, role and generation carry the same `orderLinkId`
- **THEN** both are linked to that cycle

#### Scenario: Child without a known parent
- **WHEN** a child's `parentOrderLinkId` matches no `entry` link, or matches entry links of different cycles
- **THEN** no link is written (`parent_not_found` or `parent_ambiguous`) and its facts stay unattributed

### Requirement: Transactions, crash safety and monotonic cursors
Every store write call SHALL be one transaction: all its facts and links are
stored, or none. Each stored fact SHALL get an `event_seq` and each link a
`link_seq` greater than every earlier one, never reused, also across
restarts and crashes; gaps are allowed. The store SHALL return facts or links
after a given sequence in ascending order, with a limit of 1 to 1000.

#### Scenario: Batch rolls back
- **WHEN** a batch of facts contains one invalid record
- **THEN** no fact of that batch is stored

#### Scenario: Late fact read after cursor
- **WHEN** a consumer has read up to `event_seq` N and a fill with an earlier exchange time is stored later
- **THEN** reading after N returns that fill

#### Scenario: Process killed mid-write
- **WHEN** a process writing batches is killed with `SIGKILL` at a random moment and the database is reopened
- **THEN** `integrity_check` returns `ok`
- **AND** every batch whose commit was acknowledged is present in full
- **AND** no batch is present partially
- **AND** new `event_seq` values are greater than every value before the kill

### Requirement: One ABI process per data directory
The RUNBOOK SHALL state that exactly one ABI process may use a data
directory, that SQLite locking does not enforce this on the macOS Docker
Desktop bind mount, that no other process may open the database while ABI
runs, and that backups copy the file only with ABI stopped.

#### Scenario: Operational contract documented
- **WHEN** the RUNBOOK section on the facts store is read
- **THEN** it states the one-process rule, the no-outside-reader rule, the backup rule and the one-account-per-database rule

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
