import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const moduleDirectory = new URL("../../src/exchange/orderPriceLimits/", import.meta.url);

test("orderPriceLimits stays independent from business and protection modules", () => {
  const sources = readdirSync(moduleDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, moduleDirectory), "utf8"));

  const imports = sources.flatMap((source) => source.match(/^import .*;$/gm) ?? []);
  for (const forbiddenPath of [
    "/services/",
    "/risk/",
    "/correlation/",
    "/routes/",
    "/app/",
    "/execution/",
  ]) {
    assert.equal(imports.some((line) => line.includes(forbiddenPath)), false, forbiddenPath);
  }

  const combinedSource = sources.join("\n");
  for (const forbiddenSemantic of [
    "InstrumentTradingRules",
    "stopLoss",
    "takeProfit",
    "surrogate",
    "clamp",
    "strategyId",
    "positionSide",
  ]) {
    assert.equal(combinedSource.includes(forbiddenSemantic), false, forbiddenSemantic);
  }

  assert.equal(combinedSource.includes("new Map"), false, "cache map");
  assert.equal(combinedSource.includes("setTimeout"), false, "retry timer");
});
