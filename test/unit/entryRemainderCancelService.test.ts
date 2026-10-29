import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { correlationRecordKey } from "../../src/correlation/entryPackageExecutionRecord.js";
import { validateEntryRemainderCancelCommand } from "../../src/domain/positionManagementApi.js";
import { EntryRemainderCancelService } from "../../src/services/entryRemainder/entryRemainderCancelService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: EntryRemainderCancelService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
  mutex: KeyedMutex;
  storePath: string;
};

const FILLED_AT = 1785000300000;

test("body validation accepts only a closed empty object", () => {
  const path = { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" };
  const ok = validateEntryRemainderCancelCommand(path, {});
  assert.deepEqual(ok, { ok: true, command: path });
  for (const payload of [{ x: 1 }, [], "text", null, 1]) {
    assert.equal(validateEntryRemainderCancelCommand(path, payload).ok, false, JSON.stringify(payload));
  }
  assert.equal(validateEntryRemainderCancelCommand({ strategyInstanceId: "", tradeCycleId: "c" }, {}).ok, false);
});

test("unknown pair is 422 unknown_trade_cycle_binding without exchange calls", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.apply(command());
    assert.equal(result.statusCode, 422);
    assert.equal(errorCode(result.body), "unknown_trade_cycle_binding");
    assertNoExchangeCall(bybit);
  });
});

test("record without a captured first fill is 422 entry_not_filled without exchange calls", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ firstFillAtMs: null }));
    const result = await service.apply(command());
    assert.equal(result.statusCode, 422);
    assert.equal(errorCode(result.body), "entry_not_filled");
    assertNoExchangeCall(bybit);
  });
});

test("partially filled live entry is cancelled by its own orderLinkId and confirmed terminal", async () => {
  await withService(async ({ service, bybit, repo, storePath }) => {
    await repo.save(makeRecord());
    // Another pair on the same symbol with its own live entry.
    await repo.save(
      makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", orderLinkId: "link-2", firstFillAtMs: null }),
    );
    setEntry(bybit, "link-1", "PartiallyFilled", "0.004", "0.010");
    setEntry(bybit, "link-2", "New", "0", "0.010");
    const before = await readFile(storePath, "utf8");

    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      setEntry(bybit, "link-1", "Cancelled", "0.004", "0.010");
      return response;
    };

    const result = await service.apply(command());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "entry_remainder_cancelled",
      executed_quantity: "0.004",
    });
    assert.deepEqual(bybit.cancelOrderCalls, [{ category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1" }]);
    assert.ok(bybit.getOrderByLinkIdCalls.every((call) => call.orderLinkId === "link-1"));
    assert.ok(bybit.getOrderHistoryCalls.every((call) => call.orderLinkId === "link-1"));
    assertNoPositionOrProtectionCall(bybit);
    assert.equal(await readFile(storePath, "utf8"), before, "correlation record is unchanged");
  });
});

for (const status of ["Filled", "Cancelled"]) {
  test(`${status} entry needs no cancel and answers entry_order_already_terminal`, async () => {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", status, "0.004", "0.010");
      const result = await service.apply(command());
      assert.equal(result.statusCode, 200);
      assert.equal((result.body as { status: string }).status, "entry_order_already_terminal");
      assert.equal((result.body as { executed_quantity: string }).executed_quantity, "0.004");
      assert.equal(bybit.cancelOrderCalls.length, 0);
      assertNoPositionOrProtectionCall(bybit);
    });
  });
}

test("a status the shared entry classifiers do not know fails closed without a cancel", async () => {
  // Bybit reports PartiallyFilledCanceled for spot only; linear uses
  // Cancelled with cumExecQty > 0. The shared status sets close also uses
  // stay unchanged, so an unknown status is ambiguous, never guessed.
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "PartiallyFilledCanceled", "0.004", "0.010");
    const result = await service.apply(command());
    assert.equal(result.statusCode, 500);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("terminal_closed record answers already terminal with null quantity and no exchange call", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "terminal_closed" }));
    const result = await service.apply(command());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "entry_order_already_terminal",
      executed_quantity: null,
    });
    assertNoExchangeCall(bybit);
  });
});

test("filled record with no current order_link_id is 500 without exchange calls", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ orderLinkId: null }));
    const result = await service.apply(command());
    assert.equal(result.statusCode, 500);
    assert.equal(errorCode(result.body), "internal_error");
    assertNoExchangeCall(bybit);
  });
});

test("order still live after the bounded confirmation reads fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "PartiallyFilled", "0.004", "0.010");
    const result = await service.apply(command());
    assert.equal(result.statusCode, 500);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assertNoPositionOrProtectionCall(bybit);
  });
});

test("query failure fails closed without a cancel", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    const failure = { retCode: 10002, retMsg: "timeout", result: {} };
    bybit.orderByLinkIdResponseByLinkId.set("link-1", failure);
    bybit.orderHistoryResponseByLinkId.set("link-1", failure);
    const result = await service.apply(command());
    assert.equal(result.statusCode, 500);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("unacknowledged cancel fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "PartiallyFilled", "0.004", "0.010");
    bybit.cancelOrder = async (payload) => {
      bybit.cancelOrderCalls.push(payload);
      return { retCode: 110001, retMsg: "order not exists or too late to cancel", result: {} };
    };
    const result = await service.apply(command());
    assert.equal(result.statusCode, 500);
    assertNoPositionOrProtectionCall(bybit);
  });
});

test("live-execution guard skip fails closed without any cancel write", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setEntry(bybit, "link-1", "PartiallyFilled", "0.004", "0.010");
      const result = await service.apply(command());
      assert.equal(result.statusCode, 500);
      assert.equal(bybit.cancelOrderCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false },
  );
});

test("repeat after a successful cancel answers already terminal without a second cancel", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "PartiallyFilled", "0.004", "0.010");
    const realCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await realCancel(payload);
      setEntry(bybit, "link-1", "Cancelled", "0.004", "0.010");
      return response;
    };
    assert.equal((await service.apply(command())).statusCode, 200);
    const again = await service.apply(command());
    assert.equal(again.statusCode, 200);
    assert.equal((again.body as { status: string }).status, "entry_order_already_terminal");
    assert.equal(bybit.cancelOrderCalls.length, 1);
  });
});

test("runs under the pair-level lock and waits for another write of the same pair", async () => {
  await withService(async ({ service, bybit, repo, mutex }) => {
    await repo.save(makeRecord());
    setEntry(bybit, "link-1", "Filled", "0.010", "0.010");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const other = mutex.withKeyLock(correlationRecordKey("instance-1", "cycle-1"), async () => {
      await held;
      order.push("close");
    });
    const pending = service.apply(command()).then(() => order.push("remainder"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bybit.getOrderByLinkIdCalls.length + bybit.getOrderHistoryCalls.length, 0);
    release();
    await Promise.all([other, pending]);
    assert.deepEqual(order, ["close", "remainder"]);
  });
});

async function withService(fn: (ctx: Ctx) => Promise<void>, configOverrides: Partial<AbiConfig> = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-remainder-"));
  try {
    const bybit = new FakeBybitAdapter();
    const storePath = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(storePath);
    const mutex = new KeyedMutex();
    const service = new EntryRemainderCancelService({
      config: liveConfig(configOverrides),
      bybit,
      correlationRepository: repo,
      mutex,
    });
    await fn({ service, bybit, repo, mutex, storePath });
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

function command(): { strategyInstanceId: string; tradeCycleId: string } {
  return { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code: string } }).error?.code;
}

function assertNoExchangeCall(bybit: FakeBybitAdapter): void {
  assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  assert.equal(bybit.getOrderHistoryCalls.length, 0);
  assert.equal(bybit.cancelOrderCalls.length, 0);
  assertNoPositionOrProtectionCall(bybit);
}

function assertNoPositionOrProtectionCall(bybit: FakeBybitAdapter): void {
  assert.equal(bybit.createOrderCalls.length, 0);
  assert.equal(bybit.amendOrderCalls.length, 0);
  assert.equal(bybit.cancelAllOrdersCalls.length, 0);
  assert.equal(bybit.getOpenPositionsCalls.length, 0);
  assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 0);
  assert.ok(bybit.cancelOrderCalls.every((call) => call.orderId === undefined), "no child is cancelled by orderId");
}

function makeRecord(
  overrides: Partial<{
    strategyInstanceId: string;
    tradeCycleId: string;
    status: EntryPackageExecutionStatus;
    orderLinkId: string | null;
    firstFillAtMs: number | null;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    position_binding_mode: "one_way",
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
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
    calculated_quantity: "0.010",
    order_link_id: overrides.orderLinkId === undefined ? "link-1" : overrides.orderLinkId,
    order_id: overrides.orderLinkId === null ? null : "order-1",
    close_order_link_id: null,
    close_order_id: null,
    closure_reason: null,
    closure_order_id: null,
    closure_order_link_id: null,
    closure_parent_order_link_id: null,
    first_fill_at_ms: overrides.firstFillAtMs === undefined ? FILLED_AT : overrides.firstFillAtMs,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

function setEntry(bybit: FakeBybitAdapter, orderLinkId: string, orderStatus: string, cumExecQty: string, qty: string): void {
  const response = {
    retCode: 0,
    result: { list: [{ orderId: `order-${orderLinkId}`, orderStatus, price: "100000", qty, cumExecQty }] },
  };
  bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
  bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
}
