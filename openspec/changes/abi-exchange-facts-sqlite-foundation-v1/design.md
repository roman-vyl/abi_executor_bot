## Context

Audit 2026-10-25 (report https://claude.ai/artifact/HQwiQwcgA3KdTr1d24gqAa, files `/mnt/project-files/abi-facts-journal/`):

- ABI creates two identifiers: entry and close `orderLinkId` = `"abi-ep-" + sha256([SI, TC, role, generation])[0:20]`. Retries within a generation reuse it.
- Bybit creates the Partial SL/TP children: own `orderLinkId` empty, `parentOrderLinkId` = entry `orderLinkId` (confirmed on real `order/history` responses, trade 6072511f). `execution/list` rows have `orderId` but no `parentOrderLinkId`.
- This chain (entry `orderLinkId` → child `parentOrderLinkId` → child `orderId` → `execId`) is proven for the regular Partial SL/TP only. Other closings (ABI close order, liquidation, ADL, manual or account-wide close) are not proven to have the same structure; v1 stores their facts and links them only with the evidence listed in D4.
- Funding executions come on the net position (`orderLinkId` empty) and cannot be attributed to one cycle.
- Unfilled conditional orders end as `Deactivated`; on demo, cancelled/rejected/deactivated orders stay in REST history only about 24 hours and all history only 7 days.
- Mac experiment: Docker Desktop bind mounts have no working `fcntl` locks. One process per file is safe; several are not.

## Goals / Non-Goals

Goal: a correct, durable, deduplicating local store with a versioned contract, ready for the next changes (fact collection, read API). Non-goals: see proposal.

## Decisions

### D1. Two tables plus meta, schema contract v1

```sql
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- 'contract' = 'abi-exchange-facts', 'schema_version' = '1'

CREATE TABLE exchange_facts_v1 (
  event_seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- read cursor, never reused
  fact_kind             TEXT NOT NULL CHECK (fact_kind IN ('order_state','execution')),
  source                TEXT NOT NULL CHECK (source IN ('ws','rest')),
  source_endpoint       TEXT NOT NULL,          -- e.g. 'ws:order', 'rest:/v5/execution/list'
  bybit_env             TEXT NOT NULL,          -- demo | testnet | mainnet
  category              TEXT NOT NULL,          -- linear
  symbol                TEXT NOT NULL,
  order_id              TEXT,                   -- NULL only if Bybit sent none
  order_link_id         TEXT,                   -- NULL when Bybit sent ''
  parent_order_link_id  TEXT,                   -- NULL when absent or ''
  exec_id               TEXT,                   -- execution only
  order_status          TEXT,                   -- order_state only
  exchange_time_ms      INTEGER,                -- execTime (execution) / updatedTime (order_state)
  received_at_ms        INTEGER NOT NULL,       -- ABI clock when received
  dedup_key             TEXT NOT NULL UNIQUE,
  raw_json              TEXT NOT NULL           -- the Bybit item as received
);
CREATE INDEX exchange_facts_v1_order_id      ON exchange_facts_v1(order_id);
CREATE INDEX exchange_facts_v1_order_link_id ON exchange_facts_v1(order_link_id);
CREATE INDEX exchange_facts_v1_parent_link   ON exchange_facts_v1(parent_order_link_id);

CREATE TABLE order_links_v1 (
  link_seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_instance_id  TEXT NOT NULL,
  trade_cycle_id        TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('entry','close','stop_loss','take_profit')),
  generation            INTEGER,                -- entry/close only
  order_link_id         TEXT,
  order_id              TEXT,
  evidence              TEXT NOT NULL CHECK (evidence IN
                          ('abi_order_link_id','create_response','parent_order_link_id')),
  established_at_ms     INTEGER NOT NULL,
  CHECK (order_link_id IS NOT NULL OR order_id IS NOT NULL)
);
CREATE UNIQUE INDEX order_links_v1_identity ON order_links_v1(
  strategy_instance_id, trade_cycle_id, role,
  COALESCE(generation, -1), COALESCE(order_link_id, ''), COALESCE(order_id, ''));
CREATE INDEX order_links_v1_order_id      ON order_links_v1(order_id);
CREATE INDEX order_links_v1_order_link_id ON order_links_v1(order_link_id);
```

- `fact_kind` is a closed list in v1: `order_state` (one order row from WS `order`, REST `order/realtime` or `order/history`) and `execution` (one row from WS `execution` or REST `execution/list`). ABI's own commands are not facts in v1; adding a kind is a schema version bump.
- Facts carry no cycle columns. Attribution lives only in `order_links_v1`; a consumer joins `order_id` / `order_link_id`. Funding and other unattributable facts simply have no link.
- `raw_json`: the Bybit item (one row, not the whole page) as received. Bybit V5 sends numeric values as strings, so ABI stores the item text without any numeric reformatting. A test asserts byte equality for a recorded `order/history` and `execution/list` row from 6072511f.
- Empty strings from Bybit become `NULL` in the indexed columns only; `raw_json` keeps them.

### D2. Driver and build

`better-sqlite3` exactly `12.9.0` (no caret), plus `@types/better-sqlite3` as dev dependency, both in `package-lock.json`. On the Mac (Node 20.20.2, Debian 12, arm64) 12.9.0 installed from a prebuilt binary; 12.10–12.11.1 had no prebuilt for Node 20 and failed without Python. The Dockerfile stays as is. Task 1.1 verifies `npm ci` in `node:20-bookworm-slim` for both `linux/amd64` (CI) and `linux/arm64` (Mac) without a compiler; if either needs a compile, implementation stops and reports to the owner (no toolchain added, no Node change).

### D3. Dedup keys

| fact_kind | dedup_key |
|---|---|
| `execution` | `exec:` + `execId` |
| `order_state` | `order:` + `orderId` + `:` + `updatedTime` + `:` + `orderStatus` + `:` + `cumExecQty` |

Insert is `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`; the write call reports how many facts were inserted and how many were duplicates. A duplicate is not an error. A fact missing a field its key needs (`execId`, or `orderId`/`updatedTime`/`orderStatus`/`cumExecQty`) is refused with a typed error and nothing in its batch is written.

### D4. Links: append-only, conflicts refused

A link states "this order belongs to (SI, TC) in this role", with the evidence that proved it:

- `abi_order_link_id`: ABI built the entry/close `orderLinkId` itself (known before any exchange call);
- `create_response`: the `orderId` Bybit returned for an order ABI created;
- `parent_order_link_id`: a child row whose `parentOrderLinkId` equals an entry `orderLinkId` already linked.

Rows are never updated or deleted. Inserting an identical link is a duplicate (unique index). Inserting a link whose `order_id` is already linked to a different (SI, TC), or whose role differs for the same `order_id`, is refused with a typed `link_conflict` error in the same transaction; existing rows stay. The same `order_link_id` may appear for several generations only with different `generation` values of the same (SI, TC).

### D5. Transactions and durability

- One store method call = one `BEGIN IMMEDIATE` transaction: a batch of facts (e.g. one REST page) and/or links is written all-or-nothing.
- Pragmas at open: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `locking_mode=EXCLUSIVE`, `busy_timeout=5000`.
- `locking_mode=EXCLUSIVE`: only ABI opens the file (option C). Exclusive mode keeps the WAL index in process memory instead of a shared `-shm` file, so the store does not depend on shared memory or locks across the Docker Desktop file boundary. Consequence: no other process may read the file while ABI runs; backups copy the file only with ABI stopped (RUNBOOK).
- `better-sqlite3` is synchronous; writes are small. Order execution does not call the store in this change.

### D6. Schema versioning

- On open: create the schema if the file is new; if `schema_meta.schema_version` = `1` continue; if it is higher, refuse to start (`exchange_facts_schema_newer`); if `contract` differs, refuse (`exchange_facts_contract_mismatch`).
- The published contract is exactly the two `_v1` tables and `schema_meta`. Any later column or kind change bumps `schema_version` with an explicit migration; consumers read `schema_meta` first.

### D7. Read after cursor (internal)

`readFactsAfter(afterSeq, limit)` returns facts with `event_seq > afterSeq` ordered by `event_seq`, at most `limit` (1–1000), and `readLinksAfter(afterLinkSeq, limit)` the same for links. Used by tests now and by the read API later. `event_seq` is strictly increasing and never reused; gaps are allowed.

### D8. Config and startup

- `ABI_EXCHANGE_FACTS_ENABLED` (`true|false`, default `false`, invalid value fails startup).
- `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts.sqlite3`; in the container `/app/var` = Mac `BBB_data/abi`).
- Enabled: open in `server.ts` before listening; open/migrate failure fails startup; close on graceful shutdown. `service_starting` gains `exchange_facts_store: "disabled" | "enabled"` and, when enabled, `exchange_facts_schema_version`. No path or file contents in events beyond what exists today for the correlation path.

## Risks / Trade-offs

- Exclusive mode blocks any outside reader (sqlite3 CLI on the Mac) while ABI runs: intended; reading goes through the future API.
- A second ABI container on the same folder would corrupt the file because bind-mount locks do not work: operational rule, one ABI per `BBB_data/abi` (already true for the correlation JSONL).
- Disk growth: thousands of rows a day with raw JSON, a few MB per day; no retention in v1.
- Prebuilt binary availability may change upstream: exact pin plus lockfile; CI build is the check.

## Open Questions

None blocking. Fact collection (WS + REST recovery), writes of links from the trading paths, and the read API are the next changes.
