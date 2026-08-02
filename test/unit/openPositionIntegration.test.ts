import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

test("9.1 full happy path: applied + matching live fill resolves open, sourced from the fake response", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied", side: "long" }));
    bybit.openPositionsResponse = envelope([row({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 1785000012345 })]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 1785000012345, average_entry_price: "100000" },
    });
  });
});

test("9.2 partial fill (less than intended order quantity) still reports open", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied", side: "long", calculatedQuantity: "0.010" }));
    bybit.openPositionsResponse = envelope([row({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 1 })]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { position_open: true, first_fill_at_ms: 1, average_entry_price: "100000" });
  });
});

for (const status of ["absent", "terminal_unfilled"] as const) {
  test(`9.3 durably closed status '${status}' resolves closed without invoking the fake Bybit backend`, async () => {
    await withStack(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

      assert.deepEqual(result.body, { position_open: false, first_fill_at_ms: null, average_entry_price: null });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
    });
  });
}

for (const status of ["applied", "pending_replace", "pending_cancel"] as const) {
  test(`9.3 live-query-admissible status '${status}' resolves closed when the fake backend reports no open row`, async () => {
    await withStack(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));
      bybit.openPositionsResponse = envelope([]);

      const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

      assert.deepEqual(result.body, { position_open: false, first_fill_at_ms: null, average_entry_price: null });
    });
  });
}

for (const status of ["pending_create", "create_failed", "unknown"] as const) {
  test(`9.4 unresolved status '${status}' returns internal_error without invoking the fake Bybit backend`, async () => {
    await withStack(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

      assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
    });
  });
}

test("9.5 unsupported category returns unsupported_exchange_scope without invoking the fake Bybit backend", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied", exchangeCategory: "spot" }));

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unsupported_exchange_scope", message: "record's exchange category is not supported" } },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("9.6 simulated timeout returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsError = new Error("ETIMEDOUT");

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 malformed envelope (result/result.list missing or wrong-shaped) returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));

    for (const malformed of [{ retCode: 0 }, { retCode: 0, result: {} }, { retCode: 0, result: { list: "nope" } }]) {
      bybit.openPositionsResponse = malformed;
      const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });
      assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    }
  });
});

test("9.6 symbol-mismatched row returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = envelope([row({ symbol: "ETHUSDT", side: "Buy", size: "0.001" })]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 missing/invalid/negative size returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));

    for (const size of [undefined, "abc", "-0.001"]) {
      bybit.openPositionsResponse = envelope([row({ side: "Buy", size: size as string })]);
      const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });
      assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    }
  });
});

test("9.6 malformed response body (non-object item) returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = envelope([null]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 wrong side returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied", side: "long" }));
    bybit.openPositionsResponse = envelope([row({ side: "Sell", size: "0.001" })]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 hedge-mode row with size>0 and non-zero positionIdx returns internal_error", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = envelope([row({ side: "Buy", size: "0.001", positionIdx: 1 })]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 flat, zero-size hedge-mode row (positionIdx non-zero) also fails closed, not exempted by zero size", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = envelope([
      { symbol: "BTCUSDT", side: "", size: "0", positionIdx: 2, avgPrice: "", openTime: 0 },
    ]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("9.6 a valid zero-size, positionIdx==0 row with empty/default fields resolves closed, not a failure", async () => {
  await withStack(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = envelope([
      { symbol: "BTCUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 },
    ]);

    const result = await service.resolve({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
    });
  });
});

test("9.7 missing-record case end-to-end returns unknown_trade_cycle_binding without invoking the fake Bybit backend", async () => {
  await withStack(async ({ service, bybit }) => {
    const result = await service.resolve({ strategyInstanceId: "no-such-instance", tradeCycleId: "no-such-cycle" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" } },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

function envelope(list: unknown[]): unknown {
  return { retCode: 0, result: { list } };
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    side: "Buy",
    size: "0.001",
    positionIdx: 0,
    avgPrice: "100000",
    openTime: 1785000012345,
    ...overrides,
  };
}

type Ctx = {
  service: OpenPositionResolutionService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

async function withStack(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-open-position-integration-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const service = new OpenPositionResolutionService({ correlationRepository: repo, bybit });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRecord(
  overrides: Partial<{
    status: EntryPackageExecutionStatus;
    exchangeCategory: "linear" | "spot";
    side: "long" | "short";
    calculatedQuantity: string;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance",
    trade_cycle_id: "cycle",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
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
    calculated_quantity: overrides.calculatedQuantity ?? "0.001",
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
