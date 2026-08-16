import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { internalErrorResult, terminalWithoutFillResult, unknownTradeCycleBindingResult } from "../../src/domain/entryCycleRecoveryApi.js";
import type { RecoveryStateHttpResult } from "../../src/domain/entryCycleRecoveryApi.js";
import type { EntryCycleRecoveryResolutionServicePort } from "../../src/routes/entryCycleRecoveryRoutes.js";
import { handleEntryCycleRecoveryRoutes, matchEntryCycleRecoveryRoute } from "../../src/routes/entryCycleRecoveryRoutes.js";
import { captureWrites, parseEvents } from "../fakes/captureProcessWrites.js";

const notReadyResolutionService: EntryCycleRecoveryResolutionServicePort = {
  resolve(): Promise<RecoveryStateHttpResult> {
    throw new Error("resolutionService.resolve should not be called while not ready");
  },
};

function notReady(): boolean {
  return false;
}

test("recovery-state route ignores a different method or path", async () => {
  const request = makeRequest("GET", "/health");
  const response = makeResponse();

  assert.equal(
    await handleEntryCycleRecoveryRoutes({
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
  assert.deepEqual(matchEntryCycleRecoveryRoute("PUT", route()), { matched: false });
  assert.deepEqual(matchEntryCycleRecoveryRoute("DELETE", route()), { matched: false });
});

test("recovery-state route accepts exact path and percent-decodes opaque identifiers", () => {
  assert.deepEqual(
    matchEntryCycleRecoveryRoute(
      "GET",
      "/v1/strategy-instances/instance%2Ffuture/trade-cycles/cycle%20id/recovery-state",
    ),
    {
      matched: true,
      strategyInstanceId: "instance/future",
      tradeCycleId: "cycle id",
    },
  );
});

test("empty path identifiers map to validation_failed with details", () => {
  const match = matchEntryCycleRecoveryRoute("GET", "/v1/strategy-instances//trade-cycles/cycle/recovery-state");

  assert.equal(match.matched, true);
  if (match.matched) {
    assert.deepEqual(match.details, [
      { path: "/path/strategy_instance_id", message: "path value must be a non-empty string" },
    ]);
  }
});

test("malformed path percent encoding maps to validation failure", async () => {
  const request = makeRequest("GET", "/v1/strategy-instances/%ZZ/trade-cycles/cycle/recovery-state");
  const response = makeResponse();

  assert.equal(
    await handleEntryCycleRecoveryRoutes({
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
    await handleEntryCycleRecoveryRoutes({
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
  const resolutionService: EntryCycleRecoveryResolutionServicePort = {
    async resolve(query): Promise<RecoveryStateHttpResult> {
      received = query;
      return terminalWithoutFillResult();
    },
  };

  const request = makeRequest("GET", route());
  const response = makeResponse();

  assert.equal(
    await handleEntryCycleRecoveryRoutes({
      request,
      response: response.response,
      resolutionService,
      isReady: () => true,
    }),
    true,
  );

  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), terminalWithoutFillResult().body);
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
    await handleEntryCycleRecoveryRoutes({
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

test("a resolved recovery_state emits operation_started then operation_completed, both info", async () => {
  const resolutionService: EntryCycleRecoveryResolutionServicePort = {
    async resolve(): Promise<RecoveryStateHttpResult> {
      return terminalWithoutFillResult();
    },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handleEntryCycleRecoveryRoutes({
      request: makeRequest("GET", route()),
      response: makeResponse().response,
      resolutionService,
      isReady: () => true,
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(parseEvents(stderr.lines).length, 0);
  const events = parseEvents(stdout.lines);
  assert.deepEqual(
    events.map((event) => event.event),
    ["operation_started", "operation_completed"],
  );
  assert.equal(events[0].operation, "recovery_state");
  assert.equal(events[1].level, "info");
  assert.equal(events[1].outcome, "terminal_without_fill");
});

test("a handled business-negative result (unknown_trade_cycle_binding) stays operation_completed, not failed", async () => {
  const resolutionService: EntryCycleRecoveryResolutionServicePort = {
    async resolve(): Promise<RecoveryStateHttpResult> {
      return unknownTradeCycleBindingResult();
    },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handleEntryCycleRecoveryRoutes({
      request: makeRequest("GET", route()),
      response: makeResponse().response,
      resolutionService,
      isReady: () => true,
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(parseEvents(stderr.lines).length, 0, "no error-level event for a handled business-negative outcome");
  const events = parseEvents(stdout.lines);
  const terminal = events.find((event) => event.event === "operation_completed" || event.event === "operation_failed");
  assert.equal(terminal?.event, "operation_completed");
  assert.equal(terminal?.outcome, "unknown_trade_cycle_binding");
});

test("an uncaught exception from resolve() emits operation_failed at error level and is still mapped to a safe internal_error response", async () => {
  const resolutionService: EntryCycleRecoveryResolutionServicePort = {
    async resolve(): Promise<RecoveryStateHttpResult> {
      throw new Error("unexpected boom");
    },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const response = makeResponse();
  try {
    await handleEntryCycleRecoveryRoutes({
      request: makeRequest("GET", route()),
      response: response.response,
      resolutionService,
      isReady: () => true,
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), internalErrorResult().body);

  assert.equal(parseEvents(stdout.lines).length, 1, "only operation_started goes to stdout");
  const failedEvents = parseEvents(stderr.lines);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].event, "operation_failed");
  assert.equal(failedEvents[0].level, "error");
  assert.equal(failedEvents[0].outcome, "internal_error");
});

function route(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/recovery-state";
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
