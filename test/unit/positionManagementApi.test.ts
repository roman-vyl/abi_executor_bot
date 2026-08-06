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
  validateCloseCommand,
  validateProtectionCommand,
  validationFailedResult,
} from "../../src/domain/positionManagementApi.js";
import type { CloseConfirmation, ProtectionConfirmation } from "../../src/domain/positionManagementApi.js";

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

function verifiedProtection(overrides: Partial<ProtectionConfirmation> = {}): ProtectionConfirmation {
  return {
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    acceptedStopPrice: "99000",
    acceptedTakePrice: "103000",
    confirmedStopPrice: "99000",
    confirmedTakePrice: "103000",
    verificationSucceeded: true,
    ...overrides,
  };
}

test("serializeProtectionApplied returns 200 with the accepted request strings when fully confirmed", () => {
  const result = serializeProtectionApplied(verifiedProtection());

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

test("serializeProtectionApplied returns the accepted strings even when the exchange echoed different formatting", () => {
  const result = serializeProtectionApplied(
    verifiedProtection({
      acceptedStopPrice: "99000",
      confirmedStopPrice: "99000.00",
      acceptedTakePrice: "+103000",
      confirmedTakePrice: "103000e0",
    }),
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual((result.body as Record<string, unknown>).stop_price, "99000");
  assert.deepEqual((result.body as Record<string, unknown>).take_price, "+103000");
});

test("serializeProtectionApplied nulls take_price through unchanged when both sides are null", () => {
  const result = serializeProtectionApplied(
    verifiedProtection({ acceptedTakePrice: null, confirmedTakePrice: null }),
  );

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

test("serializeProtectionApplied fails closed when verification did not succeed", () => {
  const result = serializeProtectionApplied(verifiedProtection({ verificationSucceeded: false }));
  assert.deepEqual(result, internalErrorResult());
});

test("serializeProtectionApplied fails closed on a genuine stop-price mismatch", () => {
  const result = serializeProtectionApplied(verifiedProtection({ confirmedStopPrice: "99001" }));
  assert.deepEqual(result, internalErrorResult());
});

test("serializeProtectionApplied fails closed on a genuine take-price mismatch", () => {
  const result = serializeProtectionApplied(verifiedProtection({ confirmedTakePrice: "103500" }));
  assert.deepEqual(result, internalErrorResult());
});

test("serializeProtectionApplied fails closed when accepted take is null but confirmed take is not", () => {
  const result = serializeProtectionApplied(verifiedProtection({ acceptedTakePrice: null }));
  assert.deepEqual(result, internalErrorResult());
});

test("serializeProtectionApplied fails closed when confirmed take is null but accepted take is not", () => {
  const result = serializeProtectionApplied(verifiedProtection({ confirmedTakePrice: null }));
  assert.deepEqual(result, internalErrorResult());
});

test("serializeProtectionApplied fails closed on malformed decimal or empty identifiers", () => {
  assert.deepEqual(
    serializeProtectionApplied(verifiedProtection({ acceptedStopPrice: "not-a-number" })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeProtectionApplied(verifiedProtection({ confirmedStopPrice: "not-a-number" })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeProtectionApplied(verifiedProtection({ strategyInstanceId: "" })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeProtectionApplied(verifiedProtection({ tradeCycleId: "" })),
    internalErrorResult(),
  );
});

function verifiedClose(overrides: Partial<CloseConfirmation> = {}): CloseConfirmation {
  return {
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    positionZeroVerified: true,
    noAttributedActiveOrdersVerified: true,
    correlationCompleteAndConsistent: true,
    ...overrides,
  };
}

test("serializeTradeCycleClosed returns the closed success object when all postconditions are verified", () => {
  const result = serializeTradeCycleClosed(verifiedClose());

  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "trade_cycle_closed",
    },
  });
});

test("serializeTradeCycleClosed fails closed when any single postcondition is unverified", () => {
  assert.deepEqual(
    serializeTradeCycleClosed(verifiedClose({ positionZeroVerified: false })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeTradeCycleClosed(verifiedClose({ noAttributedActiveOrdersVerified: false })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeTradeCycleClosed(verifiedClose({ correlationCompleteAndConsistent: false })),
    internalErrorResult(),
  );
});

test("serializeTradeCycleClosed fails closed on empty identifiers even with all postconditions verified", () => {
  assert.deepEqual(
    serializeTradeCycleClosed(verifiedClose({ strategyInstanceId: "" })),
    internalErrorResult(),
  );
  assert.deepEqual(
    serializeTradeCycleClosed(verifiedClose({ tradeCycleId: "" })),
    internalErrorResult(),
  );
});

test("validateCloseCommand builds a typed command from opaque non-empty path values", () => {
  const result = validateCloseCommand({ strategyInstanceId: "instance", tradeCycleId: "cycle" });

  assert.deepEqual(result, {
    ok: true,
    command: { strategyInstanceId: "instance", tradeCycleId: "cycle" },
  });
});

test("validateCloseCommand rejects empty or missing path identifiers", () => {
  const result = validateCloseCommand({ strategyInstanceId: "", tradeCycleId: undefined });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.details.some((detail) => detail.path === "/path/strategy_instance_id"));
    assert.ok(result.details.some((detail) => detail.path === "/path/trade_cycle_id"));
  }
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
