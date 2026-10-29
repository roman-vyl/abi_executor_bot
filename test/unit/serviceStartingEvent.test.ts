import assert from "node:assert/strict";
import test from "node:test";

import { serviceStartingFields } from "../../src/app/serviceStartingEvent.js";
import type { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";
import { makeTestConfig } from "../fixtures/config.js";

test("serviceStartingFields excludes the raw Bybit API key and secret", () => {
  const config = makeTestConfig({
    bybitApiKey: "super-secret-key",
    bybitApiSecret: "super-secret-secret",
  });

  const fields = serviceStartingFields(config, { status: "disabled" });
  const serialized = JSON.stringify(fields);

  assert.equal(serialized.includes("super-secret-key"), false);
  assert.equal(serialized.includes("super-secret-secret"), false);
  assert.equal("bybitApiKey" in fields, false);
  assert.equal("bybitApiSecret" in fields, false);
  assert.equal(fields.bybitApiKeyConfigured, true);
});

test("serviceStartingFields reports bybitApiKeyConfigured false when no key is set", () => {
  const config = makeTestConfig({ bybitApiKey: "" });
  const fields = serviceStartingFields(config, { status: "disabled" });
  assert.equal(fields.bybitApiKeyConfigured, false);
});

test("serviceStartingFields reports the position sizing mode", () => {
  assert.equal(serviceStartingFields(makeTestConfig(), { status: "disabled" }).positionSizingMode, "minimum");
  assert.equal(serviceStartingFields(makeTestConfig({ positionSizingMode: "risk" }), { status: "disabled" }).positionSizingMode, "risk");
});

test("serviceStartingFields reports the exchange facts store", () => {
  const disabled = serviceStartingFields(makeTestConfig(), { status: "disabled" });
  assert.equal(disabled.exchangeFactsStore, "disabled");
  assert.equal("exchangeFactsSchemaVersion" in disabled, false);

  const store = {} as ExchangeFactsStore;
  const enabled = serviceStartingFields(makeTestConfig({ exchangeFactsEnabled: true }), { status: "enabled", store });
  assert.equal(enabled.exchangeFactsStore, "enabled");
  assert.equal(enabled.exchangeFactsSchemaVersion, 3);

  const unavailable = serviceStartingFields(makeTestConfig({ exchangeFactsEnabled: true }), {
    status: "unavailable",
    reason: "open_failed",
  });
  assert.equal(unavailable.exchangeFactsStore, "unavailable");
  assert.equal("exchangeFactsSchemaVersion" in unavailable, false);
});
