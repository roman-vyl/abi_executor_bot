import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { BybitHistoryWindowInput, BybitHistoryWindowReader } from "../../src/exchange/bybitAdapter.js";
import { ExchangeFactsStore, type FactInput } from "../../src/exchangeFacts/exchangeFactsStore.js";
import {
  createExchangeRestReconciler,
  decimalSumEquals,
  ExchangeRestReconciler,
  REST_BAR_MS,
  REST_HISTORY_MS,
  REST_PACE_MS,
  REST_QUIET_MS,
  REST_SWEEP_INTERVAL_MS,
  REST_SWEEP_SPAN_MS,
  REST_WINDOW_MS,
  type CycleSourceRecord,
  type ExchangeRestReconcilerOptions,
} from "../../src/exchangeFacts/exchangeRestReconciler.js";
import type { EventLevel } from "../../src/observability/events.js";
import { makeTestConfig } from "../fixtures/config.js";

type Emitted = { level: EventLevel; event: string; fields?: Record<string, unknown> };
type Request = BybitHistoryWindowInput & { endpoint: "order_history" | "execution_list"; atMs: number };

const BAR = 1_793_100_000_000 - (1_793_100_000_000 % REST_BAR_MS);
// One minute after a bar close: outside the quiet period.
const T = BAR + 60_000;
const HOUR = 3_600_000;

class Clock {
  constructor(public t: number) {}
  readonly sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

function order(orderId: string, timeMs: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "XRPUSDT",
    orderId,
    orderLinkId: "",
    orderStatus: "Filled",
    qty: "10",
    cumExecQty: "10",
    createdTime: String(timeMs),
    updatedTime: String(timeMs),
    ...fields,
  };
}

function execution(execId: string, orderId: string, timeMs: number, execQty = "10", symbol = "XRPUSDT"): Record<string, unknown> {
  return { symbol, orderId, orderLinkId: "", execId, execType: "Trade", execQty, execTime: String(timeMs) };
}

// Bybit history: records in [startTime, endTime], two per page.
class FakeHistory implements BybitHistoryWindowReader {
  readonly requests: Request[] = [];
  orders: Record<string, unknown>[] = [];
  executions: Record<string, unknown>[] = [];
  failures: { endpoint?: string; cursor?: string | undefined; error: Error; times: number }[] = [];
  requireSymbol = false;

  constructor(private readonly clock: Clock) {}

  getOrderHistoryWindow(input: BybitHistoryWindowInput): Promise<unknown> {
    return this.page("order_history", input, this.orders, "updatedTime");
  }

  getExecutionWindow(input: BybitHistoryWindowInput): Promise<unknown> {
    return this.page("execution_list", input, this.executions, "execTime");
  }

  private async page(
    endpoint: Request["endpoint"],
    input: BybitHistoryWindowInput,
    records: Record<string, unknown>[],
    timeField: string,
  ): Promise<unknown> {
    this.requests.push({ ...input, endpoint, atMs: this.clock.t });
    assert.ok(input.endTime - input.startTime <= REST_WINDOW_MS, "window longer than 7 days");
    const failure = this.failures.find(
      (f) => f.times > 0 && (f.endpoint === undefined || f.endpoint === endpoint) && f.cursor === input.cursor,
    );
    if (failure !== undefined) {
      failure.times -= 1;
      throw failure.error;
    }
    if (this.requireSymbol && input.symbol === undefined) {
      throw new Error("Bybit retCode 10001: params error: symbol or settleCoin is required");
    }
    const matching = records.filter((record) => {
      const time = Number(record[timeField]);
      return (
        time >= input.startTime &&
        time <= input.endTime &&
        (input.symbol === undefined || record.symbol === input.symbol)
      );
    });
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const list = matching.slice(offset, offset + 2);
    const next = offset + 2 < matching.length ? String(offset + 2) : "";
    return { retCode: 0, retMsg: "OK", result: { category: "linear", list, nextPageCursor: next } };
  }
}

function openStore(t: TestContext): { store: ExchangeFactsStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-rest-"));
  const store = ExchangeFactsStore.open({ path: path.join(dir, "facts.sqlite3"), bybitEnvironment: "demo", category: "linear" });
  t.after(() => {
    try {
      store.close();
    } catch {
      // closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

function makeReconciler(
  store: ExchangeFactsStore,
  clock: Clock,
  reader: BybitHistoryWindowReader,
  overrides: Partial<ExchangeRestReconcilerOptions> = {},
): { reconciler: ExchangeRestReconciler; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const reconciler = new ExchangeRestReconciler({
    store,
    reader,
    category: "linear",
    listRecords: () => [],
    isCorrelationReady: () => true,
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
    now: clock.now,
    sleep: clock.sleep,
    tickIntervalMs: 3_600_000,
    ...overrides,
  });
  return { reconciler, emitted };
}

// Lets the worker run until the queue is empty and it waits for work.
async function settle(reconciler: ExchangeRestReconciler): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const status = reconciler.status();
    if (status.queueWindows === 0 && status.state !== "fetching" && status.state !== "backfilling") {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
  }
  assert.fail("reconciler did not settle");
}

function wsFact(kind: FactInput["kind"], record: Record<string, unknown>): FactInput {
  return {
    kind,
    source: "ws",
    sourceEndpoint: kind === "execution" ? "ws:execution" : "ws:order",
    rawJson: JSON.stringify(record),
    receivedAtMs: T,
  };
}

test("first start reads the last 30 days in 7-day windows, newest first, and records each window", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  history.orders = [order("o-1", T - 2 * HOUR), order("o-2", T - 3 * HOUR), order("o-3", T - 4 * HOUR), order("o-old", T - 20 * 24 * HOUR)];
  history.executions = [execution("e-1", "o-1", T - 2 * HOUR), execution("e-2", "o-2", T - 3 * HOUR, "10")];
  const { reconciler, emitted } = makeReconciler(store, clock, history);

  reconciler.start();
  t.after(() => reconciler.stop());
  assert.equal(reconciler.status().state, "backfilling");
  reconciler.tick();
  await settle(reconciler);

  for (const endpoint of ["order_history", "execution_list"] as const) {
    const windows = store.readRestWindows(endpoint, 0);
    assert.equal(windows.length, 5, endpoint);
    assert.equal(Math.min(...windows.map((w) => w.startMs)), T - REST_HISTORY_MS);
    assert.equal(Math.max(...windows.map((w) => w.endMs)), T);
  }
  // Newest window first; the first window of orders needed two pages.
  const firstOrders = history.requests.filter((r) => r.endpoint === "order_history" && r.cursor === undefined);
  assert.equal(firstOrders[0].endTime, T);
  assert.ok(firstOrders.every((r, i) => i === 0 || r.endTime < firstOrders[i - 1].endTime));
  assert.ok(history.requests.some((r) => r.endpoint === "order_history" && r.cursor === "2"));
  assert.equal(history.requests.filter((r) => r.symbol !== undefined).length, 0);

  const facts = store.readFactsAfter(0, 100);
  assert.equal(facts.length, 6);
  assert.ok(facts.every((f) => f.source === "rest"));
  assert.deepEqual(
    [...new Set(facts.map((f) => f.sourceEndpoint))].sort(),
    ["rest:/v5/execution/list", "rest:/v5/order/history"],
  );
  const status = reconciler.status();
  assert.equal(status.state, "idle");
  assert.equal(status.backfillDone, true);
  assert.equal(status.coveredFromMs, T - REST_HISTORY_MS);
  assert.equal(status.recordsFetched, 6);
  assert.equal(status.recordsNew, 6);
  assert.equal(emitted.filter((e) => e.event === "exchange_rest_backfill_done").length, 1);
  // The backfill is followed by a completeness check.
  const check = emitted.find((e) => e.event === "exchange_completeness_checked");
  assert.ok(check !== undefined);
  assert.equal(reconciler.completenessStatus().checkedAtMs !== undefined, true);
});

test("a restart fetches only the time since the last covered window", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  const first = makeReconciler(store, clock, history).reconciler;
  first.start();
  first.tick();
  await settle(first);
  first.stop();
  const coveredUntil = Math.max(...store.readRestWindows("order_history", 0).map((w) => w.endMs));

  clock.t += 2 * HOUR;
  history.requests.length = 0;
  const second = makeReconciler(store, clock, history).reconciler;
  second.start();
  t.after(() => second.stop());
  second.tick();
  await settle(second);

  assert.deepEqual(
    history.requests.map((r) => [r.endpoint, r.startTime]).sort(),
    [
      ["execution_list", coveredUntil],
      ["order_history", coveredUntil],
    ],
  );
  assert.equal(second.status().backfillDone, true);
});

test("records already stored from WS give no second row", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  const state = order("o-1", T - HOUR, { orderLinkId: "abi-ep-x" });
  const fill = execution("e-1", "o-1", T - HOUR);
  store.writeFacts([wsFact("order_state", state), wsFact("execution", fill)]);
  // REST sends the same state with another field set and order.
  history.orders = [{ ...state, extraRestField: "x", qty: "10.0" }];
  history.executions = [{ ...fill, feeRate: "0.00055" }];
  const { reconciler } = makeReconciler(store, clock, history);
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  assert.equal(store.readFactsAfter(0, 100).length, 2);
  assert.equal(reconciler.status().recordsFetched, 2);
  assert.equal(reconciler.status().recordsNew, 0);
});

test("a reconnect fetches from the disconnect minus 2 minutes; the sweep reads the last hour every 10 minutes", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  const { reconciler, emitted } = makeReconciler(store, clock, history);
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  clock.t = T + REST_BAR_MS;
  const disconnectedAt = clock.t - 5_000;
  store.writeStreamBatch({
    facts: [],
    snapshots: [],
    logs: [
      { atMs: disconnectedAt, event: "disconnected", connId: "c1", detail: "1006" },
      { atMs: disconnectedAt + 1_000, event: "connecting", connId: null, detail: null },
      { atMs: disconnectedAt + 2_000, event: "subscribed", connId: "c2", detail: null },
    ],
  });
  history.requests.length = 0;
  reconciler.tick();
  await settle(reconciler);
  assert.deepEqual(
    history.requests.map((r) => [r.endpoint, r.startTime, r.endTime]),
    [
      ["order_history", disconnectedAt - 120_000, T + REST_BAR_MS],
      ["execution_list", disconnectedAt - 120_000, T + REST_BAR_MS],
    ],
  );

  // Ten minutes after the start: the sweep.
  clock.t = T + REST_SWEEP_INTERVAL_MS;
  history.requests.length = 0;
  const checksBefore = emitted.filter((e) => e.event === "exchange_completeness_checked").length;
  reconciler.tick();
  await settle(reconciler);
  const sweepAt = T + REST_SWEEP_INTERVAL_MS;
  assert.deepEqual(
    history.requests.map((r) => [r.endpoint, r.startTime, r.endTime]),
    [
      ["order_history", sweepAt - REST_SWEEP_SPAN_MS, sweepAt],
      ["execution_list", sweepAt - REST_SWEEP_SPAN_MS, sweepAt],
    ],
  );
  assert.ok(reconciler.status().lastSweepAtMs !== undefined);
  assert.equal(emitted.filter((e) => e.event === "exchange_completeness_checked").length, checksBefore + 1);
  // Before the next interval nothing is enqueued.
  history.requests.length = 0;
  clock.t += 1_000;
  reconciler.tick();
  await settle(reconciler);
  assert.equal(history.requests.length, 0);
});

test("overlapping queued windows are merged", (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  // Not started: the queue only fills.
  const { reconciler } = makeReconciler(store, clock, history);
  reconciler.tick();
  const backfill = reconciler.status().queueWindows;
  assert.equal(backfill, 10);

  store.writeStreamBatch({
    facts: [],
    snapshots: [],
    logs: [
      { atMs: T - 60_000, event: "disconnected", connId: "c1", detail: null },
      { atMs: T - 50_000, event: "subscribed", connId: "c2", detail: null },
    ],
  });
  clock.t = T + REST_SWEEP_INTERVAL_MS;
  reconciler.tick();
  // The reconnect reaches past the newest backfill window (more than 7 days
  // together): one window per endpoint; the sweep merges into it.
  assert.equal(reconciler.status().queueWindows, backfill + 2);
});

test("requests are paced and never sent in the first 30 seconds after a 5-minute boundary", async (t) => {
  const { store } = openStore(t);
  // Ten seconds after a bar close.
  const clock = new Clock(BAR + 10_000);
  const history = new FakeHistory(clock);
  history.orders = Array.from({ length: 9 }, (_, i) => order(`o-${i}`, BAR - (i + 1) * 60_000));
  const { reconciler } = makeReconciler(store, clock, history);
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  assert.ok(history.requests.length > 10);
  for (const [i, request] of history.requests.entries()) {
    const phase = request.atMs % REST_BAR_MS;
    assert.ok(phase >= REST_QUIET_MS, `request ${i} at ${phase} ms after the boundary`);
    if (i > 0) {
      assert.ok(request.atMs - history.requests[i - 1].atMs >= REST_PACE_MS);
    }
  }
  assert.equal(history.requests[0].atMs, BAR + REST_QUIET_MS);
});

test("a failure half way keeps the stored pages, records no window and is retried after a backoff", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  history.orders = [order("o-1", T - HOUR), order("o-2", T - 2 * HOUR), order("o-3", T - 3 * HOUR)];
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  history.failures = [{ endpoint: "order_history", cursor: "2", error: timeout, times: 2 }];
  const { reconciler, emitted } = makeReconciler(store, clock, history);
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  const failed = emitted.filter((e) => e.event === "exchange_rest_request_failed");
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].fields, { endpoint: "order_history", errorCode: "timeout" });
  assert.ok(clock.sleeps.includes(5_000));
  assert.ok(clock.sleeps.includes(30_000));
  // Finished in the end: one row per window and each record once.
  assert.equal(store.readRestWindows("order_history", 0).length, 5);
  assert.equal(store.readFactsAfter(0, 100).length, 3);
  assert.equal(reconciler.status().lastError, undefined);
});

test("a store write failure leaves the window queued and trading untouched", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  let failWrites = 1;
  const failingStore = Object.create(store) as ExchangeFactsStore;
  failingStore.writeRestPage = (page) => {
    if (failWrites > 0) {
      failWrites -= 1;
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    }
    return store.writeRestPage(page);
  };
  const { reconciler, emitted } = makeReconciler(failingStore, clock, history);
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  assert.equal(emitted.filter((e) => e.event === "exchange_rest_request_failed")[0].fields?.errorCode, "SQLITE_IOERR");
  assert.equal(store.readRestWindows("order_history", 0).length, 5);
});

test("when Bybit needs a symbol the reconciler asks per known symbol", async (t) => {
  const { store } = openStore(t);
  store.writeFacts([wsFact("execution", execution("e-ws", "o-ws", T - 10 * HOUR, "1", "BTCUSDT"))]);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  history.requireSymbol = true;
  history.executions = [execution("e-x", "o-x", T - HOUR, "1", "XRPUSDT")];
  const records: CycleSourceRecord[] = [
    { strategy_instance_id: "i", trade_cycle_id: "c", exchange_symbol: "XRPUSDT", status: "position_open", first_fill_at_ms: null },
  ];
  const { reconciler, emitted } = makeReconciler(store, clock, history, { listRecords: () => records });
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await settle(reconciler);

  assert.equal(emitted.filter((e) => e.event === "exchange_rest_symbol_required").length, 2);
  assert.deepEqual(
    [...new Set(history.requests.filter((r) => r.symbol !== undefined).map((r) => r.symbol))].sort(),
    ["BTCUSDT", "XRPUSDT"],
  );
  assert.equal(store.readRestWindows("execution_list", 0).length, 5);
  assert.ok(store.readFactsAfter(0, 100).some((f) => f.execId === "e-x"));
});

test("completeness counts each of the four kinds of missing data", (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const from = T - 10 * HOUR;
  const gapStart = T - 6 * HOUR;
  const gapEnd = gapStart + 30_000;
  const window = (endpoint: "order_history" | "execution_list", startMs: number, endMs: number) =>
    store.writeRestPage({ facts: [], window: { endpoint, startMs, endMs, completedAtMs: T, records: 0, newRecords: 0 } });
  window("order_history", from, T);
  window("execution_list", from - HOUR, gapStart);
  window("execution_list", gapEnd + 1_000, T);
  store.writeStreamBatch({
    facts: [],
    snapshots: [],
    logs: [
      { atMs: gapStart, event: "disconnected", connId: "c1", detail: null },
      { atMs: gapEnd, event: "subscribed", connId: "c2", detail: null },
    ],
  });

  const closeLabel = "abi-ep-close-1";
  store.writeFacts([
    // Filled 10, only 6 stored.
    wsFact("order_state", order("o-short", T - HOUR)),
    wsFact("execution", execution("e-short-1", "o-short", T - HOUR, "4")),
    wsFact("execution", execution("e-short-2", "o-short", T - HOUR, "2")),
    // Complete: 3.818 = 1.8 + 2.018.
    wsFact("order_state", order("o-full", T - HOUR, { cumExecQty: "3.818" })),
    wsFact("execution", execution("e-full-1", "o-full", T - HOUR, "1.8")),
    wsFact("execution", execution("e-full-2", "o-full", T - HOUR, "2.018")),
    // A close order of cycle c-ok with its fill.
    wsFact("order_state", order("o-close", T - HOUR, { orderLinkId: closeLabel })),
    wsFact("execution", execution("e-close", "o-close", T - HOUR)),
  ]);
  store.writeLinks([
    {
      kind: "own",
      orderId: "o-close",
      strategyInstanceId: "inst",
      tradeCycleId: "c-ok",
      role: "close",
      generation: 1,
      orderLinkId: closeLabel,
      evidence: "own_order_link_id_lookup",
      establishedAtMs: T,
    },
  ]);
  // Seen only by REST, without labels.
  store.writeRestPage({
    facts: [
      {
        kind: "order_state",
        source: "rest",
        sourceEndpoint: "rest:/v5/order/history",
        rawJson: JSON.stringify(order("o-rest", T - HOUR, { orderStatus: "Cancelled", cumExecQty: "0" })),
        receivedAtMs: T,
      },
    ],
  });
  const cycle = (id: string, status: string, firstFill: number | null): CycleSourceRecord => ({
    strategy_instance_id: "inst",
    trade_cycle_id: id,
    exchange_symbol: "XRPUSDT",
    status,
    first_fill_at_ms: firstFill,
  });
  const records = [
    cycle("c-ok", "terminal_closed", T - 2 * HOUR),
    cycle("c-missing", "terminal_closed", T - 2 * HOUR),
    cycle("c-before-coverage", "terminal_closed", from - 2 * HOUR),
    cycle("c-never-filled", "terminal_closed", null),
    cycle("c-open", "position_open", T - 2 * HOUR),
  ];
  const { reconciler, emitted } = makeReconciler(store, clock, new FakeHistory(clock), { listRecords: () => records });
  reconciler.tick();

  reconciler.checkCompleteness();

  assert.deepEqual(reconciler.completenessStatus(), {
    checkedAtMs: T,
    execMismatchOrders: 1,
    uncoveredGaps: 1,
    closedCyclesWithoutCloseFill: 1,
    unlabeledRestOrders: 1,
  });
  const event = emitted.find((e) => e.event === "exchange_completeness_checked");
  assert.equal(event?.level, "warn");
  assert.deepEqual(event?.fields?.execMismatchOrderIds, ["o-short"]);
  assert.deepEqual(event?.fields?.uncoveredGapRanges, [`${gapStart}-${gapEnd}`]);
  assert.deepEqual(event?.fields?.closedCyclesWithoutCloseFillIds, ["inst/c-missing"]);
  assert.deepEqual(event?.fields?.unlabeledRestOrderIds, ["o-rest"]);
  assert.ok(!JSON.stringify(event?.fields).includes("rawJson"));
});

test("completeness is all zero when everything is covered and adds up", (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  for (const endpoint of ["order_history", "execution_list"] as const) {
    store.writeRestPage({
      facts: [],
      window: { endpoint, startMs: T - 10 * HOUR, endMs: T, completedAtMs: T, records: 0, newRecords: 0 },
    });
  }
  store.writeStreamBatch({
    facts: [],
    snapshots: [],
    logs: [
      { atMs: T - 5 * HOUR, event: "disconnected", connId: "c1", detail: null },
      { atMs: T - 5 * HOUR + 3_000, event: "subscribed", connId: "c2", detail: null },
    ],
  });
  store.writeFacts([
    wsFact("order_state", order("o-1", T - HOUR)),
    wsFact("execution", execution("e-1", "o-1", T - HOUR, "10")),
  ]);
  const { reconciler, emitted } = makeReconciler(store, clock, new FakeHistory(clock));
  reconciler.tick();
  reconciler.checkCompleteness();

  assert.deepEqual(reconciler.completenessStatus(), {
    checkedAtMs: T,
    execMismatchOrders: 0,
    uncoveredGaps: 0,
    closedCyclesWithoutCloseFill: 0,
    unlabeledRestOrders: 0,
  });
  assert.equal(emitted.find((e) => e.event === "exchange_completeness_checked")?.level, "info");
});

test("the reconciler waits for the correlation replay and does not start without a store or a key", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  let ready = false;
  const { reconciler } = makeReconciler(store, clock, history, { isCorrelationReady: () => ready });
  reconciler.start();
  t.after(() => reconciler.stop());
  reconciler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(history.requests.length, 0);
  ready = true;
  reconciler.tick();
  await settle(reconciler);
  assert.ok(history.requests.length > 0);

  const deps = { reader: history, listRecords: () => [], isCorrelationReady: () => true };
  assert.deepEqual(createExchangeRestReconciler(makeTestConfig(), { status: "disabled" }, deps).status().reason, "store_not_enabled");
  const noKey = makeTestConfig({ bybitApiKey: "", bybitApiSecret: "" });
  const handle = createExchangeRestReconciler(noKey, { status: "enabled", store }, deps);
  assert.equal(handle.status().state, "disabled");
  assert.equal(handle.status().reason, "no_api_key");
});

test("after stop no request is sent and no answer is written", async (t) => {
  const { store } = openStore(t);
  const clock = new Clock(T);
  const history = new FakeHistory(clock);
  const { reconciler } = makeReconciler(store, clock, history);
  reconciler.start();
  reconciler.tick();
  reconciler.stop();
  await reconciler.idle();
  assert.equal(reconciler.status().state, "stopped");
  assert.equal(store.readRestWindows("order_history", 0).length, 0);
});

test("exact decimal sums", () => {
  assert.equal(decimalSumEquals(["1.8", "2.018"], "3.818"), true);
  assert.equal(decimalSumEquals(["0.1", "0.2"], "0.3"), true);
  assert.equal(decimalSumEquals([], "0"), true);
  assert.equal(decimalSumEquals(["4", "2"], "10"), false);
  assert.equal(decimalSumEquals(["x"], "1"), false);
});
