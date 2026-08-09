import { compareDecimal } from "../domain/exactDecimal.js";

export type InstrumentTradingRules = {
  minOrderQty: string;
  qtyStep: string;
  minNotionalValue: string;
};

export type InstrumentTradingRulesFailureReason =
  | "unsupported_category"
  | "malformed_envelope"
  | "category_mismatch"
  | "list_not_array"
  | "wrong_row_count"
  | "malformed_item"
  | "symbol_mismatch"
  | "missing_lot_size_filter"
  | "invalid_min_order_qty"
  | "invalid_qty_step"
  | "invalid_min_notional_value";

export type DecodedInstrumentTradingRules =
  | { ok: true; rules: InstrumentTradingRules }
  | { ok: false; reason: InstrumentTradingRulesFailureReason };

export type ExpectedInstrumentIdentity = {
  category: "linear" | "spot";
  symbol: string;
};

// Pure decoder for a single `instruments-info` response, scoped to the
// `linear` lotSizeFilter shape (minOrderQty/qtyStep/minNotionalValue).
// `spot`'s lotSizeFilter is a different schema (basePrecision/minOrderAmt)
// and is rejected outright rather than parsed with linear's field names.
// Numeric fields are validated with the same arithmetic-safe `compareDecimal`
// parser sizing itself uses, not a grammar-only check, so a decoded value can
// never later throw inside the sizing calculation.
export function decodeInstrumentTradingRulesResponse(input: {
  response: unknown;
  expected: ExpectedInstrumentIdentity;
}): DecodedInstrumentTradingRules {
  const { response, expected } = input;

  if (expected.category === "spot") {
    return { ok: false, reason: "unsupported_category" };
  }

  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { ok: false, reason: "malformed_envelope" };
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    return { ok: false, reason: "malformed_envelope" };
  }

  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.category !== expected.category) {
    return { ok: false, reason: "category_mismatch" };
  }

  const list = resultRecord.list;
  if (!Array.isArray(list)) {
    return { ok: false, reason: "list_not_array" };
  }

  if (list.length !== 1) {
    return { ok: false, reason: "wrong_row_count" };
  }

  const row = list[0];
  if (typeof row !== "object" || row === null) {
    return { ok: false, reason: "malformed_item" };
  }

  const record = row as Record<string, unknown>;
  if (record.symbol !== expected.symbol) {
    return { ok: false, reason: "symbol_mismatch" };
  }

  const lotSizeFilter = record.lotSizeFilter;
  if (typeof lotSizeFilter !== "object" || lotSizeFilter === null) {
    return { ok: false, reason: "missing_lot_size_filter" };
  }

  const filter = lotSizeFilter as Record<string, unknown>;

  const minOrderQty = filter.minOrderQty;
  if (typeof minOrderQty !== "string" || !isStrictlyPositive(minOrderQty)) {
    return { ok: false, reason: "invalid_min_order_qty" };
  }

  const qtyStep = filter.qtyStep;
  if (typeof qtyStep !== "string" || !isStrictlyPositive(qtyStep)) {
    return { ok: false, reason: "invalid_qty_step" };
  }

  const minNotionalValue = filter.minNotionalValue;
  if (typeof minNotionalValue !== "string" || !isNonNegative(minNotionalValue)) {
    return { ok: false, reason: "invalid_min_notional_value" };
  }

  return { ok: true, rules: { minOrderQty, qtyStep, minNotionalValue } };
}

function isStrictlyPositive(text: string): boolean {
  try {
    return compareDecimal(text, "0") > 0;
  } catch {
    return false;
  }
}

function isNonNegative(text: string): boolean {
  try {
    return compareDecimal(text, "0") >= 0;
  } catch {
    return false;
  }
}
