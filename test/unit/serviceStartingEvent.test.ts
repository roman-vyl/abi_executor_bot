import assert from "node:assert/strict";
import test from "node:test";

import { serviceStartingFields } from "../../src/app/serviceStartingEvent.js";
import { makeTestConfig } from "../fixtures/config.js";

test("serviceStartingFields excludes the raw Bybit API key and secret", () => {
  const config = makeTestConfig({
    bybitApiKey: "super-secret-key",
    bybitApiSecret: "super-secret-secret",
  });

  const fields = serviceStartingFields(config);
  const serialized = JSON.stringify(fields);

  assert.equal(serialized.includes("super-secret-key"), false);
  assert.equal(serialized.includes("super-secret-secret"), false);
  assert.equal("bybitApiKey" in fields, false);
  assert.equal("bybitApiSecret" in fields, false);
  assert.equal(fields.bybitApiKeyConfigured, true);
});

test("serviceStartingFields reports bybitApiKeyConfigured false when no key is set", () => {
  const config = makeTestConfig({ bybitApiKey: "" });
  const fields = serviceStartingFields(config);
  assert.equal(fields.bybitApiKeyConfigured, false);
});
