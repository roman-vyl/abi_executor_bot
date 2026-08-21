import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EarlyExecutionObservation,
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const DURABLY_CLOSED: EntryPackageExecutionStatus[] = ["absent", "terminal_unfilled", "terminal_closed"];
const LIVE_QUERY_ADMISSIBLE: EntryPackageExecutionStatus[] = ["applied", "pending_replace", "pending_cancel"];
const UNRESOLVED: EntryPackageExecutionStatus[] = ["pending_create", "create_failed", "unknown"];

test("missing record fails closed as unknown_trade_cycle_binding without querying the exchange", async () => {
  await withResolutionService(async ({ service, bybit }) => {
    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" } },
    });
    assertNoExchangeCalls(bybit);
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
      assertNoExchangeCalls(bybit);
    });
  });
}

for (const status of UNRESOLVED) {
  test(`status '${status}' fails closed to internal_error without querying the exchange`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
      assertNoExchangeCalls(bybit);
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
    assertNoExchangeCalls(bybit);
  });
});

for (const status of LIVE_QUERY_ADMISSIBLE) {
  test(`status '${status}': own order terminal without fill closes without querying the aggregate`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      setOwnOrderStatus(bybit, "link-1", { orderStatus: "Rejected", cumExecQty: "0" });
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, {
        statusCode: 200,
        body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
      });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
      assert.equal(bybit.getExecutionListCalls.length, 0);
    });
  });
}

for (const status of LIVE_QUERY_ADMISSIBLE) {
  test(`status '${status}': a live entry order with zero own cumulative fill (e.g. Untriggered) reports closed, not internal_error`, async () => {
    await withResolutionService(async ({ service, bybit, repo }) => {
      setOwnOrderStatus(bybit, "link-1", { orderStatus: "Untriggered", cumExecQty: "0" });
      await repo.save(makeRecord({ status }));

      const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

      assert.deepEqual(result, {
        statusCode: 200,
        body: { position_open: false, first_fill_at_ms: null, average_entry_price: null },
      });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
      assert.equal(bybit.getExecutionListCalls.length, 0);
    });
  });
}

test("a live, still-partial own fill is reported open, sourced from own evidence, even while the entry order is not yet terminal", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.0003", avgPrice: "99900" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100500", openTime: 999 });
    await repo.save(makeRecord({ status: "applied", side: "long", firstFillAtMs: 12345 }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      // average_entry_price is this cycle's own avg execution price
      // ("99900"), never the aggregate's ("100500") — proves sourcing.
      body: { position_open: true, first_fill_at_ms: 12345, average_entry_price: "99900" },
    });
    assert.equal(bybit.getExecutionListCalls.length, 0);
  });
});

test("a fresh full fill with no captured first_fill_at_ms triggers exactly one execution-list capture, durably saved", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    // Two executions before this cycle's first observation — the true
    // first fill (721_000) is not the one this GET happens to see "most
    // recently"; min(execTime) must still find it.
    bybit.executionListResponse = executionListPage({ execTimes: [723_000, 721_000], nextCursor: "" });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 721_000, average_entry_price: "100000" },
    });
    assert.equal(bybit.getExecutionListCalls.length, 1);
    assert.deepEqual(bybit.getExecutionListCalls[0], {
      category: "linear",
      symbol: "BTCUSDT",
      orderLinkId: "link-1",
      limit: "50",
    });
    assert.equal("orderId" in bybit.getExecutionListCalls[0], false);

    const stored = repo.get("instance-1", "cycle-1");
    assert.equal(stored?.first_fill_at_ms, 721_000);
  });
});

test("pagination is followed to completion: the true earliest execution on a later page is still found", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponses = [
      executionListPage({ execTimes: [900_000], nextCursor: "cursor-2" }),
      executionListPage({ execTimes: [500_000], nextCursor: "" }),
    ];
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { first_fill_at_ms: number }).first_fill_at_ms, 500_000);
    assert.equal(bybit.getExecutionListCalls.length, 2);
    assert.equal(bybit.getExecutionListCalls[1].cursor, "cursor-2");
  });
});

test("bounded pagination fails closed rather than computing a minimum over a partial set", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    let calls = 0;
    bybit.getExecutionList = async (payload) => {
      bybit.getExecutionListCalls.push(payload);
      calls += 1;
      return executionListPage({ execTimes: [calls], nextCursor: `cursor-${calls}` });
    };
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, null);
  });
});

test("no executions found for an order own-evidence already proves filled fails closed, never fabricated", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponse = executionListPage({ execTimes: [], nextCursor: "" });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, null);
  });
});

test("execType filtering: a non-Trade execution in the set fails the capture closed", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponse = {
      retCode: 0,
      result: {
        category: "linear",
        list: [
          { symbol: "BTCUSDT", execType: "Trade", execTime: "700000" },
          { symbol: "BTCUSDT", execType: "Funding", execTime: "699000" },
        ],
        nextPageCursor: "",
      },
    };
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("already-final observation with first_fill_at_ms already captured needs no own-order or execution-list call", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    await repo.save(
      makeRecord({
        status: "applied",
        side: "long",
        firstFillAtMs: 555,
        earlyExecutionObservation: observation({ order_status: "Filled", cumulative_filled_qty: "0.001" }),
      }),
    );

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 555, average_entry_price: "99950" },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOrderHistoryCalls.length, 0);
    assert.equal(bybit.getExecutionListCalls.length, 0);
    // The aggregate is still consulted (weak sanity + protection's stop/take needs).
    assert.equal(bybit.getOpenPositionsCalls.length, 1);
  });
});

test("backward-compat backfill: an already-final observation without a captured first_fill_at_ms triggers exactly one execution-list capture", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponse = executionListPage({ execTimes: [654_321], nextCursor: "" });
    await repo.save(
      makeRecord({
        status: "applied",
        side: "long",
        firstFillAtMs: null,
        earlyExecutionObservation: observation({ order_status: "Filled", cumulative_filled_qty: "0.001" }),
      }),
    );

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 654_321, average_entry_price: "99950" },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getExecutionListCalls.length, 1);
    assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, 654_321);
  });
});

test("first capture is durable and stable across repeated GETs — a second GET never recomputes it", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponse = executionListPage({ execTimes: [111_000], nextCursor: "" });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const first = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal((first.body as { first_fill_at_ms: number }).first_fill_at_ms, 111_000);
    assert.equal(bybit.getExecutionListCalls.length, 1);

    // Simulates further order movement since the first GET — a different
    // execution set must never overwrite the already-captured value.
    bybit.executionListResponse = executionListPage({ execTimes: [999_999], nextCursor: "" });

    const second = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.deepEqual(second, {
      statusCode: 200,
      body: { position_open: true, first_fill_at_ms: 111_000, average_entry_price: "100000" },
    });
    assert.equal(bybit.getExecutionListCalls.length, 1);
  });
});

test("own fill with no usable average price fails closed, never fabricated", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.0003" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("aggregate/own-evidence disagreement on existence fails closed", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.0003", avgPrice: "99900" });
    bybit.openPositionsResponse = closedResponse();
    await repo.save(makeRecord({ status: "applied", side: "long", firstFillAtMs: 1 }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("aggregate/own-evidence disagreement on side fails closed", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.0003", avgPrice: "99900" });
    bybit.openPositionsResponse = positionResponse({ side: "Sell", size: "0.001", avgPrice: "100000", openTime: 999 });
    await repo.save(makeRecord({ status: "applied", side: "long", firstFillAtMs: 1 }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("any aggregate-query transport failure maps to internal_error, never position_open: false", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.0003", avgPrice: "99900" });
    bybit.openPositionsError = new Error("timeout");
    await repo.save(makeRecord({ status: "applied", side: "long", firstFillAtMs: 1 }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a concurrent GET and PUT-style write for the same pair are serialized — neither write is lost", async () => {
  await withResolutionService(async ({ service, bybit, repo }) => {
    setOwnOrderStatus(bybit, "link-1", { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.001", avgPrice: "100000", openTime: 999 });
    bybit.executionListResponse = executionListPage({ execTimes: [222_000], nextCursor: "" });
    await repo.save(makeRecord({ status: "applied", side: "long" }));

    // Holds the mutex for the pair from outside resolve(), simulating a
    // concurrent PUT .../entry-package revalidation in flight.
    const mutex = ctxMutex(service);
    let releaseOther: () => void = () => undefined;
    const otherHeld = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const otherTask = mutex.withKeyLock(
      JSON.stringify(["instance-1", "cycle-1"]),
      () => otherHeld,
    );

    const resolvePromise = service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    // resolve() must still be waiting on the mutex — its own write has not
    // happened yet.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, null);

    releaseOther();
    await otherTask;
    const result = await resolvePromise;

    assert.equal(result.statusCode, 200);
    assert.equal(repo.get("instance-1", "cycle-1")?.first_fill_at_ms, 222_000);
  });
});

function ctxMutex(service: OpenPositionResolutionService): KeyedMutex {
  return (service as unknown as { deps: { mutex: KeyedMutex } }).deps.mutex;
}

function assertNoExchangeCalls(bybit: FakeBybitAdapter): void {
  assert.equal(bybit.getOpenPositionsCalls.length, 0);
  assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  assert.equal(bybit.getOrderHistoryCalls.length, 0);
  assert.equal(bybit.getExecutionListCalls.length, 0);
}

function setOwnOrderStatus(
  bybit: FakeBybitAdapter,
  orderLinkId: string,
  input: { orderStatus: string; cumExecQty: string; qty?: string; avgPrice?: string },
): void {
  const response = {
    retCode: 0,
    result: {
      list: [
        {
          orderStatus: input.orderStatus,
          triggerPrice: "100000",
          qty: input.qty ?? "0.001",
          cumExecQty: input.cumExecQty,
          stopLoss: "0",
          takeProfit: "0",
          avgPrice: input.avgPrice ?? "",
        },
      ],
    },
  };
  bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
  bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
}

function executionListPage(input: { execTimes: number[]; nextCursor: string }): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: input.execTimes.map((execTime) => ({
        symbol: "BTCUSDT",
        execType: "Trade",
        execTime: String(execTime),
      })),
      nextPageCursor: input.nextCursor,
    },
  };
}

// A symbol-scoped, one-way-mode query returns exactly one row: Bybit's flat
// placeholder row when there is no exposure. An empty list is a separate,
// non-closed failure case exercised by its own test elsewhere.
function closedResponse(symbol = "BTCUSDT", category = "linear"): unknown {
  return {
    retCode: 0,
    result: { category, list: [{ symbol, side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
  };
}

function positionResponse(input: { side: "Buy" | "Sell"; size: string; avgPrice: string; openTime: number }): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
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
    const service = new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex: new KeyedMutex() });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function observation(overrides: Partial<EarlyExecutionObservation> = {}): EarlyExecutionObservation {
  return {
    order_status: "PartiallyFilled",
    cumulative_filled_qty: "0.0004",
    remaining_qty: "0.0006",
    avg_execution_price: "99950",
    observed_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<{
    status: EntryPackageExecutionStatus;
    exchangeSymbol: string;
    exchangeCategory: "linear" | "spot";
    side: "long" | "short";
    calculatedQuantity: string | null;
    orderLinkId: string | null;
    earlyExecutionObservation: EarlyExecutionObservation | null;
    firstFillAtMs: number | null;
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
    calculated_quantity: overrides.calculatedQuantity ?? "0.001",
    order_link_id: overrides.orderLinkId ?? "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: overrides.firstFillAtMs ?? null,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: overrides.earlyExecutionObservation ?? null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}
