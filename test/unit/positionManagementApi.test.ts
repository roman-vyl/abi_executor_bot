import assert from "node:assert/strict";
import test from "node:test";

import {
  internalErrorResult,
  isNumericallyEqualExactDecimal,
  malformedJsonResult,
  positionNotOpenResult,
  serializeProtectionApplied,
  serializeTradeCycleClosed,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
  unsupportedMediaTypeResult,
  validateProtectionCommand,
  validationFailedResult,
} from "../../src/domain/positionManagementApi.js";

test("valid protection request with a take price is accepted", () => {
  const result = validateProtectionCommand(
    { strategyInstanceId: "instance", tradeCycleId: "cycle" },
    { stop_price: "99000", take_price: "103000" },
  );

  assert.deepEqual(result, {
    ok: true,
    command: {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
      stopPrice: "99000",
      takePrice: "103000",
    },
  });
});

test("valid protection request with a null take price is accepted", () => {
  const result = validateProtectionCommand(
    { strategyInstanceId: "instance", tradeCycleId: "cycle" },
    { stop_price: "99000", take_price: null },
  );

  assert.deepEqual(result, {
    ok: true,
    command: {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
      stopPrice: "99000",
      takePrice: null,
    },
  });
});

test("missing or malformed stop_price is rejected", () => {
  for (const body of [
    { take_price: null },
    { stop_price: null, take_price: null },
    { stop_price: 99000, take_price: null },
    { stop_price: "not-a-number", take_price: null },
  ]) {
    const result = validateProtectionCommand(
      { strategyInstanceId: "instance", tradeCycleId: "cycle" },
      body,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.details.some((detail) => detail.path === "/stop_price"));
    }
  }
});

test("malformed non-null take_price is rejected", () => {
  const result = validateProtectionCommand(
    { strategyInstanceId: "instance", tradeCycleId: "cycle" },
    { stop_price: "99000", take_price: "not-a-number" },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.details.some((detail) => detail.path === "/take_price"));
  }
});

test("unknown fields and non-object bodies are rejected", () => {
  const unknownField = validateProtectionCommand(
    { strategyInstanceId: "instance", tradeCycleId: "cycle" },
    { stop_price: "99000", take_price: null, extra: true },
  );
  assert.equal(unknownField.ok, false);

  const nonObject = validateProtectionCommand(
    { strategyInstanceId: "instance", tradeCycleId: "cycle" },
    "not-an-object",
  );
  assert.equal(nonObject.ok, false);
  if (!nonObject.ok) {
    assert.deepEqual(nonObject.details, [{ path: "/", message: "request body must be a JSON object" }]);
  }
});

test("empty path identifiers are rejected", () => {
  const result = validateProtectionCommand(
    { strategyInstanceId: "", tradeCycleId: undefined },
    { stop_price: "99000", take_price: null },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.details.some((detail) => detail.path === "/path/strategy_instance_id"));
    assert.ok(result.details.some((detail) => detail.path === "/path/trade_cycle_id"));
  }
});

test("isNumericallyEqualExactDecimal ignores formatting differences but not value differences", () => {
  assert.equal(isNumericallyEqualExactDecimal("99000", "99000"), true);
  assert.equal(isNumericallyEqualExactDecimal("99000", "99000.0"), true);
  assert.equal(isNumericallyEqualExactDecimal("+99000", "99000"), true);
  assert.equal(isNumericallyEqualExactDecimal("990.00e2", "99000"), true);
  assert.equal(isNumericallyEqualExactDecimal("99000", "99001"), false);
  assert.equal(isNumericallyEqualExactDecimal("99000", "98999.99"), false);
});

test("isNumericallyEqualExactDecimal is total: malformed input is a mismatch, not a throw", () => {
  assert.equal(isNumericallyEqualExactDecimal("not-a-number", "99000"), false);
  assert.equal(isNumericallyEqualExactDecimal("99000", ""), false);
});

test("serializeProtectionApplied returns the exact accepted request strings, closed object", () => {
  const result = serializeProtectionApplied({
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    stopPrice: "99000",
    takePrice: "103000",
  });

  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "protection_applied",
      stop_price: "99000",
      take_price: "103000",
    },
  });
});

test("serializeProtectionApplied nulls take_price through unchanged", () => {
  const result = serializeProtectionApplied({
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    stopPrice: "99000",
    takePrice: null,
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.body).sort(), [
    "status",
    "stop_price",
    "strategy_instance_id",
    "take_price",
    "trade_cycle_id",
  ]);
  assert.equal((result.body as Record<string, unknown>).take_price, null);
});

test("serializeTradeCycleClosed returns the closed success object", () => {
  const result = serializeTradeCycleClosed({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "trade_cycle_closed",
    },
  });
});

test("error result builders map to the documented codes and statuses", () => {
  assert.deepEqual(malformedJsonResult(), {
    statusCode: 400,
    body: { error: { code: "malformed_json", message: "request body must be valid JSON" } },
  });
  assert.deepEqual(unsupportedMediaTypeResult(), {
    statusCode: 415,
    body: { error: { code: "unsupported_media_type", message: "content-type must be application/json" } },
  });
  assert.deepEqual(validationFailedResult([{ path: "/", message: "bad" }]), {
    statusCode: 422,
    body: {
      error: {
        code: "validation_failed",
        message: "request validation failed",
        details: [{ path: "/", message: "bad" }],
      },
    },
  });
  assert.deepEqual(unknownTradeCycleBindingResult(), {
    statusCode: 422,
    body: {
      error: {
        code: "unknown_trade_cycle_binding",
        message: "no correlation record exists for the requested pair",
      },
    },
  });
  assert.deepEqual(unsupportedExchangeScopeResult(), {
    statusCode: 422,
    body: {
      error: {
        code: "unsupported_exchange_scope",
        message: "resolved position's exchange category is not supported",
      },
    },
  });
  assert.deepEqual(positionNotOpenResult(), {
    statusCode: 422,
    body: {
      error: { code: "position_not_open", message: "no live position exists for the requested pair" },
    },
  });
  assert.deepEqual(internalErrorResult(), {
    statusCode: 500,
    body: { error: { code: "internal_error", message: "internal error" } },
  });
});

test("validationFailedResult with no details fails safe to internal_error", () => {
  assert.deepEqual(validationFailedResult([]), internalErrorResult());
});
