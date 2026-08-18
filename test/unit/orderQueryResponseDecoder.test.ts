import assert from "node:assert/strict";
import test from "node:test";

import { decodeChildOrderListResponse, decodeOrderQueryResponse } from "../../src/services/entryPackage/orderQueryResponseDecoder.js";
import type {
  ChildOrderListProtocolFailureReason,
  OrderQueryProtocolFailureReason,
} from "../../src/services/entryPackage/orderQueryResponseDecoder.js";

const expected = { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1" };

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "link-1",
    orderStatus: "New",
    triggerPrice: "100000",
    qty: "0.001",
    stopLoss: "99000",
    takeProfit: "103000",
    cumExecQty: "0",
    avgPrice: "",
    ...overrides,
  };
}

function assertProtocolFailure(response: unknown, reason: OrderQueryProtocolFailureReason): void {
  const decoded = decodeOrderQueryResponse({ response, expected });
  assert.deepEqual(decoded, { kind: "protocol_failure", reason });
}

test("a structurally valid empty list decodes as not_found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [] } },
    expected,
  });
  assert.deepEqual(decoded, { kind: "not_found" });
});

test("a single matching row decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row()] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
  if (decoded.kind === "found") {
    assert.equal(decoded.item.orderStatus, "New");
    assert.equal(decoded.item.qty, "0.001");
  }
});

test("a missing result is a malformed envelope", () => {
  assertProtocolFailure({ retCode: 0 }, "malformed_envelope");
});

test("a non-object response is a malformed envelope", () => {
  assertProtocolFailure("not an object", "malformed_envelope");
});

test("a null response is a malformed envelope", () => {
  assertProtocolFailure(null, "malformed_envelope");
});

test("a non-object result is a malformed envelope", () => {
  assertProtocolFailure({ retCode: 0, result: "nope" }, "malformed_envelope");
});

test("a missing list is list_not_array", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear" } }, "list_not_array");
});

test("a non-array list is list_not_array", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: "oops" } }, "list_not_array");
});

test("more than one row is multiple_rows_returned", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row(), row()] } },
    "multiple_rows_returned",
  );
});

test("a null row is malformed_item", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [null] } }, "malformed_item");
});

test("a scalar row is malformed_item", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [42] } }, "malformed_item");
});

test("a category mismatch is category_mismatch", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "spot", list: [] } }, "category_mismatch");
});

test("a symbol mismatch is symbol_mismatch", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ symbol: "ETHUSDT" })] } },
    "symbol_mismatch",
  );
});

test("an orderLinkId mismatch is order_link_id_mismatch", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ orderLinkId: "link-2" })] } },
    "order_link_id_mismatch",
  );
});

test("an unknown non-empty orderStatus still decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ orderStatus: "SomeFutureStatus" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("an empty orderStatus is invalid_order_status", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ orderStatus: "" })] } },
    "invalid_order_status",
  );
});

// Numeric validation matrix.

test("negative qty is invalid_qty", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: "-0.001" })] } }, "invalid_qty");
});

test("zero qty is invalid_qty", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: "0" })] } }, "invalid_qty");
});

test("malformed qty text is invalid_qty", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ qty: "not-a-number" })] } },
    "invalid_qty",
  );
});

test("qty with an out-of-range exponent is invalid_qty", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ qty: "1e999" })] } },
    "invalid_qty",
  );
});

test("negative cumExecQty is invalid_cumulative_filled_qty", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ cumExecQty: "-0.001" })] } },
    "invalid_cumulative_filled_qty",
  );
});

test("zero cumExecQty is allowed and decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ cumExecQty: "0" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("negative triggerPrice is invalid_trigger_price", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ triggerPrice: "-1" })] } },
    "invalid_trigger_price",
  );
});

test("zero triggerPrice is allowed and decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ triggerPrice: "0" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("negative stopLoss is invalid_stop_loss", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ stopLoss: "-1" })] } },
    "invalid_stop_loss",
  );
});

test("zero stopLoss is allowed and decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ stopLoss: "0" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("negative takeProfit is invalid_take_profit", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ takeProfit: "-1" })] } },
    "invalid_take_profit",
  );
});

test("zero takeProfit is allowed and decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ takeProfit: "0" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("negative avgPrice is invalid_average_price", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ avgPrice: "-1" })] } },
    "invalid_average_price",
  );
});

test("zero avgPrice is invalid_average_price", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ avgPrice: "0" })] } },
    "invalid_average_price",
  );
});

test("a positive avgPrice is allowed and decodes as found", () => {
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [row({ avgPrice: "99950" })] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
});

test("malformed decimal text on any field is rejected, not silently coerced", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ stopLoss: "abc" })] } },
    "invalid_stop_loss",
  );
});

test("an out-of-range exponent on any field is rejected", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ takeProfit: "1e-999" })] } },
    "invalid_take_profit",
  );
});

// A field the exchange omits entirely is a legitimate empty. A field that
// IS present but not a string is a malformed row, not an omission — it
// must never be silently coerced to "".

test("a numeric field genuinely absent from the row (no own key) is treated as empty and decodes as found", () => {
  const { avgPrice: _avgPrice, ...rowWithoutAvgPrice } = row();
  const decoded = decodeOrderQueryResponse({
    response: { retCode: 0, result: { category: "linear", list: [rowWithoutAvgPrice] } },
    expected,
  });
  assert.equal(decoded.kind, "found");
  if (decoded.kind === "found") {
    assert.equal(decoded.item.avgPrice, "");
  }
});

test("qty present as a number rather than a string is invalid_qty, not coerced", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: 0.001 })] } }, "invalid_qty");
});

test("qty present as null rather than a string is invalid_qty, not treated as absent", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: null })] } }, "invalid_qty");
});

test("qty present as an object rather than a string is invalid_qty", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: {} })] } }, "invalid_qty");
});

test("qty present as a boolean rather than a string is invalid_qty", () => {
  assertProtocolFailure({ retCode: 0, result: { category: "linear", list: [row({ qty: true })] } }, "invalid_qty");
});

test("avgPrice present as a number rather than a string is invalid_average_price, not coerced", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ avgPrice: 99950 })] } },
    "invalid_average_price",
  );
});

test("cumExecQty present as null rather than a string is invalid_cumulative_filled_qty, not treated as zero", () => {
  assertProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [row({ cumExecQty: null })] } },
    "invalid_cumulative_filled_qty",
  );
});

// -- decodeChildOrderListResponse --
// abi-native-partial-protection-attribution-v1: a symbol-scoped list decoder,
// distinct from decodeOrderQueryResponse above — accepts zero or many rows,
// never rejects on orderLinkId (native children observe it empty).

const childListExpected = { category: "linear", symbol: "BTCUSDT" };

function childRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId: "order-1",
    parentOrderLinkId: "abi-ep-entry-1",
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty: "0.001",
    leavesQty: "0.001",
    ...overrides,
  };
}

function assertChildListProtocolFailure(response: unknown, reason: ChildOrderListProtocolFailureReason): void {
  const decoded = decodeChildOrderListResponse({ response, expected: childListExpected });
  assert.deepEqual(decoded, { kind: "protocol_failure", reason });
}

test("an empty list decodes as ok with zero items", () => {
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [] } },
    expected: childListExpected,
  });
  assert.deepEqual(decoded, { kind: "ok", items: [] });
});

test("several well-formed rows all decode", () => {
  const decoded = decodeChildOrderListResponse({
    response: {
      retCode: 0,
      result: {
        category: "linear",
        list: [
          childRow({ orderId: "order-1", stopOrderType: "PartialStopLoss" }),
          childRow({ orderId: "order-2", stopOrderType: "PartialTakeProfit", createType: "CreateByPartialTakeProfit" }),
        ],
      },
    },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    assert.equal(decoded.items.length, 2);
    assert.equal(decoded.items[0].orderId, "order-1");
    assert.equal(decoded.items[1].orderId, "order-2");
  }
});

test("an empty orderLinkId on a row is legitimate, not rejected", () => {
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [childRow({ orderLinkId: "" })] } },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    assert.equal(decoded.items[0].orderLinkId, "");
  }
});

test("more than one row does not fail closed by row count alone", () => {
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [childRow(), childRow({ orderId: "order-2" })] } },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
});

test("a category mismatch on the child list is category_mismatch", () => {
  assertChildListProtocolFailure({ retCode: 0, result: { category: "spot", list: [] } }, "category_mismatch");
});

test("a symbol mismatch on any row is symbol_mismatch", () => {
  assertChildListProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [childRow({ symbol: "ETHUSDT" })] } },
    "symbol_mismatch",
  );
});

test("a missing envelope is malformed_envelope", () => {
  assertChildListProtocolFailure({ retCode: 0 }, "malformed_envelope");
});

test("a non-array list is list_not_array", () => {
  assertChildListProtocolFailure({ retCode: 0, result: { category: "linear", list: "oops" } }, "list_not_array");
});

test("a null row is malformed_item", () => {
  assertChildListProtocolFailure({ retCode: 0, result: { category: "linear", list: [null] } }, "malformed_item");
});

test("orderId present as a number rather than a string is invalid_order_id", () => {
  assertChildListProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [childRow({ orderId: 1 })] } },
    "invalid_order_id",
  );
});

test("an empty orderId is invalid_order_id — never a legitimate omission", () => {
  assertChildListProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [childRow({ orderId: "" })] } },
    "invalid_order_id",
  );
});

test("a genuinely absent parentOrderLinkId decodes as empty, not rejected", () => {
  const { parentOrderLinkId: _parentOrderLinkId, ...rowWithoutParent } = childRow();
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [rowWithoutParent] } },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    assert.equal(decoded.items[0].parentOrderLinkId, "");
  }
});

test("leavesQty of exactly zero is allowed — the expected terminal value, not merely tolerated", () => {
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [childRow({ leavesQty: "0" })] } },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    assert.equal(decoded.items[0].leavesQty, "0");
  }
});

test("a negative leavesQty is invalid_leaves_qty", () => {
  assertChildListProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [childRow({ leavesQty: "-1" })] } },
    "invalid_leaves_qty",
  );
});

test("an empty orderStatus is invalid_order_status", () => {
  assertChildListProtocolFailure(
    { retCode: 0, result: { category: "linear", list: [childRow({ orderStatus: "" })] } },
    "invalid_order_status",
  );
});

test("Deactivated is a valid orderStatus and decodes as ok", () => {
  const decoded = decodeChildOrderListResponse({
    response: { retCode: 0, result: { category: "linear", list: [childRow({ orderStatus: "Deactivated" })] } },
    expected: childListExpected,
  });
  assert.equal(decoded.kind, "ok");
});
