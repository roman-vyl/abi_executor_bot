import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config/config.js";

test("loadConfig uses demo environment when BYBIT_ENV=demo", () => {
  const config = loadConfig({
    BYBIT_ENV: "demo",
  });

  assert.equal(config.bybitEnvironment, "demo");
  assert.equal(config.bybitTestnet, false);
});

test("loadConfig keeps BYBIT_TESTNET backward compatibility", () => {
  const config = loadConfig({
    BYBIT_TESTNET: "true",
  });

  assert.equal(config.bybitEnvironment, "testnet");
  assert.equal(config.bybitTestnet, true);
});
