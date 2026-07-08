import assert from "node:assert/strict";
import test from "node:test";

import type { SignalIntent } from "../../src/domain/signals.js";
import { checkSignalRisk } from "../../src/risk/riskGuard.js";
import { makeTestConfig } from "../fixtures/config.js";

test("checkSignalRisk accepts entry-only signal", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100"), makeTestConfig()), { ok: true });
});

test("checkSignalRisk accepts long with stop below entry", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100", "90"), makeTestConfig()), { ok: true });
});

test("checkSignalRisk accepts short with stop above entry", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("short", "100", "110"), makeTestConfig()), { ok: true });
});

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

test("checkSignalRisk rejects inverted long stop-only protection", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100", "110"), makeTestConfig()), {
    ok: false,
    error: "long requires stop_loss < entry",
  });
});

test("checkSignalRisk rejects inverted short stop-only protection", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("short", "100", "90"), makeTestConfig()), {
    ok: false,
    error: "short requires entry < stop_loss",
  });
});

test("checkSignalRisk rejects inverted long full protection", () => {
  assert.deepEqual(checkSignalRisk(makeIntent("long", "100", "110", "120"), makeTestConfig()), {
    ok: false,
    error: "long requires stop_loss < entry < take_profit",
  });
});

function makeIntent(
  side: "long" | "short",
  entryPrice: string,
  stopLossPrice?: string,
  takeProfitPrice?: string,
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
    ...(stopLossPrice === undefined
      ? {}
      : { stopLoss: { type: "stop_market" as const, triggerPrice: stopLossPrice } }),
    ...(takeProfitPrice === undefined
      ? {}
      : { takeProfit: { type: "take_profit_market" as const, triggerPrice: takeProfitPrice } }),
  };
}
