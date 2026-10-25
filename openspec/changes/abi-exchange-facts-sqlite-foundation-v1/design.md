## Context

Audit 2026-10-25 (report https://claude.ai/artifact/HQwiQwcgA3KdTr1d24gqAa, model review https://claude.ai/artifact/8AW4Kx8ocHpqNyNWM1r5GH, files `/mnt/project-files/abi-facts-journal/`):

- ABI creates two identifiers: entry and close `orderLinkId` = `"abi-ep-" + sha256([SI, TC, role, generation])[0:20]`. Retries within a generation reuse it; a new generation gets a new one.
- Bybit creates the Partial SL/TP children: own `orderLinkId` empty, `parentOrderLinkId` = entry `orderLinkId` (confirmed on real `order/history` responses, trade 6072511f). `execution/list` rows have `orderId` but no `parentOrderLinkId`. On a Partial entry filled in several pieces Bybit may create one child pair per piece.
- This chain (entry `orderLinkId` → child `parentOrderLinkId` → child `orderId` → `execId`) is proven for the regular Partial SL/TP only. Other closings (ABI close order, liquidation, ADL, manual or account-wide close) are not proven to have the same structure; v1 stores their facts and links them only with the evidence listed in D4.
- Funding executions come on the net position (`orderLinkId` empty) and cannot be attributed to one cycle.
- Unfilled conditional orders end as `Deactivated`; on demo, cancelled/rejected/deactivated orders stay in REST history only about 24 hours and all history only 7 days.
- Mac experiment: Docker Desktop bind mounts have no working `fcntl` locks. One process per file is safe; several are not.

## Goals / Non-Goals

Goal: a correct, durable, deduplicating ABI-internal store, ready for the next changes (fact collection, read API). Non-goals: see proposal.

## Decisions

### D1. Internal storage schema v1

The SQL schema is ABI's internal storage, versioned for ABI's own migrations. It is not an inter-service contract: the future contract with the Central Journal is a read-only ABI HTTP API with its own version; the Central Journal never opens this file and never copies its facts into its own database. Foundation guarantees the cursor reads (D7) that such an API needs.

```sql
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 'storage_schema'    = 'abi-exchange-facts-storage'
-- 'schema_version'    = '1'
-- 'bybit_env'         = 'demo' | 'testnet' | 'mainnet'   (written once at creation)
-- 'category'          = 'linear'                         (written once at creation)
-- 'dedup_key_version' = '1'

CREATE TABLE exchange_facts (
  event_seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- read cursor, never reused
  fact_kind             TEXT NOT NULL CHECK (fact_kind IN ('order_state','execution')),
  source                TEXT NOT NULL CHECK (source IN ('ws','rest')),
  source_endpoint       TEXT NOT NULL,          -- e.g. 'ws:order', 'rest:/v5/execution/list'
  symbol                TEXT NOT NULL,
  order_id              TEXT,                   -- NULL only if Bybit sent none or ''
  order_link_id         TEXT,                   -- NULL when Bybit sent ''
  parent_order_link_id  TEXT,                   -- NULL when absent or ''
  exec_id               TEXT,                   -- execution only
  exec_type             TEXT,                   -- execution only: Trade, Funding, AdlTrade, ...
  order_status          TEXT,                   -- order_state only
  exchange_time_ms      INTEGER,                -- execTime (execution) / updatedTime (order_state)
  received_at_ms        INTEGER NOT NULL,       -- ABI clock when received
  dedup_key             TEXT NOT NULL UNIQUE,
  raw_json              TEXT NOT NULL           -- the Bybit item as received
);
CREATE INDEX exchange_facts_order_id      ON exchange_facts(order_id);
CREATE INDEX exchange_facts_order_link_id ON exchange_facts(order_link_id);
CREATE INDEX exchange_facts_parent_link   ON exchange_facts(parent_order_link_id);
CREATE INDEX exchange_facts_exec_type     ON exchange_facts(exec_type);

CREATE TABLE order_links (
  link_seq              INTEGER NOT NULL UNIQUE,  -- read cursor, assigned from a counter, never reused
  order_id              TEXT PRIMARY KEY,         -- Bybit orderId: one exchange order = one row
  strategy_instance_id  TEXT NOT NULL,
  trade_cycle_id        TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('entry','close','stop_loss','take_profit')),
  generation            INTEGER NOT NULL,         -- entry/close: own; child: its parent entry's
  order_link_id         TEXT,                     -- own orderLinkId (ABI orders); NULL for children
  parent_order_link_id  TEXT,                     -- children only
  evidence              TEXT NOT NULL CHECK (evidence IN
                          ('create_response','own_order_link_id_lookup','parent_order_link_id')),
  established_at_ms     INTEGER NOT NULL,
  CHECK ((role IN ('entry','close') AND order_link_id IS NOT NULL AND parent_order_link_id IS NULL)
      OR (role IN ('stop_loss','take_profit') AND order_link_id IS NULL AND parent_order_link_id IS NOT NULL))
);
CREATE INDEX order_links_cycle            ON order_links(strategy_instance_id, trade_cycle_id);
CREATE INDEX order_links_order_link_id    ON order_links(order_link_id);
CREATE INDEX order_links_parent_link      ON order_links(parent_order_link_id);
```

- Facts carry no cycle columns and no environment column (the environment is the database, D6). Attribution lives only in `order_links`; a consumer joins `exchange_facts.order_id = order_links.order_id`. Facts whose `order_id` has no link (Funding, liquidation, account-wide close, unknown orders) stay unattributed.
- `raw_json`: the Bybit item (one row, not the whole page) as received. Bybit V5 sends numeric values as strings; ABI stores the item text without any numeric reformatting. A test asserts byte equality for recorded rows of trade 6072511f.
- Empty strings from Bybit become `NULL` in the indexed columns only; `raw_json` keeps them.
- `link_seq` is assigned in the same transaction as `MAX(link_seq) + 1`; link rows are never deleted, so it only grows and a committed value is never reused.

### D2. Driver and build

`better-sqlite3` exactly `12.9.0` (no caret), plus `@types/better-sqlite3` as dev dependency, both in `package-lock.json`. On the Mac (Node 20.20.2, Debian 12, arm64) 12.9.0 installed from a prebuilt binary; 12.10–12.11.1 had no prebuilt for Node 20 and failed without Python. The Dockerfile stays as is. Task 1.1 verifies `npm ci` in `node:20-bookworm-slim` for both `linux/amd64` (CI) and `linux/arm64` (Mac) without a compiler; if either needs a compile, implementation stops and reports to the owner (no toolchain added, no Node change).

### D3. Fact kinds and their meaning

`fact_kind` is the form of the Bybit record, not its economic meaning:

- `order_state`: one order record from the WS `order` topic or REST `order/realtime` / `order/history`, for any order type (entry, conditional, stop loss, take profit, close) and any `orderStatus` (`Untriggered`, `Triggered`, `New`, `PartiallyFilled`, `Filled`, `Cancelled`, `Deactivated`, `Rejected`). Creation, trigger, amend (trigger price, quantity, SL/TP price), cancel and deactivation all appear as new records of the order.
- `execution`: one record from the WS `execution` topic or REST `execution/list`, of any `execType` (`Trade`, `Funding`, `AdlTrade`, `BustTrade`, `Settle`, `Delivery`, `BlockTrade`, `MovePosition`). A partial fill is its own record with its own `execId`. Funding is an `execution` with `exec_type = 'Funding'`, not a trade.

The economic meaning is read from Bybit fields (`execType`, `stopOrderType`, `createType`, `orderStatus`, `cancelType`). Not covered by v1, on purpose: ABI's own commands and Bybit's direct REST error answers to them (e.g. a create rejected with a `retCode`, which produces no order record), position and wallet records. Adding a kind is a schema version bump. Note for the collection change: the `execution.fast` topic must not be used (no fee; the first, poorer record would win the `execId` dedup).

### D4. Deduplication

| fact_kind | dedup_key |
|---|---|
| `execution` | `exec:` + `execId` |
| `order_state` | `order:` + `orderId` + `:` + `updatedTime` + `:` + `sha256(fingerprint)` |

Fingerprint (`dedup_key_version` 1): the values of these fields, in this order, joined with a separator: `orderStatus, qty, price, triggerPrice, takeProfit, stopLoss, tpLimitPrice, slLimitPrice, triggerBy, tpTriggerBy, slTriggerBy, leavesQty, cumExecQty, cumExecValue, cumExecFee, avgPrice, cancelType, rejectReason`. Normalization before hashing only: a decimal string loses trailing fractional zeros and a trailing dot (`3.8180` → `3.818`, `0.00` → `0`), a missing field and an empty string are the same. `raw_json` is never normalized.

- The same snapshot from WS and REST gives the same key: one fact. Any content change of these fields, even within the same millisecond, gives a new key: kept.
- The fingerprint covers this fixed list, not every possible field of a Bybit answer. Its completeness against real WS `order` records is checked in the collection change; Foundation tests it on recorded REST rows of trade 6072511f.
- Insert is `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`; the write call reports inserted and duplicate counts. A duplicate is not an error. A fact missing a field its key needs (`execId`; or `orderId` / `updatedTime`) is refused with a typed error and nothing in its batch is written.
- Changing the rule means a new `dedup_key_version` and an explicit migration; the store refuses a database with an unknown `dedup_key_version`.

### D5. Links: one immutable row per exchange order

- A link row is written once, when the `orderId` is known, with the evidence that proved it:
  - `create_response`: the `orderId` Bybit returned for an order ABI created;
  - `own_order_link_id_lookup`: the `orderId` found through ABI's own `orderLinkId` after an unclear answer;
  - `parent_order_link_id`: a child order whose `parentOrderLinkId` equals the `order_link_id` of an existing `entry` row; the child takes that row's instance, cycle and generation.
- Before the `orderId` is known the intent exists only in the correlation JSONL; no partial row is written.
- Rows are never updated or deleted. Writing a link for an `order_id` that already exists with identical fields is a duplicate. With any different instance, cycle, role or generation it is refused with `link_conflict`; the existing row stays.
- An `orderId` that already has a link is answered from that row first (duplicate or `link_conflict`), before any parent lookup, so a repeated child never depends on the current state of its parent.
- A child whose parent `orderLinkId` matches no `entry` row, or matches `entry` rows of different cycles, is not linked (`parent_not_found` / `parent_ambiguous`); its facts stay unattributed.
- A retry within a generation that yields a second `orderId` for the same `orderLinkId` gives a second row of the same cycle; a new generation gives a new `orderLinkId` and new rows. Several stop/take children of one entry each get their own row.
- Aggregated position data is never evidence.

### D6. One database per environment and account

- Default path `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3` (Mac: `BBB_data/abi/abi_exchange_facts_demo.sqlite3`).
- The protection is the check, not the name: `bybit_env` and `category` are written into `schema_meta` when the file is created and compared with the configuration at every open. A mismatch refuses startup with `exchange_facts_environment_mismatch`.
- A file that has tables but no `schema_meta` is refused (`exchange_facts_unknown_database`), never treated as new.
- `storage_schema` must equal `abi-exchange-facts-storage`; `schema_version` greater than `1` is refused (`exchange_facts_schema_newer`).
- One database belongs to one environment and one Bybit account. Foundation does not query the account UID. Operational rule (RUNBOOK): when the API keys are switched to another account, the old database must be moved aside before ABI starts with the facts store enabled.

### D7. Transactions, durability and cursor reads

- One store method call = one `BEGIN IMMEDIATE` transaction: a batch of facts (e.g. one REST page) and/or links is written all-or-nothing.
- Pragmas at open, in this order: `locking_mode=EXCLUSIVE`, then `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`. Exclusive mode set before WAL keeps the WAL index in process memory, so no `-shm` file is created and the store does not rely on shared memory across the Docker Desktop file boundary.
- `readFactsAfter(afterEventSeq, limit)` and `readLinksAfter(afterLinkSeq, limit)` return rows with a greater sequence in ascending order, `limit` 1–1000. Sequences only grow and are never reused, also across restarts; gaps are allowed. A fact stored late (e.g. a fill found by REST with an earlier exchange time) is still read after the last seen `event_seq`.
- `better-sqlite3` is synchronous; writes are small. Order execution does not call the store in this change.

### D8. Config and startup

- `ABI_EXCHANGE_FACTS_ENABLED` (`true|false`, default `false`, invalid value fails startup).
- `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3`; in the container `/app/var` = Mac `BBB_data/abi`).
- Enabled: open in `server.ts` before listening; any open/check failure emits `exchange_facts_store_failed` with a closed reason and fails startup; close on graceful shutdown. `service_starting` gains `exchangeFactsStore: "disabled" | "enabled"` and, when enabled, `exchangeFactsSchemaVersion` (camelCase like the event's other fields).

## Risks / Trade-offs

- `locking_mode=EXCLUSIVE` is not a guard against a second process: on the macOS bind mount file locks do not work, so a second ABI on the same data directory would open the file and corrupt it. Operational contract: one ABI process per data directory, ensured by deployment (one `abi` service in `bbb_stack`), not by SQLite. No distributed locks.
- No outside reader (sqlite3 CLI on the Mac, backup tools) may open the file while ABI runs; backups copy the file only with ABI stopped (RUNBOOK). Reading goes through the future API.
- One database per account is an operational rule only until an account check exists.
- Disk growth: thousands of rows a day with raw JSON, a few MB per day; no retention in v1.
- Prebuilt binary availability may change upstream: exact pin plus lockfile; CI build is the check.

## Open Questions

None blocking. Fact collection (WS + REST recovery), writes of links from the trading paths, and the read API are the next changes.
