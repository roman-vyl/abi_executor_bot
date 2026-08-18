import { compareDecimal } from "../../domain/exactDecimal.js";

export type BybitOrderView = {
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  stopLoss: string;
  takeProfit: string;
  cumExecQty: string;
  avgPrice: string;
};

export type OrderQueryProtocolFailureReason =
  | "malformed_envelope"
  | "category_mismatch"
  | "list_not_array"
  | "multiple_rows_returned"
  | "malformed_item"
  | "symbol_mismatch"
  | "order_link_id_mismatch"
  | "invalid_order_status"
  | "invalid_qty"
  | "invalid_cumulative_filled_qty"
  | "invalid_trigger_price"
  | "invalid_stop_loss"
  | "invalid_take_profit"
  | "invalid_average_price";

export type DecodedOrderQuery =
  | { kind: "found"; item: BybitOrderView }
  | { kind: "not_found" }
  | { kind: "protocol_failure"; reason: OrderQueryProtocolFailureReason };

export type ExpectedOrderIdentity = {
  category: string;
  symbol: string;
  orderLinkId: string;
};

// Pure decoder for a single `order/realtime` or `order/history` response,
// scoped to the single-orderLinkId/limit=1 query shape both endpoints are
// always called with. Never returns "not_found" for anything
// other than a structurally valid, correct-category, genuinely empty list —
// every other malformed or identity-mismatched shape is "protocol_failure"
// with a specific reason, so it can never be mistaken for a trustworthy
// "the order does not exist" answer.
export function decodeOrderQueryResponse(input: {
  response: unknown;
  expected: ExpectedOrderIdentity;
}): DecodedOrderQuery {
  const { response, expected } = input;

  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.category !== expected.category) {
    return { kind: "protocol_failure", reason: "category_mismatch" };
  }

  const list = resultRecord.list;
  if (!Array.isArray(list)) {
    return { kind: "protocol_failure", reason: "list_not_array" };
  }

  if (list.length === 0) {
    return { kind: "not_found" };
  }

  if (list.length > 1) {
    return { kind: "protocol_failure", reason: "multiple_rows_returned" };
  }

  const row = list[0];
  if (typeof row !== "object" || row === null) {
    return { kind: "protocol_failure", reason: "malformed_item" };
  }

  const record = row as Record<string, unknown>;

  if (record.symbol !== expected.symbol) {
    return { kind: "protocol_failure", reason: "symbol_mismatch" };
  }
  if (record.orderLinkId !== expected.orderLinkId) {
    return { kind: "protocol_failure", reason: "order_link_id_mismatch" };
  }

  const orderStatus = record.orderStatus;
  if (typeof orderStatus !== "string" || orderStatus === "") {
    return { kind: "protocol_failure", reason: "invalid_order_status" };
  }

  const qtyField = readOptionalStringField(record, "qty");
  if (!qtyField.ok || !isPositiveOrEmptyExactDecimal(qtyField.value)) {
    return { kind: "protocol_failure", reason: "invalid_qty" };
  }

  const cumExecQtyField = readOptionalStringField(record, "cumExecQty");
  if (!cumExecQtyField.ok || !isNonNegativeOrEmptyExactDecimal(cumExecQtyField.value)) {
    return { kind: "protocol_failure", reason: "invalid_cumulative_filled_qty" };
  }

  const triggerPriceField = readOptionalStringField(record, "triggerPrice");
  if (!triggerPriceField.ok || !isNonNegativeOrEmptyExactDecimal(triggerPriceField.value)) {
    return { kind: "protocol_failure", reason: "invalid_trigger_price" };
  }

  const stopLossField = readOptionalStringField(record, "stopLoss");
  if (!stopLossField.ok || !isNonNegativeOrEmptyExactDecimal(stopLossField.value)) {
    return { kind: "protocol_failure", reason: "invalid_stop_loss" };
  }

  const takeProfitField = readOptionalStringField(record, "takeProfit");
  if (!takeProfitField.ok || !isNonNegativeOrEmptyExactDecimal(takeProfitField.value)) {
    return { kind: "protocol_failure", reason: "invalid_take_profit" };
  }

  const avgPriceField = readOptionalStringField(record, "avgPrice");
  if (!avgPriceField.ok || !isPositiveOrEmptyExactDecimal(avgPriceField.value)) {
    return { kind: "protocol_failure", reason: "invalid_average_price" };
  }

  return {
    kind: "found",
    item: {
      orderStatus,
      triggerPrice: triggerPriceField.value,
      qty: qtyField.value,
      stopLoss: stopLossField.value,
      takeProfit: takeProfitField.value,
      cumExecQty: cumExecQtyField.value,
      avgPrice: avgPriceField.value,
    },
  };
}

// A candidate order row from a symbol-scoped (not orderLinkId-scoped) query
// — potentially a native Bybit-materialized `tpslMode: "Partial"` protection
// child, potentially an unrelated order for the same symbol. `orderLinkId`
// is decoded for completeness/audit only: a native child is observed to
// always report it empty (abi-native-partial-protection-attribution-v1
// design.md Decision 0, fact 2), so it is never used as an identity —
// `orderId` is. `parentOrderLinkId`/`stopOrderType`/`createType` are the
// attribution and role-classification fields that same design's Decision 0
// confirmed against real Bybit Demo responses.
export type BybitChildOrderCandidate = {
  orderLinkId: string;
  orderId: string;
  parentOrderLinkId: string;
  stopOrderType: string;
  createType: string;
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  leavesQty: string;
};

export type ChildOrderListProtocolFailureReason =
  | "malformed_envelope"
  | "category_mismatch"
  | "list_not_array"
  | "malformed_item"
  | "symbol_mismatch"
  | "invalid_order_link_id"
  | "invalid_order_id"
  | "invalid_parent_order_link_id"
  | "invalid_stop_order_type"
  | "invalid_create_type"
  | "invalid_order_status"
  | "invalid_trigger_price"
  | "invalid_qty"
  | "invalid_leaves_qty";

export type DecodedChildOrderList =
  | { kind: "ok"; items: BybitChildOrderCandidate[] }
  | { kind: "protocol_failure"; reason: ChildOrderListProtocolFailureReason };

export type ExpectedChildOrderListScope = {
  category: string;
  symbol: string;
};

// Pure decoder for a symbol-scoped `order/realtime` or `order/history`
// response — unlike decodeOrderQueryResponse, this accepts zero or many
// rows (that is the whole point of a symbol-wide scan) and does not reject
// on a particular orderLinkId, since there is no single expected identity
// to match: every row is a candidate, filtered by parentOrderLinkId one
// layer up (resolveOwnAttachedProtection). A malformed individual row still
// fails the whole response closed, the same discipline decodeOrderQueryResponse
// applies to its own single row.
export function decodeChildOrderListResponse(input: {
  response: unknown;
  expected: ExpectedChildOrderListScope;
}): DecodedChildOrderList {
  const { response, expected } = input;

  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    return { kind: "protocol_failure", reason: "malformed_envelope" };
  }

  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.category !== expected.category) {
    return { kind: "protocol_failure", reason: "category_mismatch" };
  }

  const list = resultRecord.list;
  if (!Array.isArray(list)) {
    return { kind: "protocol_failure", reason: "list_not_array" };
  }

  const items: BybitChildOrderCandidate[] = [];

  for (const row of list) {
    if (typeof row !== "object" || row === null) {
      return { kind: "protocol_failure", reason: "malformed_item" };
    }

    const record = row as Record<string, unknown>;

    if (record.symbol !== expected.symbol) {
      return { kind: "protocol_failure", reason: "symbol_mismatch" };
    }

    // Legitimately empty on a native child (fact 2) — only a present,
    // non-string value is rejected as malformed.
    const orderLinkIdField = readOptionalStringField(record, "orderLinkId");
    if (!orderLinkIdField.ok) {
      return { kind: "protocol_failure", reason: "invalid_order_link_id" };
    }

    // The only reliable per-child identity (used for dedup by the caller) —
    // unlike orderLinkId, never legitimately empty.
    const orderId = record.orderId;
    if (typeof orderId !== "string" || orderId === "") {
      return { kind: "protocol_failure", reason: "invalid_order_id" };
    }

    const parentOrderLinkIdField = readOptionalStringField(record, "parentOrderLinkId");
    if (!parentOrderLinkIdField.ok) {
      return { kind: "protocol_failure", reason: "invalid_parent_order_link_id" };
    }

    const stopOrderTypeField = readOptionalStringField(record, "stopOrderType");
    if (!stopOrderTypeField.ok) {
      return { kind: "protocol_failure", reason: "invalid_stop_order_type" };
    }

    const createTypeField = readOptionalStringField(record, "createType");
    if (!createTypeField.ok) {
      return { kind: "protocol_failure", reason: "invalid_create_type" };
    }

    const orderStatus = record.orderStatus;
    if (typeof orderStatus !== "string" || orderStatus === "") {
      return { kind: "protocol_failure", reason: "invalid_order_status" };
    }

    const triggerPriceField = readOptionalStringField(record, "triggerPrice");
    if (!triggerPriceField.ok || !isNonNegativeOrEmptyExactDecimal(triggerPriceField.value)) {
      return { kind: "protocol_failure", reason: "invalid_trigger_price" };
    }

    const qtyField = readOptionalStringField(record, "qty");
    if (!qtyField.ok || !isPositiveOrEmptyExactDecimal(qtyField.value)) {
      return { kind: "protocol_failure", reason: "invalid_qty" };
    }

    // 0 is the expected, legitimate value on a terminal record (fact 10) —
    // not merely tolerated as empty.
    const leavesQtyField = readOptionalStringField(record, "leavesQty");
    if (!leavesQtyField.ok || !isNonNegativeOrEmptyExactDecimal(leavesQtyField.value)) {
      return { kind: "protocol_failure", reason: "invalid_leaves_qty" };
    }

    items.push({
      orderLinkId: orderLinkIdField.value,
      orderId,
      parentOrderLinkId: parentOrderLinkIdField.value,
      stopOrderType: stopOrderTypeField.value,
      createType: createTypeField.value,
      orderStatus,
      triggerPrice: triggerPriceField.value,
      qty: qtyField.value,
      leavesQty: leavesQtyField.value,
    });
  }

  return { kind: "ok", items };
}

// A field the exchange omits entirely (not an own key on the row) is a
// legitimate empty — some fields only appear at certain order states. A
// field that IS present but is not a string (a number, null, boolean,
// object) is not an omission, it's a malformed row: silently coercing it
// to "" would let a wrong-shaped field masquerade as "the exchange didn't
// report this," so it is rejected as protocol_failure instead.
function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
): { ok: true; value: string } | { ok: false } {
  if (!Object.hasOwn(record, key)) {
    return { ok: true, value: "" };
  }

  const value = record[key];
  return typeof value === "string" ? { ok: true, value } : { ok: false };
}

function isPositiveOrEmptyExactDecimal(text: string): boolean {
  if (text === "") {
    return true;
  }
  try {
    return compareDecimal(text, "0") > 0;
  } catch {
    return false;
  }
}

function isNonNegativeOrEmptyExactDecimal(text: string): boolean {
  if (text === "") {
    return true;
  }
  try {
    return compareDecimal(text, "0") >= 0;
  } catch {
    return false;
  }
}
