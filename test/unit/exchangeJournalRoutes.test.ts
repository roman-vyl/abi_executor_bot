import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { ExchangeFactsStore, type FactInput } from "../../src/exchangeFacts/exchangeFactsStore.js";
import { disabledLinkerStatus } from "../../src/exchangeFacts/exchangeOrderLinker.js";
import { disabledRestStatus, emptyCompletenessStatus } from "../../src/exchangeFacts/exchangeRestReconciler.js";
import { disabledStreamStatus } from "../../src/exchangeStream/exchangeStreamRecorder.js";
import type { ExchangeFactsStoreState } from "../../src/app/exchangeFactsStartup.js";
import { handleExchangeJournalRoutes } from "../../src/routes/exchangeJournalRoutes.js";
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
const ENTRY_EXEC_TIME = 1_792_939_843_422;
const SL_EXEC_TIME = 1_792_940_451_013;

type Body = Record<string, any>;

function openStore(t: test.TestContext): ExchangeFactsStore {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-journal-"));
  const store = ExchangeFactsStore.open({ path: path.join(dir, "facts.sqlite3"), bybitEnvironment: "demo", category: "linear" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function fact(kind: FactInput["kind"], rawJson: string): FactInput {
  return {
    kind,
    source: "ws",
    sourceEndpoint: kind === "execution" ? "ws:execution" : "ws:order",
    rawJson,
    receivedAtMs: 1_792_950_000_000,
  };
}

// Six facts: entry order, entry fill, SL child, SL fill, TP child, funding
// (never linked); entry, SL and TP linked to one cycle.
function seededStore(t: test.TestContext): ExchangeFactsStore {
  const store = openStore(t);
  store.writeFacts([
    fact("order_state", ENTRY_ORDER_RECORD),
    fact("execution", ENTRY_EXECUTION_RECORD),
    fact("order_state", SL_CHILD_RECORD),
    fact("execution", SL_EXECUTION_RECORD),
    fact("order_state", TP_CHILD_RECORD),
    fact("execution", FUNDING_EXECUTION_RECORD),
  ]);
  store.writeLinks([
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
  return store;
}

const health = () => ({
  stream: disabledStreamStatus("store_not_enabled"),
  linker: disabledLinkerStatus("store_not_enabled"),
  rest: disabledRestStatus("store_not_enabled"),
  completeness: emptyCompletenessStatus(),
});

async function get(
  exchangeFacts: ExchangeFactsStoreState,
  url: string,
  options: { method?: string; emit?: (level: string, event: string, fields?: Record<string, unknown>) => void } = {},
): Promise<{ handled: boolean; status: number; body: Body }> {
  const request = Readable.from([]) as IncomingMessage;
  request.method = options.method ?? "GET";
  request.url = url;
  request.headers = {};
  let status = 0;
  let text = "";
  const response = {
    writeHead(statusCode: number): void {
      status = statusCode;
    },
    end(body: string): void {
      text = body;
    },
  } as ServerResponse;
  const handled = await handleExchangeJournalRoutes({ request, response, exchangeFacts, health, emit: options.emit });
  return { handled, status, body: text === "" ? {} : (JSON.parse(text) as Body) };
}

function enabled(store: ExchangeFactsStore): ExchangeFactsStoreState {
  return { status: "enabled", store };
}

test("the events feed is followed by cursor and returns every event once, also while new ones arrive", async (t) => {
  const store = seededStore(t);
  const seen: number[] = [];
  let after = 0;
  for (let page = 0; page < 10; page += 1) {
    const { status, body } = await get(enabled(store), `/v1/exchange-journal/facts?after_seq=${after}&limit=2`);
    assert.equal(status, 200);
    seen.push(...body.items.map((item: Body) => item.event_seq));
    after = body.next_after_seq;
    if (page === 1) {
      store.writeFacts([fact("execution", JSON.stringify({ ...JSON.parse(SL_EXECUTION_RECORD), execId: "late-exec" }))]);
    }
    if (!body.has_more) {
      break;
    }
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);

  const empty = await get(enabled(store), `/v1/exchange-journal/facts?after_seq=${after}`);
  assert.deepEqual(empty.body, { items: [], next_after_seq: after, has_more: false });
});

test("an event has the closed shape, its raw record unchanged and its order's link or null", async (t) => {
  const store = seededStore(t);
  const { body } = await get(enabled(store), "/v1/exchange-journal/facts");
  const entryFill = body.items[1];
  assert.deepEqual(Object.keys(entryFill).sort(), [
    "event_seq", "exchange_time_ms", "exec_id", "exec_type", "fact_kind", "link", "order_id", "order_link_id",
    "order_status", "parent_order_link_id", "raw", "received_at_ms", "source", "source_endpoint", "symbol",
  ]);
  assert.deepEqual(entryFill.raw, JSON.parse(ENTRY_EXECUTION_RECORD));
  assert.equal(typeof entryFill.raw.execQty, "string");
  assert.equal(entryFill.link.role, "entry");
  assert.equal(entryFill.link.trade_cycle_id, TC);
  assert.equal(body.items[5].link, null);
});

test("the events feed filters by strategy, symbol and period", async (t) => {
  const store = seededStore(t);

  const bySi = await get(enabled(store), `/v1/exchange-journal/facts?strategy_instance_id=${SI}`);
  assert.equal(bySi.body.items.length, 5);
  assert.ok(bySi.body.items.every((item: Body) => item.link.strategy_instance_id === SI));

  const otherSi = await get(enabled(store), "/v1/exchange-journal/facts?strategy_instance_id=other");
  assert.deepEqual(otherSi.body.items, []);

  const otherSymbol = await get(enabled(store), "/v1/exchange-journal/facts?symbol=ETHUSDT");
  assert.deepEqual(otherSymbol.body.items, []);

  const period = await get(enabled(store), `/v1/exchange-journal/facts?from_ms=${ENTRY_EXEC_TIME}&to_ms=${SL_EXEC_TIME + 1}`);
  assert.ok(period.body.items.length > 0);
  assert.ok(
    period.body.items.every((item: Body) => item.exchange_time_ms >= ENTRY_EXEC_TIME && item.exchange_time_ms <= SL_EXEC_TIME),
  );
  assert.ok(period.body.items.some((item: Body) => item.exec_type === "Trade" && item.order_id === SL_ORDER_ID));
});

test("the links feed is read by cursor", async (t) => {
  const store = seededStore(t);
  const first = await get(enabled(store), "/v1/exchange-journal/order-links?limit=2");
  assert.deepEqual(first.body.items.map((link: Body) => link.role), ["entry", "stop_loss"]);
  assert.equal(first.body.has_more, true);
  assert.deepEqual(Object.keys(first.body.items[0]).sort(), [
    "established_at_ms", "evidence", "generation", "link_seq", "order_id", "order_link_id",
    "parent_order_link_id", "role", "strategy_instance_id", "trade_cycle_id",
  ]);
  const second = await get(enabled(store), `/v1/exchange-journal/order-links?after_seq=${first.body.next_after_seq}`);
  assert.deepEqual(second.body.items.map((link: Body) => link.role), ["take_profit"]);
  assert.equal(second.body.has_more, false);
});

test("one order is returned with its link and all its events; an unknown order is 404", async (t) => {
  const store = seededStore(t);
  const entry = await get(enabled(store), `/v1/exchange-journal/orders/${ENTRY_ORDER_ID}`);
  assert.equal(entry.status, 200);
  assert.equal(entry.body.link.role, "entry");
  assert.deepEqual(entry.body.events.map((event: Body) => event.fact_kind), ["order_state", "execution"]);
  assert.equal(entry.body.truncated, false);

  const unknown = await get(enabled(store), "/v1/exchange-journal/orders/no-such-order");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "order_not_found");
});

test("one trade cycle is returned with all its orders; a cycle without orders is empty", async (t) => {
  const store = seededStore(t);
  const cycle = await get(enabled(store), `/v1/strategy-instances/${SI}/trade-cycles/${TC}/exchange-journal`);
  assert.equal(cycle.status, 200);
  assert.deepEqual(cycle.body.orders.map((order: Body) => order.link.role), ["entry", "stop_loss", "take_profit"]);
  assert.deepEqual(cycle.body.orders[1].events.map((event: Body) => event.fact_kind), ["order_state", "execution"]);
  assert.equal(cycle.body.truncated, false);

  const none = await get(enabled(store), `/v1/strategy-instances/${SI}/trade-cycles/unknown/exchange-journal`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.orders, []);

  const bad = await get(enabled(store), `/v1/strategy-instances/%E0%A4%A/trade-cycles/${TC}/exchange-journal`);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "validation_failed");
});

test("status reports the store and the last sequences; other endpoints are 503 without the store", async (t) => {
  const store = seededStore(t);
  const on = await get(enabled(store), "/v1/exchange-journal/status");
  assert.equal(on.status, 200);
  assert.equal(on.body.store, "enabled");
  assert.equal(on.body.last_event_seq, 6);
  assert.equal(on.body.last_link_seq, 3);
  assert.equal(on.body.schema_version, 3);
  assert.deepEqual(on.body.rest, health().rest);

  const off = await get({ status: "disabled" }, "/v1/exchange-journal/status");
  assert.equal(off.status, 200);
  assert.equal(off.body.store, "disabled");
  assert.equal(off.body.last_event_seq, null);

  const broken = await get({ status: "unavailable", reason: "open_failed" }, "/v1/exchange-journal/status");
  assert.equal(broken.body.store_reason, "open_failed");

  for (const url of [
    "/v1/exchange-journal/facts",
    "/v1/exchange-journal/order-links",
    `/v1/exchange-journal/orders/${ENTRY_ORDER_ID}`,
    `/v1/strategy-instances/${SI}/trade-cycles/${TC}/exchange-journal`,
  ]) {
    const result = await get({ status: "disabled" }, url);
    assert.equal(result.status, 503, url);
    assert.equal(result.body.error.code, "exchange_journal_unavailable");
  }
});

test("bad query values are 422 naming the parameter", async (t) => {
  const store = seededStore(t);
  const cases: Array<[string, string]> = [
    ["/v1/exchange-journal/facts?limit=5000", "/query/limit"],
    ["/v1/exchange-journal/facts?limit=0", "/query/limit"],
    ["/v1/exchange-journal/facts?after_seq=-1", "/query/after_seq"],
    ["/v1/exchange-journal/facts?after_seq=1.5", "/query/after_seq"],
    ["/v1/exchange-journal/facts?symbol=", "/query/symbol"],
    ["/v1/exchange-journal/facts?colour=red", "/query/colour"],
    ["/v1/exchange-journal/facts?from_ms=10&to_ms=10", "/query/from_ms"],
    ["/v1/exchange-journal/facts?limit=1&limit=2", "/query/limit"],
    ["/v1/exchange-journal/order-links?symbol=BTCUSDT", "/query/symbol"],
    [`/v1/exchange-journal/orders/${ENTRY_ORDER_ID}?limit=1`, "/query/limit"],
  ];
  for (const [url, pathName] of cases) {
    const { status, body } = await get(enabled(store), url);
    assert.equal(status, 422, url);
    assert.equal(body.error.code, "validation_failed");
    assert.ok(body.error.details.some((detail: Body) => detail.path === pathName), url);
  }
});

test("only GET on journal paths is handled", async (t) => {
  const store = seededStore(t);
  assert.equal((await get(enabled(store), "/v1/exchange-journal/facts", { method: "POST" })).handled, false);
  assert.equal((await get(enabled(store), "/v1/exchange-journal/other")).handled, false);
  assert.equal((await get(enabled(store), "/v1/strategy-instances/a/trade-cycles/b/open-position")).handled, false);
});

test("reads never change the store; a failing read is 500 with an event and no payload", async (t) => {
  const store = seededStore(t);
  const before = store.readLastSequences();
  for (const url of [
    "/v1/exchange-journal/facts",
    "/v1/exchange-journal/order-links",
    `/v1/exchange-journal/orders/${ENTRY_ORDER_ID}`,
    `/v1/strategy-instances/${SI}/trade-cycles/${TC}/exchange-journal`,
    "/v1/exchange-journal/status",
  ]) {
    await get(enabled(store), url);
  }
  assert.deepEqual(store.readLastSequences(), before);
  assert.equal(store.readFactsAfter(0, 100).length, 6);
  assert.equal(store.readLinksAfter(0, 100).length, 3);

  const failing = Object.create(store) as ExchangeFactsStore;
  failing.readJournalFacts = () => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  };
  const events: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const result = await get(enabled(failing), "/v1/exchange-journal/facts", {
    emit: (level, event, fields) => events.push([level, event, fields]),
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "internal_error");
  assert.deepEqual(events, [["error", "exchange_journal_read_failed", { endpoint: "facts", errorCode: "SQLITE_BUSY" }]]);
});
