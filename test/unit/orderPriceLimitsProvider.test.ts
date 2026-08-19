import assert from "node:assert/strict";
import test from "node:test";

import { BybitCurrentOrderPriceLimitsProvider } from "../../src/exchange/orderPriceLimits/provider.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

function validResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    retCode: 0,
    retMsg: "OK",
    result: {
      symbol: "BTCUSDT",
      buyLmt: "105878.10",
      sellLmt: "103781.60",
      ts: "1750302284491",
      ...overrides,
    },
    time: 1750302285376,
  };
}

test("a supported lookup returns typed success and passes exact scope to the adapter", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderPriceLimitResponse = validResponse();
  const provider = new BybitCurrentOrderPriceLimitsProvider(bybit);

  const result = await provider.getCurrent({ category: "linear", symbol: "BTCUSDT" });

  assert.deepEqual(result, {
    kind: "success",
    limits: { buyLimit: "105878.10", sellLimit: "103781.60", observedAtMs: 1750302284491 },
  });
  assert.deepEqual(bybit.getOrderPriceLimitCalls, [{ category: "linear", symbol: "BTCUSDT" }]);
});

test("every unsupported category fails closed before adapter access", async () => {
  const bybit = new FakeBybitAdapter();
  const provider = new BybitCurrentOrderPriceLimitsProvider(bybit);

  for (const category of ["spot", "inverse", "option", ""]) {
    assert.deepEqual(await provider.getCurrent({ category, symbol: "BTCUSDT" }), {
      kind: "failure",
      failure: { kind: "unsupported_category", category },
    });
  }

  assert.deepEqual(bybit.getOrderPriceLimitCalls, []);
});

test("adapter rejection becomes a typed transport failure", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderPriceLimitError = new Error("transport failed");
  const provider = new BybitCurrentOrderPriceLimitsProvider(bybit);

  assert.deepEqual(await provider.getCurrent({ category: "linear", symbol: "BTCUSDT" }), {
    kind: "failure",
    failure: { kind: "transport_failure" },
  });
  assert.equal(bybit.getOrderPriceLimitCalls.length, 1);
});

test("a decoded response failure remains a typed protocol failure", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderPriceLimitResponse = validResponse({ buyLmt: "0" });
  const provider = new BybitCurrentOrderPriceLimitsProvider(bybit);

  assert.deepEqual(await provider.getCurrent({ category: "linear", symbol: "BTCUSDT" }), {
    kind: "failure",
    failure: { kind: "protocol_failure", reason: "invalid_buy_limit" },
  });
});

test("two same-instrument requests make two fresh adapter calls", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderPriceLimitResponses = [
    validResponse(),
    validResponse({ buyLmt: "106000.25", sellLmt: "104000.75", ts: "1750302285500" }),
  ];
  const provider = new BybitCurrentOrderPriceLimitsProvider(bybit);

  const first = await provider.getCurrent({ category: "linear", symbol: "BTCUSDT" });
  const second = await provider.getCurrent({ category: "linear", symbol: "BTCUSDT" });

  assert.deepEqual(first, {
    kind: "success",
    limits: { buyLimit: "105878.10", sellLimit: "103781.60", observedAtMs: 1750302284491 },
  });
  assert.deepEqual(second, {
    kind: "success",
    limits: { buyLimit: "106000.25", sellLimit: "104000.75", observedAtMs: 1750302285500 },
  });
  assert.deepEqual(bybit.getOrderPriceLimitCalls, [
    { category: "linear", symbol: "BTCUSDT" },
    { category: "linear", symbol: "BTCUSDT" },
  ]);
});

