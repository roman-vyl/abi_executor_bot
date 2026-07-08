import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan } from "../../src/domain/executionPlan.js";
import type { SignalIntent } from "../../src/domain/signals.js";
import { mapExecutionPlanToBybit } from "../../src/exchange/bybitOrderMapper.js";
import { makeTestConfig } from "../fixtures/config.js";

test("entry-only plan maps without TP/SL fields", () => {
  const { plan, mapped } = mapIntent(makeIntent({ stopLoss: undefined, takeProfit: undefined }));

  assert.deepEqual(plan.protection, { mode: "none" });
  assert.equal("stopLossAfterFill" in plan, false);
  assert.equal("takeProfitAfterFill" in plan, false);
  assert.equal(mapped.createEntryOrder.side, "Buy");
  assert.equal(mapped.createEntryOrder.triggerDirection, 1);
  for (const field of [
    "stopLoss",
    "takeProfit",
    "slTriggerBy",
    "tpTriggerBy",
    "tpslMode",
    "slOrderType",
    "tpOrderType",
  ]) {
    assert.equal(field in mapped.createEntryOrder, false);
  }
  assert.equal(mapped.amendEntryOrder.stopLoss, "0");
  assert.equal(mapped.amendEntryOrder.takeProfit, "0");
});

test("stop-only plan maps only Full market stop loss", () => {
  const { mapped } = mapIntent(makeIntent({ takeProfit: undefined }));

  assert.equal(mapped.createEntryOrder.stopLoss, "90");
  assert.equal(mapped.createEntryOrder.slTriggerBy, "LastPrice");
  assert.equal(mapped.createEntryOrder.slOrderType, "Market");
  assert.equal(mapped.createEntryOrder.tpslMode, "Full");
  assert.equal("takeProfit" in mapped.createEntryOrder, false);
  assert.equal("tpTriggerBy" in mapped.createEntryOrder, false);
  assert.equal("tpOrderType" in mapped.createEntryOrder, false);
  assert.equal(mapped.amendEntryOrder.stopLoss, "90");
  assert.equal(mapped.amendEntryOrder.takeProfit, "0");
});

test("long plan maps Full market stop loss and take profit", () => {
  const { mapped } = mapIntent(makeIntent());

  assert.equal(mapped.createEntryOrder.category, "linear");
  assert.equal(mapped.createEntryOrder.symbol, "BTCUSDT");
  assert.equal(mapped.createEntryOrder.side, "Buy");
  assert.equal(mapped.createEntryOrder.orderType, "Market");
  assert.equal(mapped.createEntryOrder.triggerDirection, 1);
  assert.equal(mapped.createEntryOrder.triggerBy, "LastPrice");
  assert.equal(mapped.createEntryOrder.stopLoss, "90");
  assert.equal(mapped.createEntryOrder.takeProfit, "120");
  assert.equal(mapped.createEntryOrder.slTriggerBy, "LastPrice");
  assert.equal(mapped.createEntryOrder.tpTriggerBy, "LastPrice");
  assert.equal(mapped.createEntryOrder.slOrderType, "Market");
  assert.equal(mapped.createEntryOrder.tpOrderType, "Market");
  assert.equal(mapped.createEntryOrder.tpslMode, "Full");
  assert.equal(mapped.amendEntryOrder.triggerPrice, "100");
  assert.equal(mapped.amendEntryOrder.stopLoss, "90");
  assert.equal(mapped.amendEntryOrder.takeProfit, "120");
  assert.equal(mapped.amendEntryOrder.slTriggerBy, "LastPrice");
  assert.equal(mapped.amendEntryOrder.tpTriggerBy, "LastPrice");
  assert.equal(mapped.cancelEntryOrder.orderLinkId, mapped.createEntryOrder.orderLinkId);
  assert.equal(mapped.getEntryOrder.limit, "1");
});

test("short plan maps Sell side and preserves short protection prices", () => {
  const { mapped } = mapIntent(
    makeIntent({
      side: "short",
      entry: { type: "stop_market", triggerPrice: "100", triggerDirection: "falls_to" },
      stopLoss: { type: "stop_market", triggerPrice: "110" },
      takeProfit: { type: "take_profit_market", triggerPrice: "80" },
    }),
  );

  assert.equal(mapped.createEntryOrder.side, "Sell");
  assert.equal(mapped.createEntryOrder.triggerDirection, 2);
  assert.equal(mapped.createEntryOrder.stopLoss, "110");
  assert.equal(mapped.createEntryOrder.takeProfit, "80");
});

function mapIntent(intent: SignalIntent): {
  plan: ReturnType<typeof buildExecutionPlan>;
  mapped: ReturnType<typeof mapExecutionPlanToBybit>;
} {
  const config = makeTestConfig();
  const plan = buildExecutionPlan(intent, { qty: "0.001", reason: "test" }, config.bybitTriggerBy);
  return { plan, mapped: mapExecutionPlanToBybit(config, plan) };
}

function makeIntent(overrides: Partial<SignalIntent> = {}): SignalIntent {
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
    ...overrides,
  };
}
