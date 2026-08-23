import assert from "node:assert/strict";
import test from "node:test";

import {
  ceilRatioToStep,
  ceilToStep,
  compareDecimal,
  decimalEquals,
  floorToStep,
  maxDecimal,
  multiplyDecimal,
  subtractDecimal,
} from "../../src/domain/exactDecimal.js";

test("accepts the full exact-decimal transport grammar, matching isExactDecimalText", () => {
  assert.equal(compareDecimal(".5", "0.5"), 0);
  assert.equal(compareDecimal("1.", "1"), 0);
  assert.equal(compareDecimal("+100000", "100000"), 0);
  assert.equal(compareDecimal("1e3", "1000"), 0);
  assert.equal(compareDecimal("1.5e2", "150"), 0);
  assert.equal(compareDecimal("1e-2", "0.01"), 0);
  assert.equal(compareDecimal("-1", "-1.0"), 0);
});

test("rejects garbage input rather than silently misparsing", () => {
  assert.throws(() => compareDecimal("abc", "1"));
  assert.throws(() => compareDecimal("1.2.3", "1"));
  assert.throws(() => compareDecimal("", "1"));
  assert.throws(() => compareDecimal("1e999", "1"));
});

test("ceilToStep still rounds up correctly with the wider grammar", () => {
  assert.equal(ceilToStep(".0009", "0.001"), "0.001");
  assert.equal(ceilToStep("1e-3", "0.001"), "0.001");
});

test("ceilRatioToStep exact-decimal division is unaffected by the grammar widening", () => {
  assert.equal(ceilRatioToStep("5", "3", "0.001"), "1.667");
});

test("floorToStep leaves an exact-multiple-of-step input unchanged", () => {
  assert.equal(floorToStep("1.5", "0.5"), "1.5");
  assert.equal(floorToStep("0.001", "0.001"), "0.001");
});

test("floorToStep rounds a value strictly between two step boundaries down to the lower one", () => {
  assert.equal(floorToStep("0.0019", "0.001"), "0.001");
  assert.equal(floorToStep("1.0009", "0.001"), "1");
});

test("floorToStep and ceilToStep differ whenever the input is not already an exact multiple", () => {
  assert.equal(floorToStep("0.0019", "0.001"), "0.001");
  assert.equal(ceilToStep("0.0019", "0.001"), "0.002");
  assert.notEqual(floorToStep("0.0019", "0.001"), ceilToStep("0.0019", "0.001"));

  // Exact multiples: both agree (no rounding needed either way).
  assert.equal(floorToStep("1.5", "0.5"), ceilToStep("1.5", "0.5"));
});

test("maxDecimal and subtractDecimal handle bare-dot and signed forms", () => {
  assert.equal(maxDecimal(".5", "0.4"), ".5");
  assert.equal(subtractDecimal("1.", "0.25"), "0.75");
});

test("subtractDecimal still guards against a negative result", () => {
  assert.throws(() => subtractDecimal("1", "2"));
});

test("decimalEquals ignores formatting-only differences", () => {
  assert.equal(decimalEquals("99", "99.0"), true);
  assert.equal(decimalEquals("99", "+99"), true);
  assert.equal(decimalEquals("99", "990e-1"), true);
  assert.equal(decimalEquals(".5", "0.5"), true);
  assert.equal(decimalEquals("1.", "1"), true);
  assert.equal(decimalEquals("0", "-0"), true);
  assert.equal(decimalEquals("0", "0.00"), true);
  assert.equal(decimalEquals("0", "0e5"), true);
});

test("decimalEquals is exact for exponents far beyond compareDecimal's MAX_ABS_EXPONENT bound", () => {
  assert.equal(decimalEquals("1e101", "10e100"), true);
  assert.equal(decimalEquals("1e1000", "10e999"), true);
  assert.equal(decimalEquals("1e1000", "2e1000"), false);
});

test("decimalEquals reports a genuine numeric difference as false", () => {
  assert.equal(decimalEquals("99000", "99001"), false);
  assert.equal(decimalEquals("99000", "98999.99"), false);
  assert.equal(decimalEquals("1", "-1"), false);
});

test("decimalEquals is total: malformed input is a mismatch, never a throw", () => {
  assert.equal(decimalEquals("not-a-number", "1"), false);
  assert.equal(decimalEquals("", "1"), false);
  assert.equal(decimalEquals("1.2.3", "1.2.3"), false);
  assert.equal(decimalEquals("1", "1"), true);
});

test("multiplyDecimal computes an exact product with no binary-float rounding", () => {
  assert.equal(multiplyDecimal("100000", "1.5"), "150000");
  assert.equal(multiplyDecimal("100000.33", "1.5"), "150000.495");
  assert.equal(multiplyDecimal("0.1", "0.2"), "0.02");
});

test("multiplyDecimal accepts the exponent transport grammar (e.g. 1e3), matching isExactDecimalText", () => {
  assert.equal(multiplyDecimal("1e3", "1.5"), "1500");
  assert.equal(compareDecimal(multiplyDecimal("1e3", "1.5"), "1500"), 0);
});
