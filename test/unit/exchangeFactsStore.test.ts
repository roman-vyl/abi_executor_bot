import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { normalizeFingerprintValue } from "../../src/exchangeFacts/dedup.js";
import {
  ExchangeFactsOpenError,
  ExchangeFactsStore,
  ExchangeFactsWriteError,
  type FactInput,
} from "../../src/exchangeFacts/exchangeFactsStore.js";
import {
  ENTRY_EXECUTION_RECORD,
  ENTRY_ORDER_ID,
  ENTRY_ORDER_LINK_ID,
  ENTRY_ORDER_RECORD,
  FUNDING_EXECUTION_RECORD,
  SL_CHILD_RECORD,
  SL_EXECUTION_RECORD,
  SL_ORDER_ID,
  TP_CHILD_RECORD,
  TP_ORDER_ID,
} from "../fixtures/exchangeFacts6072511f.js";

const SI = "6072511f-strategy-instance";
const TC = "f7b4cce7-trade-cycle";

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-facts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openDemo(dbPath: string): ExchangeFactsStore {
  return ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "linear" });
}

function fact(kind: FactInput["kind"], rawJson: string, source: FactInput["source"] = "rest"): FactInput {
  return {
    kind,
    source,
    sourceEndpoint: source === "rest" ? (kind === "execution" ? "rest:/v5/execution/list" : "rest:/v5/order/history") : `ws:${kind === "execution" ? "execution" : "order"}`,
    rawJson,
    receivedAtMs: 1_792_950_000_000,
  };
}

function withFields(rawJson: string, changes: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(rawJson), ...changes });
}

function assertOpenFails(dbPath: string, env: "demo" | "testnet" | "mainnet", reason: string): void {
  assert.throws(
    () => ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: env, category: "linear" }),
    (error: unknown) => error instanceof ExchangeFactsOpenError && error.reason === reason,
  );
}

test("new database gets the schema and environment meta, and no -shm file while open", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const store = openDemo(dbPath);
  assert.equal(existsSync(`${dbPath}-shm`), false);
  store.close();

  const db = new Database(dbPath, { readonly: true });
  const meta = Object.fromEntries(
    db.prepare<[], { key: string; value: string }>("SELECT key, value FROM schema_meta").all().map((r) => [r.key, r.value]),
  );
  db.close();
  assert.deepEqual(meta, {
    storage_schema: "abi-exchange-facts-storage",
    schema_version: "2",
    dedup_key_version: "1",
    snapshot_key_version: "1",
    bybit_env: "demo",
    category: "linear",
  });
});

test("reopening a v2 database of the same environment keeps every row", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const first = openDemo(dbPath);
  first.writeFacts([fact("order_state", ENTRY_ORDER_RECORD)]);
  first.close();

  const second = openDemo(dbPath);
  assert.equal(second.readFactsAfter(0, 10).length, 1);
  second.close();
});

// Turns a fresh v2 file into the exact v1 layout (v1 tables, v1 meta).
function downgradeToV1(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec("DROP TABLE account_snapshots; DROP TABLE stream_connection_log;");
  db.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'").run();
  db.prepare("DELETE FROM schema_meta WHERE key = 'snapshot_key_version'").run();
  db.close();
}

test("a v1 database is upgraded to v2 in place and keeps every row", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const first = openDemo(dbPath);
  first.writeFacts([fact("order_state", ENTRY_ORDER_RECORD), fact("execution", ENTRY_EXECUTION_RECORD)]);
  first.close();
  downgradeToV1(dbPath);

  const upgraded = openDemo(dbPath);
  assert.equal(upgraded.readFactsAfter(0, 10).length, 2);
  upgraded.writeStreamBatch({
    facts: [],
    snapshots: [],
    logs: [{ atMs: 1_793_100_000_000, event: "connecting", connId: null, detail: null }],
  });
  assert.equal(upgraded.readConnectionLogAfter(0, 10).length, 1);
  upgraded.close();

  const db = new Database(dbPath, { readonly: true });
  const meta = Object.fromEntries(
    db.prepare<[], { key: string; value: string }>("SELECT key, value FROM schema_meta").all().map((r) => [r.key, r.value]),
  );
  db.close();
  assert.equal(meta.schema_version, "2");
  assert.equal(meta.snapshot_key_version, "1");
});

test("a v1 database of another environment is refused and not upgraded", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  openDemo(dbPath).close();
  downgradeToV1(dbPath);
  assertOpenFails(dbPath, "mainnet", "exchange_facts_environment_mismatch");

  const db = new Database(dbPath, { readonly: true });
  const version = db.prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  const tables = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_snapshots'")
    .all();
  db.close();
  assert.equal(version?.value, "1");
  assert.equal(tables.length, 0);
});

test("a database of another environment is refused and left unchanged", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const store = openDemo(dbPath);
  store.writeFacts([fact("order_state", ENTRY_ORDER_RECORD)]);
  store.close();

  assertOpenFails(dbPath, "mainnet", "exchange_facts_environment_mismatch");
  assert.throws(
    () => ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "inverse" }),
    (error: unknown) => error instanceof ExchangeFactsOpenError && error.reason === "exchange_facts_environment_mismatch",
  );

  const reopened = openDemo(dbPath);
  assert.equal(reopened.readFactsAfter(0, 10).length, 1);
  reopened.close();
});

test("a file with tables but no schema_meta is refused", (t) => {
  const dbPath = path.join(tempDir(t), "foreign.sqlite3");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE something (id INTEGER)");
  db.close();
  assertOpenFails(dbPath, "demo", "exchange_facts_unknown_database");
});

test("a newer schema version and an unknown dedup rule are refused", (t) => {
  const dir = tempDir(t);
  for (const [key, value, reason] of [
    ["schema_version", "3", "exchange_facts_schema_newer"],
    ["dedup_key_version", "2", "exchange_facts_dedup_rule_unknown"],
    ["snapshot_key_version", "2", "exchange_facts_dedup_rule_unknown"],
  ] as const) {
    const dbPath = path.join(dir, `${key}.sqlite3`);
    openDemo(dbPath).close();
    const db = new Database(dbPath);
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run(value, key);
    db.close();
    assertOpenFails(dbPath, "demo", reason);
  }
});

test("raw records are stored byte for byte and identifiers are indexed", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const records: FactInput[] = [
    fact("order_state", ENTRY_ORDER_RECORD),
    fact("order_state", SL_CHILD_RECORD),
    fact("order_state", TP_CHILD_RECORD),
    fact("execution", ENTRY_EXECUTION_RECORD),
    fact("execution", SL_EXECUTION_RECORD),
    fact("execution", FUNDING_EXECUTION_RECORD),
  ];
  assert.deepEqual(store.writeFacts(records), { inserted: 6, duplicates: 0 });

  const stored = store.readFactsAfter(0, 100);
  assert.deepEqual(
    stored.map((row) => row.rawJson),
    records.map((record) => record.rawJson),
  );

  const [entry, sl, tp, entryExec, slExec, funding] = stored;
  assert.equal(entry.orderLinkId, ENTRY_ORDER_LINK_ID);
  assert.equal(entry.parentOrderLinkId, null);
  assert.equal(entry.exchangeTimeMs, 1_792_939_843_423);
  assert.equal(sl.orderLinkId, null);
  assert.equal(sl.parentOrderLinkId, ENTRY_ORDER_LINK_ID);
  assert.equal(tp.orderStatus, "Deactivated");
  assert.equal(entryExec.execType, "Trade");
  assert.equal(entryExec.exchangeTimeMs, 1_792_939_843_422);
  assert.equal(slExec.orderLinkId, null);
  assert.equal(slExec.orderId, SL_ORDER_ID);
  assert.equal(funding.kind, "execution");
  assert.equal(funding.execType, "Funding");
  assert.equal(funding.orderLinkId, null);
});

test("the same fill from ws and then rest is stored once", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  assert.deepEqual(store.writeFacts([fact("execution", ENTRY_EXECUTION_RECORD, "ws")]), { inserted: 1, duplicates: 0 });
  const restShape = withFields(ENTRY_EXECUTION_RECORD, { category: undefined, blockTradeId: "" });
  assert.deepEqual(store.writeFacts([fact("execution", restShape, "rest")]), { inserted: 0, duplicates: 1 });
  const stored = store.readFactsAfter(0, 10);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "ws");
});

test("the same order snapshot from two sources with 3.8180 and 3.818 is one fact", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const wsShape = withFields(ENTRY_ORDER_RECORD, { category: "linear", qty: "3.8180", cumExecQty: "3.8180" });
  assert.deepEqual(store.writeFacts([fact("order_state", wsShape, "ws")]), { inserted: 1, duplicates: 0 });
  assert.deepEqual(store.writeFacts([fact("order_state", ENTRY_ORDER_RECORD, "rest")]), { inserted: 0, duplicates: 1 });
});

test("a stop moved with the same status, cumExecQty and updatedTime is kept", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const untriggered = withFields(SL_CHILD_RECORD, {
    orderStatus: "Untriggered",
    cumExecQty: "0",
    updatedTime: "1792940000000",
  });
  const moved = withFields(untriggered, { triggerPrice: "80700" });
  assert.deepEqual(store.writeFacts([fact("order_state", untriggered), fact("order_state", moved)]), {
    inserted: 2,
    duplicates: 0,
  });
});

test("orderLinkId is not a dedup key: two orders sharing it are both stored", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const retry = withFields(ENTRY_ORDER_RECORD, { orderId: "retry-order-id" });
  assert.deepEqual(store.writeFacts([fact("order_state", ENTRY_ORDER_RECORD), fact("order_state", retry)]), {
    inserted: 2,
    duplicates: 0,
  });
});

test("a batch with an execution lacking execId stores nothing", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const broken = withFields(SL_EXECUTION_RECORD, { execId: "" });
  assert.throws(
    () => store.writeFacts([fact("execution", ENTRY_EXECUTION_RECORD), fact("execution", broken)]),
    (error: unknown) => error instanceof ExchangeFactsWriteError && error.code === "invalid_fact",
  );
  assert.equal(store.readFactsAfter(0, 10).length, 0);

  store.writeFacts([fact("execution", ENTRY_EXECUTION_RECORD)]);
  assert.equal(store.readFactsAfter(0, 10).length, 1);
});

test("an entry and its two children are linked to one cycle and attribute their facts", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const outcomes = store.writeLinks([
    {
      kind: "own",
      orderId: ENTRY_ORDER_ID,
      strategyInstanceId: SI,
      tradeCycleId: TC,
      role: "entry",
      generation: 5,
      orderLinkId: ENTRY_ORDER_LINK_ID,
      evidence: "create_response",
      establishedAtMs: 1_792_939_809_500,
    },
    { kind: "child", orderId: SL_ORDER_ID, role: "stop_loss", parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 1_792_939_843_500 },
    { kind: "child", orderId: TP_ORDER_ID, role: "take_profit", parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 1_792_939_843_500 },
  ]);
  assert.deepEqual(outcomes, ["inserted", "inserted", "inserted"]);

  const links = store.readLinksAfter(0, 10);
  assert.deepEqual(
    links.map((link) => [link.linkSeq, link.role, link.strategyInstanceId, link.tradeCycleId, link.generation, link.evidence]),
    [
      [1, "entry", SI, TC, 5, "create_response"],
      [2, "stop_loss", SI, TC, 5, "parent_order_link_id"],
      [3, "take_profit", SI, TC, 5, "parent_order_link_id"],
    ],
  );

  store.writeFacts([fact("execution", SL_EXECUTION_RECORD), fact("execution", FUNDING_EXECUTION_RECORD)]);
  const byOrderId = new Map(links.map((link) => [link.orderId, link]));
  const [slFill, funding] = store.readFactsAfter(0, 10);
  assert.equal(byOrderId.get(slFill.orderId!)?.tradeCycleId, TC);
  assert.equal(byOrderId.get(funding.orderId!), undefined);
});

test("an identical link is a duplicate, a different cycle is a link_conflict", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const link = {
    kind: "own" as const,
    orderId: ENTRY_ORDER_ID,
    strategyInstanceId: SI,
    tradeCycleId: TC,
    role: "entry" as const,
    generation: 5,
    orderLinkId: ENTRY_ORDER_LINK_ID,
    evidence: "create_response" as const,
    establishedAtMs: 1_792_939_809_500,
  };
  assert.deepEqual(store.writeLinks([link]), ["inserted"]);
  assert.deepEqual(store.writeLinks([{ ...link, evidence: "own_order_link_id_lookup" }]), ["duplicate"]);
  assert.throws(
    () => store.writeLinks([{ ...link, tradeCycleId: "another-cycle" }]),
    (error: unknown) => error instanceof ExchangeFactsWriteError && error.code === "link_conflict",
  );
  const links = store.readLinksAfter(0, 10);
  assert.equal(links.length, 1);
  assert.equal(links[0].tradeCycleId, TC);
});

test("two orderIds with the same orderLinkId are both linked to the cycle", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const base = {
    kind: "own" as const,
    strategyInstanceId: SI,
    tradeCycleId: TC,
    role: "entry" as const,
    generation: 5,
    orderLinkId: ENTRY_ORDER_LINK_ID,
    evidence: "create_response" as const,
    establishedAtMs: 1_792_939_809_500,
  };
  assert.deepEqual(
    store.writeLinks([
      { ...base, orderId: ENTRY_ORDER_ID },
      { ...base, orderId: "retry-order-id", evidence: "own_order_link_id_lookup" },
    ]),
    ["inserted", "inserted"],
  );
  // A child of that orderLinkId still resolves to one cycle.
  assert.deepEqual(
    store.writeLinks([{ kind: "child", orderId: SL_ORDER_ID, role: "stop_loss", parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 1 }]),
    ["inserted"],
  );
});

test("a child without a known parent or with an ambiguous parent is not linked", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  assert.deepEqual(
    store.writeLinks([{ kind: "child", orderId: SL_ORDER_ID, role: "stop_loss", parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 1 }]),
    ["parent_not_found"],
  );

  const own = {
    kind: "own" as const,
    role: "entry" as const,
    generation: 1,
    orderLinkId: "abi-ep-shared-link-id",
    evidence: "create_response" as const,
    establishedAtMs: 1,
    strategyInstanceId: SI,
  };
  store.writeLinks([
    { ...own, orderId: "order-a", tradeCycleId: "cycle-a" },
    { ...own, orderId: "order-b", tradeCycleId: "cycle-b" },
  ]);
  assert.deepEqual(
    store.writeLinks([{ kind: "child", orderId: "child-x", role: "take_profit", parentOrderLinkId: "abi-ep-shared-link-id", establishedAtMs: 1 }]),
    ["parent_ambiguous"],
  );
  assert.equal(store.readLinksAfter(0, 10).length, 2);
});

test("event_seq and link_seq keep growing across a reopen, and a late fill is read after the cursor", (t) => {
  const dbPath = path.join(tempDir(t), "facts.sqlite3");
  const first = openDemo(dbPath);
  first.writeFacts([fact("execution", SL_EXECUTION_RECORD)]);
  first.writeLinks([
    {
      kind: "own",
      orderId: ENTRY_ORDER_ID,
      strategyInstanceId: SI,
      tradeCycleId: TC,
      role: "entry",
      generation: 5,
      orderLinkId: ENTRY_ORDER_LINK_ID,
      evidence: "create_response",
      establishedAtMs: 1,
    },
  ]);
  const cursor = first.readFactsAfter(0, 10).at(-1)!.eventSeq;
  first.close();

  const second = openDemo(dbPath);
  t.after(() => second.close());
  // Earlier exchange time than the fill already read, stored later.
  second.writeFacts([fact("execution", ENTRY_EXECUTION_RECORD)]);
  second.writeLinks([{ kind: "child", orderId: SL_ORDER_ID, role: "stop_loss", parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 2 }]);

  const after = second.readFactsAfter(cursor, 10);
  assert.equal(after.length, 1);
  assert.ok(after[0].eventSeq > cursor);
  assert.equal(after[0].execId, "cada68b5-4729-4d46-9e95-1a9bd6c71e59");
  assert.deepEqual(
    second.readLinksAfter(0, 10).map((link) => link.linkSeq),
    [1, 2],
  );
});

test("read limits outside 1..1000 are refused", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());
  assert.throws(() => store.readFactsAfter(0, 0), RangeError);
  assert.throws(() => store.readLinksAfter(0, 1001), RangeError);
});

test("fingerprint normalization only trims fractional zeros", () => {
  assert.equal(normalizeFingerprintValue("3.8180"), "3.818");
  assert.equal(normalizeFingerprintValue("0.00"), "0");
  assert.equal(normalizeFingerprintValue("80750"), "80750");
  assert.equal(normalizeFingerprintValue("100"), "100");
  assert.equal(normalizeFingerprintValue(""), "");
  assert.equal(normalizeFingerprintValue(undefined), "");
  assert.equal(normalizeFingerprintValue("Filled"), "Filled");
});

test("a repeated child is answered from its own orderId, not from its parent", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const own = {
    kind: "own" as const,
    strategyInstanceId: SI,
    role: "entry" as const,
    generation: 1,
    orderLinkId: ENTRY_ORDER_LINK_ID,
    evidence: "create_response" as const,
    establishedAtMs: 1,
  };
  const child = { kind: "child" as const, orderId: SL_ORDER_ID, role: "stop_loss" as const, parentOrderLinkId: ENTRY_ORDER_LINK_ID, establishedAtMs: 2 };
  store.writeLinks([{ ...own, orderId: ENTRY_ORDER_ID, tradeCycleId: TC }]);
  assert.deepEqual(store.writeLinks([child]), ["inserted"]);

  // The parent orderLinkId becomes ambiguous later; the known child stays a duplicate.
  store.writeLinks([{ ...own, orderId: "other-entry", tradeCycleId: "other-cycle" }]);
  assert.deepEqual(store.writeLinks([child]), ["duplicate"]);

  // The same orderId as a different role is still a conflict.
  assert.throws(
    () => store.writeLinks([{ ...child, role: "take_profit" }]),
    (error: unknown) => error instanceof ExchangeFactsWriteError && error.code === "link_conflict",
  );
});

test("position and wallet snapshots are stored raw and deduplicated by their keys", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  const position = JSON.stringify({ symbol: "XRPUSDT", positionIdx: 0, seq: 140698842507866, size: "0", updatedTime: "1793105274204" });
  const wallet = JSON.stringify({ accountType: "UNIFIED", totalEquity: "99876.5" });
  const batch = {
    facts: [],
    snapshots: [
      { kind: "position" as const, source: "ws" as const, sourceEndpoint: "ws:position", rawJson: position, receivedAtMs: 1_793_105_274_300 },
      {
        kind: "wallet" as const,
        source: "ws" as const,
        sourceEndpoint: "ws:wallet",
        rawJson: wallet,
        receivedAtMs: 1_793_105_274_300,
        frameCreationTimeMs: 1_793_105_274_205,
      },
    ],
    logs: [],
  };
  assert.deepEqual(store.writeStreamBatch(batch).snapshots, { inserted: 2, duplicates: 0 });
  assert.deepEqual(store.writeStreamBatch(batch).snapshots, { inserted: 0, duplicates: 2 });

  const stored = store.readSnapshotsAfter(0, 10);
  assert.equal(stored[0].dedupKey, "pos:XRPUSDT:0:140698842507866");
  assert.equal(stored[0].exchangeTimeMs, 1_793_105_274_204);
  assert.equal(stored[0].rawJson, position);
  assert.equal(stored[1].symbol, null);
  assert.equal(stored[1].exchangeTimeMs, 1_793_105_274_205);
  assert.match(stored[1].dedupKey, /^wallet:UNIFIED:1793105274205:[0-9a-f]{64}$/);

  // The same balance in a later frame is a new snapshot.
  store.writeStreamBatch({ ...batch, snapshots: [{ ...batch.snapshots[1], frameCreationTimeMs: 1_793_105_280_000 }] });
  assert.equal(store.readSnapshotsAfter(0, 10).length, 3);
});

test("a stream batch with one invalid row stores nothing", (t) => {
  const store = openDemo(path.join(tempDir(t), "facts.sqlite3"));
  t.after(() => store.close());

  assert.throws(
    () =>
      store.writeStreamBatch({
        facts: [fact("execution", ENTRY_EXECUTION_RECORD, "ws")],
        snapshots: [
          { kind: "position", source: "ws", sourceEndpoint: "ws:position", rawJson: JSON.stringify({ symbol: "XRPUSDT" }), receivedAtMs: 1 },
        ],
        logs: [{ atMs: 1_793_100_000_000, event: "disconnected", connId: "c1", detail: "code=1006" }],
      }),
    (error: unknown) => error instanceof ExchangeFactsWriteError && error.code === "invalid_snapshot",
  );
  assert.equal(store.readFactsAfter(0, 10).length, 0);
  assert.equal(store.readConnectionLogAfter(0, 10).length, 0);

  const result = store.writeStreamBatch({
    facts: [fact("execution", ENTRY_EXECUTION_RECORD, "ws")],
    snapshots: [],
    logs: [{ atMs: 1_793_100_000_000, event: "disconnected", connId: "c1", detail: "code=1006" }],
  });
  assert.deepEqual(result, { facts: { inserted: 1, duplicates: 0 }, snapshots: { inserted: 0, duplicates: 0 }, logs: 1 });
  assert.deepEqual(store.readConnectionLogAfter(0, 10), [
    { logSeq: 1, atMs: 1_793_100_000_000, event: "disconnected", connId: "c1", detail: "code=1006" },
  ]);
});
