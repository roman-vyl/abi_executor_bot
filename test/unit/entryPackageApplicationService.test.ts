import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import type { AbiConfig } from "../../src/config/config.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { DesiredEntryDto, EntryPackageCommand, EntryPackageHttpResult } from "../../src/domain/entryPackageApi.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: EntryPackageApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

test("first APPLY creates a live order and confirms application", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const result = await service.apply(makeCommand());

    assertApplied(result, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("identical repeated APPLY revalidates without a duplicate create", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    await service.apply(makeCommand());
    const second = await service.apply(makeCommand());

    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.ok(bybit.getOrderByLinkIdCalls.length >= 2);
  });
});

test("REPLACE via amend when only price/stop/take change (side unchanged)", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "101000", stopLoss: "100000", takeProfit: "104000" }),
    ]);
    const second = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({
          planned_entry_price: "101000",
          initial_stop_price: "100000",
          initial_take_price: "104000",
        }),
      }),
    );

    assertApplied(second, "0.001");
    assert.equal(bybit.amendOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("REPLACE via cancel-and-create when side changes", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;

    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "100000", stopLoss: "101000", takeProfit: "97000" }),
    ]);
    const second = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({ side: "short", initial_stop_price: "101000", initial_take_price: "97000" }),
      }),
    );

    assertApplied(second, "0.001");
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 2);

    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.order_link_id, firstOrderLinkId);
    assert.equal(record?.generation, 2);
    assert.equal(record?.binding_history.length, 1);
    assert.equal(record?.binding_history[0]?.end_reason, "replaced");
  });
});

test("successful CANCEL returns absent after durable confirmation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);
    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertAbsent(result);
    assert.equal(bybit.cancelOrderCalls.length, 1);

    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "absent");
    assert.equal(record?.order_link_id, null);
    assert.equal(record?.binding_history[0]?.end_reason, "cancelled");
  });
});

test("already-absent CANCEL makes no exchange call", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertAbsent(result);
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("create transport failure returns a safe error and never a fabricated success", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.createOrder = async () => {
      throw new Error("transport failure");
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "create_failed");
  });
});

test("create accepted but confirmation ambiguous returns a safe error", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "unknown");
  });
});

test("terminal-without-fill fail-closed, then CANCEL, then a fresh CREATE gets a new generation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Rejected", cumExecQty: "0" }]);
    const repeatResult = await service.apply(makeCommand());
    assertInternalError(repeatResult);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_unfilled");

    const blockedResult = await service.apply(makeCommand());
    assertInternalError(blockedResult);
    assert.equal(bybit.createOrderCalls.length, 1, "no new order created while terminal_unfilled");

    const cancelCallsBefore = bybit.cancelOrderCalls.length;
    const cancelResult = await service.apply(makeCommand({ desiredEntry: null }));
    assertAbsent(cancelResult);
    assert.equal(bybit.cancelOrderCalls.length, cancelCallsBefore, "no exchange call needed to leave terminal_unfilled");

    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    bybit.orderHistoryResponse = orderList([]);
    const freshCreateResult = await service.apply(makeCommand());
    assertApplied(freshCreateResult, "0.001");
    assert.equal(bybit.createOrderCalls.length, 2);

    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.order_link_id, firstOrderLinkId);
    assert.equal(record?.generation, 2);
  });
});

test("a changed ticker within an existing trade cycle is rejected without contacting the exchange", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    const createCallsBefore = bybit.createOrderCalls.length;
    const amendCallsBefore = bybit.amendOrderCalls.length;
    const cancelCallsBefore = bybit.cancelOrderCalls.length;

    const result = await service.apply(makeCommand({ ticker: "ETHUSDT.P" }));

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, createCallsBefore);
    assert.equal(bybit.amendOrderCalls.length, amendCallsBefore);
    assert.equal(bybit.cancelOrderCalls.length, cancelCallsBefore);
  });
});

test("metadata-only change durably updates without sending an amend or create request", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    const result = await service.apply(
      makeCommand({ desiredEntry: makeDesiredEntry({ locked_exit_profile: "scratch" }) }),
    );

    assertApplied(result, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.desired_entry?.locked_exit_profile, "scratch");
  });
});

test("skipped_live_execution never produces entry_package_applied or entry_package_absent", async () => {
  await withService(
    async ({ service, bybit }) => {
      const result = await service.apply(makeCommand());

      assertInternalError(result);
      assert.equal(bybit.createOrderCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false, bybitApiKey: "", bybitApiSecret: "" },
  );
});

test("concurrent identical PUT produces exactly one exchange create order", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const [first, second] = await Promise.all([service.apply(makeCommand()), service.apply(makeCommand())]);

    assertApplied(first, "0.001");
    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("concurrent differing PUT does not interleave: second request completes only after the first", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const secondDesiredEntry = makeDesiredEntry({
      planned_entry_price: "101000",
      initial_stop_price: "100000",
      initial_take_price: "104000",
    });

    const firstPromise = service.apply(makeCommand());
    const secondPromise = service.apply(makeCommand({ desiredEntry: secondDesiredEntry }));

    // The first request's confirmation query needs matching fields; the
    // second (amend) request's confirmation needs the amended fields. Since
    // the mutex serializes them, swap the fake's response once the first
    // create call has actually gone out.
    await waitUntil(() => bybit.createOrderCalls.length >= 1);
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "101000", stopLoss: "100000", takeProfit: "104000" }),
    ]);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assertApplied(first, "0.001");
    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 1);
    assert.equal(repo.get("instance-1", "cycle-1")?.desired_entry?.planned_entry_price, "101000");
  });
});

test("a failing first request releases the mutex so a subsequent request for the same trade cycle still proceeds", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.createOrder = async () => {
      throw new Error("transport failure");
    };

    const failed = await service.apply(makeCommand());
    assertInternalError(failed);

    bybit.createOrder = async (payload) => {
      bybit.createOrderCalls.push(payload);
      return { retCode: 0, result: { orderLinkId: "fake-create" } };
    };
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const succeeded = await service.apply(makeCommand());
    assertApplied(succeeded, "0.001");
  });
});

function makeCommand(overrides: Partial<EntryPackageCommand> = {}): EntryPackageCommand {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    ticker: "BTCUSDT.P",
    desiredEntry: makeDesiredEntry(),
    riskMultiplier: "1",
    ...overrides,
  };
}

function makeDesiredEntry(overrides: Partial<DesiredEntryDto> = {}): DesiredEntryDto {
  return {
    side: "long",
    source_plan_bar_open_time_ms: 1785000000000,
    planned_entry_price: "100000",
    initial_stop_price: "99000",
    initial_take_price: "103000",
    locked_exit_profile: "runner",
    ...overrides,
  };
}

function liveOrder(
  overrides: Partial<{
    orderStatus: string;
    triggerPrice: string;
    qty: string;
    stopLoss: string;
    takeProfit: string;
  }> = {},
) {
  return {
    orderStatus: "New",
    triggerPrice: "100000",
    qty: "0.001",
    stopLoss: "99000",
    takeProfit: "103000",
    ...overrides,
  };
}

function orderList(items: unknown[]): unknown {
  return { retCode: 0, result: { list: items } };
}

function assertApplied(result: EntryPackageHttpResult, calculatedQuantity: string): void {
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const body = result.body as { status: string; calculated_quantity: string };
  assert.equal(body.status, "entry_package_applied");
  assert.equal(body.calculated_quantity, calculatedQuantity);
}

function assertAbsent(result: EntryPackageHttpResult): void {
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const body = result.body as { status: string };
  assert.equal(body.status, "entry_package_absent");
}

function assertInternalError(result: EntryPackageHttpResult): void {
  assert.equal(result.statusCode, 500, JSON.stringify(result.body));
  const body = result.body as { error: { code: string } };
  assert.equal(body.error.code, "internal_error");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-package-app-service-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
      ...configOverrides,
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
    const mutex = new KeyedMutex();

    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator,
      mutex,
      resolveSymbol: (ticker) => ticker.replace(/\.P$/, ""),
    });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
