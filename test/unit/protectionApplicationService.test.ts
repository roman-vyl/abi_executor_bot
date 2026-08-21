import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import type { AbiConfig } from "../../src/config/config.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EarlyExecutionObservation,
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { ProtectionApplicationService } from "../../src/services/protection/protectionApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: ProtectionApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
  tradingRules: FakeInstrumentTradingRulesProvider;
};

test("unknown and durably absent pairs fail before any exchange query", async () => {
  await withService(async ({ service, bybit, repo }) => {
    const unknown = await service.apply(makeCommand());
    assert.equal(unknown.statusCode, 422);
    assert.equal((unknown.body as { error: { code: string } }).error.code, "unknown_trade_cycle_binding");

    await repo.save(makeRecord({ status: "absent" }));
    const absent = await service.apply(makeCommand());
    assert.equal(absent.statusCode, 422);
    assert.equal((absent.body as { error: { code: string } }).error.code, "position_not_open");

    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
    assert.equal(bybit.amendOrderCalls.length, 0);
  });
});

test("unsupported scope and no live position fail before native attribution or amend", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ exchangeCategory: "spot" }));
    const unsupported = await service.apply(makeCommand());
    assert.equal(unsupported.statusCode, 422);
    assert.equal((unsupported.body as { error: { code: string } }).error.code, "unsupported_exchange_scope");

    assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
    assert.equal(bybit.amendOrderCalls.length, 0);
  });

  await withService(async ({ service, bybit, repo }) => {
    await repo.save(
      makeRecord({
        status: "applied",
        earlyExecutionObservation: {
          order_status: "Cancelled",
          cumulative_filled_qty: "0",
          remaining_qty: "0.001",
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    bybit.openPositionsResponse = closedPositionResponse();
    const closed = await service.apply(makeCommand());
    assert.equal(closed.statusCode, 422);
    assert.equal((closed.body as { error: { code: string } }).error.code, "position_not_open");

    assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
    assert.equal(bybit.amendOrderCalls.length, 0);
  });
});

test("already-satisfied native Partial pair returns the closed public success without a write", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    installAttributedRows(bybit);

    const result = await service.apply(makeCommand());

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        strategy_instance_id: "instance-1",
        trade_cycle_id: "cycle-1",
        status: "protection_applied",
        stop_price: "99000",
        take_price: "103000",
      },
    });
    assert.equal(bybit.amendOrderCalls.length, 0);
  });
});

test("explicit take changes reconcile in place and succeed only after fresh read-back", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    installMutableAttributedRows(bybit, { stop: { triggerPrice: "98000" }, take: { triggerPrice: "104000" } });

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      bybit.amendOrderCalls.map((call) => ({ orderId: call.orderId, triggerPrice: call.triggerPrice, qty: call.qty })),
      [
        { orderId: "stop-1", triggerPrice: "99000", qty: undefined },
        { orderId: "take-1", triggerPrice: "103000", qty: undefined },
      ],
    );
    assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 2, "pre-amend and post-amend attribution are both fresh");
  });
});

test("quantity change travels on STOP and Bybit-synchronized sibling qty is freshly confirmed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    installMutableAttributedRows(bybit, { stop: { qty: "0.0005" }, take: { qty: "0.0005" } });

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(bybit.amendOrderCalls, [
      { category: "linear", symbol: "BTCUSDT", orderId: "stop-1", qty: "0.001" },
    ]);
  });
});

test("take_price null uses the deterministic surrogate but preserves public null", async () => {
  await withService(async ({ service, bybit, repo, tradingRules }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    tradingRules.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" };
    installMutableAttributedRows(bybit, { take: { triggerPrice: "103000" } });

    const result = await service.apply(makeCommand({ takePrice: null }));

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { take_price: string | null }).take_price, null);
    assert.deepEqual(bybit.amendOrderCalls, [
      { category: "linear", symbol: "BTCUSDT", orderId: "take-1", triggerPrice: "150000" },
    ]);
  });
});

test("trading-rules failure on null take is typed into safe internal_error without attribution or amend", async () => {
  await withService(async ({ service, bybit, repo, tradingRules }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    tradingRules.failure = new Error("transport failure");

    const result = await service.apply(makeCommand({ takePrice: null }));

    assert.equal(result.statusCode, 500);
    assert.equal((result.body as { error: { code: string } }).error.code, "internal_error");
    assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
    assert.equal(bybit.amendOrderCalls.length, 0);
  });
});

test("terminal, missing, duplicate, and query-failed attribution all fail closed without fallback", async () => {
  const cases: Array<{ name: string; configure: (bybit: FakeBybitAdapter) => void }> = [
    {
      name: "terminal leg",
      configure: (bybit) => installAttributedRows(bybit, { stop: { orderStatus: "Deactivated", leavesQty: "0" } }),
    },
    {
      name: "no pair",
      configure: (bybit) => {
        bybit.activeOrdersResponse = childList([]);
        bybit.orderHistoryForSymbolResponse = childList([]);
      },
    },
    {
      name: "duplicate stop",
      configure: (bybit) => {
        bybit.activeOrdersResponse = childList([stopRow(), stopRow({ orderId: "stop-2" }), takeRow()]);
        bybit.orderHistoryForSymbolResponse = childList([]);
      },
    },
    {
      name: "query failure",
      configure: (bybit) => {
        bybit.getActiveOrders = async () => {
          throw new Error("timeout");
        };
      },
    },
  ];

  for (const item of cases) {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setOpenLong(bybit);
      item.configure(bybit);

      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 500, item.name);
      assert.equal(bybit.amendOrderCalls.length, 0, item.name);
    });
  }
});

test("amend rejection and unconfirmed post-amend state fail closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    installAttributedRows(bybit, { stop: { triggerPrice: "98000" } });
    bybit.amendOrderResponse = { retCode: 10001, retMsg: "rejected", result: {} };

    const rejected = await service.apply(makeCommand());
    assert.equal(rejected.statusCode, 500);
  });

  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOpenLong(bybit);
    installAttributedRows(bybit, { stop: { triggerPrice: "98000" } });

    const mismatch = await service.apply(makeCommand());
    assert.equal(mismatch.statusCode, 500);
    assert.equal(bybit.amendOrderCalls.length, 1);
  });
});

test("live guard blocks both already-satisfied acknowledgement and amend", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setOpenLong(bybit);
      installAttributedRows(bybit);

      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 500);
      assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
      assert.equal(bybit.amendOrderCalls.length, 0);
    },
    { liveTradingEnabled: false },
  );
});

test("sole owner and same-side shared owner use identical native lifecycle and never touch sibling children", async () => {
  const run = async (shared: boolean): Promise<{ calls: unknown[]; siblingRows: Record<string, unknown>[] }> => {
    let captured: { calls: unknown[]; siblingRows: Record<string, unknown>[] } | undefined;
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      if (shared) {
        await repo.save(makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", orderLinkId: "link-2" }));
      }
      setOpenLong(bybit, shared ? "0.002" : "0.001");

      const siblingRows = [
        stopRow({ orderId: "sibling-stop", parentOrderLinkId: "link-2", triggerPrice: "97000" }),
        takeRow({ orderId: "sibling-take", parentOrderLinkId: "link-2", triggerPrice: "105000" }),
      ];
      installMutableAttributedRows(bybit, { stop: { triggerPrice: "98000" } }, shared ? siblingRows : []);

      const result = await service.apply(makeCommand());
      assert.equal(result.statusCode, 200);
      captured = { calls: [...bybit.amendOrderCalls], siblingRows };
    });
    assert.ok(captured !== undefined);
    return captured;
  };

  const sole = await run(false);
  const shared = await run(true);
  assert.deepEqual(shared.calls, sole.calls);
  assert.deepEqual(shared.siblingRows.map((row) => row.triggerPrice), ["97000", "105000"]);
  assert.equal(shared.calls.some((call) => String((call as { orderId?: string }).orderId).startsWith("sibling-")), false);
});

test("mixed-side active ownership fails closed before exchange access", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    await repo.save(
      makeRecord({
        strategyInstanceId: "instance-2",
        tradeCycleId: "cycle-2",
        orderLinkId: "link-2",
        side: "short",
      }),
    );

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 500);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.amendOrderCalls.length, 0);
  });
});

test("successful protection does not mutate durable correlation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    const before = repo.get("instance-1", "cycle-1");
    setOpenLong(bybit);
    installAttributedRows(bybit);

    const result = await service.apply(makeCommand());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(repo.get("instance-1", "cycle-1"), before);
  });
});

function installAttributedRows(
  bybit: FakeBybitAdapter,
  overrides: { stop?: Record<string, unknown>; take?: Record<string, unknown> } = {},
  extras: Record<string, unknown>[] = [],
): void {
  bybit.activeOrdersResponse = childList([stopRow(overrides.stop), takeRow(overrides.take), ...extras]);
  bybit.orderHistoryForSymbolResponse = childList([]);
}

function installMutableAttributedRows(
  bybit: FakeBybitAdapter,
  overrides: { stop?: Record<string, unknown>; take?: Record<string, unknown> } = {},
  extras: Record<string, unknown>[] = [],
): void {
  const stop = stopRow(overrides.stop);
  const take = takeRow(overrides.take);
  bybit.activeOrdersResponse = childList([stop, take, ...extras]);
  bybit.orderHistoryForSymbolResponse = childList([]);

  const originalAmend = bybit.amendOrder.bind(bybit);
  bybit.amendOrder = async (payload) => {
    const response = await originalAmend(payload);
    if ((response as { retCode?: number }).retCode !== 0) {
      return response;
    }
    const target = [stop, take].find((row) => row.orderId === payload.orderId);
    if (target !== undefined && payload.triggerPrice !== undefined) {
      target.triggerPrice = payload.triggerPrice;
    }
    if (payload.qty !== undefined) {
      stop.qty = payload.qty;
      take.qty = payload.qty;
      stop.leavesQty = payload.qty;
      take.leavesQty = payload.qty;
    }
    return response;
  };
}

function childList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: "linear", list: rows } };
}

function stopRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId: "stop-1",
    parentOrderLinkId: "link-1",
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty: "0.001",
    leavesQty: "0.001",
    ...overrides,
  };
}

function takeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...stopRow(),
    orderId: "take-1",
    stopOrderType: "PartialTakeProfit",
    createType: "CreateByPartialTakeProfit",
    triggerPrice: "103000",
    ...overrides,
  };
}

function setOpenLong(bybit: FakeBybitAdapter, size = "0.001"): void {
  bybit.openPositionsResponse = {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol: "BTCUSDT", side: "Buy", size, positionIdx: 0, avgPrice: "100000", openTime: 1 }],
    },
  };
}

function closedPositionResponse(): unknown {
  return {
    retCode: 0,
    result: { category: "linear", list: [{ symbol: "BTCUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
  };
}

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-native-protection-service-"));
  try {
    const config = liveConfig(configOverrides);
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();
    const tradingRules = new FakeInstrumentTradingRulesProvider();
    const service = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex,
      openPositionResolutionService: new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex }),
      tradingRules,
    });
    await fn({ service, bybit, repo, tradingRules });
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

function makeCommand(overrides: {
  strategyInstanceId?: string;
  tradeCycleId?: string;
  stopPrice?: string;
  takePrice?: string | null;
} = {}): { strategyInstanceId: string; tradeCycleId: string; stopPrice: string; takePrice: string | null } {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    stopPrice: "99000",
    takePrice: "103000",
    ...overrides,
  };
}

const DEFAULT_FILLED_OBSERVATION: EarlyExecutionObservation = {
  order_status: "Filled",
  cumulative_filled_qty: "0.001",
  remaining_qty: "0",
  observed_at: "2026-01-01T00:00:00.000Z",
  avg_execution_price: "100000",
};

function makeRecord(overrides: {
  strategyInstanceId?: string;
  tradeCycleId?: string;
  exchangeSymbol?: string;
  exchangeCategory?: "linear" | "spot";
  status?: EntryPackageExecutionStatus;
  orderLinkId?: string;
  side?: "long" | "short";
  earlyExecutionObservation?: EarlyExecutionObservation | null;
} = {}): EntryPackageExecutionRecord {
  const side = overrides.side ?? "long";
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    exchange_symbol: overrides.exchangeSymbol ?? "BTCUSDT",
    exchange_category: overrides.exchangeCategory ?? "linear",
    desired_entry: {
      side,
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: side === "long" ? "99000" : "101000",
      initial_take_price: side === "long" ? "103000" : "97000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: overrides.orderLinkId ?? "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation:
      overrides.earlyExecutionObservation !== undefined
        ? overrides.earlyExecutionObservation
        : DEFAULT_FILLED_OBSERVATION,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}
