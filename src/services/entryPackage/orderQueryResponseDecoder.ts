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
// always called with (design.md). Never returns "not_found" for anything
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

  const qty = readStringField(record, "qty");
  if (!isPositiveOrEmptyExactDecimal(qty)) {
    return { kind: "protocol_failure", reason: "invalid_qty" };
  }

  const cumExecQty = readStringField(record, "cumExecQty");
  if (!isNonNegativeOrEmptyExactDecimal(cumExecQty)) {
    return { kind: "protocol_failure", reason: "invalid_cumulative_filled_qty" };
  }

  const triggerPrice = readStringField(record, "triggerPrice");
  if (!isNonNegativeOrEmptyExactDecimal(triggerPrice)) {
    return { kind: "protocol_failure", reason: "invalid_trigger_price" };
  }

  const stopLoss = readStringField(record, "stopLoss");
  if (!isNonNegativeOrEmptyExactDecimal(stopLoss)) {
    return { kind: "protocol_failure", reason: "invalid_stop_loss" };
  }

  const takeProfit = readStringField(record, "takeProfit");
  if (!isNonNegativeOrEmptyExactDecimal(takeProfit)) {
    return { kind: "protocol_failure", reason: "invalid_take_profit" };
  }

  const avgPrice = readStringField(record, "avgPrice");
  if (!isPositiveOrEmptyExactDecimal(avgPrice)) {
    return { kind: "protocol_failure", reason: "invalid_average_price" };
  }

  return {
    kind: "found",
    item: { orderStatus, triggerPrice, qty, stopLoss, takeProfit, cumExecQty, avgPrice },
  };
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
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
