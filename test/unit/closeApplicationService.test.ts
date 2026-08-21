import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import type { AbiConfig } from "../../src/config/config.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../src/domain/entryPackageOrderIdentity.js";
import { CloseApplicationService } from "../../src/services/close/closeApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: CloseApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

test("unknown and already-closed bindings are handled without exchange writes", async () => {
  await withService(async ({ service, bybit, repo }) => {
    const unknown = await service.apply(makeCommand());
    assert.equal(unknown.statusCode, 422);

    await repo.save(makeRecord({ status: "terminal_closed" }));
    const closed = await service.apply(makeCommand());
    assert.equal(closed.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

for (const status of ["absent", "terminal_unfilled"] as const) {
  test(`${status} is durably promoted without querying or writing Bybit`, async () => {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));
      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 200);
      assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
      assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
      assert.equal(bybit.cancelOrderCalls.length, 0);
      assert.equal(bybit.createOrderCalls.length, 0);
    });
  });
}

test("unsupported, missing-identity, and mixed-side records fail before exchange writes", async () => {
  const cases: Array<(repo: EntryPackageCorrelationRepository) => Promise<void>> = [
    async (repo) => repo.save(makeRecord({ exchangeCategory: "spot" })),
    async (repo) => repo.save(makeRecord({ orderLinkId: null })),
    async (repo) => {
      await repo.save(makeRecord());
      await repo.save(
        makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", orderLinkId: "link-2", side: "short" }),
      );
    },
  ];

  for (const arrange of cases) {
    await withService(async ({ service, bybit, repo }) => {
      await arrange(repo);
      const result = await service.apply(makeCommand());
      assert.ok(result.statusCode >= 400);
      assert.equal(bybit.cancelOrderCalls.length, 0);
      assert.equal(bybit.createOrderCalls.length, 0);
    });
  }
});

test("entry remainder is cancelled and confirmed before protection and aggregate observation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ calculatedQuantity: "0.003" }));
    setEntry(bybit, "link-1", "PartiallyFilled", "0.001", "0.003");
    installTerminalProtection(bybit, "link-1", "0.001");
    setPosition(bybit, "Buy", "0.001");
    installFilledCloseAfterCreate(bybit, closeId(), "0.001");

    const events: string[] = [];
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      events.push(payload.orderLinkId === "link-1" ? "entry-cancel" : "child-cancel");
      const response = await realCancel(payload);
      if (payload.orderLinkId === "link-1") {
        setEntry(bybit, "link-1", "Cancelled", "0.001", "0.003");
      }
      return response;
    };
    const realActive = bybit.getActiveOrders.bind(bybit);
    bybit.getActiveOrders = async (input) => {
      events.push("protection-read");
      return realActive(input);
    };
    const realPositions = bybit.getOpenPositions.bind(bybit);
    bybit.getOpenPositions = async (input) => {
      events.push("aggregate-read");
      return realPositions(input);
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(events.slice(0, 3), ["entry-cancel", "protection-read", "aggregate-read"]);
    assert.equal(bybit.createOrderCalls[0].qty, "0.001");
  });
});

test("active native pair is cancelled by exact child orderId and freshly re-read before market close", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    const ownRows = installActiveProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.006");
    installFilledCloseAfterCreate(bybit, closeId(), "0.003");

    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      if (payload.orderId === "stop-link-1") {
        terminalize(ownRows);
      }
      return response;
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 1, "coupled cancel needs only one exact child write");
    assert.deepEqual(bybit.cancelOrderCalls[0], { category: "linear", symbol: "BTCUSDT", orderId: "stop-link-1" });
    assert.ok(bybit.getOrderHistoryForSymbolCalls.length >= 3, "pre-cancel, post-ACK, and terminal reads are fresh");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.cancelAllOrdersCalls.length, 0);
  });
});

test("clean absence after an accepted exact child cancel bridges Bybit terminal-history propagation lag", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installActiveProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");
    installFilledCloseAfterCreate(bybit, closeId(), "0.003");

    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      if (payload.orderId === "stop-link-1") {
        // Real Demo behavior: both children leave realtime immediately,
        // while terminal history can remain empty for a propagation gap.
        installNoProtection(bybit);
      }
      return response;
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
  });
});

test("child identity drift after cancel fails closed and never dispatches market close", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installActiveProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");

    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      if (payload.orderId === "stop-link-1") {
        bybit.activeOrdersResponse = childList([
          stopRow("link-1", "0.003", { orderId: "replacement-stop", orderStatus: "Deactivated", leavesQty: "0" }),
          takeRow("link-1", "0.003", { orderId: "replacement-take", orderStatus: "Deactivated", leavesQty: "0" }),
        ]);
      }
      return response;
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 500);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
  });
});

test("protection is always neutralized before a market-close write", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installActiveProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");

    const events: string[] = [];
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      events.push(`cancel:${payload.orderId ?? payload.orderLinkId}`);
      return realCancel(payload);
    };
    const realCreate = bybit.createOrder.bind(bybit);
    bybit.createOrder = async (payload) => {
      events.push(`create:${payload.orderLinkId}`);
      return realCreate(payload);
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 500, "unchanged active read-back is not neutralization proof");
    assert.ok(events.some((event) => event.startsWith("cancel:stop-link-1")));
    assert.equal(events.some((event) => event.startsWith("create:")), false);
    assert.equal(bybit.getOpenPositionsCalls.length, 0, "aggregate and close are unreachable while protection stays active");
  });
});

test("ambiguous, duplicate, failed, or rejected protection cleanup sends zero close writes", async () => {
  const cases: Array<(bybit: FakeBybitAdapter) => void> = [
    (bybit) => {
      bybit.activeOrdersResponse = childList([stopRow("link-1", "0.003"), stopRow("link-1", "0.003", { orderId: "stop-2" }), takeRow("link-1", "0.003")]);
    },
    (bybit) => {
      bybit.activeOrdersResponse = { retCode: 0, result: { category: "linear", list: "bad" } };
    },
    (bybit) => {
      bybit.getActiveOrders = async () => {
        throw new Error("transport");
      };
    },
    (bybit) => {
      installActiveProtection(bybit, "link-1", "0.003");
      bybit.cancelOrder = async (payload) => {
        bybit.cancelOrderCalls.push(payload);
        return { retCode: 10001, retMsg: "rejected", result: {} };
      };
    },
  ];

  for (const configure of cases) {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
      setPosition(bybit, "Buy", "0.003");
      configure(bybit);
      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 500);
      assert.equal(bybit.createOrderCalls.length, 0);
      assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
    });
  }
});

test("zero own exposure cleans protection but never creates a close identity or order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Cancelled", "0", "0.003");
    const rows = installActiveProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "5", "BTCUSDT");
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      if (payload.orderId !== undefined) terminalize(rows);
      return response;
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 0);
    const saved = repo.get("instance-1", "cycle-1");
    assert.equal(saved?.close_order_link_id, null);
    assert.equal(saved?.status, "terminal_closed");
  });
});

test("zero own exposure aggregate truth table accepts flat/same-side and rejects opposite/failure", async () => {
  const cases: Array<{ name: string; response: unknown; expected: number }> = [
    { name: "flat", response: flatPosition(), expected: 200 },
    { name: "same-side sibling", response: position("Buy", "2"), expected: 200 },
    { name: "opposite", response: position("Sell", "2"), expected: 500 },
    { name: "malformed", response: { retCode: 0, result: { category: "linear", list: "bad" } }, expected: 500 },
    { name: "failed", response: { retCode: 10001, retMsg: "failed", result: {} }, expected: 500 },
  ];

  for (const item of cases) {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", "Cancelled", "0", "0.003");
      installNoProtection(bybit);
      bybit.openPositionsResponse = item.response;
      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, item.expected, item.name);
      assert.equal(bybit.createOrderCalls.length, 0, item.name);
    });
  }
});

test("positive own exposure aggregate truth table accepts only sufficient same-side state", async () => {
  const cases: Array<{ name: string; response: unknown; expected: number }> = [
    { name: "equal same-side", response: position("Buy", "0.003"), expected: 200 },
    { name: "larger same-side", response: position("Buy", "9"), expected: 200 },
    { name: "smaller same-side", response: position("Buy", "0.002"), expected: 500 },
    { name: "flat", response: flatPosition(), expected: 500 },
    { name: "opposite", response: position("Sell", "9"), expected: 500 },
    { name: "malformed", response: { retCode: 0, result: { category: "linear", list: [] } }, expected: 500 },
    { name: "failed", response: { retCode: 10001, retMsg: "failed", result: {} }, expected: 500 },
  ];

  for (const item of cases) {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
      installTerminalProtection(bybit, "link-1", "0.003");
      bybit.openPositionsResponse = item.response;
      if (item.expected === 200) installFilledCloseAfterCreate(bybit, closeId(), "0.003");

      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, item.expected, item.name);
      assert.equal(bybit.createOrderCalls.length, item.expected === 200 ? 1 : 0, item.name);
      if (item.expected === 200) assert.equal(bybit.createOrderCalls[0].qty, "0.003", item.name);
    });
  }
});

test("sole and shared owners use exact own fill quantity and preserve sibling children/correlation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A", orderLinkId: "link-a", calculatedQuantity: "0.004" }));
    await repo.save(makeRecord({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B", orderLinkId: "link-b", calculatedQuantity: "0.006" }));
    setEntry(bybit, "link-a", "Cancelled", "0.001", "0.004");
    setEntry(bybit, "link-b", "Filled", "0.006", "0.006");
    const ownRows = terminalProtectionRows("link-a", "0.001");
    const siblingRows = activeProtectionRows("link-b", "0.006");
    bybit.activeOrdersResponse = childList([...ownRows, ...siblingRows]);
    bybit.orderHistoryForSymbolResponse = childList([]);
    setPosition(bybit, "Buy", "0.007");
    const expectedClose = closeIdentity("instance-A", "cycle-A");
    installFilledCloseAfterCreate(bybit, expectedClose, "0.001");
    const siblingBefore = repo.get("instance-B", "cycle-B");

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls[0].qty, "0.001");
    assert.equal(bybit.createOrderCalls[0].orderLinkId, expectedClose);
    assert.equal(bybit.cancelOrderCalls.some((call) => call.orderId?.startsWith("stop-link-b") || call.orderId?.startsWith("take-link-b")), false);
    assert.deepEqual(repo.get("instance-B", "cycle-B"), siblingBefore);
    assert.equal(siblingRows.every((row) => row.orderStatus === "Untriggered"), true);
  });
});

test("an already-filled exact close identity is recovered without resend", async () => {
  await withService(async ({ service, bybit, repo }) => {
    const identity = closeId();
    await repo.save(makeRecord({ closeOrderLinkId: identity }));
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installTerminalProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");
    setOrder(bybit, identity, "Filled", "0.003", "0.003");

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("zero/partial close execution is incomplete and live/ambiguous close is fail-closed", async () => {
  const cases: Array<{ status: string; cumExecQty: string; expected: number }> = [
    { status: "Cancelled", cumExecQty: "0", expected: 422 },
    { status: "Cancelled", cumExecQty: "0.001", expected: 422 },
    { status: "New", cumExecQty: "0", expected: 500 },
  ];
  for (const item of cases) {
    await withService(async ({ service, bybit, repo }) => {
      const identity = closeId();
      await repo.save(makeRecord({ closeOrderLinkId: identity }));
      setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
      installTerminalProtection(bybit, "link-1", "0.003");
      setPosition(bybit, "Buy", "0.003");
      setOrder(bybit, identity, item.status, item.cumExecQty, "0.003");
      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, item.expected);
      assert.equal(bybit.createOrderCalls.length, 0);
      assert.notEqual(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
    });
  }
});

test("a genuinely never-created durable close identity is resent once with the same identity", async () => {
  await withService(async ({ service, bybit, repo }) => {
    const identity = closeId();
    await repo.save(makeRecord({ closeOrderLinkId: identity }));
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installTerminalProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");
    installFilledCloseAfterCreate(bybit, identity, "0.003");

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls[0].orderLinkId, identity);
  });
});

test("close identity is durable before a guarded or throwing write and reused on retry", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
      installTerminalProtection(bybit, "link-1", "0.003");
      setPosition(bybit, "Buy", "0.003");

      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 500);
      assert.equal(bybit.createOrderCalls.length, 0);
      assert.equal(repo.get("instance-1", "cycle-1")?.close_order_link_id, closeId());
    },
    { liveTradingEnabled: false },
  );

  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installTerminalProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");
    bybit.createOrder = async () => {
      throw new Error("timeout after write");
    };
    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 500);
    assert.equal(repo.get("instance-1", "cycle-1")?.close_order_link_id, closeId());
  });
});

test("reappearing protection after exact close execution blocks terminal_closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    const identity = closeId();
    await repo.save(makeRecord({ closeOrderLinkId: identity }));
    setEntry(bybit, "link-1", "Filled", "0.003", "0.003");
    installTerminalProtection(bybit, "link-1", "0.003");
    setPosition(bybit, "Buy", "0.003");
    setOrder(bybit, identity, "Filled", "0.003", "0.003");

    let activeReads = 0;
    const terminal = bybit.activeOrdersResponse;
    bybit.getActiveOrders = async () => {
      activeReads += 1;
      return activeReads === 1 ? terminal : childList(activeProtectionRows("link-1", "0.003"));
    };

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 500);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-close-cutover-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const service = new CloseApplicationService({
      config: liveConfig(configOverrides),
      bybit,
      correlationRepository: repo,
      mutex: new KeyedMutex(),
    });
    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function liveConfig(overrides: Partial<AbiConfig> = {}): AbiConfig {
  return makeTestConfig({
    dryRun: false,
    liveTradingEnabled: true,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
    bybitEnvironment: "testnet",
    ...overrides,
  });
}

function makeCommand(overrides: { strategyInstanceId?: string; tradeCycleId?: string } = {}): {
  strategyInstanceId: string;
  tradeCycleId: string;
} {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<{
    strategyInstanceId: string;
    tradeCycleId: string;
    status: EntryPackageExecutionStatus;
    exchangeSymbol: string;
    exchangeCategory: "linear" | "spot";
    orderLinkId: string | null;
    calculatedQuantity: string;
    side: "long" | "short";
    generation: number;
    closeOrderLinkId: string | null;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: overrides.exchangeSymbol ?? "BTCUSDT",
    exchange_category: overrides.exchangeCategory ?? "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: {
      side: overrides.side ?? "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: overrides.calculatedQuantity ?? "0.003",
    order_link_id: overrides.orderLinkId === undefined ? "link-1" : overrides.orderLinkId,
    order_id: overrides.orderLinkId === null ? null : "order-1",
    close_order_link_id: overrides.closeOrderLinkId ?? null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: overrides.generation ?? 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

function setEntry(
  bybit: FakeBybitAdapter,
  orderLinkId: string,
  orderStatus: string,
  cumExecQty: string,
  qty: string,
): void {
  setOrder(bybit, orderLinkId, orderStatus, cumExecQty, qty);
}

function setOrder(
  bybit: FakeBybitAdapter,
  orderLinkId: string,
  orderStatus: string,
  cumExecQty: string,
  qty: string,
): void {
  const response = {
    retCode: 0,
    result: {
      list: [{ orderStatus, triggerPrice: "100000", qty, cumExecQty, stopLoss: "99000", takeProfit: "103000" }],
    },
  };
  bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
  bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
}

function installFilledCloseAfterCreate(bybit: FakeBybitAdapter, orderLinkId: string, qty: string): void {
  const realCreate = bybit.createOrder.bind(bybit);
  bybit.createOrder = async (payload) => {
    const response = await realCreate(payload);
    if (payload.orderLinkId === orderLinkId) setOrder(bybit, orderLinkId, "Filled", qty, qty);
    return response;
  };
}

function installNoProtection(bybit: FakeBybitAdapter): void {
  bybit.activeOrdersResponse = childList([]);
  bybit.orderHistoryForSymbolResponse = childList([]);
}

function installActiveProtection(bybit: FakeBybitAdapter, parentOrderLinkId: string, qty: string): Record<string, unknown>[] {
  const rows = activeProtectionRows(parentOrderLinkId, qty);
  bybit.activeOrdersResponse = childList(rows);
  bybit.orderHistoryForSymbolResponse = childList([]);
  return rows;
}

function installTerminalProtection(bybit: FakeBybitAdapter, parentOrderLinkId: string, qty: string): void {
  bybit.activeOrdersResponse = childList(terminalProtectionRows(parentOrderLinkId, qty));
  bybit.orderHistoryForSymbolResponse = childList([]);
}

function activeProtectionRows(parentOrderLinkId: string, qty: string): Record<string, unknown>[] {
  return [stopRow(parentOrderLinkId, qty), takeRow(parentOrderLinkId, qty)];
}

function terminalProtectionRows(parentOrderLinkId: string, qty: string): Record<string, unknown>[] {
  return activeProtectionRows(parentOrderLinkId, qty).map((row) => ({ ...row, orderStatus: "Deactivated", leavesQty: "0" }));
}

function terminalize(rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    row.orderStatus = "Deactivated";
    row.leavesQty = "0";
  }
}

function childList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: "linear", list: rows } };
}

function stopRow(parentOrderLinkId: string, qty: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId: `stop-${parentOrderLinkId}`,
    parentOrderLinkId,
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty,
    leavesQty: qty,
    ...overrides,
  };
}

function takeRow(parentOrderLinkId: string, qty: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...stopRow(parentOrderLinkId, qty),
    orderId: `take-${parentOrderLinkId}`,
    stopOrderType: "PartialTakeProfit",
    createType: "CreateByPartialTakeProfit",
    triggerPrice: "103000",
    ...overrides,
  };
}

function setPosition(bybit: FakeBybitAdapter, side: "Buy" | "Sell", size: string, symbol = "BTCUSDT"): void {
  bybit.openPositionsResponse = position(side, size, symbol);
}

function position(side: "Buy" | "Sell", size: string, symbol = "BTCUSDT"): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol, side, size, positionIdx: 0, avgPrice: "100000", openTime: 1 }],
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

function closeId(): string {
  return closeIdentity("instance-1", "cycle-1");
}

function closeIdentity(strategyInstanceId: string, tradeCycleId: string, generation = 1): string {
  return buildEntryPackageOrderLinkId(strategyInstanceId, tradeCycleId, "close", generation);
}
