import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import { handleOpenPositionRoutes } from "../../src/routes/openPositionRoutes.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

test("success DTO is a closed object satisfying the cross-field invariant (open)", async () => {
  await withStack(async ({ invoke, repo, bybit }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = positionResponse();

    const response = await invoke();

    assert.equal(response.status(), 200);
    assert.deepEqual(Object.keys(response.body()).sort(), [
      "average_entry_price",
      "first_fill_at_ms",
      "position_open",
    ]);
    assert.equal(response.body().position_open, true);
    assert.notEqual(response.body().first_fill_at_ms, null);
    assert.notEqual(response.body().average_entry_price, null);
  });
});

test("success DTO is a closed object satisfying the cross-field invariant (closed)", async () => {
  await withStack(async ({ invoke, repo }) => {
    await repo.save(makeRecord({ status: "absent" }));

    const response = await invoke();

    assert.equal(response.status(), 200);
    assert.deepEqual(response.body(), {
      position_open: false,
      first_fill_at_ms: null,
      average_entry_price: null,
    });
  });
});

test("every documented error response has the exact HTTP status, code, and details presence/absence", async () => {
  await withStack(async ({ invoke, repo }) => {
    // unknown_trade_cycle_binding: no record at all
    const unknown = await invoke();
    assert.equal(unknown.status(), 422);
    assert.equal(unknown.body().error.code, "unknown_trade_cycle_binding");
    assert.equal("details" in unknown.body().error, false);

    // unsupported_exchange_scope
    await repo.save(makeRecord({ status: "applied", exchangeCategory: "spot" }));
    const unsupported = await invoke();
    assert.equal(unsupported.status(), 422);
    assert.equal(unsupported.body().error.code, "unsupported_exchange_scope");
    assert.equal("details" in unsupported.body().error, false);

    // internal_error (unresolved status)
    await repo.save(makeRecord({ status: "unknown" }));
    const internal = await invoke();
    assert.equal(internal.status(), 500);
    assert.equal(internal.body().error.code, "internal_error");
    assert.equal("details" in internal.body().error, false);
  });

  // validation_failed: exercised at the route layer directly (no body to combine with)
  const response = await invokeWithUrl("/v1/strategy-instances//trade-cycles/cycle/open-position");
  assert.equal(response.status(), 422);
  assert.equal(response.body().error.code, "validation_failed");
  assert.ok(Array.isArray(response.body().error.details));
  assert.ok(response.body().error.details.length > 0);
});

test("no response ever contains 404, a raw Bybit body, or exception/stack details (malformed envelope)", async () => {
  await withStack(async ({ invoke, repo, bybit }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = { retCode: 10001, retMsg: "some raw bybit failure detail", result: null };

    const response = await invoke();

    assert.notEqual(response.status(), 404);
    assert.equal(response.status(), 500);
    const serialized = JSON.stringify(response.body());
    assert.equal(serialized.includes("some raw bybit failure detail"), false);
    assert.deepEqual(response.body(), { error: { code: "internal_error", message: "internal error" } });
  });
});

test("no response ever contains 404 or exception/stack details (transport failure)", async () => {
  await withStack(async ({ invoke, repo, bybit }) => {
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsError = new Error("some internal exception message with a stack");

    const response = await invoke();

    assert.notEqual(response.status(), 404);
    assert.equal(response.status(), 500);
    const serialized = JSON.stringify(response.body());
    assert.equal(serialized.includes("some internal exception message"), false);
    assert.deepEqual(response.body(), { error: { code: "internal_error", message: "internal error" } });
  });
});

test("not-ready readiness fails closed without attempting correlation lookup or an exchange call", async () => {
  await withStack(async ({ invoke, repo, bybit }) => {
    await repo.save(makeRecord({ status: "applied" }));

    const response = await invoke({ isReady: () => false });

    assert.equal(response.status(), 500);
    assert.equal(response.body().error.code, "internal_error");
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

function positionResponse(): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{ symbol: "BTCUSDT", side: "Buy", size: "0.001", positionIdx: 0, avgPrice: "100000", openTime: 111 }],
    },
  };
}

function makeRecord(
  overrides: Partial<{ status: EntryPackageExecutionRecord["status"]; exchangeCategory: "linear" | "spot" }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance",
    trade_cycle_id: "cycle",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: overrides.exchangeCategory ?? "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

type Ctx = {
  repo: EntryPackageCorrelationRepository;
  bybit: FakeBybitAdapter;
  invoke: (options?: { isReady?: () => boolean }) => Promise<ReturnType<typeof makeResponse>>;
};

async function withStack(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-open-position-contract-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const resolutionService = new OpenPositionResolutionService({ correlationRepository: repo, bybit });

    const invoke = async (options: { isReady?: () => boolean } = {}) => {
      const request = makeRequest(route());
      const response = makeResponse();
      await handleOpenPositionRoutes({
        request,
        response: response.response,
        resolutionService,
        isReady: options.isReady ?? (() => true),
      });
      return response;
    };

    await fn({ repo, bybit, invoke });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function invokeWithUrl(url: string): Promise<ReturnType<typeof makeResponse>> {
  const dir = await mkdtemp(join(tmpdir(), "abi-open-position-contract-url-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const resolutionService = new OpenPositionResolutionService({ correlationRepository: repo, bybit });

    const request = makeRequest(url);
    const response = makeResponse();
    await handleOpenPositionRoutes({ request, response: response.response, resolutionService, isReady: () => true });
    return response;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function route(): string {
  return "/v1/strategy-instances/instance/trade-cycles/cycle/open-position";
}

function makeRequest(url: string): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage;
  request.method = "GET";
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
