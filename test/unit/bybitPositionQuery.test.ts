import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePositionQueryResponse } from "../../src/exchange/bybitAdapter.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const CATEGORY = "linear";
const SYMBOL = "BTCUSDT";
const INPUT = { category: CATEGORY, symbol: SYMBOL };

function envelope(list: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { retCode: 0, result: { category: CATEGORY, list, ...overrides } };
}

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: SYMBOL,
    side: "Buy",
    size: "0.5",
    positionIdx: 0,
    avgPrice: "100000",
    openTime: 1785000012345,
    ...overrides,
  };
}

function flatRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: SYMBOL,
    side: "",
    size: "0",
    positionIdx: 0,
    avgPrice: "",
    openTime: 0,
    ...overrides,
  };
}

test("a single flat row (exactly one, size zero) is no_position", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow()]), INPUT), { kind: "no_position" });
});

test("a single valid size>0 row is returned as the position", () => {
  const result = evaluatePositionQueryResponse(envelope([validRow()]), INPUT);
  assert.deepEqual(result, {
    kind: "position",
    row: { symbol: SYMBOL, side: "Buy", size: "0.5", positionIdx: 0, avgPrice: "100000", openTime: 1785000012345 },
  });
});

test("an empty list is never trusted as no_position and fails closed", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([]), INPUT), {
    kind: "failure",
    reason: "no_row_returned",
  });
});

test("more than one row fails closed regardless of size, even two flat rows", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow(), flatRow()]), INPUT), {
    kind: "failure",
    reason: "multiple_rows_returned",
  });
});

test("a flat row alongside a valid size>0 row still fails closed as multiple rows, not resolved as the single position", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow(), validRow()]), INPUT), {
    kind: "failure",
    reason: "multiple_rows_returned",
  });
});

test("two size>0 rows fail closed as multiple rows", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow(), validRow({ side: "Sell" })]), INPUT), {
    kind: "failure",
    reason: "multiple_rows_returned",
  });
});

for (const [name, response] of [
  ["missing result", { retCode: 0 }],
  ["result not an object", { retCode: 0, result: "nope" }],
  ["missing result.list", { retCode: 0, result: { category: CATEGORY } }],
  ["result.list not an array", { retCode: 0, result: { category: CATEGORY, list: "nope" } }],
] as const) {
  test(`malformed envelope fails closed: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(response, INPUT), {
      kind: "failure",
      reason: "malformed_envelope",
    });
  });
}

for (const [name, category] of [
  ["missing", undefined],
  ["wrong-typed", 5],
  ["mismatched", "spot"],
] as const) {
  test(`result.category mismatch fails closed: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow()], { category }), INPUT), {
      kind: "failure",
      reason: "category_mismatch",
    });
  });
}

test("matching result.category passes through to row validation", () => {
  const result = evaluatePositionQueryResponse(envelope([flatRow()], { category: CATEGORY }), INPUT);
  assert.deepEqual(result, { kind: "no_position" });
});

test("a non-object single item fails closed", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([null]), INPUT), {
    kind: "failure",
    reason: "malformed_item",
  });
  assert.deepEqual(evaluatePositionQueryResponse(envelope(["not-an-object"]), INPUT), {
    kind: "failure",
    reason: "malformed_item",
  });
});

for (const [name, symbolValue] of [
  ["missing", undefined],
  ["wrong-typed", 123],
  ["mismatched", "ETHUSDT"],
] as const) {
  test(`symbol mismatch fails closed: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ symbol: symbolValue })]), INPUT), {
      kind: "failure",
      reason: "symbol_mismatch",
    });
  });
}

for (const [name, positionIdx] of [
  ["missing", undefined],
  ["non-integer", 0.5],
  ["hedge value 1", 1],
  ["hedge value 2", 2],
] as const) {
  test(`invalid positionIdx on a size>0 row fails closed: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ positionIdx })]), INPUT), {
      kind: "failure",
      reason: "invalid_position_idx",
    });
  });

  test(`invalid positionIdx on a valid size==0 row still fails closed (not exempted): ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow({ positionIdx })]), INPUT), {
      kind: "failure",
      reason: "invalid_position_idx",
    });
  });
}

for (const [name, size] of [
  ["missing", undefined],
  ["non-exact-decimal", "abc"],
  ["non-finite", "Infinity"],
  ["negative", "-0.001"],
] as const) {
  test(`invalid size fails closed, never treated as no position: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ size })]), INPUT), {
      kind: "failure",
      reason: "invalid_size",
    });
  });
}

test("size>0 row missing or invalid side fails closed", () => {
  for (const side of [undefined, "None", "buy", ""]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ side })]), INPUT), {
      kind: "failure",
      reason: "invalid_side",
    });
  }
});

test("size>0 row missing or invalid avgPrice fails closed", () => {
  for (const avgPrice of [undefined, "0", "-1", "not-a-number"]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ avgPrice })]), INPUT), {
      kind: "failure",
      reason: "invalid_avg_price",
    });
  }
});

test("size>0 row missing or invalid openTime fails closed", () => {
  for (const openTime of [undefined, 0, -1, 1.5, "1785000012345"]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ openTime })]), INPUT), {
      kind: "failure",
      reason: "invalid_open_time",
    });
  }
});

// Decimal-exponent edge cases: classification must never throw regardless of
// how large the magnitude the exponent implies is (exactDecimal.ts's
// arithmetic parser enforces a MAX_ABS_EXPONENT bound and throws outside it,
// but sign/zero classification does not do arithmetic and must be total).
test("a huge positive exponent on size is accepted as a valid positive size without throwing", () => {
  assert.doesNotThrow(() => evaluatePositionQueryResponse(envelope([validRow({ size: "1e+200" })]), INPUT));
  const result = evaluatePositionQueryResponse(envelope([validRow({ size: "1e+200" })]), INPUT);
  assert.equal(result.kind, "position");
});

test("a huge negative exponent on size (still nonzero) is accepted as a valid positive size without throwing", () => {
  const result = evaluatePositionQueryResponse(envelope([validRow({ size: "1e-200" })]), INPUT);
  assert.equal(result.kind, "position");
});

test("zero with a large exponent is still classified as exactly zero without throwing", () => {
  const result = evaluatePositionQueryResponse(envelope([flatRow({ size: "0e200" })]), INPUT);
  assert.deepEqual(result, { kind: "no_position" });
});

test("negative zero with a large exponent is classified as zero (not negative), without throwing", () => {
  const result = evaluatePositionQueryResponse(envelope([flatRow({ size: "-0e200" })]), INPUT);
  assert.deepEqual(result, { kind: "no_position" });
});

test("a huge-exponent negative nonzero size fails closed as invalid_size without throwing", () => {
  const result = evaluatePositionQueryResponse(envelope([validRow({ size: "-1e200" })]), INPUT);
  assert.deepEqual(result, { kind: "failure", reason: "invalid_size" });
});

test("FakeBybitAdapter.queryPositionForInstrument maps a transport failure to a typed failure", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsError = new Error("timeout");

  const result = await bybit.queryPositionForInstrument(INPUT);

  assert.deepEqual(result, { kind: "failure", reason: "transport_error" });
});

test("FakeBybitAdapter.queryPositionForInstrument passes the explicit category and symbol through to getOpenPositions", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsResponse = envelope([flatRow()]);

  await bybit.queryPositionForInstrument(INPUT);

  assert.deepEqual(bybit.getOpenPositionsCalls, [{ category: CATEGORY, symbol: SYMBOL }]);
});
