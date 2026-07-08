import assert from "node:assert/strict";
import test from "node:test";

import { parseSignalIntent } from "../../src/domain/signals.js";
import { makeTestConfig } from "../fixtures/config.js";

test("parseSignalIntent accepts entry with stop loss and take profit", () => {
  const result = parseSignalIntent(makePayload(), makeTestConfig());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.intent.symbol, "BTCUSDT");
    assert.equal(result.intent.entry.triggerDirection, "rises_to");
    assert.equal(result.intent.stopLoss?.triggerPrice, "60880.0");
    assert.equal(result.intent.takeProfit?.triggerPrice, "62000.0");
  }
});

test("parseSignalIntent accepts entry-only signal", () => {
  const payload = makePayload();
  delete payload.stop_loss;
  delete payload.take_profit;

  const result = parseSignalIntent(payload, makeTestConfig());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.intent.stopLoss, undefined);
    assert.equal(result.intent.takeProfit, undefined);
  }
});

test("parseSignalIntent accepts entry with stop loss only", () => {
  const payload = makePayload();
  delete payload.take_profit;

  const result = parseSignalIntent(payload, makeTestConfig());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.intent.stopLoss?.triggerPrice, "60880.0");
    assert.equal(result.intent.takeProfit, undefined);
  }
});

test("parseSignalIntent rejects take profit without stop loss", () => {
  const payload = makePayload();
  delete payload.stop_loss;

  assert.deepEqual(parseSignalIntent(payload, makeTestConfig()), {
    ok: false,
    error: "take_profit requires stop_loss",
  });
});

test("parseSignalIntent rejects unknown symbols", () => {
  const payload = makePayload();
  payload.instance_id = "ema200-touch:ETHUSDT:1h";
  payload.symbol = "ETHUSDT";

  assert.deepEqual(parseSignalIntent(payload, makeTestConfig()), {
    ok: false,
    error: "symbol ETHUSDT is not allowed",
  });
});

function makePayload(): Record<string, unknown> {
  return {
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
  };
}
