import assert from "node:assert/strict";
import test from "node:test";

import { mapEntryPackageToBybit } from "../../src/exchange/bybitOrderMapper.js";
import { makeTestConfig } from "../fixtures/config.js";

test("long package produces Buy side, falls_to trigger, and always includes take profit", () => {
  const config = makeTestConfig();
  const payloads = mapEntryPackageToBybit(config, {
    symbol: "BTCUSDT",
    category: "linear",
    side: "long",
    plannedEntryPrice: "100000",
    initialStopPrice: "99000",
    initialTakePrice: "103000",
    qty: "0.001",
    orderLinkId: "abi-ep-0000000000000000abcd",
  });

  assert.equal(payloads.createEntryOrder.side, "Buy");
  assert.equal(payloads.createEntryOrder.triggerDirection, 2);
  assert.equal(payloads.createEntryOrder.tpslMode, "Full");
  assert.equal(payloads.createEntryOrder.qty, "0.001");
  assert.equal(payloads.createEntryOrder.stopLoss, "99000");
  assert.equal(payloads.createEntryOrder.takeProfit, "103000");
  assert.equal(payloads.cancelEntryOrder.orderLinkId, "abi-ep-0000000000000000abcd");
  assert.equal(payloads.getEntryOrder.limit, "1");
  assert.equal(payloads.getEntryOrderHistory.limit, "1");
});

test("short package produces Sell side and rises_to trigger", () => {
  const config = makeTestConfig();
  const payloads = mapEntryPackageToBybit(config, {
    symbol: "BTCUSDT",
    category: "linear",
    side: "short",
    plannedEntryPrice: "100000",
    initialStopPrice: "101000",
    initialTakePrice: "97000",
    qty: "0.001",
    orderLinkId: "abi-ep-0000000000000000abcd",
  });

  assert.equal(payloads.createEntryOrder.side, "Sell");
  assert.equal(payloads.createEntryOrder.triggerDirection, 1);
  assert.equal(payloads.createEntryOrder.takeProfit, "97000");
});

test("category comes from the input identity, not global config, across all four payloads", () => {
  const config = makeTestConfig({ bybitCategory: "linear" });
  const payloads = mapEntryPackageToBybit(config, {
    symbol: "BTCUSDT",
    category: "spot",
    side: "long",
    plannedEntryPrice: "100000",
    initialStopPrice: "99000",
    initialTakePrice: "103000",
    qty: "0.001",
    orderLinkId: "abi-ep-0000000000000000abcd",
  });

  assert.equal(payloads.createEntryOrder.category, "spot");
  assert.equal(payloads.cancelEntryOrder.category, "spot");
  assert.equal(payloads.getEntryOrder.category, "spot");
  assert.equal(payloads.getEntryOrderHistory.category, "spot");
});
