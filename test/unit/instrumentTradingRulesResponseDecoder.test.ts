import assert from "node:assert/strict";
import test from "node:test";

import { decodeInstrumentTradingRulesResponse } from "../../src/exchange/instrumentTradingRulesResponseDecoder.js";
import type { InstrumentTradingRulesFailureReason } from "../../src/exchange/instrumentTradingRulesResponseDecoder.js";

const expected = { category: "linear" as const, symbol: "BTCUSDT" };

function lotSizeFilter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    minOrderQty: "0.001",
    qtyStep: "0.001",
    minNotionalValue: "5",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    lotSizeFilter: lotSizeFilter(),
    ...overrides,
  };
}

function response(list: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { retCode: 0, result: { category: "linear", list, ...overrides } };
}

function assertFailure(
  input: { response: unknown; expected?: { category: "linear" | "spot"; symbol: string } },
  reason: InstrumentTradingRulesFailureReason,
): void {
  const decoded = decodeInstrumentTradingRulesResponse({
    response: input.response,
    expected: input.expected ?? expected,
  });
  assert.deepEqual(decoded, { ok: false, reason });
}

test("a single matching linear row decodes success", () => {
  const decoded = decodeInstrumentTradingRulesResponse({ response: response([row()]), expected });
  assert.deepEqual(decoded, {
    ok: true,
    rules: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" },
  });
});

test("minNotionalValue of exactly 0 decodes success", () => {
  const decoded = decodeInstrumentTradingRulesResponse({
    response: response([row({ lotSizeFilter: lotSizeFilter({ minNotionalValue: "0" }) })]),
    expected,
  });
  assert.deepEqual(decoded, {
    ok: true,
    rules: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "0" },
  });
});

test("an empty list fails with wrong_row_count", () => {
  assertFailure({ response: response([]) }, "wrong_row_count");
});

test("multiple rows fail with wrong_row_count", () => {
  assertFailure({ response: response([row(), row()]) }, "wrong_row_count");
});

test("a category mismatch fails with category_mismatch", () => {
  assertFailure({ response: response([row()], { category: "inverse" }) }, "category_mismatch");
});

test("a symbol mismatch fails with symbol_mismatch", () => {
  assertFailure({ response: response([row({ symbol: "ETHUSDT" })]) }, "symbol_mismatch");
});

test("a missing lotSizeFilter fails with missing_lot_size_filter", () => {
  assertFailure({ response: response([row({ lotSizeFilter: undefined })]) }, "missing_lot_size_filter");
});

test("a non-object lotSizeFilter fails with missing_lot_size_filter", () => {
  assertFailure({ response: response([row({ lotSizeFilter: "nope" })]) }, "missing_lot_size_filter");
});

test("a numeric minOrderQty fails with invalid_min_order_qty", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minOrderQty: 0.001 }) })]) },
    "invalid_min_order_qty",
  );
});

test("a null qtyStep fails with invalid_qty_step", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ qtyStep: null }) })]) },
    "invalid_qty_step",
  );
});

test("an object minNotionalValue fails with invalid_min_notional_value", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minNotionalValue: {} }) })]) },
    "invalid_min_notional_value",
  );
});

test("minOrderQty of 0 fails with invalid_min_order_qty", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minOrderQty: "0" }) })]) },
    "invalid_min_order_qty",
  );
});

test("negative minOrderQty fails with invalid_min_order_qty", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minOrderQty: "-0.001" }) })]) },
    "invalid_min_order_qty",
  );
});

test("qtyStep of 0 fails with invalid_qty_step", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ qtyStep: "0" }) })]) },
    "invalid_qty_step",
  );
});

test("negative qtyStep fails with invalid_qty_step", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ qtyStep: "-0.001" }) })]) },
    "invalid_qty_step",
  );
});

test("negative minNotionalValue fails with invalid_min_notional_value", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minNotionalValue: "-5" }) })]) },
    "invalid_min_notional_value",
  );
});

test("malformed decimal text fails for each numeric field", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minOrderQty: "abc" }) })]) },
    "invalid_min_order_qty",
  );
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ qtyStep: "1.2.3" }) })]) },
    "invalid_qty_step",
  );
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minNotionalValue: "abc" }) })]) },
    "invalid_min_notional_value",
  );
});

test("an out-of-range exponent fails for each numeric field via the compareDecimal try/catch path", () => {
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minOrderQty: "1e999" }) })]) },
    "invalid_min_order_qty",
  );
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ qtyStep: "1e999" }) })]) },
    "invalid_qty_step",
  );
  assertFailure(
    { response: response([row({ lotSizeFilter: lotSizeFilter({ minNotionalValue: "1e999" }) })]) },
    "invalid_min_notional_value",
  );
});

test("category spot fails with unsupported_category without inspecting the response", () => {
  assertFailure(
    { response: response([row()]), expected: { category: "spot", symbol: "BTCUSDT" } },
    "unsupported_category",
  );
  assertFailure({ response: null, expected: { category: "spot", symbol: "BTCUSDT" } }, "unsupported_category");
  assertFailure(
    { response: undefined, expected: { category: "spot", symbol: "BTCUSDT" } },
    "unsupported_category",
  );
});

test("a missing result is a malformed envelope", () => {
  assertFailure({ response: { retCode: 0 } }, "malformed_envelope");
});

test("a non-object response is a malformed envelope", () => {
  assertFailure({ response: "not an object" }, "malformed_envelope");
});

test("a null response is a malformed envelope", () => {
  assertFailure({ response: null }, "malformed_envelope");
});

test("a non-object result is a malformed envelope", () => {
  assertFailure({ response: { retCode: 0, result: "nope" } }, "malformed_envelope");
});

test("a non-array list is list_not_array", () => {
  assertFailure({ response: { retCode: 0, result: { category: "linear", list: "oops" } } }, "list_not_array");
});

test("a null row is malformed_item", () => {
  assertFailure({ response: response([null]) }, "malformed_item");
});
