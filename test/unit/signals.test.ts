import assert from "node:assert/strict";
import test from "node:test";

import { makeTestConfig } from "../fixtures/config.js";
import { parseSignalIntent } from "../../src/domain/signals.js";

test("parseSignalIntent accepts the bbb stop-market contract", () => {
  const result = parseSignalIntent(
    {
      signal_id: "sig-001",
      instance_id: "ema200-touch:BTCUSDT:1h",
      strategy_id: "ema200-touch",
      symbol: "btcusdt",
      side: "long",
      entry: {
        type: "stop_market",
        trigger_price: "61234.5",
        trigger_direction: "rises_to",
      },
      stop_loss: {
        type: "stop_market",
        trigger_price: "60880.0",
      },
      take_profit: {
        type: "take_profit_market",
        trigger_price: "62000.0",
      },
    },
    makeTestConfig(),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.intent.symbol, "BTCUSDT");
    assert.equal(result.intent.entry.triggerDirection, "rises_to");
  }
});

test("parseSignalIntent rejects unknown symbols", () => {
  const result = parseSignalIntent(
    {
      signal_id: "sig-001",
      instance_id: "ema200-touch:ETHUSDT:1h",
      strategy_id: "ema200-touch",
      symbol: "ETHUSDT",
      side: "long",
      entry: {
        type: "stop_market",
        trigger_price: "100",
        trigger_direction: "rises_to",
      },
      stop_loss: {
        type: "stop_market",
        trigger_price: "90",
      },
      take_profit: {
        type: "take_profit_market",
        trigger_price: "120",
      },
    },
    makeTestConfig(),
  );

  assert.deepEqual(result, {
    ok: false,
    error: "symbol ETHUSDT is not allowed",
  });
});
