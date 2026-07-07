import assert from "node:assert/strict";
import test from "node:test";

import { makeTestConfig } from "../fixtures/config.js";
import { checkSignalRisk } from "../../src/risk/riskGuard.js";
import type { SignalIntent } from "../../src/domain/signals.js";

test("checkSignalRisk accepts long with stop below entry and take above entry", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100", "90", "120"), makeTestConfig()), {
    ok: true,
  });
});

test("checkSignalRisk accepts short with take below entry and stop above entry", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("short", "100", "110", "80"), makeTestConfig()), {
    ok: true,
  });
});

test("checkSignalRisk rejects inverted long protection", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100", "110", "120"), makeTestConfig()), {
    ok: false,
    error: "long requires stop_loss < entry < take_profit",
  });
});

function makeIntent(
  side: "long" | "short",
  entryPrice: string,
  stopLossPrice: string,
  takeProfitPrice: string,
): SignalIntent {
  return {
    signalId: "sig-001",
    instanceId: "ema200-touch:BTCUSDT:1h",
    strategyId: "ema200-touch",
    symbol: "BTCUSDT",
    side,
    entry: {
      type: "stop_market",
      triggerPrice: entryPrice,
      triggerDirection: "rises_to",
    },
    stopLoss: {
      type: "stop_market",
      triggerPrice: stopLossPrice,
    },
    takeProfit: {
      type: "take_profit_market",
      triggerPrice: takeProfitPrice,
    },
  };
}
