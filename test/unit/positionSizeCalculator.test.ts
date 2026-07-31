import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";

test("min-qty-only case: min order qty already satisfies notional", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.01", qtyStep: "0.001", minNotionalValue: "1" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const qty = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
  });

  assert.equal(qty, "0.01");
});

test("min-notional-driven case: notional requirement exceeds min order qty", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "100" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const qty = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
  });

  // ceil(100/61000 / 0.001) * 0.001 = ceil(1.639...) * 0.001 = 0.002
  assert.equal(qty, "0.002");
});

test("exact-decimal division correctness avoids binary floating point", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  // 5 / 3 is a repeating decimal in binary float; result must still be exact
  // and rounded up to the step, not silently truncated by float imprecision.
  const qty = await calculator.calculate("BTCUSDT.P", "3", "2.9", "1", {
    resolvedSymbol: "BTCUSDT",
  });

  // ceil((5/3) / 0.001) * 0.001 = ceil(1666.67) * 0.001 = 1.667
  assert.equal(qty, "1.667");
});

test("rules-unavailable failure propagates and fails only the current calculation", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.failure = new Error("instruments-info unavailable");
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  await assert.rejects(
    calculator.calculate("BTCUSDT.P", "61000", "60000", "1", { resolvedSymbol: "BTCUSDT" }),
    /instruments-info unavailable/,
  );
});

test("risk_multiplier is accepted and threaded through without affecting the V1 result", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const withRiskOne = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
  });
  const withRiskFive = await calculator.calculate("BTCUSDT.P", "61000", "60000", "5", {
    resolvedSymbol: "BTCUSDT",
  });

  assert.equal(withRiskOne, withRiskFive);
});

test("no hardcoded quantity literal appears in the application service source", () => {
  const applicationServicePath = fileURLToPath(
    new URL("../../src/services/entryPackage/entryPackageApplicationService.ts", import.meta.url),
  );
  const source = readFileSync(applicationServicePath, "utf8");

  assert.equal(/["'`]0\.001["'`]/.test(source), false, "application service must not hardcode a quantity literal");
});
