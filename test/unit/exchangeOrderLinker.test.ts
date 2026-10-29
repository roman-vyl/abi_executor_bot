import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { buildEntryPackageOrderLinkId } from "../../src/domain/entryPackageOrderIdentity.js";
import { ExchangeFactsStore, type FactInput, type OwnOrderLinkInput } from "../../src/exchangeFacts/exchangeFactsStore.js";
import {
  createExchangeOrderLinker,
  ExchangeOrderLinker,
  LabelIndex,
  type ExchangeOrderLinkerOptions,
  type LabelSourceRecord,
  type LinkerFactsStore as LinkerFactsStoreLike,
} from "../../src/exchangeFacts/exchangeOrderLinker.js";
import type { EventLevel } from "../../src/observability/events.js";

type Emitted = { level: EventLevel; event: string; fields?: Record<string, unknown> };

const INSTANCE = "inst-xrp-1";
const CYCLE = "cycle-3dfc2594";
const OTHER_CYCLE = "cycle-5bf9afc0";
const T = 1_793_105_274_202;

function label(cycle: string, role: "entry" | "close", generation: number, instance = INSTANCE): string {
  return buildEntryPackageOrderLinkId(instance, cycle, role, generation);
}

function orderRecord(fields: Record<string, unknown>): FactInput {
  return {
    kind: "order_state",
    source: "ws",
    sourceEndpoint: "ws:order",
    rawJson: JSON.stringify({
      category: "linear",
      symbol: "XRPUSDT",
      orderLinkId: "",
      parentOrderLinkId: "",
      orderStatus: "New",
      stopOrderType: "",
      qty: "3.9",
      updatedTime: String(T),
      ...fields,
    }),
    receivedAtMs: T,
  };
}

function entryOrder(orderId: string, orderLinkId: string, updatedTime = T): FactInput {
  return orderRecord({ orderId, orderLinkId, stopOrderType: "Stop", orderStatus: "Untriggered", updatedTime: String(updatedTime) });
}

function childOrder(orderId: string, parent: string, stopOrderType: string, updatedTime = T): FactInput {
  return orderRecord({ orderId, parentOrderLinkId: parent, stopOrderType, updatedTime: String(updatedTime) });
}

function execution(execId: string, orderId: string, execType = "Trade"): FactInput {
  return {
    kind: "execution",
    source: "ws",
    sourceEndpoint: "ws:execution",
    rawJson: JSON.stringify({
      category: "linear",
      symbol: "XRPUSDT",
      orderId,
      orderLinkId: "",
      execId,
      execType,
      execQty: "3.9",
      execTime: String(T),
    }),
    receivedAtMs: T,
  };
}

function openStore(t: TestContext, dir?: string): { store: ExchangeFactsStore; dir: string } {
  const directory = dir ?? mkdtempSync(path.join(tmpdir(), "abi-linker-"));
  const store = ExchangeFactsStore.open({
    path: path.join(directory, "facts.sqlite3"),
    bybitEnvironment: "demo",
    category: "linear",
  });
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    if (dir === undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return { store, dir: directory };
}

function write(store: ExchangeFactsStore, facts: FactInput[]): void {
  store.writeStreamBatch({ facts, snapshots: [], logs: [] });
}

function makeLinker(
  store: LinkerFactsStoreLike,
  records: LabelSourceRecord[],
  overrides: Partial<ExchangeOrderLinkerOptions> = {},
): { linker: ExchangeOrderLinker; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const linker = new ExchangeOrderLinker({
    store,
    listRecords: () => records,
    isCorrelationReady: () => true,
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
    now: () => T + 1_000,
    ...overrides,
  });
  return { linker, emitted };
}

function links(store: ExchangeFactsStore) {
  return store.readLinksAfter(0, 1000).map((link) => ({
    orderId: link.orderId,
    cycle: link.tradeCycleId,
    role: link.role,
    generation: link.generation,
    evidence: link.evidence,
  }));
}

const record = (cycle: string, generation: number, instance = INSTANCE): LabelSourceRecord => ({
  strategy_instance_id: instance,
  trade_cycle_id: cycle,
  generation,
});

test("entry, stop loss and take profit of one flush are linked to the cycle in one tick", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [
    entryOrder("entry-1", entryLabel),
    childOrder("sl-1", entryLabel, "PartialStopLoss"),
    childOrder("tp-1", entryLabel, "PartialTakeProfit"),
    execution("exec-sl-1", "sl-1"),
  ]);
  const { linker, emitted } = makeLinker(store, [record(CYCLE, 1)]);

  linker.tick();

  assert.deepEqual(links(store), [
    { orderId: "entry-1", cycle: CYCLE, role: "entry", generation: 1, evidence: "own_order_link_id_lookup" },
    { orderId: "sl-1", cycle: CYCLE, role: "stop_loss", generation: 1, evidence: "parent_order_link_id" },
    { orderId: "tp-1", cycle: CYCLE, role: "take_profit", generation: 1, evidence: "parent_order_link_id" },
  ]);
  const status = linker.status();
  assert.equal(status.state, "running");
  assert.equal(status.linksWritten, 3);
  assert.deepEqual(status.waitingOrders, {});
  assert.deepEqual(status.notLinkableOrders, {});
  assert.equal(emitted.filter((e) => e.event === "exchange_order_linker_started").length, 1);

  // The execution belongs to the cycle through its orderId; no extra row.
  const fill = store.readFactsAfter(0, 1000).find((fact) => fact.kind === "execution");
  assert.equal(fill?.orderId, "sl-1");
  assert.equal(store.readLinksAfter(0, 1000).filter((link) => link.orderId === fill?.orderId).length, 1);
});

test("later states and amendments of a linked order need no new link", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [entryOrder("entry-1", entryLabel), childOrder("sl-1", entryLabel, "PartialStopLoss")]);
  const { linker } = makeLinker(store, [record(CYCLE, 1)]);
  linker.tick();

  write(store, [
    orderRecord({ orderId: "sl-1", parentOrderLinkId: entryLabel, stopOrderType: "PartialStopLoss", triggerPrice: "1.31", updatedTime: String(T + 10) }),
    orderRecord({ orderId: "sl-1", parentOrderLinkId: entryLabel, stopOrderType: "PartialStopLoss", orderStatus: "Filled", updatedTime: String(T + 20) }),
    execution("exec-sl-1", "sl-1"),
  ]);
  linker.tick();

  assert.equal(links(store).length, 2);
  assert.equal(linker.status().linksWritten, 2);
});

test("a close order is linked with role close", (t) => {
  const { store } = openStore(t);
  write(store, [entryOrder("close-1", label(CYCLE, "close", 1))]);
  const { linker } = makeLinker(store, [record(CYCLE, 1)]);

  linker.tick();

  assert.deepEqual(links(store), [
    { orderId: "close-1", cycle: CYCLE, role: "close", generation: 1, evidence: "own_order_link_id_lookup" },
  ]);
});

test("an order of an earlier generation is linked with its own generation", (t) => {
  const { store } = openStore(t);
  write(store, [entryOrder("entry-g1", label(CYCLE, "entry", 1)), entryOrder("entry-g3", label(CYCLE, "entry", 3))]);
  const { linker } = makeLinker(store, [record(CYCLE, 3)]);

  linker.tick();

  assert.deepEqual(
    links(store).map((link) => [link.orderId, link.generation]),
    [
      ["entry-g1", 1],
      ["entry-g3", 3],
    ],
  );
});

test("a child stored hours before its entry waits and is linked once the entry record exists", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 2);
  write(store, [childOrder("sl-2", entryLabel, "PartialStopLoss")]);
  const { linker } = makeLinker(store, [record(CYCLE, 2)]);

  for (let tick = 0; tick < 5; tick += 1) {
    linker.tick();
  }
  assert.deepEqual(links(store), []);
  assert.deepEqual(linker.status().waitingOrders, { parent_not_found: 1 });

  write(store, [entryOrder("entry-2", entryLabel, T + 4 * 3_600_000)]);
  linker.tick();

  assert.deepEqual(
    links(store).map((link) => [link.orderId, link.role, link.generation]),
    [
      ["entry-2", "entry", 2],
      ["sl-2", "stop_loss", 2],
    ],
  );
  assert.deepEqual(linker.status().waitingOrders, {});
});

test("the order in which records arrive does not change the links", (t) => {
  const entryLabel = label(CYCLE, "entry", 1);
  const entry = entryOrder("entry-1", entryLabel);
  const stop = childOrder("sl-1", entryLabel, "PartialStopLoss");
  const take = childOrder("tp-1", entryLabel, "PartialTakeProfit");

  const run = (order: FactInput[][]) => {
    const { store } = openStore(t);
    const { linker } = makeLinker(store, [record(CYCLE, 1)]);
    for (const batch of order) {
      write(store, batch);
      linker.tick();
    }
    return links(store).sort((a, b) => a.orderId.localeCompare(b.orderId));
  };

  assert.deepEqual(run([[entry], [stop], [take]]), run([[take], [stop], [entry]]));
  assert.equal(run([[take], [stop], [entry]]).length, 3);
});

test("an ABI label not yet in the correlation records waits until its record appears", (t) => {
  const { store } = openStore(t);
  write(store, [entryOrder("entry-x", label(OTHER_CYCLE, "entry", 1))]);
  const records: LabelSourceRecord[] = [record(CYCLE, 1)];
  const { linker } = makeLinker(store, records);

  linker.tick();
  assert.deepEqual(linker.status().waitingOrders, { own_label_unknown: 1 });

  records.push(record(OTHER_CYCLE, 1));
  linker.tick();
  assert.deepEqual(links(store).map((link) => link.cycle), [OTHER_CYCLE]);
});

test("orders that are not ABI trading orders are not linked and are counted by reason", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [
    entryOrder("entry-1", entryLabel),
    orderRecord({ orderId: "manual-1", orderLinkId: "my-manual-order" }),
    orderRecord({ orderId: "close-all-1" }),
    childOrder("trail-1", entryLabel, "TrailingStop"),
    {
      ...execution("funding-1", ""),
      rawJson: JSON.stringify({ category: "linear", symbol: "XRPUSDT", orderId: "", execId: "funding-1", execType: "Funding", execTime: String(T) }),
    },
  ]);
  const { linker } = makeLinker(store, [record(CYCLE, 1)]);

  linker.tick();
  linker.tick();

  assert.deepEqual(links(store).map((link) => link.orderId), ["entry-1"]);
  assert.deepEqual(linker.status().notLinkableOrders, { foreign_label: 1, no_label: 1, child_type_unknown: 1 });
  assert.deepEqual(linker.status().waitingOrders, {});
});

test("a restart rebuilds the same sets without writing a link twice", (t) => {
  const { store, dir } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [
    entryOrder("entry-1", entryLabel),
    childOrder("sl-1", entryLabel, "PartialStopLoss"),
    childOrder("orphan-1", label(OTHER_CYCLE, "entry", 1), "PartialStopLoss"),
    orderRecord({ orderId: "manual-1", orderLinkId: "manual" }),
  ]);
  const first = makeLinker(store, [record(CYCLE, 1)]).linker;
  first.tick();
  const before = first.status();
  first.stop();
  store.close();

  const reopened = openStore(t, dir).store;
  const second = makeLinker(reopened, [record(CYCLE, 1)]).linker;
  second.tick();
  const after = second.status();

  assert.equal(before.linksWritten, 2);
  assert.equal(after.linksWritten, 0);
  assert.deepEqual(after.waitingOrders, before.waitingOrders);
  assert.deepEqual(after.waitingOrders, { parent_not_found: 1 });
  assert.deepEqual(after.notLinkableOrders, before.notLinkableOrders);
  assert.equal(links(reopened).length, 2);
  assert.equal(after.lastError, undefined);
});

test("the startup scan reads at most the configured number of facts per tick", (t) => {
  const { store } = openStore(t);
  write(store, [1, 2, 3, 4, 5].map((n) => entryOrder(`close-${n}`, label(`cycle-${n}`, "close", 1))));
  const records = [1, 2, 3, 4, 5].map((n) => record(`cycle-${n}`, 1));
  const { linker } = makeLinker(store, records, { maxFactsPerTick: 2 });

  linker.tick();
  assert.equal(links(store).length, 2);
  linker.tick();
  linker.tick();
  assert.equal(links(store).length, 5);
});

test("a conflicting link keeps the existing one and does not block the other orders", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  // entry-2 gets linked to another cycle behind the linker's back, between
  // its classification and its write: the store refuses the second link.
  write(store, [entryOrder("close-1", label(CYCLE, "close", 1)), entryOrder("entry-2", entryLabel)]);
  const realWrite = store.writeLinks.bind(store);
  let injected = false;
  const conflicting: LinkerFactsStoreLike = {
    readFactsAfter: (after, limit) => store.readFactsAfter(after, limit),
    readLinksAfter: (after, limit) => store.readLinksAfter(after, limit),
    writeLinks: (input) => {
      if (!injected) {
        injected = true;
        const entry = input.find((link) => link.orderId === "entry-2") as OwnOrderLinkInput;
        realWrite([{ ...entry, tradeCycleId: OTHER_CYCLE }]);
      }
      return realWrite(input);
    },
  };
  const { linker, emitted } = makeLinker(conflicting, [record(CYCLE, 1)]);

  linker.tick();

  const byOrder = Object.fromEntries(links(store).map((link) => [link.orderId, link.cycle]));
  assert.equal(byOrder["entry-2"], OTHER_CYCLE);
  assert.equal(byOrder["close-1"], CYCLE);
  assert.deepEqual(linker.status().notLinkableOrders, { link_conflict: 1 });
  assert.deepEqual(
    emitted.filter((e) => e.event === "exchange_order_linker_link_conflict").map((e) => e.fields),
    [{ orderId: "entry-2", role: "entry" }],
  );
});

test("a database failure is caught, reported once and retried on the next tick", (t) => {
  const { store } = openStore(t);
  write(store, [entryOrder("entry-1", label(CYCLE, "entry", 1))]);
  let failing = true;
  const flaky: LinkerFactsStoreLike = {
    readFactsAfter: (after, limit) => store.readFactsAfter(after, limit),
    readLinksAfter: (after, limit) => store.readLinksAfter(after, limit),
    writeLinks: (input) => {
      if (failing) {
        throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      }
      return store.writeLinks(input);
    },
  };
  const { linker, emitted } = makeLinker(flaky, [record(CYCLE, 1)]);

  assert.doesNotThrow(() => linker.tick());
  assert.doesNotThrow(() => linker.tick());
  assert.equal(linker.status().lastError, "SQLITE_IOERR");
  assert.deepEqual(
    emitted.filter((e) => e.event === "exchange_order_linker_tick_failed").map((e) => e.fields),
    [{ errorCode: "SQLITE_IOERR" }],
  );
  assert.deepEqual(linker.status().waitingOrders, { own_label_unknown: 1 });

  failing = false;
  linker.tick();
  assert.equal(links(store).length, 1);
  assert.equal(linker.status().lastError, undefined);
});

test("nothing is read before the correlation store is replayed", (t) => {
  const { store } = openStore(t);
  write(store, [entryOrder("entry-1", label(CYCLE, "entry", 1))]);
  let ready = false;
  let reads = 0;
  const counting: LinkerFactsStoreLike = {
    readFactsAfter: (after, limit) => {
      reads += 1;
      return store.readFactsAfter(after, limit);
    },
    readLinksAfter: (after, limit) => store.readLinksAfter(after, limit),
    writeLinks: (input) => store.writeLinks(input),
  };
  const { linker } = makeLinker(counting, [record(CYCLE, 1)], { isCorrelationReady: () => ready });

  linker.tick();
  assert.equal(linker.status().state, "waiting_for_correlation");
  assert.equal(reads, 0);

  ready = true;
  linker.tick();
  assert.equal(linker.status().state, "running");
  assert.equal(links(store).length, 1);
});

test("stop ends the linker", (t) => {
  const { store } = openStore(t);
  const { linker } = makeLinker(store, []);
  linker.start();
  linker.stop();
  linker.tick();
  assert.equal(linker.status().state, "stopped");
});

test("no linker runs without an enabled store", () => {
  for (const exchangeFacts of [
    { status: "disabled" as const },
    { status: "unavailable" as const, reason: "exchange_facts_driver_unavailable" as const },
  ]) {
    const handle = createExchangeOrderLinker(exchangeFacts, {
      listRecords: () => {
        throw new Error("must not be called");
      },
      isCorrelationReady: () => true,
    });
    handle.start();
    handle.stop();
    assert.deepEqual(handle.status(), {
      state: "disabled",
      reason: "store_not_enabled",
      linksWritten: 0,
      waitingOrders: {},
      notLinkableOrders: {},
    });
  }
});

test("the label index resolves the labels trading builds, for every generation and both roles", () => {
  const index = new LabelIndex();
  index.refresh([record(CYCLE, 2)]);

  assert.deepEqual(index.resolve(buildEntryPackageOrderLinkId(INSTANCE, CYCLE, "entry", 2)), {
    strategyInstanceId: INSTANCE,
    tradeCycleId: CYCLE,
    role: "entry",
    generation: 2,
  });
  assert.equal((index.resolve(buildEntryPackageOrderLinkId(INSTANCE, CYCLE, "close", 1)) as { role: string }).role, "close");
  assert.equal(index.resolve(buildEntryPackageOrderLinkId(INSTANCE, CYCLE, "entry", 3)), undefined);

  index.refresh([record(CYCLE, 3)]);
  assert.equal(
    (index.resolve(buildEntryPackageOrderLinkId(INSTANCE, CYCLE, "entry", 3)) as { generation: number }).generation,
    3,
  );
});

function fromRest(fact: FactInput): FactInput {
  return { ...fact, source: "rest", sourceEndpoint: "rest:/v5/order/history" };
}

test("an unlabeled REST order state does not decide the order; its later WS child state links it", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [entryOrder("entry-1", entryLabel)]);
  // REST order history carries no parentOrderLinkId.
  store.writeRestPage({ facts: [fromRest(orderRecord({ orderId: "sl-1", stopOrderType: "PartialStopLoss" }))] });
  const { linker } = makeLinker(store, [record(CYCLE, 1)]);

  linker.tick();
  assert.deepEqual(linker.status().notLinkableOrders, {});
  assert.equal(links(store).length, 1);

  write(store, [childOrder("sl-1", entryLabel, "PartialStopLoss", T + 10)]);
  linker.tick();

  assert.deepEqual(
    links(store).map((link) => [link.orderId, link.role]),
    [
      ["entry-1", "entry"],
      ["sl-1", "stop_loss"],
    ],
  );
  assert.deepEqual(linker.status().notLinkableOrders, {});
});

test("an entry placed before the journal is linked from REST and its waiting WS child follows", (t) => {
  const { store } = openStore(t);
  const entryLabel = label(CYCLE, "entry", 1);
  write(store, [childOrder("sl-1", entryLabel, "PartialStopLoss")]);
  const { linker } = makeLinker(store, [record(CYCLE, 1)]);
  linker.tick();
  assert.deepEqual(linker.status().waitingOrders, { parent_not_found: 1 });

  store.writeRestPage({ facts: [fromRest(entryOrder("entry-1", entryLabel))] });
  linker.tick();

  assert.deepEqual(
    links(store).map((link) => [link.orderId, link.role]),
    [
      ["entry-1", "entry"],
      ["sl-1", "stop_loss"],
    ],
  );
  assert.deepEqual(linker.status().waitingOrders, {});
});
