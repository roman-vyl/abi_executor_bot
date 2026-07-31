import assert from "node:assert/strict";
import test from "node:test";

import { mapEntryOrderSemantics } from "../../src/domain/entryOrderSemantics.js";

test("long maps to Buy with falls_to trigger", () => {
  assert.deepEqual(mapEntryOrderSemantics("long"), {
    exchangeSide: "Buy",
    triggerDirection: "falls_to",
  });
});

test("short maps to Sell with rises_to trigger", () => {
  assert.deepEqual(mapEntryOrderSemantics("short"), {
    exchangeSide: "Sell",
    triggerDirection: "rises_to",
  });
});

test("mapping has no market-price parameter and is deterministic", () => {
  assert.equal(mapEntryOrderSemantics.length, 1);

  for (const side of ["long", "short"] as const) {
    const first = mapEntryOrderSemantics(side);
    const second = mapEntryOrderSemantics(side);
    assert.deepEqual(first, second);
  }
});
