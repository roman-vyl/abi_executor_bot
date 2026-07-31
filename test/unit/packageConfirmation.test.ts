import assert from "node:assert/strict";
import test from "node:test";

import { confirmEntryPackage, confirmEntryPackageCancelled } from "../../src/services/entryPackage/packageConfirmation.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const desired = {
  triggerPrice: "100000",
  qty: "0.001",
  stopLoss: "99000",
  takeProfit: "103000",
};

const payloads = {
  getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1", limit: "1" as const },
  getEntryOrderHistoryPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1", limit: "1" as const },
};

test("pending order confirmed when realtime fields match the desired package", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "New", triggerPrice: "100000", qty: "0.001", stopLoss: "99000", takeProfit: "103000" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.deepEqual(outcome, { kind: "pending_confirmed" });
});

test("full fill before acknowledgement is classified from realtime and returns an aggregate observation", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "99950" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.equal(outcome.kind, "full_fill");
  if (outcome.kind === "full_fill") {
    assert.equal(outcome.observation.cumulative_filled_qty, "0.001");
    assert.equal(outcome.observation.remaining_qty, "0");
    assert.equal(outcome.observation.avg_execution_price, "99950");
  }
});

test("partial fill before acknowledgement records observed filled and remaining quantities", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "PartiallyFilled", cumExecQty: "0.0004", qty: "0.001" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.equal(outcome.kind, "partial_fill");
  if (outcome.kind === "partial_fill") {
    assert.equal(outcome.observation.cumulative_filled_qty, "0.0004");
    assert.equal(outcome.observation.remaining_qty, "0.0006");
  }
});

test("rejected before any fill is classified rejected/deactivated with no fill", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = listResponse([{ orderStatus: "Rejected", cumExecQty: "0" }]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.deepEqual(outcome, { kind: "terminal_without_fill" });
});

test("full fill resolves only via the order-history fallback when the order has already left the realtime set", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]); // absent from /v5/order/realtime
  bybit.orderHistoryResponse = listResponse([{ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100010" }]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.equal(outcome.kind, "full_fill");
  assert.equal(bybit.getOrderByLinkIdCalls.length > 0, true);
  assert.equal(bybit.getOrderHistoryCalls.length > 0, true);
});

test("ambiguous observation is returned when neither query resolves within the bounded budget", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, desired });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("cancel confirmation: order absent from both queries is confirmed cancelled", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "cancelled_confirmed" });
});

test("cancel confirmation: terminal-cancelled status confirms cancellation", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "Cancelled", cumExecQty: "0" }]);

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "cancelled_confirmed" });
});

test("cancel confirmation: a fill observed during cancellation is never reported as cancelled", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "Filled", cumExecQty: "0.001" }]);

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.equal(outcome.kind, "filled_before_cancel");
});

function listResponse(
  items: Array<{
    orderStatus: string;
    triggerPrice?: string;
    qty?: string;
    stopLoss?: string;
    takeProfit?: string;
    cumExecQty?: string;
    avgPrice?: string;
  }>,
): unknown {
  return { retCode: 0, result: { list: items } };
}
