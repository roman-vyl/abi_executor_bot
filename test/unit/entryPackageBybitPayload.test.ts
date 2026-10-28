import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

for (const orderType of ["limit", null] as const) {
  test(`touch_trigger with order type ${String(orderType)} throws instead of building a request`, () => {
    assert.throws(
      () =>
        mapEntryPackageToBybit(
          makeTestConfig({ liveEntryMode: "touch_trigger", touchTriggerEntryOrderType: orderType }),
          longInput,
        ),
      /touch_trigger entry order type .* is not supported/,
    );
  });
}
