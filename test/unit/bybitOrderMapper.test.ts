import assert from "node:assert/strict";
import test from "node:test";

import { makeTestConfig } from "../fixtures/config.js";
import { buildExecutionPlan } from "../../src/domain/executionPlan.js";
import { mapExecutionPlanToBybit } from "../../src/exchange/bybitOrderMapper.js";
import type { SignalIntent } from "../../src/domain/signals.js";

test("mapExecutionPlanToBybit maps long stop-market entry to Bybit create payload", () => {
  const plan = buildExecutionPlan(makeIntent(), {
    qty: "0.001",
    reason: "test",
  });
  const mapped = mapExecutionPlanToBybit(makeTestConfig(), plan);

  assert.equal(mapped.createEntryOrder.category, "linear");
  assert.equal(mapped.createEntryOrder.symbol, "BTCUSDT");
  assert.equal(mapped.createEntryOrder.side, "Buy");
  assert.equal(mapped.createEntryOrder.orderType, "Market");
  assert.equal(mapped.createEntryOrder.triggerDirection, 1);
  assert.equal(mapped.createEntryOrder.triggerBy, "LastPrice");
  assert.equal(mapped.cancelEntryOrder.orderLinkId, mapped.createEntryOrder.orderLinkId);
  assert.equal(mapped.getEntryOrder.limit, "1");
});

function makeIntent(): SignalIntent {
  return {
    signalId: "sig-001",
    instanceId: "ema200-touch:BTCUSDT:1h",
    strategyId: "ema200-touch",
    symbol: "BTCUSDT",
    side: "long",
    entry: {
      type: "stop_market",
      triggerPrice: "100",
      triggerDirection: "rises_to",
    },
    stopLoss: {
      type: "stop_market",
      triggerPrice: "90",
    },
    takeProfit: {
      type: "take_profit_market",
      triggerPrice: "120",
    },
  };
}
