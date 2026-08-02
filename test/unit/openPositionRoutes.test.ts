import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { internalErrorResult, openPositionClosedResult } from "../../src/domain/openPositionApi.js";
import type { OpenPositionHttpResult } from "../../src/domain/openPositionApi.js";
import type { OpenPositionResolutionServicePort } from "../../src/routes/openPositionRoutes.js";
import { handleOpenPositionRoutes, matchOpenPositionRoute } from "../../src/routes/openPositionRoutes.js";

const notReadyResolutionService: OpenPositionResolutionServicePort = {
  resolve(): Promise<OpenPositionHttpResult> {
    throw new Error("resolutionService.resolve should not be called while not ready");
  },
};

function notReady(): boolean {
  return false;
}

test("open-position route ignores a different method or path", async () => {
  const request = makeRequest("GET", "/health");
  const response = makeResponse();

  assert.equal(
    await handleOpenPositionRoutes({
      request,
      response: response.response,
      resolutionService: notReadyResolutionService,
      isReady: notReady,
    }),
    false,
  );
  assert.equal(response.status(), 0);
});

test("non-GET method targeting the same path shape is not matched", () => {
  assert.deepEqual(matchOpenPositionRoute("PUT", route()), { matched: false });
  assert.deepEqual(matchOpenPositionRoute("POST", route()), { matched: false });
});

test("open-position route accepts exact path and percent-decodes opaque identifiers", () => {
  assert.deepEqual(
    matchOpenPositionRoute(
      "GET",
      "/v1/strategy-instances/instance%2Ffuture/trade-cycles/cycle%20id/open-position",
    ),
    {
      matched: true,
      strategyInstanceId: "instance/future",
      tradeCycleId: "cycle id",
    },
  );
});

test("empty path identifiers map to validation_failed with details", () => {
  const match = matchOpenPositionRoute("GET", "/v1/strategy-instances//trade-cycles/cycle/open-position");

  assert.equal(match.matched, true);
  if (match.matched) {
    assert.deepEqual(match.details, [
      { path: "/path/strategy_instance_id", message: "path value must be a non-empty string" },
    ]);
  }
});

test("malformed path percent encoding maps to validation failure", async () => {
  const request = makeRequest("GET", "/v1/strategy-instances/%ZZ/trade-cycles/cycle/open-position");
  const response = makeResponse();

  assert.equal(
    await handleOpenPositionRoutes({
      request,
      response: response.response,
      resolutionService: notReadyResolutionService,
      isReady: notReady,
    }),
    true,
  );
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.equal(response.body().error.details[0].path, "/path/strategy_instance_id");
});

test("not-ready readiness fails closed without calling the resolution service", async () => {
  const request = makeRequest("GET", route());
  const response = makeResponse();

  assert.equal(
    await handleOpenPositionRoutes({
      request,
      response: response.response,
      resolutionService: notReadyResolutionService,
      isReady: notReady,
    }),
    true,
  );
  assert.deepEqual(response.body(), internalErrorResult().body);
  assert.equal(response.status(), 500);
});

test("when ready, decoded identifiers are handed to the resolution service and its result is returned as-is", async () => {
  let received: { strategyInstanceId: string; tradeCycleId: string } | undefined;
  const resolutionService: OpenPositionResolutionServicePort = {
    async resolve(query): Promise<OpenPositionHttpResult> {
      received = query;
      return openPositionClosedResult();
    },
  };

  const request = makeRequest("GET", route());
  const response = makeResponse();

  assert.equal(
    await handleOpenPositionRoutes({
      request,
      response: response.response,
      resolutionService,
      isReady: () => true,
    }),
    true,
  );

  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), openPositionClosedResult().body);
  assert.deepEqual(received, { strategyInstanceId: "instance", tradeCycleId: "cycle" });
});

test("unknown HTTP-boundary failure maps to safe internal error", async () => {
  const request = makeRequest("GET", route());
  Object.defineProperty(request, "url", {
    get(): never {
      throw new Error("unexpected boundary failure");
    },
  });
  const response = makeResponse();

  assert.equal(
    await handleOpenPositionRoutes({
      request,
      response: response.response,
      resolutionService: notReadyResolutionService,
      isReady: notReady,
    }),
    true,
  );
  assert.deepEqual(response.body(), internalErrorResult().body);
  assert.equal(response.status(), 500);
});

function route(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/open-position";
}

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
  body: () => Record<string, any>;
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
    body: () => JSON.parse(responseBody) as Record<string, any>,
  };
}
