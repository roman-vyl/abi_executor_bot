import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePositionQueryResponse } from "../../src/exchange/bybitAdapter.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const SYMBOL = "BTCUSDT";

function envelope(list: unknown[]): unknown {
  return { retCode: 0, result: { list } };
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

test("empty list is no_position", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([]), SYMBOL), { kind: "no_position" });
});

test("a single valid size>0 row is returned as the position", () => {
  const result = evaluatePositionQueryResponse(envelope([validRow()]), SYMBOL);
  assert.deepEqual(result, {
    kind: "position",
    row: { symbol: SYMBOL, side: "Buy", size: "0.5", positionIdx: 0, avgPrice: "100000", openTime: 1785000012345 },
  });
});

test("a valid zero-size row is excluded, not a failure, even with empty/default fields", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow()]), SYMBOL), { kind: "no_position" });
});

test("all-zero-size rows resolve as no_position", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow(), flatRow()]), SYMBOL), { kind: "no_position" });
});

for (const [name, response] of [
  ["missing result", { retCode: 0 }],
  ["result not an object", { retCode: 0, result: "nope" }],
  ["missing result.list", { retCode: 0, result: {} }],
  ["result.list not an array", { retCode: 0, result: { list: "nope" } }],
] as const) {
  test(`malformed envelope fails closed: ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(response, SYMBOL), {
      kind: "failure",
      reason: "malformed_envelope",
    });
  });
}

test("a non-object list item fails closed", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([null]), SYMBOL), {
    kind: "failure",
    reason: "malformed_item",
  });
  assert.deepEqual(evaluatePositionQueryResponse(envelope(["not-an-object"]), SYMBOL), {
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
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ symbol: symbolValue })]), SYMBOL), {
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
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ positionIdx })]), SYMBOL), {
      kind: "failure",
      reason: "invalid_position_idx",
    });
  });

  test(`invalid positionIdx on a valid size==0 row still fails closed (not exempted): ${name}`, () => {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow({ positionIdx })]), SYMBOL), {
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
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ size })]), SYMBOL), {
      kind: "failure",
      reason: "invalid_size",
    });
  });
}

test("size>0 row missing or invalid side fails closed", () => {
  for (const side of [undefined, "None", "buy", ""]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ side })]), SYMBOL), {
      kind: "failure",
      reason: "invalid_side",
    });
  }
});

test("size>0 row missing or invalid avgPrice fails closed", () => {
  for (const avgPrice of [undefined, "0", "-1", "not-a-number"]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ avgPrice })]), SYMBOL), {
      kind: "failure",
      reason: "invalid_avg_price",
    });
  }
});

test("size>0 row missing or invalid openTime fails closed", () => {
  for (const openTime of [undefined, 0, -1, 1.5, "1785000012345"]) {
    assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow({ openTime })]), SYMBOL), {
      kind: "failure",
      reason: "invalid_open_time",
    });
  }
});

test("more than one size>0 row is ambiguous and fails closed", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([validRow(), validRow({ side: "Sell" })]), SYMBOL), {
    kind: "failure",
    reason: "ambiguous_rows",
  });
});

test("a flat row alongside one valid size>0 row still resolves to that single position", () => {
  assert.deepEqual(evaluatePositionQueryResponse(envelope([flatRow(), validRow()]), SYMBOL), {
    kind: "position",
    row: { symbol: SYMBOL, side: "Buy", size: "0.5", positionIdx: 0, avgPrice: "100000", openTime: 1785000012345 },
  });
});

test("FakeBybitAdapter.queryPositionForInstrument maps a transport failure to a typed failure", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsError = new Error("timeout");

  const result = await bybit.queryPositionForInstrument({ category: "linear", symbol: SYMBOL });

  assert.deepEqual(result, { kind: "failure", reason: "transport_error" });
});

test("FakeBybitAdapter.queryPositionForInstrument passes the explicit category and symbol through to getOpenPositions", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsResponse = envelope([validRow()]);

  await bybit.queryPositionForInstrument({ category: "linear", symbol: SYMBOL });

  assert.deepEqual(bybit.getOpenPositionsCalls, [{ category: "linear", symbol: SYMBOL }]);
});
