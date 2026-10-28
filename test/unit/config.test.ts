import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("linear position binding mode defaults one-way and accepts only the closed policy", () => {
  assert.equal(loadConfig({}).bybitLinearPositionBindingMode, "one_way");
  assert.equal(
    loadConfig({ ABI_BYBIT_LINEAR_POSITION_BINDING_MODE: "hedge" }).bybitLinearPositionBindingMode,
    "hedge",
  );
  assert.equal(
    loadConfig({ ABI_BYBIT_LINEAR_POSITION_BINDING_MODE: " ONE_WAY " }).bybitLinearPositionBindingMode,
    "one_way",
  );
  assert.throws(
    () => loadConfig({ ABI_BYBIT_LINEAR_POSITION_BINDING_MODE: "auto" }),
    /must be one of: one_way, hedge/,
  );
  assert.throws(
    () => loadConfig({ ABI_BYBIT_LINEAR_POSITION_BINDING_MODE: "" }),
    /must be one of: one_way, hedge/,
  );
});

test("position sizing mode defaults to minimum and is independent of BYBIT_ENV", () => {
  assert.equal(loadConfig({}).positionSizingMode, "minimum");
  assert.equal(loadConfig({ BYBIT_ENV: "mainnet" }).positionSizingMode, "minimum");
  assert.equal(loadConfig({ ABI_POSITION_SIZING_MODE: " Minimum " }).positionSizingMode, "minimum");
  for (const env of ["demo", "testnet", "mainnet"]) {
    const config = loadConfig({
      BYBIT_ENV: env,
      ABI_POSITION_SIZING_MODE: "risk",
      BYBIT_API_KEY: "key",
      BYBIT_API_SECRET: "secret",
    });
    assert.equal(config.positionSizingMode, "risk");
    assert.equal(config.bybitEnvironment, env);
  }
});

test("position sizing mode fails closed on an unknown value", () => {
  assert.throws(
    () => loadConfig({ ABI_POSITION_SIZING_MODE: "percent" }),
    /ABI_POSITION_SIZING_MODE must be one of: minimum, risk/,
  );
  assert.throws(() => loadConfig({ ABI_POSITION_SIZING_MODE: "" }), /ABI_POSITION_SIZING_MODE/);
});

test("risk sizing requires API credentials, also in dry-run", () => {
  for (const env of [
    { ABI_POSITION_SIZING_MODE: "risk" },
    { ABI_POSITION_SIZING_MODE: "risk", BYBIT_API_KEY: "key" },
    { ABI_POSITION_SIZING_MODE: "risk", BYBIT_API_SECRET: "secret" },
    { ABI_POSITION_SIZING_MODE: "risk", ABI_DRY_RUN: "true", BYBIT_API_KEY: " " , BYBIT_API_SECRET: "secret" },
  ]) {
    assert.throws(() => loadConfig(env), /requires BYBIT_API_KEY and BYBIT_API_SECRET/);
  }
  const dryRun = loadConfig({
    ABI_POSITION_SIZING_MODE: "risk",
    ABI_DRY_RUN: "true",
    BYBIT_API_KEY: "key",
    BYBIT_API_SECRET: "secret",
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.positionSizingMode, "risk");
});

test("loadConfig keeps the exchange facts store off by default with a per-environment path", () => {
  const config = loadConfig({ BYBIT_ENV: "demo" });
  assert.equal(config.exchangeFactsEnabled, false);
  assert.equal(config.exchangeFactsDbPath, "./var/abi_exchange_facts_demo.sqlite3");
  assert.equal(loadConfig({ BYBIT_ENV: "mainnet" }).exchangeFactsDbPath, "./var/abi_exchange_facts_mainnet.sqlite3");
});

test("loadConfig reads ABI_EXCHANGE_FACTS_ENABLED and ABI_EXCHANGE_FACTS_DB_PATH", () => {
  const config = loadConfig({
    BYBIT_ENV: "demo",
    ABI_EXCHANGE_FACTS_ENABLED: "true",
    ABI_EXCHANGE_FACTS_DB_PATH: "/app/var/facts.sqlite3",
  });
  assert.equal(config.exchangeFactsEnabled, true);
  assert.equal(config.exchangeFactsDbPath, "/app/var/facts.sqlite3");
});

test("loadConfig rejects ABI_EXCHANGE_FACTS_ENABLED other than true or false", () => {
  for (const value of ["yes", "1", ""]) {
    assert.throws(
      () => loadConfig({ ABI_EXCHANGE_FACTS_ENABLED: value }),
      /ABI_EXCHANGE_FACTS_ENABLED must be true or false/,
    );
  }
});

function withConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "abi-config-"));
  const path = join(dir, "abi.json");
  writeFileSync(path, content, "utf8");
  return path;
}

test("live entry config defaults to ema_anchor without ABI_CONFIG_PATH", () => {
  const config = loadConfig({});

  assert.equal(config.liveEntryMode, "ema_anchor");
  assert.equal(config.touchTriggerEntryOrderType, null);
});

test("live entry config defaults to ema_anchor when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "abi-config-"));
  const config = loadConfig({ ABI_CONFIG_PATH: join(dir, "absent.json") });

  assert.equal(config.liveEntryMode, "ema_anchor");
  assert.equal(config.touchTriggerEntryOrderType, null);
});

test("live entry config accepts an empty object as defaults", () => {
  const config = loadConfig({ ABI_CONFIG_PATH: withConfigFile("{}") });

  assert.equal(config.liveEntryMode, "ema_anchor");
  assert.equal(config.touchTriggerEntryOrderType, null);
});

for (const orderType of ["market", "limit"] as const) {
  test(`live entry config reads touch_trigger with ${orderType}`, () => {
    const config = loadConfig({
      ABI_CONFIG_PATH: withConfigFile(
        JSON.stringify({ live_entry_mode: "touch_trigger", touch_trigger_entry_order_type: orderType }),
      ),
    });

    assert.equal(config.liveEntryMode, "touch_trigger");
    assert.equal(config.touchTriggerEntryOrderType, orderType);
  });
}

test("live entry config accepts ema_anchor with or without a valid order type", () => {
  const without = loadConfig({ ABI_CONFIG_PATH: withConfigFile('{"live_entry_mode": "ema_anchor"}') });
  assert.equal(without.liveEntryMode, "ema_anchor");
  assert.equal(without.touchTriggerEntryOrderType, null);

  const withType = loadConfig({
    ABI_CONFIG_PATH: withConfigFile('{"live_entry_mode": "ema_anchor", "touch_trigger_entry_order_type": "limit"}'),
  });
  assert.equal(withType.liveEntryMode, "ema_anchor");
  assert.equal(withType.touchTriggerEntryOrderType, "limit");
});

for (const [label, content, message] of [
  ["touch_trigger without an order type", '{"live_entry_mode": "touch_trigger"}', /touch_trigger_entry_order_type is required/],
  ["an array root", "[]", /must contain a JSON object/],
  ["a null root", "null", /must contain a JSON object/],
  ["a string root", '"touch_trigger"', /must contain a JSON object/],
  ["invalid JSON", '{"live_entry_mode": ', /is not valid JSON/],
  ["an unknown key", '{"live_entry_mode": "ema_anchor", "order_lifetime_bars": 3}', /unknown keys: order_lifetime_bars/],
  ["an unknown mode", '{"live_entry_mode": "close"}', /live_entry_mode must be one of: ema_anchor, touch_trigger/],
  ["a non-string mode", '{"live_entry_mode": 1}', /live_entry_mode must be one of/],
  [
    "an unknown order type",
    '{"live_entry_mode": "touch_trigger", "touch_trigger_entry_order_type": "stop_market"}',
    /touch_trigger_entry_order_type must be one of: market, limit/,
  ],
  [
    "an invalid order type in ema_anchor",
    '{"live_entry_mode": "ema_anchor", "touch_trigger_entry_order_type": "Market"}',
    /touch_trigger_entry_order_type must be one of: market, limit/,
  ],
] as const) {
  test(`live entry config refuses to start with ${label}`, () => {
    assert.throws(() => loadConfig({ ABI_CONFIG_PATH: withConfigFile(content) }), message);
  });
}

test("live entry config refuses to start when the path cannot be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "abi-config-"));

  assert.throws(() => loadConfig({ ABI_CONFIG_PATH: dir }), /cannot be read/);
});
