import assert from "node:assert/strict";
import test from "node:test";

import { buildCancelAllOrdersPayload, buildMarketCloseOrdersFromPositions } from "../../src/account/accountActions.js";
import { makeTestConfig } from "../fixtures/config.js";

test("buildCancelAllOrdersPayload targets settle coin when symbol is omitted", () => {
  assert.deepEqual(buildCancelAllOrdersPayload(makeTestConfig(), undefined), {
    category: "linear",
    settleCoin: "USDT",
  });
});

test("buildCancelAllOrdersPayload targets one symbol when symbol is provided", () => {
  assert.deepEqual(buildCancelAllOrdersPayload(makeTestConfig(), "btcusdt"), {
    category: "linear",
    symbol: "BTCUSDT",
  });
});

test("buildMarketCloseOrdersFromPositions converts open Bybit positions to reduce-only market orders", () => {
  const closeOrders = buildMarketCloseOrdersFromPositions(makeTestConfig(), {
    result: {
      list: [
        {
          symbol: "BTCUSDT",
          side: "Buy",
          size: "0.001",
          positionIdx: 1,
        },
        {
          symbol: "ETHUSDT",
          side: "Sell",
          size: "0.01",
          positionIdx: 2,
        },
        {
          symbol: "BTCUSDT",
          side: "None",
          size: "0",
        },
      ],
    },
  });

  assert.deepEqual(closeOrders, [
    {
      category: "linear",
      symbol: "BTCUSDT",
      side: "Sell",
      orderType: "Market",
      qty: "0.001",
      reduceOnly: true,
      positionIdx: 1,
    },
    {
      category: "linear",
      symbol: "ETHUSDT",
      side: "Buy",
      orderType: "Market",
      qty: "0.01",
      reduceOnly: true,
      positionIdx: 2,
    },
  ]);
});
