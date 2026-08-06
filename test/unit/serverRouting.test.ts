import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { writeJson } from "../../src/app/http.js";
import { handleAccountRoutes } from "../../src/routes/accountRoutes.js";
import { handleEntryPackageRoutes } from "../../src/routes/entryPackageRoutes.js";
import { handleOpenPositionRoutes } from "../../src/routes/openPositionRoutes.js";
import { handleSystemRoutes } from "../../src/routes/systemRoutes.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

// Regression for the removed legacy signal/intent contour: neither path is
// claimed by any surviving route handler, so both must fall through to the
// server's single generic 404 (src/app/server.ts).
for (const [method, url] of [
  ["POST", "/signals"],
  ["GET", "/intents/some-signal-id/orders/entry"],
  ["POST", "/intents/some-signal-id/cancel"],
] as const) {
  test(`${method} ${url} is unhandled and falls through to the generic 404`, async () => {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const notReadyApplicationService = { apply: () => Promise.reject(new Error("not expected")) };
    const notReadyResolutionService = { resolve: () => Promise.reject(new Error("not expected")) };

    const request = makeRequest(method, url);
    const response = makeResponse();

    const handled =
      (await handleSystemRoutes({ request, response: response.response, config, entryPackageReady: true })) ||
      (await handleAccountRoutes({ request, response: response.response, config, bybit })) ||
      (await handleEntryPackageRoutes({
        request,
        response: response.response,
        applicationService: notReadyApplicationService,
        isReady: () => true,
      })) ||
      (await handleOpenPositionRoutes({
        request,
        response: response.response,
        resolutionService: notReadyResolutionService,
        isReady: () => true,
      }));

    assert.equal(handled, false);

    writeJson(response.response, 404, { error: "not_found" });
    assert.equal(response.status(), 404);
    assert.deepEqual(response.body(), { error: "not_found" });
  });
}

function makeRequest(method: string, url: string): IncomingMessage {
  const request = Readable.from([""]) as IncomingMessage;
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
