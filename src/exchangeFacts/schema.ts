// ABI-internal storage schema of the exchange facts store
// (abi-exchange-facts-sqlite-foundation-v1, design D1). Not an inter-service
// contract: the future read-only HTTP API is the only one.

export const STORAGE_SCHEMA = "abi-exchange-facts-storage";
export const SCHEMA_VERSION = 1;
export const DEDUP_KEY_VERSION = 1;

export const SCHEMA_DDL = `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE exchange_facts (
  event_seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_kind             TEXT NOT NULL CHECK (fact_kind IN ('order_state','execution')),
  source                TEXT NOT NULL CHECK (source IN ('ws','rest')),
  source_endpoint       TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  order_id              TEXT,
  order_link_id         TEXT,
  parent_order_link_id  TEXT,
  exec_id               TEXT,
  exec_type             TEXT,
  order_status          TEXT,
  exchange_time_ms      INTEGER,
  received_at_ms        INTEGER NOT NULL,
  dedup_key             TEXT NOT NULL UNIQUE,
  raw_json              TEXT NOT NULL
);
CREATE INDEX exchange_facts_order_id      ON exchange_facts(order_id);
CREATE INDEX exchange_facts_order_link_id ON exchange_facts(order_link_id);
CREATE INDEX exchange_facts_parent_link   ON exchange_facts(parent_order_link_id);
CREATE INDEX exchange_facts_exec_type     ON exchange_facts(exec_type);

CREATE TABLE order_links (
  link_seq              INTEGER NOT NULL UNIQUE,
  order_id              TEXT PRIMARY KEY,
  strategy_instance_id  TEXT NOT NULL,
  trade_cycle_id        TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('entry','close','stop_loss','take_profit')),
  generation            INTEGER NOT NULL,
  order_link_id         TEXT,
  parent_order_link_id  TEXT,
  evidence              TEXT NOT NULL CHECK (evidence IN
                          ('create_response','own_order_link_id_lookup','parent_order_link_id')),
  established_at_ms     INTEGER NOT NULL,
  CHECK ((role IN ('entry','close') AND order_link_id IS NOT NULL AND parent_order_link_id IS NULL)
      OR (role IN ('stop_loss','take_profit') AND order_link_id IS NULL AND parent_order_link_id IS NOT NULL))
);
CREATE INDEX order_links_cycle         ON order_links(strategy_instance_id, trade_cycle_id);
CREATE INDEX order_links_order_link_id ON order_links(order_link_id);
CREATE INDEX order_links_parent_link   ON order_links(parent_order_link_id);
`;
