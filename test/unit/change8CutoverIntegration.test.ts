import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { DesiredEntryDto, EntryPackageCommand } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { CloseApplicationService } from "../../src/services/close/closeApplicationService.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { ProtectionApplicationService } from "../../src/services/protection/protectionApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

test("Change 8 matrix: sole owner uses the same Partial protection and pair-scoped close pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-change8-sole-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const pairMutex = new KeyedMutex();
    const rules = new FakeInstrumentTradingRulesProvider();
    const entry = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rules),
      mutex: pairMutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });
    const protection = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex: pairMutex,
      openPositionResolutionService: new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex: pairMutex }),
      tradingRules: rules,
    });
    const close = new CloseApplicationService({ config, bybit, correlationRepository: repo, mutex: pairMutex });

    bybit.orderByLinkIdResponse = orderList([entryOrder("New", "0", "0.001")]);
    assert.equal((await entry.apply(entryCommand("instance-A", "cycle-A"))).statusCode, 200);
    const record = repo.get("instance-A", "cycle-A");
    assert.ok(record?.order_link_id);
    setOrder(bybit, record.order_link_id, "Filled", "0.001", "0.001");
    setAggregate(bybit, "Buy", "0.001");
    const ownRows = activePair(record.order_link_id, "0.001", "sole");
    bybit.activeOrdersResponse = childList(ownRows);
    bybit.orderHistoryForSymbolResponse = childList([]);

    assert.equal((await protection.apply(protectionCommand("instance-A", "cycle-A"))).statusCode, 200);
    const originalCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      const response = await originalCancel(payload);
      if (payload.orderId === "stop-sole") terminalize(ownRows);
      return response;
    };
    const originalCreate = bybit.createOrder.bind(bybit);
    bybit.createOrder = async (payload) => {
      const response = await originalCreate(payload);
      if ("reduceOnly" in payload) setOrder(bybit, payload.orderLinkId, "Filled", payload.qty, payload.qty);
      return response;
    };

    assert.equal((await close.apply({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" })).statusCode, 200);
    const entryWrite = bybit.createOrderCalls.find((call) => !("reduceOnly" in call));
    const closeWrite = bybit.createOrderCalls.find((call) => "reduceOnly" in call);
    assert.ok(entryWrite !== undefined && "tpslMode" in entryWrite);
    assert.equal(entryWrite.tpslMode, "Partial");
    assert.ok(closeWrite !== undefined);
    assert.equal(closeWrite.qty, "0.001");
    assert.equal(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Change 8 matrix: two genuine same-side owners remain attributable and close-one preserves its sibling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-change8-matrix-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const pairMutex = new KeyedMutex();
    const scopeMutex = new KeyedMutex();
    const rules = new FakeInstrumentTradingRulesProvider();
    const entry = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rules),
      mutex: pairMutex,
      scopeMutex,
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });
    const openPositions = new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex: pairMutex });
    const protection = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex: pairMutex,
      openPositionResolutionService: openPositions,
      tradingRules: rules,
    });
    const close = new CloseApplicationService({ config, bybit, correlationRepository: repo, mutex: pairMutex });

    // Real service calls establish both owners; no repository seeding is used.
    bybit.orderByLinkIdResponse = orderList([entryOrder("New", "0", "0.001")]);
    const first = await entry.apply(entryCommand("instance-A", "cycle-A"));
    const second = await entry.apply(entryCommand("instance-B", "cycle-B"));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 2);
    assert.equal(bybit.createOrderCalls.every((call) => "tpslMode" in call && call.tpslMode === "Partial"), true);

    const recordA = repo.get("instance-A", "cycle-A");
    const recordB = repo.get("instance-B", "cycle-B");
    assert.ok(recordA?.order_link_id);
    assert.ok(recordB?.order_link_id);
    assert.notEqual(recordA.order_link_id, recordB.order_link_id);
    const linkA = recordA.order_link_id;
    const linkB = recordB.order_link_id;

    setOrder(bybit, linkA, "Filled", "0.001", "0.001");
    setOrder(bybit, linkB, "Filled", "0.001", "0.001");
    setAggregate(bybit, "Buy", "0.002");
    const ownRowsA = activePair(linkA, "0.001", "a");
    const ownRowsB = activePair(linkB, "0.001", "b");
    const allChildren = [...ownRowsA, ...ownRowsB];
    bybit.activeOrdersResponse = childList(allChildren);
    bybit.orderHistoryForSymbolResponse = childList([]);

    const protectionA = await protection.apply(protectionCommand("instance-A", "cycle-A"));
    const protectionB = await protection.apply(protectionCommand("instance-B", "cycle-B"));
    assert.equal(protectionA.statusCode, 200);
    assert.equal(protectionB.statusCode, 200);
    assert.equal(bybit.amendOrderCalls.length, 0, "both own pairs already match desired state");

    const siblingBefore = repo.get("instance-B", "cycle-B");
    const events: string[] = [];
    const originalCancel = bybit.cancelOrder.bind(bybit);
    bybit.cancelOrder = async (payload) => {
      events.push(`cancel:${payload.orderId ?? payload.orderLinkId}`);
      const response = await originalCancel(payload);
      if (payload.orderId === "stop-a") {
        terminalize(ownRowsA);
      }
      return response;
    };
    const originalCreate = bybit.createOrder.bind(bybit);
    bybit.createOrder = async (payload) => {
      if ("reduceOnly" in payload) {
        events.push(`close:${payload.orderLinkId}`);
        const durable = repo.get("instance-A", "cycle-A");
        assert.equal(durable?.close_order_link_id, payload.orderLinkId, "close identity is durable before write");
      }
      const response = await originalCreate(payload);
      if ("reduceOnly" in payload) setOrder(bybit, payload.orderLinkId, "Filled", payload.qty, payload.qty);
      return response;
    };

    const closed = await close.apply({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" });
    assert.equal(closed.statusCode, 200);
    assert.equal(events[0], "cancel:stop-a");
    assert.ok(events[1]?.startsWith("close:"));

    const closeWrite = bybit.createOrderCalls.find((call) => "reduceOnly" in call);
    assert.ok(closeWrite !== undefined);
    assert.equal(closeWrite.qty, "0.001");
    assert.equal(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
    assert.deepEqual(repo.get("instance-B", "cycle-B"), siblingBefore);
    assert.equal(ownRowsA.every((row) => row.orderStatus === "Deactivated"), true);
    assert.equal(ownRowsB.every((row) => row.orderStatus === "Untriggered"), true);
    assert.equal(bybit.cancelOrderCalls.some((call) => call.orderId === "stop-b" || call.orderId === "take-b"), false);
    assert.equal(bybit.cancelAllOrdersCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Change 8 negative matrix has no opposite-side admission write and no protection fallback on duplicate attribution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-change8-negative-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const pairMutex = new KeyedMutex();
    const rules = new FakeInstrumentTradingRulesProvider();
    const entry = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rules),
      mutex: pairMutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });
    const protection = new ProtectionApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      mutex: pairMutex,
      openPositionResolutionService: new OpenPositionResolutionService({ correlationRepository: repo, bybit, mutex: pairMutex }),
      tradingRules: rules,
    });

    bybit.orderByLinkIdResponse = orderList([entryOrder("New", "0", "0.001")]);
    assert.equal((await entry.apply(entryCommand("instance-A", "cycle-A"))).statusCode, 200);
    const writesBefore = bybit.createOrderCalls.length;
    const opposite = await entry.apply(entryCommand("instance-B", "cycle-B", "short"));
    assert.equal(opposite.statusCode, 500);
    assert.equal(bybit.createOrderCalls.length, writesBefore);

    const own = repo.get("instance-A", "cycle-A");
    assert.ok(own?.order_link_id);
    setOrder(bybit, own.order_link_id, "Filled", "0.001", "0.001");
    setAggregate(bybit, "Buy", "0.001");
    bybit.activeOrdersResponse = childList([
      ...activePair(own.order_link_id, "0.001", "a"),
      stopRow(own.order_link_id, "0.001", "duplicate-stop"),
    ]);
    bybit.orderHistoryForSymbolResponse = childList([]);

    const ambiguous = await protection.apply(protectionCommand("instance-A", "cycle-A"));
    assert.equal(ambiguous.statusCode, 500);
    assert.equal(bybit.amendOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function entryCommand(instance: string, cycle: string, side: "long" | "short" = "long"): EntryPackageCommand {
  return {
    strategyInstanceId: instance,
    tradeCycleId: cycle,
    ticker: "BTCUSDT.P",
    desiredEntry: desired(side),
    riskMultiplier: "1",
  };
}

function desired(side: "long" | "short"): DesiredEntryDto {
  return {
    side,
    source_plan_bar_open_time_ms: 1785000000000,
    planned_entry_price: "100000",
    initial_stop_price: side === "long" ? "99000" : "101000",
    initial_take_price: side === "long" ? "103000" : "97000",
    locked_exit_profile: "runner",
  };
}

function protectionCommand(instance: string, cycle: string) {
  return { strategyInstanceId: instance, tradeCycleId: cycle, stopPrice: "99000", takePrice: "103000" };
}

function setOrder(bybit: FakeBybitAdapter, link: string, status: string, cumExecQty: string, qty: string): void {
  const response = orderList([entryOrder(status, cumExecQty, qty)]);
  bybit.orderByLinkIdResponseByLinkId.set(link, response);
  bybit.orderHistoryResponseByLinkId.set(link, response);
}

function entryOrder(orderStatus: string, cumExecQty: string, qty: string): Record<string, unknown> {
  return {
    orderStatus,
    triggerPrice: "100000",
    qty,
    cumExecQty,
    avgPrice: cumExecQty === "0" ? "" : "100000",
    stopLoss: "99000",
    takeProfit: "103000",
  };
}

function orderList(items: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { list: items } };
}

function setAggregate(bybit: FakeBybitAdapter, side: "Buy" | "Sell", size: string): void {
  bybit.openPositionsResponse = {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol: "BTCUSDT", side, size, positionIdx: 0, avgPrice: "100000", openTime: 1 }],
    },
  };
}

function childList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: "linear", list: rows } };
}

function activePair(parent: string, qty: string, suffix: string): Record<string, unknown>[] {
  return [stopRow(parent, qty, `stop-${suffix}`), takeRow(parent, qty, `take-${suffix}`)];
}

function stopRow(parent: string, qty: string, orderId: string): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId,
    parentOrderLinkId: parent,
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty,
    leavesQty: qty,
  };
}

function takeRow(parent: string, qty: string, orderId: string): Record<string, unknown> {
  return {
    ...stopRow(parent, qty, orderId),
    stopOrderType: "PartialTakeProfit",
    createType: "CreateByPartialTakeProfit",
    triggerPrice: "103000",
  };
}

function terminalize(rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    row.orderStatus = "Deactivated";
    row.leavesQty = "0";
  }
}
