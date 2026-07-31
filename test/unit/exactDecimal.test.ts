import assert from "node:assert/strict";
import test from "node:test";

import { ceilRatioToStep, ceilToStep, compareDecimal, maxDecimal, subtractDecimal } from "../../src/domain/exactDecimal.js";

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

test("maxDecimal and subtractDecimal handle bare-dot and signed forms", () => {
  assert.equal(maxDecimal(".5", "0.4"), ".5");
  assert.equal(subtractDecimal("1.", "0.25"), "0.75");
});

test("subtractDecimal still guards against a negative result", () => {
  assert.throws(() => subtractDecimal("1", "2"));
});
