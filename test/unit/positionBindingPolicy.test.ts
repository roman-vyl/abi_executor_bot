import assert from "node:assert/strict";
import test from "node:test";

import {
  effectivePositionBindingMode,
  positionBindingGeometryForNewGeneration,
} from "../../src/domain/positionBindingPolicy.js";

test("linear follows deployment policy while spot remains one-way", () => {
  assert.equal(effectivePositionBindingMode("linear", "one_way"), "one_way");
  assert.equal(effectivePositionBindingMode("linear", "hedge"), "hedge");
  assert.equal(effectivePositionBindingMode("spot", "hedge"), "one_way");
});

test("new hedge geometry derives direction from immutable desired side", () => {
  assert.deepEqual(positionBindingGeometryForNewGeneration("linear", "long", "hedge"), {
    mode: "hedge",
    direction: "long",
  });
  assert.deepEqual(positionBindingGeometryForNewGeneration("linear", "short", "hedge"), {
    mode: "hedge",
    direction: "short",
  });
  assert.deepEqual(positionBindingGeometryForNewGeneration("spot", "short", "hedge"), { mode: "one_way" });
});
