import assert from "node:assert/strict";
import test from "node:test";

import { confirmEntryPackage, confirmEntryPackageCancelled } from "../../src/services/entryPackage/packageConfirmation.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const expected = { qty: "0.001" };

const payloads = {
  getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1", limit: "1" as const },
  getEntryOrderHistoryPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1", limit: "1" as const },
};

test("pending order is confirmed from matching identity, recognized state, and quantity", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "New", triggerPrice: "100000", qty: "0.001", stopLoss: "99000", takeProfit: "103000" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "pending_confirmed" });
});

test("real Demo regression: Bybit canonical price text confirms the accepted order", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    {
      orderStatus: "Untriggered",
      triggerPrice: "63619.7",
      qty: "0.001",
      stopLoss: "64619.7",
      takeProfit: "61619.7",
    },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "pending_confirmed" });
});

test("a live order with a different quantity still fails closed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "Untriggered", triggerPrice: "63619.7", qty: "0.002", stopLoss: "64619.7", takeProfit: "61619.7" },
  ]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a read-back for a different order identity still fails closed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderLinkId: "different-link", orderStatus: "Untriggered", qty: "0.001" },
  ]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a malformed canonical price field still fails closed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "Untriggered", triggerPrice: "not-a-decimal", qty: "0.001" },
  ]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("full fill before acknowledgement is classified from realtime and returns an aggregate observation", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "99950" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.equal(outcome.kind, "full_fill");
  if (outcome.kind === "full_fill") {
    assert.equal(outcome.observation.cumulative_filled_qty, "0.001");
    assert.equal(outcome.observation.remaining_qty, "0");
    assert.equal(outcome.observation.avg_execution_price, "99950");
  }
});

test("a Filled row whose cumExecQty is a number rather than a string is ambiguous, not full_fill", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        {
          symbol: "BTCUSDT",
          orderLinkId: "link-1",
          orderStatus: "Filled",
          cumExecQty: 0.001, // malformed: exchange field must be a string, never coerced
          avgPrice: "99950",
        },
      ],
    },
  };
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("partial fill before acknowledgement records observed filled and remaining quantities", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "PartiallyFilled", cumExecQty: "0.0004", qty: "0.001" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

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

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "terminal_without_fill" });
});

test("full fill resolves only via the order-history fallback when the order has already left the realtime set", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]); // absent from /v5/order/realtime
  bybit.orderHistoryResponse = listResponse([{ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100010" }]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.equal(outcome.kind, "full_fill");
  assert.equal(bybit.getOrderByLinkIdCalls.length > 0, true);
  assert.equal(bybit.getOrderHistoryCalls.length > 0, true);
});

test("not_found is returned when both queries cleanly find nothing within the bounded budget", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "not_found" });
});

test("a filled order reporting a different qty is not blindly trusted as our own package", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([
    { orderStatus: "Filled", qty: "999", cumExecQty: "999" },
  ]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.equal(outcome.kind, "ambiguous");
});

test("a query exception is never treated as a not_found result: confirmation stays ambiguous, not not_found", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.getOrderByLinkId = async () => {
    throw new Error("transient network failure");
  };
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

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

test("cancel confirmation: a REST query failure must never fabricate cancelled_confirmed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.getOrderByLinkId = async () => {
    throw new Error("transient network failure");
  };
  bybit.getOrderHistory = async () => {
    throw new Error("transient network failure");
  };

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("cancel confirmation: realtime failing but history cleanly confirming absence is still not confirmed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.getOrderByLinkId = async () => {
    throw new Error("transient network failure");
  };
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a structurally malformed realtime response with a clean empty history is ambiguous, not not_found", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = malformedResponse();
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a clean empty realtime with a structurally malformed history is ambiguous, not not_found", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = malformedResponse();

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a malformed response during cancel confirmation is ambiguous, not cancelled_confirmed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = malformedResponse();
  bybit.orderHistoryResponse = malformedResponse();

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("valid empty realtime and valid empty history for the whole retry budget still resolve not_found (regression guard)", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "not_found" });
});

test("an unrecognized realtime order status with clean empty history for the whole budget is ambiguous", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "SomeFutureBybitStatus" }]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("a terminal-without-fill realtime status with clean empty history is ambiguous, not not_found", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

test("an unrecognized realtime status resolved by a definitive terminal-without-fill history returns terminal_without_fill", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "SomeFutureBybitStatus" }]);
  bybit.orderHistoryResponse = listResponse([{ orderStatus: "Rejected", cumExecQty: "0" }]);

  const outcome = await confirmEntryPackage({ bybit, ...payloads, expected });

  assert.deepEqual(outcome, { kind: "terminal_without_fill" });
});

test("an unrecognized realtime order status during cancel confirmation is ambiguous, not cancelled_confirmed", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = listResponse([{ orderStatus: "SomeFutureBybitStatus" }]);
  bybit.orderHistoryResponse = listResponse([]);

  const outcome = await confirmEntryPackageCancelled({ bybit, ...payloads, desiredQty: "0.001" });

  assert.deepEqual(outcome, { kind: "ambiguous" });
});

function malformedResponse(): unknown {
  return { retCode: 0, result: { category: "linear", list: "not-an-array" } };
}

function listResponse(
  items: Array<{
    orderStatus: string;
    symbol?: string;
    orderLinkId?: string;
    triggerPrice?: string;
    qty?: string;
    stopLoss?: string;
    takeProfit?: string;
    cumExecQty?: string;
    avgPrice?: string;
  }>,
  category = "linear",
): unknown {
  return {
    retCode: 0,
    result: {
      category,
      list: items.map((item) => ({
        symbol: "BTCUSDT",
        orderLinkId: "link-1",
        ...item,
      })),
    },
  };
}
