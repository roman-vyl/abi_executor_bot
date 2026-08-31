import assert from "node:assert/strict";
import test from "node:test";

import { resolveOwnAttachedProtection } from "../../src/services/protection/nativeProtectionAttribution.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const ENTRY_ORDER_LINK_ID = "abi-ep-entry-1";
const CATEGORY = "linear" as const;
const SYMBOL = "BTCUSDT";

function childRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: SYMBOL,
    orderLinkId: "",
    orderId: "order-1",
    parentOrderLinkId: ENTRY_ORDER_LINK_ID,
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty: "0.001",
    leavesQty: "0.001",
    ...overrides,
  };
}

function realtimeList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: CATEGORY, list: rows } };
}

function historyList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: CATEGORY, list: rows } };
}

async function resolve(bybit: FakeBybitAdapter) {
  return resolveOwnAttachedProtection({
    bybit,
    category: CATEGORY,
    symbol: SYMBOL,
    entryOrderLinkId: ENTRY_ORDER_LINK_ID,
  });
}

async function resolveBound(
  bybit: FakeBybitAdapter,
  entryOrderLinkId: string,
  direction: "long" | "short",
) {
  return resolveOwnAttachedProtection({
    bybit,
    category: CATEGORY,
    symbol: SYMBOL,
    entryOrderLinkId,
    binding: { mode: "hedge", direction },
  });
}

test("no matching candidates classifies as none", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([childRow({ parentOrderLinkId: "abi-ep-someone-else" })]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "none" });
});

test("exactly one stop and one take candidate, both live, classifies as attributed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
  if (resolution.kind === "attributed") {
    assert.equal(resolution.stop.orderId, "stop-1");
    assert.equal(resolution.stop.role, "stop");
    assert.equal(resolution.take.orderId, "take-1");
    assert.equal(resolution.take.role, "take");
  }
});

test("one leg found only in history (terminal) and one only in realtime (live) still attributes both — sources are merged", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([
    childRow({
      orderId: "stop-1",
      stopOrderType: "PartialStopLoss",
      orderStatus: "Deactivated",
      leavesQty: "0",
    }),
  ]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
  if (resolution.kind === "attributed") {
    assert.equal(resolution.stop.orderId, "stop-1");
    assert.equal(resolution.stop.orderStatus, "Deactivated");
    assert.equal(resolution.take.orderId, "take-1");
  }
});

test("only a stop candidate found, no take candidate, is ambiguous/partial_pair", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" })]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "partial_pair" });
});

test("only a take candidate found, no stop candidate, is ambiguous/partial_pair", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "partial_pair" });
});

test("two distinct candidates for the same role is ambiguous/duplicate_role", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "stop-2", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "duplicate_role" });
});

test("both roles duplicated is ambiguous/extra_candidates", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "stop-2", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
    childRow({ orderId: "take-2", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "extra_candidates" });
});

test("a candidate whose stopOrderType does not map to either role is ambiguous/unclassified_role", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
    childRow({ orderId: "mystery-1", stopOrderType: "SomeFutureType" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "unclassified_role" });
});

test("a same-symbol sibling's own children are never attributed to this entry", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
    childRow({ orderId: "sibling-stop-1", stopOrderType: "PartialStopLoss", parentOrderLinkId: "abi-ep-sibling-entry" }),
    childRow({
      orderId: "sibling-take-1",
      stopOrderType: "PartialTakeProfit",
      createType: "CreateByPartialTakeProfit",
      parentOrderLinkId: "abi-ep-sibling-entry",
    }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
  if (resolution.kind === "attributed") {
    assert.equal(resolution.stop.orderId, "stop-1");
    assert.equal(resolution.take.orderId, "take-1");
  }
});

test("foreign-first simultaneous hedge protection resolves each exact parent in its own slot", async () => {
  const bybit = new FakeBybitAdapter();
  const parentA = "abi-ep-entry-a";
  const parentB = "abi-ep-entry-b";
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "b-take", parentOrderLinkId: parentB, stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit", positionIdx: 2 }),
    childRow({ orderId: "b-stop", parentOrderLinkId: parentB, positionIdx: 2 }),
    childRow({ orderId: "a-take", parentOrderLinkId: parentA, stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit", positionIdx: 1 }),
    childRow({ orderId: "a-stop", parentOrderLinkId: parentA, positionIdx: 1 }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const a = await resolveBound(bybit, parentA, "long");
  assert.equal(a.kind, "attributed");
  if (a.kind === "attributed") {
    assert.deepEqual([a.stop.orderId, a.take.orderId], ["a-stop", "a-take"]);
  }

  const b = await resolveBound(bybit, parentB, "short");
  assert.equal(b.kind, "attributed");
  if (b.kind === "attributed") {
    assert.deepEqual([b.stop.orderId, b.take.orderId], ["b-stop", "b-take"]);
  }
});

test("an exact-parent hedge child in the wrong slot remains fail-closed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "a-stop", positionIdx: 2 }),
    childRow({ orderId: "a-take", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit", positionIdx: 1 }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  assert.deepEqual(await resolveBound(bybit, ENTRY_ORDER_LINK_ID, "long"), {
    kind: "ambiguous",
    reason: "query_failed",
  });
});

test("a structurally malformed foreign hedge row is not hidden by exact-parent filtering", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "foreign-stop", parentOrderLinkId: "abi-ep-foreign", positionIdx: "2" }),
    childRow({ orderId: "a-stop", positionIdx: 1 }),
    childRow({ orderId: "a-take", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit", positionIdx: 1 }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  assert.deepEqual(await resolveBound(bybit, ENTRY_ORDER_LINK_ID, "long"), {
    kind: "ambiguous",
    reason: "query_failed",
  });
});

test("the same orderId in both realtime and history with identical evidence is deduplicated, not double-counted", async () => {
  const bybit = new FakeBybitAdapter();
  const stopRow = childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" });
  bybit.activeOrdersResponse = realtimeList([
    stopRow,
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  // Same order also visible in history (transition window), identical qty/role.
  bybit.orderHistoryForSymbolResponse = historyList([stopRow]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
});

test("the same orderId in both sources with a differing stopOrderType is ambiguous/inconsistent_duplicate", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([childRow({ orderId: "order-1", stopOrderType: "PartialStopLoss" })]);
  bybit.orderHistoryForSymbolResponse = historyList([
    childRow({ orderId: "order-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "inconsistent_duplicate" });
});

test("the same orderId in both sources with a differing qty is ambiguous/inconsistent_duplicate", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([childRow({ orderId: "order-1", qty: "0.001" })]);
  bybit.orderHistoryForSymbolResponse = historyList([childRow({ orderId: "order-1", qty: "0.002" })]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "inconsistent_duplicate" });
});

test("the same orderId in both sources with a differing orderStatus is NOT inconsistent — history's status is kept", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", orderStatus: "Untriggered", leavesQty: "0.001" }),
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([
    childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", orderStatus: "Deactivated", leavesQty: "0" }),
  ]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
  if (resolution.kind === "attributed") {
    assert.equal(resolution.stop.orderStatus, "Deactivated");
    assert.equal(resolution.stop.leavesQty, "0");
  }
});

test("a terminal leg found only via history is attributed with its original qty and leavesQty 0, not assumed zeroed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([
    childRow({ orderId: "take-1", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
  ]);
  bybit.orderHistoryForSymbolResponse = historyList([
    childRow({
      orderId: "stop-1",
      stopOrderType: "PartialStopLoss",
      orderStatus: "Deactivated",
      qty: "0.005",
      leavesQty: "0",
    }),
  ]);

  const resolution = await resolve(bybit);
  assert.equal(resolution.kind, "attributed");
  if (resolution.kind === "attributed") {
    assert.equal(resolution.stop.qty, "0.005");
    assert.equal(resolution.stop.leavesQty, "0");
    assert.equal(resolution.stop.orderStatus, "Deactivated");
  }
});

test("getActiveOrders is called with the symbol only, no orderLinkId", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  await resolve(bybit);
  assert.equal(bybit.getOrderHistoryForSymbolCalls.length, 1);
  assert.deepEqual(bybit.getOrderHistoryForSymbolCalls[0], { category: CATEGORY, symbol: SYMBOL, limit: "50" });
});

test("a transport failure on either query resolves to ambiguous/query_failed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderHistoryForSymbolResponse = historyList([]);
  bybit.getActiveOrders = async () => {
    throw new Error("transport error");
  };

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "query_failed" });
});

test("a malformed response on either query resolves to ambiguous/query_failed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = { retCode: 0 };
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const resolution = await resolve(bybit);
  assert.deepEqual(resolution, { kind: "ambiguous", reason: "query_failed" });
});
