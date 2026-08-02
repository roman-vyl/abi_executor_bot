import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyExactDecimalText,
  internalErrorResult,
  isExactDecimalText,
  isNonNegativeExactDecimalText,
  isPositiveExactDecimalText,
  malformedJsonResult,
  serializeAbsentEntryPackage,
  serializeAppliedEntryPackage,
  unsupportedMediaTypeResult,
  validateEntryPackageCommand,
  validationFailedResult,
} from "../../src/domain/entryPackageApi.js";

test("valid package preserves opaque Runtime values and exact-decimal text", () => {
  const lockedExitProfile = " profile value ".repeat(40);
  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: " instance/with spaces ",
      tradeCycleId: "cycle:@future-format",
    },
    {
      ticker: "BTCUSDT.P",
      desired_entry: {
        side: "long",
        source_plan_bar_open_time_ms: 9_007_199_254_740_992,
        planned_entry_price: "-001.2300e+2",
        initial_stop_price: "+999.00",
        initial_take_price: "000.10e1",
        locked_exit_profile: lockedExitProfile,
      },
      risk_multiplier: "+000.2500e1",
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.command.strategyInstanceId, " instance/with spaces ");
    assert.equal(result.command.tradeCycleId, "cycle:@future-format");
    assert.equal(result.command.ticker, "BTCUSDT.P");
    assert.equal(result.command.desiredEntry?.planned_entry_price, "-001.2300e+2");
    assert.equal(result.command.desiredEntry?.initial_stop_price, "+999.00");
    assert.equal(result.command.desiredEntry?.initial_take_price, "000.10e1");
    assert.equal(result.command.desiredEntry?.locked_exit_profile, lockedExitProfile);
    assert.equal(result.command.riskMultiplier, "+000.2500e1");
  }
});

test("valid absence representation is accepted", () => {
  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
    },
    {
      ticker: "BTCUSDT.P",
      desired_entry: null,
      risk_multiplier: "+01.00",
    },
  );

  assert.deepEqual(result, {
    ok: true,
    command: {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
      ticker: "BTCUSDT.P",
      desiredEntry: null,
      riskMultiplier: "+01.00",
    },
  });
});

test("request rejects missing and unknown fields", () => {
  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
    },
    {
      ticker: "BTCUSDT.P",
      desired_entry: null,
      risk_multiplier: "1",
      extra: true,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.details.some((detail) => detail.path === "/extra"));
  }

  const missing = validateEntryPackageCommand(
    {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
    },
    {
      ticker: "BTCUSDT.P",
    },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.ok(resultHasPath(missing.details, "/desired_entry"));
    assert.ok(resultHasPath(missing.details, "/risk_multiplier"));
  }
});

test("risk multiplier is required and never nullable", () => {
  for (const desiredEntry of [null, makePackagePayload().desired_entry]) {
    const result = validateEntryPackageCommand(
      {
        strategyInstanceId: "instance",
        tradeCycleId: "cycle",
      },
      {
        ticker: "BTCUSDT.P",
        desired_entry: desiredEntry,
        risk_multiplier: null,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(resultHasPath(result.details, "/risk_multiplier"));
    }
  }
});

test("only empty ownership and ticker strings are rejected", () => {
  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: "",
      tradeCycleId: "",
    },
    {
      ticker: "",
      desired_entry: null,
      risk_multiplier: "1",
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(resultHasPath(result.details, "/path/strategy_instance_id"));
    assert.ok(resultHasPath(result.details, "/path/trade_cycle_id"));
    assert.ok(resultHasPath(result.details, "/ticker"));
  }
});

test("DesiredEntry rejects invalid field types and side enum", () => {
  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
    },
    {
      ticker: "BTCUSDT.P",
      desired_entry: {
        side: "both",
        source_plan_bar_open_time_ms: "1785000000000",
        planned_entry_price: 100,
        initial_stop_price: "99",
        initial_take_price: "103",
        locked_exit_profile: null,
      },
      risk_multiplier: "1",
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(resultHasPath(result.details, "/desired_entry/side"));
    assert.ok(resultHasPath(result.details, "/desired_entry/source_plan_bar_open_time_ms"));
    assert.ok(resultHasPath(result.details, "/desired_entry/planned_entry_price"));
    assert.ok(resultHasPath(result.details, "/desired_entry/locked_exit_profile"));
  }
});

test("exact-decimal validation avoids binary floating point and adds no canonical regex", () => {
  for (const value of ["0", "-0", "+1", "001.2300", ".5", "1.", "1e+1000000", "-2E-3"]) {
    assert.equal(isExactDecimalText(value), true, value);
  }
  for (const value of ["+1", "001.2300", ".5", "1.", "1e+1000000"]) {
    assert.equal(isPositiveExactDecimalText(value), true, value);
  }
  for (const value of ["", ".", "e1", "NaN", "Infinity", "1e", " 1", "1 "]) {
    assert.equal(isExactDecimalText(value), false, value);
  }
  for (const value of ["0", "-0", "-1", "-1e-3"]) {
    assert.equal(isPositiveExactDecimalText(value), false, value);
  }
});

test("sign/zero classification is total: extreme exponents never throw, unlike exactDecimal.ts's arithmetic parser", () => {
  for (const value of ["1e+200", "1e-200", "-1e200", "0e200", "-0e200", "1e+1000000"]) {
    assert.doesNotThrow(() => classifyExactDecimalText(value), value);
    assert.doesNotThrow(() => isPositiveExactDecimalText(value), value);
    assert.doesNotThrow(() => isNonNegativeExactDecimalText(value), value);
  }

  assert.deepEqual(classifyExactDecimalText("1e+200"), { valid: true, negative: false, zero: false });
  assert.deepEqual(classifyExactDecimalText("-1e200"), { valid: true, negative: true, zero: false });
  assert.deepEqual(classifyExactDecimalText("0e200"), { valid: true, negative: false, zero: true });
  assert.deepEqual(classifyExactDecimalText("-0e200"), { valid: true, negative: true, zero: true });

  assert.equal(isNonNegativeExactDecimalText("-0e200"), true);
  assert.equal(isNonNegativeExactDecimalText("-1e200"), false);
  assert.equal(isNonNegativeExactDecimalText("0e200"), true);
  assert.equal(isNonNegativeExactDecimalText("1e+200"), true);
});

test("isNonNegativeExactDecimalText accepts zero and positive text, rejects negative and invalid text", () => {
  for (const value of ["0", "-0", "+0", "0.0", "1", "001.2300", "1e+1000000"]) {
    assert.equal(isNonNegativeExactDecimalText(value), true, value);
  }
  for (const value of ["-1", "-0.001", "-1e-3", "", "abc", "Infinity"]) {
    assert.equal(isNonNegativeExactDecimalText(value), false, value);
  }
});

test("initial take and risk multiplier must be positive exact-decimal strings", () => {
  const payload = makePackagePayload();
  payload.desired_entry = {
    ...(payload.desired_entry as Record<string, unknown>),
    initial_take_price: "0",
  };
  payload.risk_multiplier = "-1";

  const result = validateEntryPackageCommand(
    {
      strategyInstanceId: "instance",
      tradeCycleId: "cycle",
    },
    payload,
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(resultHasPath(result.details, "/desired_entry/initial_take_price"));
    assert.ok(resultHasPath(result.details, "/risk_multiplier"));
  }
});

test("applied serializer returns the exact closed acknowledgement", () => {
  const result = serializeAppliedEntryPackage({
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    completePackageApplied: true,
    appliedDesiredEntry: makePackagePayload().desired_entry as any,
    calculatedQuantity: "0.00100",
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    strategy_instance_id: "instance",
    trade_cycle_id: "cycle",
    status: "entry_package_applied",
    applied_desired_entry: makePackagePayload().desired_entry,
    calculated_quantity: "0.00100",
  });
  assert.deepEqual(Object.keys(result.body).sort(), [
    "applied_desired_entry",
    "calculated_quantity",
    "status",
    "strategy_instance_id",
    "trade_cycle_id",
  ]);
});

test("partial package cannot serialize as 2xx", () => {
  const result = serializeAppliedEntryPackage({
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
    completePackageApplied: false,
    appliedDesiredEntry: makePackagePayload().desired_entry as any,
    calculatedQuantity: "0.001",
  });

  assert.deepEqual(result, internalErrorResult());
  assert.equal(result.statusCode, 500);
});

test("absent serializer confirms state without action fields", () => {
  const result = serializeAbsentEntryPackage({
    strategyInstanceId: "instance",
    tradeCycleId: "cycle",
  });

  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "entry_package_absent",
    },
  });
});

test("public errors use one safe closed envelope", () => {
  assert.deepEqual(malformedJsonResult(), {
    statusCode: 400,
    body: {
      error: {
        code: "malformed_json",
        message: "request body must be valid JSON",
      },
    },
  });
  assert.deepEqual(unsupportedMediaTypeResult(), {
    statusCode: 415,
    body: {
      error: {
        code: "unsupported_media_type",
        message: "content-type must be application/json",
      },
    },
  });
  assert.deepEqual(validationFailedResult([{ path: "/ticker", message: "required" }]), {
    statusCode: 422,
    body: {
      error: {
        code: "validation_failed",
        message: "request validation failed",
        details: [{ path: "/ticker", message: "required" }],
      },
    },
  });
  assert.deepEqual(internalErrorResult(), {
    statusCode: 500,
    body: {
      error: {
        code: "internal_error",
        message: "internal error",
      },
    },
  });
});

function makePackagePayload(): Record<string, any> {
  return {
    ticker: "BTCUSDT.P",
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
  };
}

function resultHasPath(
  details: Array<{
    path: string;
  }>,
  path: string,
): boolean {
  return details.some((detail) => detail.path === path);
}
