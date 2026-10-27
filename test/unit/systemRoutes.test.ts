import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";
import { handleSystemRoutes } from "../../src/routes/systemRoutes.js";
import { makeTestConfig } from "../fixtures/config.js";

test("health is ready only when entry-package execution is ready", async () => {
  const request = makeRequest("GET", "/health");
  const response = makeResponse();

  assert.equal(
    await handleSystemRoutes({
      request,
      response: response.response,
      config: makeTestConfig(),
      entryPackageReady: false,
      exchangeFacts: { status: "disabled" },
    }),
    true,
  );

  assert.equal(response.status(), 503);
  assert.equal(response.body().ok, false);
  assert.equal(response.body().entryPackageReady, false);
});

test("health remains successful when entry-package execution is ready", async () => {
  const request = makeRequest("GET", "/health");
  const response = makeResponse();

  assert.equal(
    await handleSystemRoutes({
      request,
      response: response.response,
      config: makeTestConfig(),
      entryPackageReady: true,
      exchangeFacts: { status: "disabled" },
    }),
    true,
  );

  assert.equal(response.status(), 200);
  assert.equal(response.body().ok, true);
  assert.equal(response.body().entryPackageReady, true);
});

test("health reports the exchange facts store without changing ok or the status", async () => {
  const store = {} as ExchangeFactsStore;
  for (const [exchangeFacts, expectedReason] of [
    [{ status: "disabled" }, undefined],
    [{ status: "enabled", store }, undefined],
    [{ status: "unavailable", reason: "exchange_facts_driver_unavailable" }, "exchange_facts_driver_unavailable"],
  ] as const) {
    const response = makeResponse();
    await handleSystemRoutes({
      request: makeRequest("GET", "/health"),
      response: response.response,
      config: makeTestConfig(),
      entryPackageReady: true,
      exchangeFacts,
    });

    assert.equal(response.status(), 200);
    assert.equal(response.body().ok, true);
    assert.equal(response.body().exchangeFactsStore, exchangeFacts.status);
    assert.equal(response.body().exchangeFactsStoreReason, expectedReason);
    assert.equal("exchangeFactsStoreReason" in response.body(), expectedReason !== undefined);
  }
});

function makeRequest(method: string, url: string): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = {};
  return request;
}

function makeResponse(): {
  response: ServerResponse;
  status: () => number;
  body: () => Record<string, unknown>;
} {
  let status = 0;
  let responseBody = "";
  const response = {
    writeHead(statusCode: number): void {
      status = statusCode;
    },
    end(body: string): void {
      responseBody = body;
    },
  } as ServerResponse;

  return {
    response,
    status: () => status,
    body: () => JSON.parse(responseBody) as Record<string, unknown>,
  };
}
