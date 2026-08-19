import assert from "node:assert/strict";
import test from "node:test";

import { decodeOrderPriceLimitsResponse } from "../../src/exchange/orderPriceLimits/decoder.js";
import type { OrderPriceLimitsProtocolFailureReason } from "../../src/exchange/orderPriceLimits/types.js";

const expectedSymbol = "BTCUSDT";

function validResponse(
  resultOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): unknown {
  return {
    retCode: 0,
    retMsg: "OK",
    result: {
      symbol: expectedSymbol,
      buyLmt: "105878.10",
      sellLmt: "103781.60",
      ts: "1750302284491",
      ...resultOverrides,
    },
    time: 1750302285376,
    ...envelopeOverrides,
  };
}

function assertProtocolFailure(response: unknown, reason: OrderPriceLimitsProtocolFailureReason): void {
  assert.deepEqual(decodeOrderPriceLimitsResponse({ response, expectedSymbol }), { ok: false, reason });
}

test("a valid response preserves exact limits and maps result.ts to observedAtMs", () => {
  const decoded = decodeOrderPriceLimitsResponse({ response: validResponse(), expectedSymbol });

  assert.deepEqual(decoded, {
    ok: true,
    limits: {
      buyLimit: "105878.10",
      sellLimit: "103781.60",
      observedAtMs: 1750302284491,
    },
  });
});

test("missing, malformed, unsafe, zero, and negative buyLmt fail closed", () => {
  for (const buyLmt of [undefined, 105878.1, "not-a-decimal", "1e999", "0", "-0.01"]) {
    assertProtocolFailure(validResponse({ buyLmt }), "invalid_buy_limit");
  }
});

test("missing, malformed, unsafe, zero, and negative sellLmt fail closed", () => {
  for (const sellLmt of [undefined, 103781.6, "1.2.3", "1e999", "0", "-0.01"]) {
    assertProtocolFailure(validResponse({ sellLmt }), "invalid_sell_limit");
  }
});

test("missing, non-string, non-canonical, non-positive, and unsafe result.ts fail closed", () => {
  for (const ts of [undefined, 1750302284491, "01", "1e3", "0", "-1", "9007199254740992"]) {
    assertProtocolFailure(validResponse({ ts }), "invalid_timestamp");
  }
});

test("malformed and rejected Bybit envelopes fail closed", () => {
  const malformed: unknown[] = [
    null,
    "not-an-object",
    {},
    { retCode: 0, retMsg: "OK", time: 1750302285376 },
    validResponse({}, { retCode: 10001 }),
    validResponse({}, { retCode: "0" }),
    validResponse({}, { retMsg: undefined }),
    validResponse({}, { time: "1750302285376" }),
    validResponse({}, { time: 0 }),
    validResponse({}, { time: Number.MAX_SAFE_INTEGER + 1 }),
    validResponse({}, { result: null }),
  ];

  for (const response of malformed) {
    assertProtocolFailure(response, "malformed_envelope");
  }
});

test("missing or mismatched result.symbol fails identity validation", () => {
  assertProtocolFailure(validResponse({ symbol: undefined }), "symbol_mismatch");
  assertProtocolFailure(validResponse({ symbol: "ETHUSDT" }), "symbol_mismatch");
});

