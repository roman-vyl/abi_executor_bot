import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { BybitCreateOrderPayload, BybitMarketCloseOrderPayload } from "../../src/exchange/bybitOrderMapper.js";
import { Journal } from "../../src/journal/journal.js";
import { handleSignalRoutes } from "../../src/routes/signalRoutes.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

test("a failed Bybit entry create marks the intent failed and allows the same instance to retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abi-signal-route-"));
  const journal = new Journal(join(directory, "journal.jsonl"));
  const config = makeTestConfig({
    dryRun: false,
    liveTradingEnabled: true,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
  });
  const bybit = new FailFirstCreateBybitAdapter();

  try {
    const failedResponse = await postSignal("sig-create-fails", config, bybit, journal);
    assert.equal(failedResponse.status, 502);
    assert.equal(failedResponse.body.intentStatus.status, "failed_to_create_entry");

    const failedStatusEvent = await journal.findLastEvent({
      signalId: "sig-create-fails",
      eventType: "intent_status_changed",
    });
    assert.deepEqual(failedStatusEvent?.payload, {
      intentId: "sig-create-fails",
      instanceId: "ema200-touch:BTCUSDT:1h",
      status: "failed_to_create_entry",
      entry: "failed_to_create",
      protection: "not_created",
      position: "not_open",
    });
    assert.equal(await journal.findActiveIntentByInstanceId("ema200-touch:BTCUSDT:1h"), null);

    const retryResponse = await postSignal("sig-create-retry", config, bybit, journal);
    assert.equal(retryResponse.status, 200);
    assert.equal(retryResponse.body.status, "accepted_live_entry_order_created");
    assert.equal(bybit.createOrderCalls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FailFirstCreateBybitAdapter extends FakeBybitAdapter {
  private shouldFail = true;

  override async createOrder(
    payload: BybitCreateOrderPayload | BybitMarketCloseOrderPayload,
  ): Promise<unknown> {
    this.createOrderCalls.push(payload);
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("Bybit rejected entry");
    }
    return { retCode: 0, result: { orderLinkId: "fake-create" } };
  }
}

async function postSignal(
  signalId: string,
  config: ReturnType<typeof makeTestConfig>,
  bybit: FakeBybitAdapter,
  journal: Journal,
): Promise<{
  status: number;
  body: { status: string; intentStatus: { status: string } };
}> {
  const request = Readable.from([
    JSON.stringify({
      signal_id: signalId,
      instance_id: "ema200-touch:BTCUSDT:1h",
      strategy_id: "ema200-touch",
      symbol: "BTCUSDT",
      side: "long",
      entry: {
        type: "stop_market",
        trigger_price: "61000.0",
        trigger_direction: "rises_to",
      },
      stop_loss: { type: "stop_market", trigger_price: "60900.0" },
      take_profit: { type: "take_profit_market", trigger_price: "62100.0" },
    }),
  ]) as IncomingMessage;
  request.method = "POST";
  request.url = "/signals";

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

  assert.equal(await handleSignalRoutes({ request, response, config, bybit, journal }), true);

  return {
    status,
    body: JSON.parse(responseBody) as { status: string; intentStatus: { status: string } },
  };
}
