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

test("loadConfig defaults standalone host to loopback when ABI_HOST is absent", () => {
  const config = loadConfig({});

  assert.equal(config.host, "127.0.0.1");
});

test("loadConfig accepts explicit container host binding", () => {
  const config = loadConfig({
    ABI_HOST: "0.0.0.0",
  });

  assert.equal(config.host, "0.0.0.0");
});

test("loadConfig fails closed on explicit invalid boolean values", () => {
  assert.throws(
    () =>
      loadConfig({
        ABI_DRY_RUN: "maybe",
      }),
    /ABI_DRY_RUN must be a boolean value/,
  );

  assert.throws(
    () =>
      loadConfig({
        ABI_LIVE_TRADING_ENABLED: "",
      }),
    /ABI_LIVE_TRADING_ENABLED must be a boolean value/,
  );
});

test("loadConfig fails closed on explicit invalid BYBIT_ENV, port, and timeout values", () => {
  assert.throws(
    () =>
      loadConfig({
        BYBIT_ENV: "sandbox",
      }),
    /BYBIT_ENV must be one of: demo, testnet, mainnet/,
  );

  assert.throws(
    () =>
      loadConfig({
        ABI_PORT: "abc",
      }),
    /ABI_PORT must be an integer/,
  );

  assert.throws(
    () =>
      loadConfig({
        ABI_BYBIT_REQUEST_TIMEOUT_MS: "0",
      }),
    /ABI_BYBIT_REQUEST_TIMEOUT_MS must be greater than 0/,
  );
});
