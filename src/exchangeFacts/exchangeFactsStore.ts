import Database from "better-sqlite3";

import { executionDedupKey, orderStateDedupKey } from "./dedup.js";
import { DEDUP_KEY_VERSION, SCHEMA_DDL, SCHEMA_VERSION, STORAGE_SCHEMA } from "./schema.js";

// ABI-internal SQLite store of Bybit exchange facts and orderId -> trade
// cycle links (abi-exchange-facts-sqlite-foundation-v1). Only the ABI process
// opens the file. Nothing in order execution calls this store yet.

export type BybitEnvironment = "demo" | "testnet" | "mainnet";

export type ExchangeFactsOpenFailureReason =
  | "open_failed"
  | "exchange_facts_environment_mismatch"
  | "exchange_facts_unknown_database"
  | "exchange_facts_schema_newer"
  | "exchange_facts_dedup_rule_unknown";

export class ExchangeFactsOpenError extends Error {
  constructor(
    readonly reason: ExchangeFactsOpenFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeFactsOpenError";
  }
}

export type ExchangeFactsWriteErrorCode = "invalid_fact" | "invalid_link" | "link_conflict";

export class ExchangeFactsWriteError extends Error {
  constructor(
    readonly code: ExchangeFactsWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeFactsWriteError";
  }
}

export type FactKind = "order_state" | "execution";
export type FactSource = "ws" | "rest";

export type FactInput = {
  kind: FactKind;
  source: FactSource;
  // e.g. "ws:order", "rest:/v5/execution/list"
  sourceEndpoint: string;
  // One Bybit record (not a page) exactly as received.
  rawJson: string;
  receivedAtMs: number;
};

export type StoredFact = {
  eventSeq: number;
  kind: FactKind;
  source: FactSource;
  sourceEndpoint: string;
  symbol: string;
  orderId: string | null;
  orderLinkId: string | null;
  parentOrderLinkId: string | null;
  execId: string | null;
  execType: string | null;
  orderStatus: string | null;
  exchangeTimeMs: number | null;
  receivedAtMs: number;
  dedupKey: string;
  rawJson: string;
};

export type LinkRole = "entry" | "close" | "stop_loss" | "take_profit";
export type LinkEvidence = "create_response" | "own_order_link_id_lookup" | "parent_order_link_id";

// An order ABI created itself, with its own deterministic orderLinkId.
export type OwnOrderLinkInput = {
  kind: "own";
  orderId: string;
  strategyInstanceId: string;
  tradeCycleId: string;
  role: "entry" | "close";
  generation: number;
  orderLinkId: string;
  evidence: "create_response" | "own_order_link_id_lookup";
  establishedAtMs: number;
};

// An order Bybit created (Partial SL/TP child), attributed only through its
// parentOrderLinkId to an existing entry link.
export type ChildOrderLinkInput = {
  kind: "child";
  orderId: string;
  role: "stop_loss" | "take_profit";
  parentOrderLinkId: string;
  establishedAtMs: number;
};

export type LinkInput = OwnOrderLinkInput | ChildOrderLinkInput;

export type LinkOutcome = "inserted" | "duplicate" | "parent_not_found" | "parent_ambiguous";

export type StoredLink = {
  linkSeq: number;
  orderId: string;
  strategyInstanceId: string;
  tradeCycleId: string;
  role: LinkRole;
  generation: number;
  orderLinkId: string | null;
  parentOrderLinkId: string | null;
  evidence: LinkEvidence;
  establishedAtMs: number;
};

export type FactWriteResult = { inserted: number; duplicates: number };

const MAX_READ_LIMIT = 1000;

type FactRow = {
  event_seq: number;
  fact_kind: FactKind;
  source: FactSource;
  source_endpoint: string;
  symbol: string;
  order_id: string | null;
  order_link_id: string | null;
  parent_order_link_id: string | null;
  exec_id: string | null;
  exec_type: string | null;
  order_status: string | null;
  exchange_time_ms: number | null;
  received_at_ms: number;
  dedup_key: string;
  raw_json: string;
};

type LinkRow = {
  link_seq: number;
  order_id: string;
  strategy_instance_id: string;
  trade_cycle_id: string;
  role: LinkRole;
  generation: number;
  order_link_id: string | null;
  parent_order_link_id: string | null;
  evidence: LinkEvidence;
  established_at_ms: number;
};

export class ExchangeFactsStore {
  private constructor(private readonly db: Database.Database) {}

  // Opens or creates the database of one Bybit environment (design D6, D7).
  // Any failure closes the handle and throws ExchangeFactsOpenError.
  static open(input: { path: string; bybitEnvironment: BybitEnvironment; category: string }): ExchangeFactsStore {
    let db: Database.Database;
    try {
      db = new Database(input.path);
    } catch (error) {
      throw new ExchangeFactsOpenError("open_failed", `cannot open exchange facts database: ${describe(error)}`);
    }

    try {
      // EXCLUSIVE before the first WAL access keeps the WAL index in process
      // memory: no -shm file, no shared memory across the Docker Desktop file
      // boundary. It is not a guard against a second process (one ABI per
      // data directory is an operational rule).
      db.pragma("locking_mode = EXCLUSIVE");
      const journalMode = db.pragma("journal_mode = WAL", { simple: true });
      if (journalMode !== "wal") {
        throw new ExchangeFactsOpenError("open_failed", `journal_mode is ${String(journalMode)}, expected wal`);
      }
      db.pragma("synchronous = FULL");
      db.pragma("busy_timeout = 5000");

      initializeOrCheck(db, input.bybitEnvironment, input.category);
      return new ExchangeFactsStore(db);
    } catch (error) {
      db.close();
      if (error instanceof ExchangeFactsOpenError) {
        throw error;
      }
      throw new ExchangeFactsOpenError("open_failed", `cannot open exchange facts database: ${describe(error)}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // One call = one transaction: every fact is stored or none (design D4, D7).
  writeFacts(facts: readonly FactInput[]): FactWriteResult {
    const insert = this.db.prepare(
      `INSERT INTO exchange_facts (
         fact_kind, source, source_endpoint, symbol, order_id, order_link_id, parent_order_link_id,
         exec_id, exec_type, order_status, exchange_time_ms, received_at_ms, dedup_key, raw_json
       ) VALUES (
         @fact_kind, @source, @source_endpoint, @symbol, @order_id, @order_link_id, @parent_order_link_id,
         @exec_id, @exec_type, @order_status, @exchange_time_ms, @received_at_ms, @dedup_key, @raw_json
       ) ON CONFLICT(dedup_key) DO NOTHING`,
    );

    const run = this.db.transaction((items: readonly FactInput[]): FactWriteResult => {
      let inserted = 0;
      for (const fact of items) {
        inserted += insert.run(toFactRow(fact)).changes;
      }
      return { inserted, duplicates: items.length - inserted };
    });

    return run.immediate(facts);
  }

  // One call = one transaction. link_conflict and invalid input abort the
  // whole call; a child whose parent is unknown or ambiguous is simply not
  // linked (design D5).
  writeLinks(links: readonly LinkInput[]): LinkOutcome[] {
    const findByOrderId = this.db.prepare<[string], LinkRow>("SELECT * FROM order_links WHERE order_id = ?");
    const findEntryParents = this.db.prepare<[string], Pick<LinkRow, "strategy_instance_id" | "trade_cycle_id" | "generation">>(
      `SELECT DISTINCT strategy_instance_id, trade_cycle_id, generation
         FROM order_links WHERE role = 'entry' AND order_link_id = ?`,
    );
    const nextLinkSeq = this.db.prepare<[], { next: number }>(
      "SELECT COALESCE(MAX(link_seq), 0) + 1 AS next FROM order_links",
    );
    const insert = this.db.prepare(
      `INSERT INTO order_links (
         link_seq, order_id, strategy_instance_id, trade_cycle_id, role, generation,
         order_link_id, parent_order_link_id, evidence, established_at_ms
       ) VALUES (
         @link_seq, @order_id, @strategy_instance_id, @trade_cycle_id, @role, @generation,
         @order_link_id, @parent_order_link_id, @evidence, @established_at_ms
       )`,
    );

    const run = this.db.transaction((items: readonly LinkInput[]): LinkOutcome[] =>
      items.map((link) => {
        validateLink(link);

        let row: Omit<LinkRow, "link_seq">;
        if (link.kind === "own") {
          row = {
            order_id: link.orderId,
            strategy_instance_id: link.strategyInstanceId,
            trade_cycle_id: link.tradeCycleId,
            role: link.role,
            generation: link.generation,
            order_link_id: link.orderLinkId,
            parent_order_link_id: null,
            evidence: link.evidence,
            established_at_ms: link.establishedAtMs,
          };
        } else {
          // An existing link is answered from its own orderId first, so a
          // repeated child never depends on the current state of its parent.
          const known = findByOrderId.get(link.orderId);
          if (known !== undefined) {
            if (known.role === link.role && known.parent_order_link_id === link.parentOrderLinkId) {
              return "duplicate";
            }
            throw new ExchangeFactsWriteError(
              "link_conflict",
              `order ${link.orderId} is already linked to another cycle, role or parent`,
            );
          }

          const parents = findEntryParents.all(link.parentOrderLinkId);
          if (parents.length === 0) {
            return "parent_not_found";
          }
          if (parents.length > 1) {
            return "parent_ambiguous";
          }
          const parent = parents[0];
          row = {
            order_id: link.orderId,
            strategy_instance_id: parent.strategy_instance_id,
            trade_cycle_id: parent.trade_cycle_id,
            role: link.role,
            generation: parent.generation,
            order_link_id: null,
            parent_order_link_id: link.parentOrderLinkId,
            evidence: "parent_order_link_id",
            established_at_ms: link.establishedAtMs,
          };
        }

        const existing = findByOrderId.get(row.order_id);
        if (existing !== undefined) {
          if (sameAttribution(existing, row)) {
            return "duplicate";
          }
          throw new ExchangeFactsWriteError(
            "link_conflict",
            `order ${row.order_id} is already linked to another cycle, role or generation`,
          );
        }

        insert.run({ ...row, link_seq: nextLinkSeq.get()!.next });
        return "inserted";
      }),
    );

    return run.immediate(links);
  }

  readFactsAfter(afterEventSeq: number, limit: number): StoredFact[] {
    const rows = this.db
      .prepare<[number, number], FactRow>(
        "SELECT * FROM exchange_facts WHERE event_seq > ? ORDER BY event_seq ASC LIMIT ?",
      )
      .all(afterEventSeq, checkedLimit(limit));
    return rows.map(fromFactRow);
  }

  readLinksAfter(afterLinkSeq: number, limit: number): StoredLink[] {
    const rows = this.db
      .prepare<[number, number], LinkRow>(
        "SELECT * FROM order_links WHERE link_seq > ? ORDER BY link_seq ASC LIMIT ?",
      )
      .all(afterLinkSeq, checkedLimit(limit));
    return rows.map(fromLinkRow);
  }
}

function initializeOrCheck(db: Database.Database, bybitEnvironment: BybitEnvironment, category: string): void {
  const tables = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

  if (tables.length === 0) {
    db.transaction(() => {
      db.exec(SCHEMA_DDL);
      const setMeta = db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)");
      setMeta.run("storage_schema", STORAGE_SCHEMA);
      setMeta.run("schema_version", String(SCHEMA_VERSION));
      setMeta.run("dedup_key_version", String(DEDUP_KEY_VERSION));
      setMeta.run("bybit_env", bybitEnvironment);
      setMeta.run("category", category);
    }).immediate();
    return;
  }

  if (!tables.includes("schema_meta")) {
    throw new ExchangeFactsOpenError("exchange_facts_unknown_database", "database has tables but no schema_meta");
  }

  const meta = new Map(
    db
      .prepare<[], { key: string; value: string }>("SELECT key, value FROM schema_meta")
      .all()
      .map((row) => [row.key, row.value]),
  );

  if (meta.get("storage_schema") !== STORAGE_SCHEMA) {
    throw new ExchangeFactsOpenError("exchange_facts_unknown_database", "database is not an ABI exchange facts store");
  }

  const version = Number(meta.get("schema_version"));
  if (Number.isInteger(version) && version > SCHEMA_VERSION) {
    throw new ExchangeFactsOpenError(
      "exchange_facts_schema_newer",
      `database schema_version ${version} is newer than ${SCHEMA_VERSION}`,
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw new ExchangeFactsOpenError("exchange_facts_unknown_database", "database schema_version is not recognized");
  }

  if (meta.get("dedup_key_version") !== String(DEDUP_KEY_VERSION)) {
    throw new ExchangeFactsOpenError(
      "exchange_facts_dedup_rule_unknown",
      "database dedup_key_version is not recognized",
    );
  }

  if (meta.get("bybit_env") !== bybitEnvironment || meta.get("category") !== category) {
    throw new ExchangeFactsOpenError(
      "exchange_facts_environment_mismatch",
      `database belongs to ${meta.get("bybit_env")}/${meta.get("category")}, ABI runs ${bybitEnvironment}/${category}`,
    );
  }
}

function toFactRow(fact: FactInput): Omit<FactRow, "event_seq"> {
  if (fact.kind !== "order_state" && fact.kind !== "execution") {
    throw new ExchangeFactsWriteError("invalid_fact", "fact kind must be order_state or execution");
  }
  if (fact.source !== "ws" && fact.source !== "rest") {
    throw new ExchangeFactsWriteError("invalid_fact", "fact source must be ws or rest");
  }
  if (fact.sourceEndpoint.trim() === "") {
    throw new ExchangeFactsWriteError("invalid_fact", "fact sourceEndpoint must not be empty");
  }
  if (!Number.isSafeInteger(fact.receivedAtMs) || fact.receivedAtMs <= 0) {
    throw new ExchangeFactsWriteError("invalid_fact", "fact receivedAtMs must be a positive integer");
  }

  let record: unknown;
  try {
    record = JSON.parse(fact.rawJson);
  } catch {
    throw new ExchangeFactsWriteError("invalid_fact", "fact rawJson is not valid JSON");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new ExchangeFactsWriteError("invalid_fact", "fact rawJson must be one JSON object");
  }
  const item = record as Record<string, unknown>;

  const symbol = identifier(item.symbol);
  if (symbol === null) {
    throw new ExchangeFactsWriteError("invalid_fact", "fact has no symbol");
  }

  const orderId = identifier(item.orderId);
  const base = {
    fact_kind: fact.kind,
    source: fact.source,
    source_endpoint: fact.sourceEndpoint,
    symbol,
    order_id: orderId,
    order_link_id: identifier(item.orderLinkId),
    parent_order_link_id: identifier(item.parentOrderLinkId),
    received_at_ms: fact.receivedAtMs,
    raw_json: fact.rawJson,
  };

  if (fact.kind === "execution") {
    const execId = identifier(item.execId);
    if (execId === null) {
      throw new ExchangeFactsWriteError("invalid_fact", "execution fact has no execId");
    }
    return {
      ...base,
      exec_id: execId,
      exec_type: identifier(item.execType),
      order_status: null,
      exchange_time_ms: epochMs(item.execTime),
      dedup_key: executionDedupKey(execId),
    };
  }

  const updatedTime = identifier(item.updatedTime);
  if (orderId === null || updatedTime === null || epochMs(updatedTime) === null) {
    throw new ExchangeFactsWriteError("invalid_fact", "order_state fact needs orderId and a numeric updatedTime");
  }
  return {
    ...base,
    exec_id: null,
    exec_type: null,
    order_status: identifier(item.orderStatus),
    exchange_time_ms: epochMs(updatedTime),
    dedup_key: orderStateDedupKey(item, orderId, updatedTime),
  };
}

function validateLink(link: LinkInput): void {
  const required: unknown[] =
    link.kind === "own"
      ? [link.orderId, link.strategyInstanceId, link.tradeCycleId, link.orderLinkId]
      : [link.orderId, link.parentOrderLinkId];
  if (required.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new ExchangeFactsWriteError("invalid_link", "link identifiers must be non-empty strings");
  }
  if (link.kind === "own" && (!Number.isSafeInteger(link.generation) || link.generation < 1)) {
    throw new ExchangeFactsWriteError("invalid_link", "link generation must be a positive integer");
  }
  if (!Number.isSafeInteger(link.establishedAtMs) || link.establishedAtMs <= 0) {
    throw new ExchangeFactsWriteError("invalid_link", "link establishedAtMs must be a positive integer");
  }
}

// Evidence may differ (create response, then a lookup): same attribution.
function sameAttribution(existing: LinkRow, row: Omit<LinkRow, "link_seq">): boolean {
  return (
    existing.strategy_instance_id === row.strategy_instance_id &&
    existing.trade_cycle_id === row.trade_cycle_id &&
    existing.role === row.role &&
    existing.generation === row.generation &&
    existing.order_link_id === row.order_link_id &&
    existing.parent_order_link_id === row.parent_order_link_id
  );
}

// Bybit sends "" for an absent identifier; indexed columns store NULL.
function identifier(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value);
  return text === "" ? null : text;
}

function epochMs(value: unknown): number | null {
  const text = identifier(value);
  if (text === null || !/^\d+$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_READ_LIMIT}`);
  }
  return limit;
}

function fromFactRow(row: FactRow): StoredFact {
  return {
    eventSeq: row.event_seq,
    kind: row.fact_kind,
    source: row.source,
    sourceEndpoint: row.source_endpoint,
    symbol: row.symbol,
    orderId: row.order_id,
    orderLinkId: row.order_link_id,
    parentOrderLinkId: row.parent_order_link_id,
    execId: row.exec_id,
    execType: row.exec_type,
    orderStatus: row.order_status,
    exchangeTimeMs: row.exchange_time_ms,
    receivedAtMs: row.received_at_ms,
    dedupKey: row.dedup_key,
    rawJson: row.raw_json,
  };
}

function fromLinkRow(row: LinkRow): StoredLink {
  return {
    linkSeq: row.link_seq,
    orderId: row.order_id,
    strategyInstanceId: row.strategy_instance_id,
    tradeCycleId: row.trade_cycle_id,
    role: row.role,
    generation: row.generation,
    orderLinkId: row.order_link_id,
    parentOrderLinkId: row.parent_order_link_id,
    evidence: row.evidence,
    establishedAtMs: row.established_at_ms,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
