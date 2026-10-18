import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../src/domain/entryPackageOrderIdentity.js";
import { CloseApplicationService } from "../../src/services/close/closeApplicationService.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

// abi-trade-cycle-closure-confirmation-v1: completion is proven only by
// full execution of an order attributed to the exact pair.

const ENTRY_LINK = "link-1";
const QTY = "0.001";

type Ctx = {
  lookup: OpenPositionResolutionService;
  close: CloseApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

const STOP_CLOSURE = {
  strategy_instance_id: "instance-1",
  trade_cycle_id: "cycle-1",
  reason: "stop_loss",
  order_id: "stop-child-1",
  order_link_id: null,
  parent_order_link_id: ENTRY_LINK,
};

test("lookup: the demo stop shape of cycle 2beec9fd returns a stop_loss closure and stores it", async () => {
  await withServices(async ({ lookup, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, filledStop(), deactivatedTake());
    bybit.executionListResponse = executions([QTY]);
    bybit.openPositionsResponse = flatPosition();

    const result = await lookup.resolve(query());

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: false, first_fill_at_ms: null, average_entry_price: null, closure: STOP_CLOSURE },
    });
    assert.deepEqual(bybit.getExecutionListCalls[0], { category: "linear", symbol: "BTCUSDT", orderId: "stop-child-1", limit: "50" });
    const saved = repo.get("instance-1", "cycle-1");
    assert.equal(saved?.status, "terminal_closed");
    assert.equal(saved?.closure_reason, "stop_loss");
    assert.equal(saved?.closure_order_id, "stop-child-1");
    assert.equal(saved?.closure_order_link_id, null);
    assert.equal(saved?.closure_parent_order_link_id, ENTRY_LINK);
    assert.equal(bybit.createOrderCalls.length + bybit.cancelOrderCalls.length, 0);
  });
});

test("lookup: a filled take-profit child returns a take_profit closure", async () => {
  await withServices(async ({ lookup, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, deactivatedStop(), filledTake());
    bybit.executionListResponse = executions([QTY]);
    bybit.openPositionsResponse = flatPosition();

    const result = await lookup.resolve(query());

    assert.equal(result.statusCode, 200);
    assert.deepEqual((result.body as { closure: unknown }).closure, {
      ...STOP_CLOSURE,
      reason: "take_profit",
      order_id: "take-child-1",
    });
  });
});

test("lookup: an executed own close is found while a sibling keeps the same-side slot open", async () => {
  await withServices(async ({ lookup, bybit, repo }) => {
    await repo.save(makeRecord({ close_order_link_id: closeId() }));
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    setOrder(bybit, closeId(), "Filled", QTY, "close-order-1");
    installProtection(bybit, deactivatedStop(), deactivatedTake());
    bybit.openPositionsResponse = position("Buy", "0.002");

    const result = await lookup.resolve(query());

    assert.equal(result.statusCode, 200);
    assert.deepEqual((result.body as { closure: unknown }).closure, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      reason: "runtime_signal",
      order_id: "close-order-1",
      order_link_id: closeId(),
      parent_order_link_id: null,
    });
    assert.equal(repo.get("instance-1", "cycle-1")?.closure_reason, "runtime_signal");
  });
});

test("lookup: an open position with active protection is unchanged", async () => {
  await withServices(async ({ lookup, bybit, repo }) => {
    await repo.save(makeRecord({ first_fill_at_ms: 111 }));
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, stopRow(), takeRow());
    bybit.openPositionsResponse = position("Buy", QTY);

    const result = await lookup.resolve(query());

    assert.deepEqual(result.body, { position_open: true, first_fill_at_ms: 111, average_entry_price: "100000", closure: null });
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
  });
});

test("lookup: unprovable or contradictory completion is internal_error with no durable write", async () => {
  const cases: Array<{ name: string; arrange: (bybit: FakeBybitAdapter) => void }> = [
    {
      name: "history lag: no own children visible and no position",
      arrange: (bybit) => {
        installProtection(bybit);
        bybit.openPositionsResponse = flatPosition();
      },
    },
    {
      name: "partially filled leg",
      arrange: (bybit) => {
        installProtection(bybit, stopRow({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", leavesQty: "0.0005" }), deactivatedTake());
        bybit.openPositionsResponse = flatPosition();
      },
    },
    {
      name: "both legs filled",
      arrange: (bybit) => {
        installProtection(bybit, filledStop(), filledTake());
        bybit.executionListResponse = executions([QTY]);
        bybit.openPositionsResponse = flatPosition();
      },
    },
    {
      name: "execution sum differs from the own fill",
      arrange: (bybit) => {
        installProtection(bybit, filledStop(), deactivatedTake());
        bybit.executionListResponse = executions(["0.0004"]);
        bybit.openPositionsResponse = flatPosition();
      },
    },
    {
      name: "filled leg while the other leg is still live",
      arrange: (bybit) => {
        installProtection(bybit, filledStop(), takeRow());
        bybit.executionListResponse = executions([QTY]);
        bybit.openPositionsResponse = flatPosition();
      },
    },
    {
      name: "sibling keeps the slot while the own stop filled partially",
      arrange: (bybit) => {
        installProtection(bybit, stopRow({ orderStatus: "Deactivated", cumExecQty: "0.0004", leavesQty: "0" }), deactivatedTake());
        bybit.openPositionsResponse = position("Buy", "0.0016");
      },
    },
  ];

  for (const item of cases) {
    await withServices(async ({ lookup, bybit, repo }) => {
      await repo.save(makeRecord());
      setOrder(bybit, ENTRY_LINK, "Filled", QTY);
      item.arrange(bybit);

      const result = await lookup.resolve(query());

      assert.equal(result.statusCode, 500, item.name);
      assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied", item.name);
      assert.equal(bybit.createOrderCalls.length + bybit.cancelOrderCalls.length, 0, item.name);
    });
  }
});

test("close: a stop that already filled closes the cycle with no cancel and no close order", async () => {
  await withServices(async ({ close, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, filledStop(), deactivatedTake());
    bybit.executionListResponse = executions([QTY]);
    bybit.openPositionsResponse = flatPosition();

    const result = await close.apply(query());

    assert.deepEqual(result, {
      statusCode: 200,
      body: { strategy_instance_id: "instance-1", trade_cycle_id: "cycle-1", status: "trade_cycle_closed", closure: STOP_CLOSURE },
    });
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.closure_reason, "stop_loss");
  });
});

test("close: a stop that fills during neutralization is the closure and no close order is sent", async () => {
  await withServices(async ({ close, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, stopRow(), takeRow());
    bybit.executionListResponse = executions([QTY]);
    bybit.openPositionsResponse = flatPosition();
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      await realCancel(payload);
      installProtection(bybit, filledStop(), deactivatedTake());
      return { retCode: 110001, retMsg: "order not exists or too late to cancel", result: {} };
    };

    const result = await close.apply(query());

    assert.equal(result.statusCode, 200);
    assert.deepEqual((result.body as { closure: unknown }).closure, STOP_CLOSURE);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("close: a partial own stop next to a sibling never dispatches a market order", async () => {
  await withServices(async ({ close, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, stopRow({ orderStatus: "Deactivated", cumExecQty: "0.0004", leavesQty: "0" }), deactivatedTake());
    bybit.openPositionsResponse = position("Buy", "0.0016");

    const result = await close.apply(query());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
  });
});

test("close: the normal runtime close with active protection returns a runtime_signal closure", async () => {
  await withServices(async ({ close, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrder(bybit, ENTRY_LINK, "Filled", QTY);
    installProtection(bybit, stopRow(), takeRow());
    bybit.openPositionsResponse = position("Buy", QTY);
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      installProtection(bybit, deactivatedStop(), deactivatedTake());
      return response;
    };
    const realCreate = bybit.createOrder.bind(bybit);
    bybit.createOrder = async (payload) => {
      const response = await realCreate(payload);
      setOrder(bybit, payload.orderLinkId, "Filled", QTY, "close-order-1");
      return response;
    };

    const result = await close.apply(query());

    assert.equal(result.statusCode, 200);
    assert.deepEqual((result.body as { closure: unknown }).closure, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      reason: "runtime_signal",
      order_id: "close-order-1",
      order_link_id: closeId(),
      parent_order_link_id: null,
    });
    assert.equal(bybit.createOrderCalls.length, 1);
    const saved = repo.get("instance-1", "cycle-1");
    assert.equal(saved?.closure_reason, "runtime_signal");
    assert.equal(saved?.closure_order_id, "close-order-1");
    assert.equal(saved?.closure_order_link_id, closeId());
  });
});

test("repeated lookup and Close answer the stored closure with no exchange call", async () => {
  await withServices(async ({ lookup, close, bybit, repo }) => {
    await repo.save(
      makeRecord({
        status: "terminal_closed",
        closure_reason: "stop_loss",
        closure_order_id: "stop-child-1",
        closure_parent_order_link_id: ENTRY_LINK,
      }),
    );
    bybit.getActiveOrders = async () => {
      throw new Error("no exchange call expected");
    };

    const looked = await lookup.resolve(query());
    const closed = await close.apply(query());

    assert.deepEqual((looked.body as { closure: unknown }).closure, STOP_CLOSURE);
    assert.deepEqual((closed.body as { closure: unknown }).closure, STOP_CLOSURE);
    assert.equal(bybit.getOrderByLinkIdCalls.length + bybit.getOrderHistoryForSymbolCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length + bybit.getExecutionListCalls.length, 0);
  });
});

test("legacy terminal_closed records answer runtime_signal from stored close identity, else null", async () => {
  await withServices(async ({ lookup, close, repo }) => {
    await repo.save(makeRecord({ status: "terminal_closed", close_order_link_id: closeId(), close_order_id: "close-order-1" }));
    await repo.save(makeRecord({ tradeCycleId: "cycle-2", status: "terminal_closed" }));

    const legacy = {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      reason: "runtime_signal",
      order_id: "close-order-1",
      order_link_id: closeId(),
      parent_order_link_id: null,
    };
    assert.deepEqual(((await lookup.resolve(query())).body as { closure: unknown }).closure, legacy);
    assert.deepEqual(((await close.apply(query())).body as { closure: unknown }).closure, legacy);

    const withoutId = { strategyInstanceId: "instance-1", tradeCycleId: "cycle-2" };
    assert.equal(((await lookup.resolve(withoutId)).body as { closure: unknown }).closure, null);
    assert.equal(((await close.apply(withoutId)).body as { closure: unknown }).closure, null);
  });
});

test("replay keeps closure fields of a stored record and normalizes legacy rows to null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-closure-replay-"));
  try {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    await repo.save(
      makeRecord({
        status: "terminal_closed",
        closure_reason: "take_profit",
        closure_order_id: "take-child-1",
        closure_parent_order_link_id: ENTRY_LINK,
      }),
    );
    const legacy: Record<string, unknown> = { ...makeRecord({ tradeCycleId: "cycle-2", status: "terminal_closed" }) };
    for (const key of ["closure_reason", "closure_order_id", "closure_order_link_id", "closure_parent_order_link_id"]) {
      delete legacy[key];
    }
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, `${JSON.stringify(legacy)}\n`);

    const replayed = new EntryPackageCorrelationRepository(path);
    const readiness = await replayed.replay();
    assert.deepEqual(readiness, { ok: true });
    assert.equal(replayed.get("instance-1", "cycle-1")?.closure_reason, "take_profit");
    assert.equal(replayed.get("instance-1", "cycle-2")?.closure_reason, null);
    assert.equal(replayed.get("instance-1", "cycle-2")?.closure_order_id, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withServices(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-closure-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const lookup = new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex });
    const close = new CloseApplicationService({ config, bybit, correlationRepository: repo, mutex });
    await fn({ lookup, close, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function query(): { strategyInstanceId: string; tradeCycleId: string } {
  return { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" };
}

function closeId(): string {
  return buildEntryPackageOrderLinkId("instance-1", "cycle-1", "close", 1);
}

function makeRecord(
  overrides: Partial<EntryPackageExecutionRecord> & { tradeCycleId?: string } = {},
): EntryPackageExecutionRecord {
  const { tradeCycleId, ...fields } = overrides;
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    position_binding_mode: "one_way",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: QTY,
    order_link_id: tradeCycleId === undefined ? ENTRY_LINK : `${ENTRY_LINK}-${tradeCycleId}`,
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    closure_reason: null,
    closure_order_id: null,
    closure_order_link_id: null,
    closure_parent_order_link_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

function setOrder(bybit: FakeBybitAdapter, orderLinkId: string, orderStatus: string, cumExecQty: string, orderId = `order-${orderLinkId}`): void {
  const response = {
    retCode: 0,
    result: {
      list: [{ orderId, orderStatus, triggerPrice: "100000", qty: QTY, cumExecQty, avgPrice: "100000", stopLoss: "99000", takeProfit: "103000" }],
    },
  };
  bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
  bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
}

// Realtime empty, both children in history: the terminal shape the demo
// read-only check observed for cycle 2beec9fd.
function installProtection(bybit: FakeBybitAdapter, ...rows: Record<string, unknown>[]): void {
  const live = rows.filter((row) => ["New", "Untriggered", "Triggered"].includes(row.orderStatus as string));
  const terminal = rows.filter((row) => !live.includes(row));
  bybit.activeOrdersResponse = childList(live);
  bybit.orderHistoryForSymbolResponse = childList(terminal);
}

function stopRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId: "stop-child-1",
    parentOrderLinkId: ENTRY_LINK,
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty: QTY,
    leavesQty: QTY,
    cumExecQty: "0",
    positionIdx: 0,
    ...overrides,
  };
}

function takeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return stopRow({
    orderId: "take-child-1",
    stopOrderType: "PartialTakeProfit",
    createType: "CreateByPartialTakeProfit",
    triggerPrice: "103000",
    ...overrides,
  });
}

function filledStop(): Record<string, unknown> {
  return stopRow({ orderStatus: "Filled", cumExecQty: QTY, leavesQty: "0" });
}

function filledTake(): Record<string, unknown> {
  return takeRow({ orderStatus: "Filled", cumExecQty: QTY, leavesQty: "0" });
}

function deactivatedStop(): Record<string, unknown> {
  return stopRow({ orderStatus: "Deactivated", leavesQty: "0" });
}

function deactivatedTake(): Record<string, unknown> {
  return takeRow({ orderStatus: "Deactivated", leavesQty: "0" });
}

function childList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: "linear", list: rows } };
}

function executions(quantities: string[]): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      nextPageCursor: "",
      list: quantities.map((execQty, index) => ({ symbol: "BTCUSDT", execType: "Trade", execTime: String(1785000000000 + index), execQty })),
    },
  };
}

function position(side: "Buy" | "Sell", size: string): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol: "BTCUSDT", side, size, positionIdx: 0, avgPrice: "100000", openTime: 1 }],
    },
  };
}

function flatPosition(): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol: "BTCUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }],
    },
  };
}
