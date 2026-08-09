import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  CloseCommand,
  PositionManagementHttpResult,
  ProtectionCommand,
} from "../../src/domain/positionManagementApi.js";
import { internalErrorResult } from "../../src/domain/positionManagementApi.js";
import type {
  CloseApplicationServicePort,
  ProtectionApplicationServicePort,
} from "../../src/routes/positionManagementRoutes.js";
import {
  handlePositionManagementRoutes,
  matchCloseRoute,
  matchProtectionRoute,
} from "../../src/routes/positionManagementRoutes.js";
import { captureWrites, parseEvents } from "../fakes/captureProcessWrites.js";

// A route-level test never needs a real ProtectionApplicationService — only
// something that satisfies the narrow port. Throws if called from a test
// that expects the route to fail before ever dispatching to it.
class FakeProtectionApplicationService implements ProtectionApplicationServicePort {
  readonly calls: ProtectionCommand[] = [];
  result: PositionManagementHttpResult = internalErrorResult();
  private readonly shouldBeCalled: boolean;

  constructor(shouldBeCalled = true) {
    this.shouldBeCalled = shouldBeCalled;
  }

  async apply(command: ProtectionCommand): Promise<PositionManagementHttpResult> {
    if (!this.shouldBeCalled) {
      throw new Error("protectionApplicationService.apply must not be called for this test");
    }
    this.calls.push(command);
    return this.result;
  }
}

// Same shape as FakeProtectionApplicationService, for the close port.
class FakeCloseApplicationService implements CloseApplicationServicePort {
  readonly calls: CloseCommand[] = [];
  result: PositionManagementHttpResult = internalErrorResult();
  private readonly shouldBeCalled: boolean;

  constructor(shouldBeCalled = true) {
    this.shouldBeCalled = shouldBeCalled;
  }

  async apply(command: CloseCommand): Promise<PositionManagementHttpResult> {
    if (!this.shouldBeCalled) {
      throw new Error("closeApplicationService.apply must not be called for this test");
    }
    this.calls.push(command);
    return this.result;
  }
}

function routeDeps(overrides: {
  protectionApplicationService?: ProtectionApplicationServicePort;
  closeApplicationService?: CloseApplicationServicePort;
  isReady?: () => boolean;
} = {}): {
  protectionApplicationService: ProtectionApplicationServicePort;
  closeApplicationService: CloseApplicationServicePort;
  isReady: () => boolean;
} {
  return {
    protectionApplicationService: overrides.protectionApplicationService ?? new FakeProtectionApplicationService(false),
    closeApplicationService: overrides.closeApplicationService ?? new FakeCloseApplicationService(false),
    isReady: overrides.isReady ?? (() => true),
  };
}

test("position-management routes ignore a different method or path", async () => {
  const request = makeRequest("GET", "/health", "", {});
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), false);
  assert.equal(response.status(), 0);
});

test("non-PUT method targeting the protection path shape is not matched", () => {
  assert.deepEqual(matchProtectionRoute("GET", protectionRoute()), { matched: false });
  assert.deepEqual(matchProtectionRoute("DELETE", protectionRoute()), { matched: false });
});

test("non-DELETE method targeting the open-position path shape is not matched", () => {
  assert.deepEqual(matchCloseRoute("PUT", closeRoute()), { matched: false });
  assert.deepEqual(matchCloseRoute("GET", closeRoute()), { matched: false });
});

test("protection route accepts exact path and percent-decodes opaque identifiers", () => {
  assert.deepEqual(
    matchProtectionRoute(
      "PUT",
      "/v1/strategy-instances/instance%2Ffuture/trade-cycles/cycle%20id/protection",
    ),
    { matched: true, strategyInstanceId: "instance/future", tradeCycleId: "cycle id" },
  );
});

test("close route accepts exact path and percent-decodes opaque identifiers", () => {
  assert.deepEqual(
    matchCloseRoute(
      "DELETE",
      "/v1/strategy-instances/instance%2Ffuture/trade-cycles/cycle%20id/open-position",
    ),
    { matched: true, strategyInstanceId: "instance/future", tradeCycleId: "cycle id" },
  );
});

test("close route rejects an empty path identifier", () => {
  const match = matchCloseRoute("DELETE", "/v1/strategy-instances//trade-cycles/cycle/open-position");

  assert.equal(match.matched, true);
  if (match.matched) {
    assert.deepEqual(match.details, [
      { path: "/path/strategy_instance_id", message: "path value must be a non-empty string" },
    ]);
  }
});

test("protection route rejects an empty path identifier the same way close does", () => {
  const match = matchProtectionRoute("PUT", "/v1/strategy-instances//trade-cycles/cycle/protection");

  assert.equal(match.matched, true);
  if (match.matched) {
    assert.deepEqual(match.details, [
      { path: "/path/strategy_instance_id", message: "path value must be a non-empty string" },
    ]);
  }
});

test("unsupported media type on protection maps to 415", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "text/plain",
  });
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
  assert.equal(response.status(), 415);
  assert.equal(response.body().error.code, "unsupported_media_type");
});

test("missing and malformed JSON on protection map to 400", async () => {
  for (const body of ["", "{"]) {
    const request = makeRequest("PUT", protectionRoute(), body, { "content-type": "application/json" });
    const response = makeResponse();

    assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
    assert.equal(response.status(), 400);
    assert.equal(response.body().error.code, "malformed_json");
  }
});

test("invalid protection body maps to 422 with field details", async () => {
  const request = makeRequest(
    "PUT",
    protectionRoute(),
    JSON.stringify({ stop_price: "not-a-number", take_price: null }),
    { "content-type": "application/json" },
  );
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.equal(response.body().error.details[0].path, "/stop_price");
});

test("malformed protection path percent encoding maps to validation failure", async () => {
  const request = makeRequest(
    "PUT",
    "/v1/strategy-instances/%ZZ/trade-cycles/cycle/protection",
    JSON.stringify(validProtectionBody()),
    { "content-type": "application/json" },
  );
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.equal(response.body().error.details[0].path, "/path/strategy_instance_id");
});

test("a transport-valid protection request is dispatched to the application service once ready", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  const response = makeResponse();
  const service = new FakeProtectionApplicationService();
  service.result = {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "protection_applied",
      stop_price: "99000",
      take_price: "103000",
    },
  };

  assert.equal(
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ protectionApplicationService: service }),
    }),
    true,
  );
  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), service.result.body);
  assert.deepEqual(service.calls, [
    { strategyInstanceId: "instance", tradeCycleId: "cycle", stopPrice: "99000", takePrice: "103000" },
  ]);
});

test("a transport-valid protection request fails safe without dispatching when not ready", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  const response = makeResponse();

  assert.equal(
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ isReady: () => false }),
    }),
    true,
  );
  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), internalErrorResult().body);
});

test("a transport-valid close request is dispatched to the application service once ready", async () => {
  const request = makeRequest("DELETE", closeRoute(), "", {});
  const response = makeResponse();
  const service = new FakeCloseApplicationService();
  service.result = {
    statusCode: 200,
    body: { strategy_instance_id: "instance", trade_cycle_id: "cycle", status: "trade_cycle_closed" },
  };

  assert.equal(
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ closeApplicationService: service }),
    }),
    true,
  );
  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), service.result.body);
  assert.deepEqual(service.calls, [{ strategyInstanceId: "instance", tradeCycleId: "cycle" }]);
});

test("a transport-valid close request fails safe without dispatching when not ready", async () => {
  const request = makeRequest("DELETE", closeRoute(), "", {});
  const response = makeResponse();

  assert.equal(
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ isReady: () => false }),
    }),
    true,
  );
  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), internalErrorResult().body);
});

test("close rejects any non-empty body without acting on its content", async () => {
  for (const body of ['{"quantity":"1"}', '{"percentage":"50"}', '{"close_fraction":"0.5"}', " "]) {
    const request = makeRequest("DELETE", closeRoute(), body, {});
    const response = makeResponse();

    assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
    assert.equal(response.status(), 422);
    assert.equal(response.body().error.code, "validation_failed");
    assert.deepEqual(response.body().error.details, [{ path: "/", message: "request body must be empty" }]);
  }
});

test("malformed close path percent encoding maps to validation failure", async () => {
  const request = makeRequest("DELETE", "/v1/strategy-instances/%ZZ/trade-cycles/cycle/open-position", "", {});
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.equal(response.body().error.details[0].path, "/path/strategy_instance_id");
});

test("unknown HTTP-boundary failure maps to safe internal error", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  Object.defineProperty(request, "url", {
    get(): never {
      throw new Error("unexpected boundary failure");
    },
  });
  const response = makeResponse();

  assert.equal(await handlePositionManagementRoutes({ request, response: response.response, ...routeDeps() }), true);
  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), internalErrorResult().body);
});

test("a successful protection apply() emits operation_started then operation_completed, both info, with identifiers", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  const response = makeResponse();
  const service = new FakeProtectionApplicationService();
  service.result = {
    statusCode: 200,
    body: {
      strategy_instance_id: "instance",
      trade_cycle_id: "cycle",
      status: "protection_applied",
      stop_price: "99000",
      take_price: "103000",
    },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ protectionApplicationService: service }),
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
  assert.equal(events[0].operation, "protection");
  assert.equal(events[0].strategy_instance_id, "instance");
  assert.equal(events[0].trade_cycle_id, "cycle");
  assert.equal(events[1].level, "info");
  assert.equal(events[1].outcome, "protection_applied");
});

test("a handled business-negative protection result (position_not_open) stays operation_completed, not failed", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  const response = makeResponse();
  const service = new FakeProtectionApplicationService();
  service.result = {
    statusCode: 422,
    body: { error: { code: "position_not_open", message: "no live position exists for the requested pair" } },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ protectionApplicationService: service }),
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(parseEvents(stderr.lines).length, 0, "no error-level event for a handled business-negative outcome");
  const terminal = parseEvents(stdout.lines).find(
    (event) => event.event === "operation_completed" || event.event === "operation_failed",
  );
  assert.equal(terminal?.event, "operation_completed");
  assert.equal(terminal?.outcome, "position_not_open");
});

test("a typed, normally-returned internal_error protection result emits operation_failed at error level", async () => {
  const request = makeRequest("PUT", protectionRoute(), JSON.stringify(validProtectionBody()), {
    "content-type": "application/json",
  });
  const response = makeResponse();
  const service = new FakeProtectionApplicationService();
  service.result = internalErrorResult();

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ protectionApplicationService: service }),
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(parseEvents(stdout.lines).length, 1, "only operation_started goes to stdout");
  const failedEvents = parseEvents(stderr.lines);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].event, "operation_failed");
  assert.equal(failedEvents[0].level, "error");
  assert.equal(failedEvents[0].outcome, "internal_error");
});

test("a successful close apply() emits operation_started then operation_completed with outcome trade_cycle_closed", async () => {
  const request = makeRequest("DELETE", closeRoute(), "", {});
  const response = makeResponse();
  const service = new FakeCloseApplicationService();
  service.result = {
    statusCode: 200,
    body: { strategy_instance_id: "instance", trade_cycle_id: "cycle", status: "trade_cycle_closed" },
  };

  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await handlePositionManagementRoutes({
      request,
      response: response.response,
      ...routeDeps({ closeApplicationService: service }),
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
  assert.equal(events[0].operation, "close_position");
  assert.equal(events[1].outcome, "trade_cycle_closed");
});

function protectionRoute(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/protection";
}

function closeRoute(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/open-position";
}

function validProtectionBody(): Record<string, unknown> {
  return { stop_price: "99000", take_price: "103000" };
}

function makeRequest(
  method: string,
  url: string,
  body: string,
  headers: Record<string, string>,
): IncomingMessage {
  const request = Readable.from([body]) as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = headers;
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
