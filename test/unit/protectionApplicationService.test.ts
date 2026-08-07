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
import type { BybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { ProtectionApplicationService } from "../../src/services/protection/protectionApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: ProtectionApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

test("unknown pair fails closed without any exchange call", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.apply(makeCommand());

    assert.deepEqual(result.body, {
      error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.setTradingStopCalls.length, 0);
  });
});

for (const status of ["absent", "terminal_unfilled"] as const) {
  test(`a durably absent pair (${status}) fails closed without any exchange call or ownership check`, async () => {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.apply(makeCommand());

      assert.equal(result.statusCode, 422);
      assert.deepEqual(result.body, {
        error: { code: "position_not_open", message: "no live position exists for the requested pair" },
      });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
      assert.equal(bybit.setTradingStopCalls.length, 0);
    });
  });
}

test("a scope-ownership mismatch fails closed with internal_error", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    // A different pair's record now claims the same scope — simulates the
    // invariant being violated (should be unreachable under
    // position-scope-exclusivity, but must still fail closed).
    await repo.save(
      makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2" }),
    );

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: { code: "internal_error", message: "internal error" } });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.setTradingStopCalls.length, 0);
  });
});

test("an unsupported category returns unsupported_exchange_scope", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ exchangeCategory: "spot" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 422);
    assert.deepEqual(result.body, {
      error: { code: "unsupported_exchange_scope", message: "resolved position's exchange category is not supported" },
    });
    assert.equal(bybit.setTradingStopCalls.length, 0);
  });
});

test("no live position returns position_not_open", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = closedResponse();

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 422);
    assert.deepEqual(result.body, {
      error: { code: "position_not_open", message: "no live position exists for the requested pair" },
    });
    assert.equal(bybit.setTradingStopCalls.length, 0);
  });
});

test("a live-query failure returns internal_error without writing", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsError = new Error("transport failure");

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.setTradingStopCalls.length, 0);
  });
});

test("live-execution guard disabled fails closed without writing", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      bybit.openPositionsResponse = positionResponse({ side: "Buy" });

      const result = await service.apply(makeCommand());

      assert.equal(result.statusCode, 500);
      assert.equal(bybit.setTradingStopCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false, bybitApiKey: "", bybitApiSecret: "" },
  );
});

test("a successful write confirmed on the first read-back attempt returns protection_applied", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" });

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "protection_applied",
      stop_price: "99000",
      take_price: "103000",
    });
    assert.equal(bybit.setTradingStopCalls.length, 1);
    assert.deepEqual(bybit.setTradingStopCalls[0], {
      category: "linear",
      symbol: "BTCUSDT",
      stopLoss: "99000",
      takeProfit: "103000",
    });
  });
});

test("read-back matches only on a later bounded attempt", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    // The pre-write live-position gate and the write's first read-back
    // attempt see the stale value; only the second read-back attempt sees
    // the newly applied one — proving the bounded retry (not a single
    // immediate re-query) is what confirms success.
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "98000", takeProfit: "102000" });
    let getOpenPositionsCallCount = 0;
    const realGetOpenPositions = bybit.getOpenPositions.bind(bybit);
    bybit.getOpenPositions = async (input) => {
      getOpenPositionsCallCount += 1;
      // Call 1: pre-write live-position gate. Calls 2+: read-back.
      if (getOpenPositionsCallCount >= 3) {
        bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" });
      }
      return realGetOpenPositions(input);
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.setTradingStopCalls.length, 1);
    assert.ok(getOpenPositionsCallCount >= 3, "expected at least one retried read-back attempt");
  });
});

test("read-back exhausted without matching returns internal_error and does not repeat the write", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    // Live position exists, but the confirmed values never match the
    // requested ones (as if the exchange rejected/ignored the write).
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "98000", takeProfit: "102000" });

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.setTradingStopCalls.length, 1);
  });
});

test("take_price: null sends Bybit's own clearing sentinel and a numeric-zero read-back confirms it", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "0.00" });

    const result = await service.apply(makeCommand({ takePrice: null }));

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "protection_applied",
      stop_price: "99000",
      take_price: null,
    });
    assert.equal(bybit.setTradingStopCalls.length, 1);
    assert.equal(bybit.setTradingStopCalls[0].takeProfit, "0");
  });
});

test("a confirmed non-zero take-profit does not satisfy an accepted null take_price", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    // The write was supposed to clear take-profit, but the exchange still
    // reports a non-zero value on read-back.
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" });

    const result = await service.apply(makeCommand({ takePrice: null }));

    assert.equal(result.statusCode, 500);
  });
});

test("protection execution never writes to the correlation store", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" });

    await service.apply(makeCommand());

    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
    assert.equal(repo.findOwnerByScope("linear", "BTCUSDT")?.strategy_instance_id, "instance-1");
  });
});

test("protection and a concurrent entry-package command for the same pair never interleave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-protection-concurrency-"));
  try {
    const config = liveConfig();
    const bybit = new FakeBybitAdapter();
    const guardedBybit = withReentrancyGuard(bybit);
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();

    await repo.save(makeRecord());
    bybit.openPositionsResponse = positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" });
    bybit.orderByLinkIdResponse = {
      retCode: 0,
      result: {
        category: "linear",
        list: [
          {
            symbol: "BTCUSDT",
            orderStatus: "New",
            triggerPrice: "101000",
            qty: "0.001",
            cumExecQty: "0",
            stopLoss: "100000",
            takeProfit: "104000",
          },
        ],
      },
    };

    const protectionService = new ProtectionApplicationService({
      config,
      bybit: guardedBybit,
      correlationRepository: repo,
      mutex,
      openPositionResolutionService: new OpenPositionResolutionService({ correlationRepository: repo, bybit: guardedBybit }),
    });

    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const entryPackageService = new EntryPackageApplicationService({
      config,
      bybit: guardedBybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rulesProvider),
      mutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });

    const [protectionResult, entryPackageResult] = await Promise.all([
      protectionService.apply(makeCommand()),
      entryPackageService.apply({
        strategyInstanceId: "instance-1",
        tradeCycleId: "cycle-1",
        ticker: "BTCUSDT.P",
        desiredEntry: {
          side: "long",
          source_plan_bar_open_time_ms: 1785000000000,
          planned_entry_price: "101000",
          initial_stop_price: "100000",
          initial_take_price: "104000",
          locked_exit_profile: "runner",
        },
        riskMultiplier: "1",
      }),
    ]);

    assert.equal(protectionResult.statusCode, 200);
    assert.equal(entryPackageResult.statusCode, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protection commands for two different pairs proceed independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-protection-independent-"));
  try {
    const config = liveConfig();
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();

    await repo.save(makeRecord());
    await repo.save(
      makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", exchangeSymbol: "ETHUSDT" }),
    );

    const gate = deferred<void>();

    bybit.getOpenPositions = async (input) => {
      if (input?.symbol === "BTCUSDT") {
        await gate.promise;
      }
      return input?.symbol === "BTCUSDT"
        ? positionResponse({ side: "Buy", stopLoss: "99000", takeProfit: "103000" })
        : positionResponse({ side: "Buy", stopLoss: "2900", takeProfit: "3100" }, "ETHUSDT");
    };

    const service = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex,
      openPositionResolutionService: new OpenPositionResolutionService({ correlationRepository: repo, bybit }),
    });

    const btcPromise = service.apply(makeCommand());
    const ethPromise = service.apply(
      makeCommand({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", stopPrice: "2900", takePrice: "3100" }),
    );

    // ETH's command must resolve without needing BTC's gate released — if a
    // bug ever serialized different pairs against each other, this would
    // hang until the test times out rather than resolve here.
    const ethResult = await ethPromise;
    assert.equal(ethResult.statusCode, 200);

    gate.resolve();
    const btcResult = await btcPromise;
    assert.equal(btcResult.statusCode, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function withReentrancyGuard(bybit: FakeBybitAdapter): BybitAdapter {
  let inFlight = false;
  return new Proxy(bybit, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        assert.equal(inFlight, false, `${String(prop)} called while another BybitAdapter call was already in flight`);
        inFlight = true;
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          inFlight = false;
        }
      };
    },
  }) as unknown as BybitAdapter;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-protection-app-service-"));
  try {
    const config = liveConfig(configOverrides);
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();
    const openPositionResolutionService = new OpenPositionResolutionService({ correlationRepository: repo, bybit });

    const service = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex,
      openPositionResolutionService,
    });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeCommand(overrides: {
  strategyInstanceId?: string;
  tradeCycleId?: string;
  stopPrice?: string;
  takePrice?: string | null;
} = {}): {
  strategyInstanceId: string;
  tradeCycleId: string;
  stopPrice: string;
  takePrice: string | null;
} {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    stopPrice: "99000",
    takePrice: "103000",
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
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: "link-1",
    order_id: "order-1",
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

function closedResponse(symbol = "BTCUSDT", category = "linear"): unknown {
  return {
    retCode: 0,
    result: { category, list: [{ symbol, side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
  };
}

function positionResponse(
  input: { side: "Buy" | "Sell"; stopLoss?: string; takeProfit?: string },
  symbol = "BTCUSDT",
): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        {
          symbol,
          side: input.side,
          size: "0.001",
          positionIdx: 0,
          avgPrice: "100000",
          openTime: 111,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfit,
        },
      ],
    },
  };
}
