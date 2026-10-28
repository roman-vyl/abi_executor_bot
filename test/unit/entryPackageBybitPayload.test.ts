import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  alignEntryLimitPrice,
  mapEntryPackageQueryPayloads,
  mapEntryPackageToBybit,
} from "../../src/exchange/bybitOrderMapper.js";
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
  assert.equal(payloads.createEntryOrder.tpslMode, "Partial");
  assert.equal(payloads.createEntryOrder.tpOrderType, "Market");
  assert.equal(payloads.createEntryOrder.slOrderType, "Market");
  assert.equal(payloads.createEntryOrder.qty, "0.001");
  assert.equal(payloads.createEntryOrder.stopLoss, "99000");
  assert.equal(payloads.createEntryOrder.takeProfit, "103000");
  assert.equal("positionIdx" in payloads.createEntryOrder, false);
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
  assert.equal(payloads.createEntryOrder.tpslMode, "Partial");
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

test("canonical production mapper contains no Full mode, alternate Partial builder, or owner-count switch", () => {
  const source = readFileSync(new URL("../../src/exchange/bybitOrderMapper.ts", import.meta.url), "utf8");

  assert.equal(source.includes('tpslMode: "Full"'), false);
  assert.equal(source.includes("buildPartialProtectionEntryOrderPayload"), false);
  assert.equal(/ownerCount|activeRecords\.length/.test(source), false);
});

const TRIGGER_KEYS = ["triggerPrice", "triggerDirection", "triggerBy"] as const;

function mapBoth(input: Parameters<typeof mapEntryPackageToBybit>[1]) {
  return {
    anchor: mapEntryPackageToBybit(makeTestConfig(), input),
    market: mapEntryPackageToBybit(
      makeTestConfig({ liveEntryMode: "touch_trigger", touchTriggerEntryOrderType: "market" }),
      input,
    ),
  };
}

const longInput = {
  symbol: "BTCUSDT",
  category: "linear" as const,
  side: "long" as const,
  plannedEntryPrice: "100000",
  initialStopPrice: "99000",
  initialTakePrice: "103000",
  qty: "0.001",
  orderLinkId: "abi-ep-0000000000000000abcd",
};

test("ema_anchor create payload is the exact conditional Market request", () => {
  const { anchor } = mapBoth(longInput);

  assert.equal(
    JSON.stringify(anchor.createEntryOrder),
    JSON.stringify({
      category: "linear",
      symbol: "BTCUSDT",
      side: "Buy",
      orderType: "Market",
      qty: "0.001",
      triggerPrice: "100000",
      triggerDirection: 2,
      triggerBy: "LastPrice",
      orderLinkId: "abi-ep-0000000000000000abcd",
      tpslMode: "Partial",
      stopLoss: "99000",
      slTriggerBy: "LastPrice",
      slOrderType: "Market",
      takeProfit: "103000",
      tpTriggerBy: "LastPrice",
      tpOrderType: "Market",
    }),
  );
});

for (const [label, input] of [
  ["long one-way", longInput],
  [
    "short one-way",
    { ...longInput, side: "short" as const, initialStopPrice: "101000", initialTakePrice: "97000" },
  ],
  ["long hedge", { ...longInput, binding: { mode: "hedge" as const, direction: "long" as const } }],
  [
    "short hedge",
    {
      ...longInput,
      side: "short" as const,
      initialStopPrice: "101000",
      initialTakePrice: "97000",
      binding: { mode: "hedge" as const, direction: "short" as const },
    },
  ],
] as const) {
  test(`touch_trigger market create payload drops only the trigger fields (${label})`, () => {
    const { anchor, market } = mapBoth(input);

    for (const key of TRIGGER_KEYS) {
      assert.equal(key in market.createEntryOrder, false, key);
      assert.equal(key in anchor.createEntryOrder, true, key);
    }
    const expected: Record<string, unknown> = { ...anchor.createEntryOrder };
    for (const key of TRIGGER_KEYS) {
      delete expected[key];
    }
    assert.deepEqual(market.createEntryOrder, expected);
    assert.equal(market.createEntryOrder.orderType, "Market");
    assert.deepEqual(market.cancelEntryOrder, anchor.cancelEntryOrder);
    assert.deepEqual(market.getEntryOrder, anchor.getEntryOrder);
    assert.deepEqual(market.getEntryOrderHistory, anchor.getEntryOrderHistory);
  });
}

test("touch_trigger with no order type throws instead of building a request", () => {
  assert.throws(
    () =>
      mapEntryPackageToBybit(
        makeTestConfig({ liveEntryMode: "touch_trigger", touchTriggerEntryOrderType: null }),
        longInput,
      ),
    /touch_trigger entry order type null is not supported/,
  );
});

const LIMIT_CONFIG = { liveEntryMode: "touch_trigger" as const, touchTriggerEntryOrderType: "limit" as const };

test("touch_trigger limit create payload is the exact GTC Limit request", () => {
  const payloads = mapEntryPackageToBybit(makeTestConfig(LIMIT_CONFIG), { ...longInput, entryLimitPrice: "100000.5" });

  assert.equal(
    JSON.stringify(payloads.createEntryOrder),
    JSON.stringify({
      category: "linear",
      symbol: "BTCUSDT",
      side: "Buy",
      orderType: "Limit",
      qty: "0.001",
      price: "100000.5",
      timeInForce: "GTC",
      orderLinkId: "abi-ep-0000000000000000abcd",
      tpslMode: "Partial",
      stopLoss: "99000",
      slTriggerBy: "LastPrice",
      slOrderType: "Market",
      takeProfit: "103000",
      tpTriggerBy: "LastPrice",
      tpOrderType: "Market",
    }),
  );
});

test("touch_trigger limit payload differs from market only in orderType, price and timeInForce", () => {
  const hedgeShort = {
    ...longInput,
    side: "short" as const,
    initialStopPrice: "101000",
    initialTakePrice: "97000",
    binding: { mode: "hedge" as const, direction: "short" as const },
  };
  for (const input of [longInput, hedgeShort]) {
    const { market } = mapBoth(input);
    const limit = mapEntryPackageToBybit(makeTestConfig(LIMIT_CONFIG), { ...input, entryLimitPrice: "100000" });

    assert.deepEqual(
      { ...limit.createEntryOrder, orderType: "Market", price: undefined, timeInForce: undefined },
      { ...market.createEntryOrder, price: undefined, timeInForce: undefined },
    );
    assert.deepEqual(limit.cancelEntryOrder, market.cancelEntryOrder);
    assert.deepEqual(limit.getEntryOrder, market.getEntryOrder);
    assert.deepEqual(limit.getEntryOrderHistory, market.getEntryOrderHistory);
  }
});

test("touch_trigger limit without an aligned price throws instead of building a request", () => {
  assert.throws(
    () => mapEntryPackageToBybit(makeTestConfig(LIMIT_CONFIG), longInput),
    /requires an aligned entry limit price/,
  );
});

test("an entryLimitPrice is ignored outside touch_trigger limit", () => {
  const withPrice = { ...longInput, entryLimitPrice: "1" };
  const { anchor, market } = mapBoth(longInput);
  assert.deepEqual(mapEntryPackageToBybit(makeTestConfig(), withPrice), anchor);
  assert.deepEqual(
    mapEntryPackageToBybit(
      makeTestConfig({ liveEntryMode: "touch_trigger", touchTriggerEntryOrderType: "market" }),
      withPrice,
    ),
    market,
  );
});

test("query payload helper returns the same cancel/query payloads as the full mapper", () => {
  const { anchor } = mapBoth(longInput);
  const { createEntryOrder: _create, ...queries } = anchor;
  assert.deepEqual(
    mapEntryPackageQueryPayloads({ symbol: "BTCUSDT", category: "linear", orderLinkId: "abi-ep-0000000000000000abcd" }),
    queries,
  );
});

for (const [label, price, tick, side, expected] of [
  ["on-grid long unchanged", "100000.5", "0.5", "long", "100000.5"],
  ["on-grid short unchanged", "100000.5", "0.5", "short", "100000.5"],
  ["off-grid long rounds up", "100000.26", "0.5", "long", "100000.5"],
  ["off-grid short rounds down", "100000.74", "0.5", "short", "100000.5"],
  ["small tick long", "1.31712345", "0.0001", "long", "1.3172"],
  ["small tick short", "1.31717", "0.0001", "short", "1.3171"],
  ["long engine precision", "63619.700087721256", "0.1", "long", "63619.8"],
  ["short engine precision", "63619.700087721256", "0.1", "short", "63619.7"],
] as const) {
  test(`alignEntryLimitPrice: ${label}`, () => {
    assert.equal(alignEntryLimitPrice(price, tick, side), expected);
  });
}
