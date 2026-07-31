import assert from "node:assert/strict";
import test from "node:test";

import { buildEntryPackageOrderLinkId } from "../../src/domain/entryPackageOrderIdentity.js";

test("distinct trade cycles of the same strategy instance produce distinct identities", () => {
  const first = buildEntryPackageOrderLinkId("instance-1", "cycle-1", "entry", 1);
  const second = buildEntryPackageOrderLinkId("instance-1", "cycle-2", "entry", 1);

  assert.notEqual(first, second);
});

test("identical inputs are deterministic and stay under Bybit's 36-character limit", () => {
  const first = buildEntryPackageOrderLinkId("instance-1", "cycle-1", "entry", 1);
  const second = buildEntryPackageOrderLinkId("instance-1", "cycle-1", "entry", 1);

  assert.equal(first, second);
  assert.ok(first.length <= 36, `orderLinkId too long: ${first.length}`);
});

test("identity depends only on the four hash inputs, changing whenever generation changes", () => {
  const generation1 = buildEntryPackageOrderLinkId("instance-1", "cycle-1", "entry", 1);
  const generation2 = buildEntryPackageOrderLinkId("instance-1", "cycle-1", "entry", 2);

  assert.notEqual(generation1, generation2);

  // The function signature accepts no other input (e.g. price, qty, side),
  // so retries of the same (instance, cycle, role, generation) are always
  // identical regardless of any other request content.
  assert.equal(buildEntryPackageOrderLinkId.length, 4);
});
