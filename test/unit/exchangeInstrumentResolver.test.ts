import assert from "node:assert/strict";
import test from "node:test";

import {
  BybitExchangeInstrumentResolver,
  ExchangeInstrumentResolutionError,
} from "../../src/exchange/exchangeInstrumentResolver.js";

test("BTCUSDT.P resolves to linear perpetual with the suffix stripped", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  const identity = resolver.resolve("BTCUSDT.P");

  assert.deepEqual(identity, {
    ticker: "BTCUSDT.P",
    symbol: "BTCUSDT",
    category: "linear",
    product: "perpetual",
  });
});

test("ETHUSDT.P resolves the same way as another linear perpetual ticker", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  const identity = resolver.resolve("ETHUSDT.P");

  assert.deepEqual(identity, {
    ticker: "ETHUSDT.P",
    symbol: "ETHUSDT",
    category: "linear",
    product: "perpetual",
  });
});

test("BTCUSDT (no suffix) resolves to spot with the symbol unchanged", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  const identity = resolver.resolve("BTCUSDT");

  assert.deepEqual(identity, {
    ticker: "BTCUSDT",
    symbol: "BTCUSDT",
    category: "spot",
    product: "spot",
  });
});

test("trailing extra characters after .P are rejected, not resolved as spot", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve("BTCUSDT.PX"), ExchangeInstrumentResolutionError);
});

test("a second dot-delimited segment is rejected", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve("BTC.USDT"), ExchangeInstrumentResolutionError);
});

test("embedded whitespace is rejected", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve("BTC USDT"), ExchangeInstrumentResolutionError);
});

test("empty ticker is rejected", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve(""), ExchangeInstrumentResolutionError);
});

test("suffix alone with no symbol text is rejected", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve(".P"), ExchangeInstrumentResolutionError);
});

test("lowercase input is rejected rather than case-normalized", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  assert.throws(() => resolver.resolve("btcusdt"), ExchangeInstrumentResolutionError);
});

test("resolution is deterministic across repeated calls", () => {
  const resolver = new BybitExchangeInstrumentResolver();

  const first = resolver.resolve("BTCUSDT.P");
  const second = resolver.resolve("BTCUSDT.P");

  assert.deepEqual(first, second);
});
