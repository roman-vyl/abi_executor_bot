import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("HTTP route does not encode numeric Bybit trigger direction", () => {
  const source = readFileSync(
    new URL("../../src/routes/entryPackageRoutes.ts", import.meta.url),
    "utf8",
  );

  assert.equal(/triggerDirection/.test(source), false);
  assert.equal(/rises_to|falls_to/.test(source), false);
});

test("EntryPackageApplicationService does not compare market price with entry price", () => {
  const source = readFileSync(
    new URL("../../src/services/entryPackage/entryPackageApplicationService.ts", import.meta.url),
    "utf8",
  );

  assert.equal(/getMarketPrice/.test(source), false);
});

test("Bybit adapter does not decide strategic side", () => {
  const source = readFileSync(new URL("../../src/exchange/bybitAdapter.ts", import.meta.url), "utf8");

  assert.equal(/"long"|"short"/.test(source), false);
});

test("production ExchangeSymbolResolver is not defined or implemented by this change", () => {
  assert.throws(() => {
    readFileSync(new URL("../../src/exchange/exchangeSymbolResolver.ts", import.meta.url), "utf8");
  });
});
