import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { Journal } from "../../src/journal/journal.js";
import { handleSignalRoutes } from "../../src/routes/signalRoutes.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

test("handleSignalRoutes ignores non-signal routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abi-signal-route-"));

  try {
    const request = Readable.from([""]) as IncomingMessage;
    request.method = "GET";
    request.url = "/health";

    const response = makeResponse();

    assert.equal(
      await handleSignalRoutes({
        request,
        response: response.response,
        config: makeTestConfig(),
        bybit: new FakeBybitAdapter(),
        journal: new Journal(join(directory, "journal.jsonl")),
      }),
      false,
    );
    assert.equal(response.status(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("handleSignalRoutes reads POST body and writes service response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abi-signal-route-"));
  const journal = new Journal(join(directory, "journal.jsonl"));
  const bybit = new FakeBybitAdapter();

  try {
    const request = Readable.from([
      JSON.stringify({
        signal_id: "sig-route",
        instance_id: "ema200-touch:BTCUSDT:1h",
        strategy_id: "ema200-touch",
        symbol: "BTCUSDT",
        side: "long",
        entry: {
          type: "stop_market",
          trigger_price: "61000.0",
          trigger_direction: "rises_to",
        },
      }),
    ]) as IncomingMessage;
    request.method = "POST";
    request.url = "/signals";

    const response = makeResponse();

    assert.equal(
      await handleSignalRoutes({
        request,
        response: response.response,
        config: makeTestConfig(),
        bybit,
        journal,
      }),
      true,
    );

    assert.equal(response.status(), 200);
    assert.equal(response.body().status, "accepted_dry_run");
    assert.equal(response.body().protectionCheck.status, "not_run_dry_run");
    assert.equal(bybit.createOrderCalls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
