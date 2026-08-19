import assert from "node:assert/strict";
import test from "node:test";

import { BybitInstrumentTradingRulesProvider } from "../../src/exchange/instrumentTradingRulesProvider.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

function validResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        {
          symbol: "BTCUSDT",
          lotSizeFilter: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", ...overrides },
          priceFilter: { tickSize: "0.5" },
        },
      ],
    },
  };
}

function makeProvider(bybit: FakeBybitAdapter): BybitInstrumentTradingRulesProvider {
  return new BybitInstrumentTradingRulesProvider(bybit, makeTestConfig());
}

test("a valid response is cached and a repeat call within TTL does not call Bybit again", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse();
  const provider = makeProvider(bybit);

  const first = await provider.getRules("BTCUSDT", "linear");
  const second = await provider.getRules("BTCUSDT", "linear");

  assert.deepEqual(first, { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" });
  assert.deepEqual(second, first);
  assert.equal(bybit.getInstrumentInfoCalls.length, 1);
});

test("an invalid response is not cached: getRules throws and Bybit was called", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse({ minOrderQty: "0" });
  const provider = makeProvider(bybit);

  await assert.rejects(() => provider.getRules("BTCUSDT", "linear"));
  assert.equal(bybit.getInstrumentInfoCalls.length, 1);
});

test("after a failed call, the next call for the same category:symbol calls Bybit again", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse({ minOrderQty: "0" });
  const provider = makeProvider(bybit);

  await assert.rejects(() => provider.getRules("BTCUSDT", "linear"));

  bybit.instrumentInfoResponse = validResponse();
  const rules = await provider.getRules("BTCUSDT", "linear");

  assert.deepEqual(rules, { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" });
  assert.equal(bybit.getInstrumentInfoCalls.length, 2);
});

test("two different category:symbol pairs cache independently", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse();
  const provider = makeProvider(bybit);

  await provider.getRules("BTCUSDT", "linear");

  bybit.instrumentInfoResponse = {
    retCode: 0,
    result: { category: "linear", list: [{ symbol: "ETHUSDT", lotSizeFilter: { minOrderQty: "0" } }] },
  };
  await assert.rejects(() => provider.getRules("ETHUSDT", "linear"));

  bybit.instrumentInfoResponse = validResponse();
  const cachedBtc = await provider.getRules("BTCUSDT", "linear");

  assert.deepEqual(cachedBtc, { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" });
  // BTCUSDT was cached by the first successful call, so the third call here
  // is served from cache; only the BTCUSDT and ETHUSDT lookups hit Bybit.
  assert.equal(bybit.getInstrumentInfoCalls.length, 2);
});

test("an out-of-range exponent is not cached and getRules throws rather than returning unusable rules", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse({ minOrderQty: "1e999" });
  const provider = makeProvider(bybit);

  await assert.rejects(() => provider.getRules("BTCUSDT", "linear"));

  bybit.instrumentInfoResponse = validResponse();
  const rules = await provider.getRules("BTCUSDT", "linear");
  assert.deepEqual(rules, { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" });
  assert.equal(bybit.getInstrumentInfoCalls.length, 2);
});

test("getRules for spot throws without calling Bybit or caching anything", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.instrumentInfoResponse = validResponse();
  const provider = makeProvider(bybit);

  await assert.rejects(() => provider.getRules("BTCUSDT", "spot"));
  assert.equal(bybit.getInstrumentInfoCalls.length, 0);

  const linearRules = await provider.getRules("BTCUSDT", "linear");
  assert.deepEqual(linearRules, { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5" });
});
