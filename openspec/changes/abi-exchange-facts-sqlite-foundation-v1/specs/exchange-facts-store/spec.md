## ADDED Requirements

### Requirement: ABI owns a local SQLite store of exchange facts
ABI SHALL keep exchange facts in a SQLite database opened only by the ABI
process, at `ABI_EXCHANGE_FACTS_DB_PATH` (default
`./var/abi_exchange_facts.sqlite3`, on the Mac demo `BBB_data/abi`), only when
`ABI_EXCHANGE_FACTS_ENABLED=true`. The store SHALL use the driver
`better-sqlite3` at exactly version `12.9.0`.

#### Scenario: Disabled by default
- **WHEN** `ABI_EXCHANGE_FACTS_ENABLED` is unset
- **THEN** ABI opens no facts database and behaves exactly as before this change

#### Scenario: Invalid flag
- **WHEN** `ABI_EXCHANGE_FACTS_ENABLED` is neither `true` nor `false`
- **THEN** configuration loading fails with an error naming the variable

#### Scenario: Single process, exclusive access
- **WHEN** the store is open
- **THEN** it runs with `journal_mode=WAL`, `synchronous=FULL` and `locking_mode=EXCLUSIVE`

#### Scenario: Order execution untouched
- **WHEN** the store is enabled or disabled
- **THEN** the entry, protection, close, recovery and account routes produce the same exchange calls, answers and correlation records as before this change

### Requirement: Versioned facts contract
The database SHALL contain `schema_meta` with `contract` =
`abi-exchange-facts` and `schema_version` = `1`, and the tables
`exchange_facts_v1` and `order_links_v1` with the columns defined in the
design. ABI SHALL refuse to open a database whose `schema_version` is higher
than it knows or whose `contract` differs.

#### Scenario: New file
- **WHEN** the store opens a path with no database
- **THEN** it creates the schema v1 and `schema_meta` in one transaction

#### Scenario: Existing v1 file
- **WHEN** the store opens a database with `schema_version` `1`
- **THEN** it keeps all rows and opens without changes

#### Scenario: Newer schema
- **WHEN** the database has `schema_version` greater than `1`
- **THEN** opening fails with `exchange_facts_schema_newer` and no row is changed

### Requirement: Facts are raw Bybit items with indexed identifiers
Each fact SHALL be one Bybit item of kind `order_state` or `execution`, with
its source (`ws` or `rest` and endpoint), Bybit environment, category,
symbol, `order_id`, `order_link_id`, `parent_order_link_id`, `exec_id`,
`order_status`, exchange time, ABI receive time, and `raw_json` holding the
item as received. Empty identifier strings SHALL be stored as `NULL` in the
indexed columns and kept unchanged in `raw_json`. Facts SHALL carry no trade
cycle attribution.

#### Scenario: Raw item preserved
- **WHEN** a recorded `order/history` row and `execution/list` row are stored
- **THEN** `raw_json` equals the received item text, with every numeric string unchanged

#### Scenario: Child order with parent link
- **WHEN** an `order_state` item has an empty `orderLinkId` and a non-empty `parentOrderLinkId`
- **THEN** `order_link_id` is `NULL` and `parent_order_link_id` holds the parent value

#### Scenario: Unattributable fact
- **WHEN** an `execution` item of type `Funding` with empty `orderLinkId` is stored
- **THEN** it is stored as a fact and no link is created for it

### Requirement: Deduplication by exchange identity
The store SHALL deduplicate facts by a unique key: `execution` by `execId`;
`order_state` by `orderId`, `updatedTime`, `orderStatus` and `cumExecQty`. A
duplicate SHALL NOT be an error and SHALL NOT change the stored fact.
`orderLinkId` SHALL NOT be used as a unique key.

#### Scenario: Same fill twice
- **WHEN** the same `execId` is written twice, from `ws` and then `rest`
- **THEN** exactly one fact exists and the second write reports one duplicate

#### Scenario: Same orderLinkId, different orders
- **WHEN** two `order_state` items share an `orderLinkId` but have different `orderId`
- **THEN** both are stored

#### Scenario: Missing key field
- **WHEN** an `execution` item has no `execId`
- **THEN** the write is refused with a typed error and nothing from its batch is stored

### Requirement: Order to cycle links are append-only and proven
The store SHALL record links of an order to (`strategy_instance_id`,
`trade_cycle_id`, role, generation) with evidence `abi_order_link_id`,
`create_response` or `parent_order_link_id`. Links SHALL never be updated or
deleted. A link that would attach an `order_id` already linked to another
cycle or another role SHALL be refused with `link_conflict`, leaving existing
rows unchanged. Aggregated position data SHALL NOT be used as evidence.

#### Scenario: Child linked through parent
- **WHEN** an entry `orderLinkId` is linked to a cycle and a child `orderId` is linked with evidence `parent_order_link_id`
- **THEN** both links exist for the same cycle with roles `entry` and `stop_loss` or `take_profit`

#### Scenario: Conflicting link
- **WHEN** an `order_id` linked to cycle A is linked to cycle B
- **THEN** the write fails with `link_conflict` and the link to cycle A stays the only one

#### Scenario: Identical link twice
- **WHEN** the same link is written twice
- **THEN** one row exists and the second write reports a duplicate

### Requirement: Transactions and monotonic read cursor
Every store write call SHALL be one transaction: all its facts and links are
stored, or none. Each stored fact SHALL get an `event_seq` greater than every
earlier one, never reused, also across restarts; gaps are allowed. The store
SHALL return facts with `event_seq` greater than a given value in ascending
order, with a limit of 1 to 1000.

#### Scenario: Batch rolls back
- **WHEN** a batch of facts contains one invalid item
- **THEN** no fact of that batch is stored and the next `event_seq` is still greater than all stored ones

#### Scenario: Late fact read after cursor
- **WHEN** a consumer has read up to `event_seq` N and a fill with an earlier exchange time is stored later
- **THEN** reading after N returns that fill

#### Scenario: Restart keeps order
- **WHEN** the store is closed and reopened and new facts are stored
- **THEN** their `event_seq` values are greater than all values before the restart and all earlier facts are still readable
