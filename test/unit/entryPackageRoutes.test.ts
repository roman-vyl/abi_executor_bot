import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { EntryPackageCommand, EntryPackageHttpResult } from "../../src/domain/entryPackageApi.js";
import { internalErrorResult } from "../../src/domain/entryPackageApi.js";
import type { EntryPackageApplicationServicePort } from "../../src/routes/entryPackageRoutes.js";
import {
  handleEntryPackageRoutes,
  matchEntryPackageRoute,
} from "../../src/routes/entryPackageRoutes.js";

const notReadyApplicationService: EntryPackageApplicationServicePort = {
  apply(): Promise<EntryPackageHttpResult> {
    throw new Error("applicationService.apply should not be called while not ready");
  },
};

function notReady(): boolean {
  return false;
}

test("entry-package route ignores a different method or path", async () => {
  const request = makeRequest("GET", "/health", "", {});
  const response = makeResponse();

  assert.equal(
    await handleEntryPackageRoutes({
      request,
      response: response.response,
      applicationService: notReadyApplicationService,
      isReady: notReady,
    }),
    false,
  );
  assert.equal(response.status(), 0);
});

test("entry-package route accepts exact path and percent-decodes opaque identifiers", () => {
  assert.deepEqual(
    matchEntryPackageRoute(
      "PUT",
      "/v1/strategy-instances/instance%2Ffuture/trade-cycles/cycle%20id/entry-package",
    ),
    {
      matched: true,
      strategyInstanceId: "instance/future",
      tradeCycleId: "cycle id",
    },
  );
});

test("entry-package route preserves opaque dot-segment identifiers", () => {
  for (const [strategyInstanceId, tradeCycleId] of [
    [".", ".."],
    ["%2E", "%2E%2E"],
  ]) {
    assert.deepEqual(
      matchEntryPackageRoute(
        "PUT",
        `/v1/strategy-instances/${strategyInstanceId}/trade-cycles/${tradeCycleId}/entry-package`,
      ),
      {
        matched: true,
        strategyInstanceId: ".",
        tradeCycleId: "..",
      },
    );
  }
});

test("unsupported or malformed content type maps to 415", async () => {
  for (const contentType of [
    "text/plain",
    "application/json;",
    "application/json;; charset=utf-8",
    "application/json; charset=utf-8; charset=utf-8",
    "application/json; charset=utf-16",
  ]) {
    const response = await invokeRoute(makePackagePayload(), {
      "content-type": contentType,
    });

    assert.equal(response.status(), 415, contentType);
    assert.equal(response.body().error.code, "unsupported_media_type", contentType);
    assert.equal("details" in response.body().error, false, contentType);
  }
});

test("application/json and UTF-8 charset are supported", async () => {
  for (const contentType of [
    "application/json",
    "Application/JSON; Charset=UTF-8",
    'application/json; charset="utf-8"',
    ' Application/JSON ; Charset = "UTF-8" ',
  ]) {
    const response = await invokeRoute(makePackagePayload(), {
      "content-type": contentType,
    });
    assert.equal(response.status(), 500);
    assert.deepEqual(response.body(), {
      error: {
        code: "internal_error",
        message: "internal error",
      },
    });
  }
});

test("missing and malformed JSON map to 400", async () => {
  for (const body of ["", "{"]) {
    const request = makeRequest("PUT", route(), body, {
      "content-type": "application/json",
    });
    const response = makeResponse();

    assert.equal(
      await handleEntryPackageRoutes({
        request,
        response: response.response,
        applicationService: notReadyApplicationService,
        isReady: notReady,
      }),
      true,
    );
    assert.equal(response.status(), 400);
    assert.equal(response.body().error.code, "malformed_json");
  }
});

test("invalid body maps to 422 with field details", async () => {
  const response = await invokeRoute({
    ticker: "",
    desired_entry: null,
    risk_multiplier: "1",
    extra: true,
  });

  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.ok(Array.isArray(response.body().error.details));
  assert.ok(response.body().error.details.length > 0);
});

test("malformed path percent encoding maps to validation failure", async () => {
  const request = makeRequest(
    "PUT",
    "/v1/strategy-instances/%ZZ/trade-cycles/cycle/entry-package",
    JSON.stringify(makePackagePayload()),
    {
      "content-type": "application/json",
    },
  );
  const response = makeResponse();

  assert.equal(
    await handleEntryPackageRoutes({
      request,
      response: response.response,
      applicationService: notReadyApplicationService,
      isReady: notReady,
    }),
    true,
  );
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.equal(response.body().error.details[0].path, "/path/strategy_instance_id");
});

test("valid absence reaches safe unconfigured boundary without fabricated success", async () => {
  const response = await invokeRoute({
    ticker: "BTCUSDT.P",
    desired_entry: null,
    risk_multiplier: "1",
  });

  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), {
    error: {
      code: "internal_error",
      message: "internal error",
    },
  });
});

test("null risk multiplier maps to validation failure for package and absence", async () => {
  for (const desiredEntry of [null, makePackagePayload().desired_entry]) {
    const response = await invokeRoute({
      ticker: "BTCUSDT.P",
      desired_entry: desiredEntry,
      risk_multiplier: null,
    });

    assert.equal(response.status(), 422);
    assert.equal(response.body().error.code, "validation_failed");
    assert.ok(
      response
        .body()
        .error.details.some((detail: { path: string }) => detail.path === "/risk_multiplier"),
    );
  }
});

test("unknown HTTP-boundary failure maps to safe internal error", async () => {
  const request = makeRequest("PUT", route(), "{}", {
    "content-type": "application/json",
  });
  Object.defineProperty(request, "headers", {
    get(): never {
      throw new Error("unexpected boundary failure");
    },
  });
  const response = makeResponse();

  assert.equal(
    await handleEntryPackageRoutes({
      request,
      response: response.response,
      applicationService: notReadyApplicationService,
      isReady: notReady,
    }),
    true,
  );
  assert.equal(response.status(), 500);
  assert.deepEqual(response.body(), {
    error: {
      code: "internal_error",
      message: "internal error",
    },
  });
});

test("when ready, a valid command is handed to the application service and its result is returned as-is", async () => {
  let receivedCommand: EntryPackageCommand | undefined;
  const applicationService: EntryPackageApplicationServicePort = {
    async apply(command: EntryPackageCommand): Promise<EntryPackageHttpResult> {
      receivedCommand = command;
      return {
        statusCode: 200,
        body: {
          strategy_instance_id: command.strategyInstanceId,
          trade_cycle_id: command.tradeCycleId,
          status: "entry_package_absent",
        },
      };
    },
  };

  const request = makeRequest(
    "PUT",
    route(),
    JSON.stringify({ ticker: "BTCUSDT.P", desired_entry: null, risk_multiplier: "1" }),
    { "content-type": "application/json" },
  );
  const response = makeResponse();

  assert.equal(
    await handleEntryPackageRoutes({
      request,
      response: response.response,
      applicationService,
      isReady: () => true,
    }),
    true,
  );
  assert.equal(response.status(), 200);
  assert.equal(response.body().status, "entry_package_absent");
  assert.equal(receivedCommand?.strategyInstanceId, "instance");
  assert.equal(receivedCommand?.tradeCycleId, "cycle");
});

test("applicationService failures still map through internalErrorResult when returned", async () => {
  const applicationService: EntryPackageApplicationServicePort = {
    async apply(): Promise<EntryPackageHttpResult> {
      return internalErrorResult();
    },
  };

  const response = await invokeRoute(makePackagePayload(), undefined, applicationService, () => true);

  assert.equal(response.status(), 500);
  assert.equal(response.body().error.code, "internal_error");
});

async function invokeRoute(
  payload: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
  },
  applicationService: EntryPackageApplicationServicePort = notReadyApplicationService,
  isReady: () => boolean = notReady,
): Promise<ReturnType<typeof makeResponse>> {
  const request = makeRequest("PUT", route(), JSON.stringify(payload), headers);
  const response = makeResponse();
  assert.equal(
    await handleEntryPackageRoutes({
      request,
      response: response.response,
      applicationService,
      isReady,
    }),
    true,
  );
  return response;
}

function route(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/entry-package";
}

function makePackagePayload(): Record<string, unknown> {
  return {
    ticker: "BTCUSDT.P",
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
  };
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
