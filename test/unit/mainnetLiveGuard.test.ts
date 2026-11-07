import assert from "node:assert/strict";
import test from "node:test";
import { getLiveExecutionMode } from "../../src/execution/liveGuard.js";
import { makeTestConfig } from "../fixtures/config.js";

test("all environments require authorization and both explicit live settings", () => {
  for (const bybitEnvironment of ["demo", "testnet", "mainnet"] as const) {
    for (const authorized of [false, true]) for (const dryRun of [false, true]) for (const liveTradingEnabled of [false, true]) {
      const result = getLiveExecutionMode(makeTestConfig({ bybitEnvironment, dryRun, liveTradingEnabled }), authorized);
      assert.equal(result.canExecuteLive, authorized && !dryRun && liveTradingEnabled);
    }
  }
});
