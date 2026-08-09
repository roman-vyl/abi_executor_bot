import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

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
    }),
    true,
  );

  assert.equal(response.status(), 200);
  assert.equal(response.body().ok, true);
  assert.equal(response.body().entryPackageReady, true);
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
