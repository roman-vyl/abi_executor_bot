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

const DURABLY_CLOSED: EntryPackageExecutionStatus[] = ["absent", "terminal_unfilled"];
const LIVE_QUERY_ADMISSIBLE: EntryPackageExecutionStatus[] = ["applied", "pending_replace", "pending_cancel"];
const UNRESOLVED: EntryPackageExecutionStatus[] = ["pending_create", "create_failed", "unknown"];

test("missing record fails closed as unknown_trade_cycle_binding without querying the exchange", async () => {
  await withResolutionService(async ({ service, bybit }) => {
    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" } },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

for (const status of DURABLY_CLOSED) {
  test(`status '${status}' durably proves no exposure without querying the exchange`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, {
        statusCode: 200,
        body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
      });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
    });
  });
}

for (const status of UNRESOLVED) {
  test(`status '${status}' fails closed to internal_error without querying the exchange`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
    });
  });
}

for (const status of LIVE_QUERY_ADMISSIBLE) {
  test(`status '${status}' proceeds to a live query using the record's own category/symbol`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      bybit.openPositionsResponse = noPositionResponse();
      await repo.save(makeRecord({ status, exchangeSymbol: "ETHUSDT" }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, {
        statusCode: 200,
        body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
      });
      assert.deepEqual(bybit.getOpenPositionsCalls, [{ category: "linear", symbol: "ETHUSDT" }]);
    });
  });
}

test("non-linear exchange_category fails closed as unsupported_exchange_scope without querying the exchange", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "applied", exchangeCategory: "spot" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unsupported_exchange_scope", message: "record's exchange category is not supported" } },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("linear category proceeds to the live query", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = noPositionResponse();
    await repo.save(makeRecord({ status: "applied" }));

    await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(bybit.getOpenPositionsCalls.length, 1);
  });
});

test("matching side confirms an open position", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 111 });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 111, average_entry_price: "100000" },
    });
  });
});

test("wrong side fails closed to internal_error", async () => {
  await withResolutionService(async ({ service, repo, bybit }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Sell", size: "0.001", avgPrice: "100000", openTime: 111 });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("partial fill still reports position_open: true", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Sell", size: "0.0001", avgPrice: "99000", openTime: 222 });
    await repo.save(makeRecord({ status: "applied", side: "short" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 222, average_entry_price: "99000" },
    });
  });
});

test("full fill reports position_open: true", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100500", openTime: 333 });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 333, average_entry_price: "100500" },
    });
  });
});

test("no live row is reported as closed", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = noPositionResponse();
    await repo.save(makeRecord({ status: "applied" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
    });
  });
});

test("all-size-zero rows are reported as closed", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = {
      retCode: 0,
      result: { list: [{ symbol: "BTCUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
    };
    await repo.save(makeRecord({ status: "applied" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
    });
  });
});

test("any adapter-layer query failure maps to internal_error, never position_open: false", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsError = new Error("timeout");
    await repo.save(makeRecord({ status: "applied" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

function noPositionResponse(): unknown {
  return { retCode: 0, result: { list: [] } };
}

function positionResponse(input: { side: "Buy" | "Sell"; size: string; avgPrice: string; openTime: number }): unknown {
  return {
    retCode: 0,
    result: {
      list: [
        {
          symbol: "BTCUSDT",
          side: input.side,
          size: input.size,
          positionIdx: 0,
          avgPrice: input.avgPrice,
          openTime: input.openTime,
        },
      ],
    },
  };
}

type Ctx = {
  service: OpenPositionResolutionService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

async function withResolutionService(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-open-position-resolution-"));
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
    exchangeSymbol: string;
    exchangeCategory: "linear" | "spot";
    side: "long" | "short";
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
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
