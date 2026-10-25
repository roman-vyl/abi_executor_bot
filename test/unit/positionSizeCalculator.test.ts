import assert from "node:assert/strict";
import test from "node:test";

import {
  FixedMinimumPositionSizeCalculator,
  RiskPercentPositionSizeCalculator,
} from "../../src/risk/positionSizeCalculator.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";

test("min-qty-only case: min order qty already satisfies notional", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.01", qtyStep: "0.001", minNotionalValue: "1" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const qty = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "linear",
  });

  assert.deepEqual(qty, { kind: "quantity", quantity: "0.01" });
});

test("min-notional-driven case: notional requirement exceeds min order qty", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "100" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const qty = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "linear",
  });

  // ceil(100/61000 / 0.001) * 0.001 = ceil(1.639...) * 0.001 = 0.002
  assert.deepEqual(qty, { kind: "quantity", quantity: "0.002" });
});

test("exact-decimal division correctness avoids binary floating point", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  // 5 / 3 is a repeating decimal in binary float; result must still be exact
  // and rounded up to the step, not silently truncated by float imprecision.
  const qty = await calculator.calculate("BTCUSDT.P", "3", "2.9", "1", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "linear",
  });

  // ceil((5/3) / 0.001) * 0.001 = ceil(1666.67) * 0.001 = 1.667
  assert.deepEqual(qty, { kind: "quantity", quantity: "1.667" });
});

test("rules-unavailable failure propagates and fails only the current calculation", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.failure = new Error("instruments-info unavailable");
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  await assert.rejects(
    calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
      resolvedSymbol: "BTCUSDT",
      resolvedCategory: "linear",
    }),
    /instruments-info unavailable/,
  );
});

test("risk_multiplier is accepted and threaded through without affecting the V1 result", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  rulesProvider.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" };
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const withRiskOne = await calculator.calculate("BTCUSDT.P", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "linear",
  });
  const withRiskFive = await calculator.calculate("BTCUSDT.P", "61000", "60000", "5", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "linear",
  });

  assert.deepEqual(withRiskOne, withRiskFive);
});

test("resolvedCategory is passed through to the trading-rules lookup", async () => {
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  const calculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  await calculator.calculate("BTCUSDT", "61000", "60000", "1", {
    resolvedSymbol: "BTCUSDT",
    resolvedCategory: "spot",
  });

  assert.deepEqual(rulesProvider.getRulesCalls, ["spot:BTCUSDT"]);
});

const linear = { resolvedSymbol: "BTCUSDT", resolvedCategory: "linear" as const };

function riskSetup(options: {
  wallet?: unknown;
  marginMode?: unknown;
  rules?: Record<string, string | null>;
} = {}): { calculator: RiskPercentPositionSizeCalculator; bybit: FakeBybitAdapter; rules: FakeInstrumentTradingRulesProvider } {
  const rules = new FakeInstrumentTradingRulesProvider();
  rules.defaultRules = {
    minOrderQty: "0.001",
    qtyStep: "0.001",
    minNotionalValue: "5",
    tickSize: "0.1",
    maxMktOrderQty: "100",
    ...(options.rules ?? {}),
  } as typeof rules.defaultRules;
  const bybit = new FakeBybitAdapter();
  bybit.accountInfoResponse = {
    retCode: 0,
    result: { marginMode: options.marginMode === undefined ? "REGULAR_MARGIN" : options.marginMode },
  };
  bybit.walletBalanceResponse = {
    retCode: 0,
    result: { list: [{ totalWalletBalance: options.wallet === undefined ? "10000" : options.wallet }] },
  };
  return { calculator: new RiskPercentPositionSizeCalculator(rules, bybit), bybit, rules };
}

for (const [risk, expected] of [
  ["0.5", "0.5"],
  ["1", "1"],
  ["2", "2"],
] as const) {
  test(`risk sizing: risk_multiplier ${risk} is ${risk}% of the wallet balance`, async () => {
    const { calculator } = riskSetup();
    // 10000 * risk% / distance 100
    const result = await calculator.calculate("BTCUSDT.P", "60000", "59900", risk, linear, "long");
    assert.deepEqual(result, { kind: "quantity", quantity: expected });
  });
}

test("risk sizing: short uses stop above entry", async () => {
  const { calculator } = riskSetup();
  const result = await calculator.calculate("BTCUSDT.P", "60000", "60100", "1", linear, "short");
  assert.deepEqual(result, { kind: "quantity", quantity: "1" });
});

test("risk sizing: quantity is rounded down to qtyStep, never up", async () => {
  const { calculator } = riskSetup({ wallet: "1000" });
  // 1000 * 1% / 3 = 3.3333… → 3.333
  const result = await calculator.calculate("BTCUSDT.P", "60", "57", "1", linear, "long");
  assert.deepEqual(result, { kind: "quantity", quantity: "3.333" });
});

test("risk sizing: reads margin mode and balance on every calculation", async () => {
  const { calculator, bybit } = riskSetup();
  await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
  await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
  assert.equal(bybit.getAccountInfoCalls, 2);
  assert.equal(bybit.getWalletBalanceCalls.length, 2);
});

test("risk sizing: portfolio margin is allowed", async () => {
  const { calculator } = riskSetup({ marginMode: "PORTFOLIO_MARGIN" });
  const result = await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
  assert.equal(result.kind, "quantity");
});

for (const [entry, stop, side] of [
  ["60000", "60000", "long"],
  ["60000", "60100", "long"],
  ["60000", "59900", "short"],
  ["60000", "60000", "short"],
] as const) {
  test(`risk sizing: invalid stop ${stop} for ${side} entry ${entry} is declined before any read`, async () => {
    const { calculator, bybit } = riskSetup();
    const result = await calculator.calculate("BTCUSDT.P", entry, stop, "1", linear, side);
    assert.equal(result.kind, "declined");
    assert.equal(result.kind === "declined" && result.reason, "invalid_stop_distance");
    assert.equal(bybit.getAccountInfoCalls, 0);
    assert.equal(bybit.getWalletBalanceCalls.length, 0);
  });
}

for (const marginMode of ["ISOLATED_MARGIN", "SOMETHING_NEW"]) {
  test(`risk sizing: margin mode ${marginMode} is declined without reading the balance`, async () => {
    const { calculator, bybit } = riskSetup({ marginMode });
    const result = await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
    assert.deepEqual(result, {
      kind: "declined",
      reason: "margin_mode_not_supported",
      message: `marginMode ${marginMode}`,
    });
    assert.equal(bybit.getWalletBalanceCalls.length, 0);
  });
}

for (const wallet of ["0", "-5"]) {
  test(`risk sizing: wallet balance ${wallet} is declined as insufficient`, async () => {
    const { calculator } = riskSetup({ wallet });
    const result = await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
    assert.equal(result.kind === "declined" && result.reason, "insufficient_balance_for_minimum_quantity");
  });
}

test("risk sizing: below minOrderQty is declined, not raised to the minimum", async () => {
  // 100 * 1% / 1000 = 0.001 < 0.01
  const { calculator } = riskSetup({ wallet: "100", rules: { minOrderQty: "0.01" } });
  const result = await calculator.calculate("BTCUSDT.P", "60000", "59000", "1", linear, "long");
  assert.deepEqual(result, {
    kind: "declined",
    reason: "insufficient_balance_for_minimum_quantity",
    message: "quantity 0.001 below minOrderQty 0.01 (wallet 100, risk 1%, distance 1000)",
  });
});

test("risk sizing: zero after rounding is declined", async () => {
  // 10 * 1% / 1000 = 0.0001 → 0
  const { calculator } = riskSetup({ wallet: "10" });
  const result = await calculator.calculate("BTCUSDT.P", "60000", "59000", "1", linear, "long");
  assert.equal(result.kind === "declined" && result.reason, "insufficient_balance_for_minimum_quantity");
});

test("risk sizing: order value below minNotionalValue is declined", async () => {
  // 1000 * 1% / 1 = 10 qty at price 0.4 → value 4 < 5
  const { calculator } = riskSetup({ wallet: "1000", rules: { minOrderQty: "1", qtyStep: "1" } });
  const result = await calculator.calculate("XUSDT.P", "0.4", "-0.6", "1", linear, "long");
  assert.deepEqual(result, {
    kind: "declined",
    reason: "insufficient_balance_for_minimum_quantity",
    message: "order value 4 below minNotionalValue 5 (wallet 1000, risk 1%, distance 1)",
  });
});

test("risk sizing: above maxMktOrderQty is declined", async () => {
  const { calculator } = riskSetup({ rules: { maxMktOrderQty: "0.5" } });
  const result = await calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long");
  assert.equal(result.kind === "declined" && result.reason, "quantity_above_exchange_maximum");
});

test("risk sizing: missing maxMktOrderQty fails closed with an error", async () => {
  const { calculator } = riskSetup({ rules: { maxMktOrderQty: null } });
  await assert.rejects(
    calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long"),
    /maxMktOrderQty/,
  );
});

for (const [name, setup] of [
  ["missing marginMode", { marginMode: "" }],
  ["malformed balance", { wallet: "abc" }],
  ["numeric balance", { wallet: 10000 }],
] as const) {
  test(`risk sizing: ${name} is an error, not a decline`, async () => {
    const { calculator } = riskSetup(setup);
    await assert.rejects(calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long"));
  });
}

test("risk sizing: a failed read is an error, not a decline", async () => {
  const { calculator, bybit } = riskSetup();
  bybit.getAccountInfo = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(calculator.calculate("BTCUSDT.P", "60000", "59900", "1", linear, "long"), /timeout/);
});
