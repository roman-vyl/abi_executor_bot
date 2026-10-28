import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";
import { disabledLinkerStatus } from "../../src/exchangeFacts/exchangeOrderLinker.js";
import { disabledStreamStatus } from "../../src/exchangeStream/exchangeStreamRecorder.js";
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
      exchangeStream: disabledStreamStatus("store_not_enabled"),
      exchangeLinker: disabledLinkerStatus("store_not_enabled"),
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
      exchangeStream: disabledStreamStatus("store_not_enabled"),
      exchangeLinker: disabledLinkerStatus("store_not_enabled"),
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
      exchangeStream: disabledStreamStatus("store_not_enabled"),
      exchangeLinker: disabledLinkerStatus("store_not_enabled"),
    });

    assert.equal(response.status(), 200);
    assert.equal(response.body().ok, true);
    assert.equal(response.body().exchangeFactsStore, exchangeFacts.status);
    assert.equal(response.body().exchangeFactsStoreReason, expectedReason);
    assert.equal("exchangeFactsStoreReason" in response.body(), expectedReason !== undefined);
  }
});

test("health reports the exchange stream without changing ok or the status", async () => {
  const response = makeResponse();
  await handleSystemRoutes({
    request: makeRequest("GET", "/health"),
    response: response.response,
    config: makeTestConfig(),
    entryPackageReady: true,
    exchangeFacts: { status: "enabled", store: {} as ExchangeFactsStore },
    exchangeStream: {
      state: "backoff",
      reconnects: 3,
      bufferedRecords: 0,
      droppedRecords: 0,
      receivedRecords: 7,
      writtenFacts: 5,
      writtenSnapshots: 1,
      duplicateRecords: 1,
      lastWriteAtMs: 1_793_105_274_202,
    },
    exchangeLinker: disabledLinkerStatus("store_not_enabled"),
  });

  assert.equal(response.status(), 200);
  assert.equal(response.body().ok, true);
  assert.deepEqual(response.body().exchangeStream, {
    state: "backoff",
    reconnects: 3,
    bufferedRecords: 0,
    droppedRecords: 0,
    receivedRecords: 7,
    writtenFacts: 5,
    writtenSnapshots: 1,
    duplicateRecords: 1,
    lastWriteAtMs: 1_793_105_274_202,
  });
});

test("health reports the exchange order linker without changing ok or the status", async () => {
  const response = makeResponse();
  const exchangeLinker = {
    state: "running" as const,
    lastTickAtMs: 1_793_105_274_202,
    linksWritten: 3,
    waitingOrders: { parent_not_found: 1 },
    notLinkableOrders: { no_label: 2 },
    lastError: "SQLITE_IOERR",
  };
  await handleSystemRoutes({
    request: makeRequest("GET", "/health"),
    response: response.response,
    config: makeTestConfig(),
    entryPackageReady: true,
    exchangeFacts: { status: "enabled", store: {} as ExchangeFactsStore },
    exchangeStream: disabledStreamStatus("no_api_key"),
    exchangeLinker,
  });

  assert.equal(response.status(), 200);
  assert.equal(response.body().ok, true);
  assert.deepEqual(response.body().exchangeLinker, exchangeLinker);
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
