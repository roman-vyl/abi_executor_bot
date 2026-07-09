import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AbiConfig } from "../../src/config/config.js";
import type { BybitCreateOrderPayload, BybitMarketCloseOrderPayload } from "../../src/exchange/bybitOrderMapper.js";
import { Journal } from "../../src/journal/journal.js";
import { createSignalIntent } from "../../src/services/signals/createSignalIntent.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { makeTestConfig } from "../fixtures/config.js";

test("createSignalIntent returns dry-run preview without exchange protection queries", async () => {
  const { journal, cleanup } = await makeJournal();
  const config = makeTestConfig();
  const bybit = new FakeBybitAdapter();

  try {
    const response = await postSignal("sig-entry-only", config, bybit, journal, {
      includeStopLoss: false,
      includeTakeProfit: false,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "accepted_dry_run");
    assert.equal(response.body.intentStatus.protection, "none");
    assert.deepEqual(response.body.wouldUseProtection, { mode: "none" });
    const createPayload = response.body.wouldSendToBybit as {
      createEntryOrder: Record<string, unknown>;
    };
    assert.equal("stopLoss" in createPayload.createEntryOrder, false);
    assert.equal("takeProfit" in createPayload.createEntryOrder, false);
    assert.equal("wouldCreateStopLossAfterFill" in response.body, false);
    assert.equal("wouldCreateTakeProfitAfterFill" in response.body, false);
    assert.equal(response.body.protectionCheck.status, "not_run_dry_run");
    assert.equal(bybit.getPositionCalls.length, 0);
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getMarketPriceCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("createSignalIntent blocks live create when pre-create position query fails", async () => {
  const { journal, cleanup } = await makeJournal();
  const config = makeLiveConfig();
  const bybit = new PositionQueryFailingBybitAdapter();

  try {
    const response = await postSignal("sig-position-query-fails", config, bybit, journal);

    assert.equal(response.statusCode, 502);
    assert.equal(response.body.status, "protection_check_failed");
    assert.equal(response.body.intentStatus.status, "failed_to_create_entry");
    assert.equal(response.body.protectionCheck.status, "exchange_query_failed");
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("createSignalIntent reports pre-existing position and forbids emergency close", async () => {
  const { journal, cleanup } = await makeJournal();
  const config = makeLiveConfig();
  const bybit = new FakeBybitAdapter();
  bybit.position = { symbol: "BTCUSDT", side: "Buy", size: "0.002" };

  try {
    const response = await postSignal("sig-pre-existing-position", config, bybit, journal);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "accepted_live_entry_order_created");
    assert.equal(response.body.protectionCheck.status, "pre_existing_position_found");
    assert.equal(response.body.protectionCheck.action, "none");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getMarketPriceCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("createSignalIntent failed Bybit create skips post-verification and allows retry", async () => {
  const { journal, cleanup } = await makeJournal();
  const config = makeLiveConfig();
  const bybit = new FailFirstCreateBybitAdapter();

  try {
    const failedResponse = await postSignal("sig-create-fails", config, bybit, journal);
    assert.equal(failedResponse.statusCode, 502);
    assert.equal(failedResponse.body.intentStatus.status, "failed_to_create_entry");
    assert.equal("protectionCheck" in failedResponse.body, false);
    assert.deepEqual(failedResponse.body.wouldUseProtection, {
      mode: "attached_full_position_market",
      stopLoss: { triggerPrice: "60900.0", triggerBy: "LastPrice", orderType: "Market" },
      takeProfit: { triggerPrice: "62100.0", triggerBy: "LastPrice", orderType: "Market" },
    });
    assert.equal("wouldCreateStopLossAfterFill" in failedResponse.body, false);
    assert.equal("wouldCreateTakeProfitAfterFill" in failedResponse.body, false);

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
    assert.equal(retryResponse.statusCode, 200);
    assert.equal(retryResponse.body.status, "accepted_live_entry_order_created");
    assert.equal(retryResponse.body.protectionCheck.status, "pending_order_not_found");
    assert.equal(bybit.createOrderCalls.length, 2);
  } finally {
    await cleanup();
  }
});

function makeLiveConfig(): AbiConfig {
  return makeTestConfig({
    dryRun: false,
    liveTradingEnabled: true,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
  });
}

class PositionQueryFailingBybitAdapter extends FakeBybitAdapter {
  override async getPosition(symbol: string): Promise<null> {
    this.getPositionCalls.push(symbol);
    throw new Error("position query down");
  }
}

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
  options: { includeStopLoss?: boolean; includeTakeProfit?: boolean } = {},
): Promise<{
  statusCode: number;
  body: Record<string, any> & { status: string; intentStatus: { status: string } };
}> {
  const payload = makeSignalPayload(signalId, options);
  const result = await createSignalIntent({ payload }, { config, bybit, journal });

  return {
    statusCode: result.statusCode,
    body: result.body as Record<string, any> & {
      status: string;
      intentStatus: { status: string };
    },
  };
}

function makeSignalPayload(
  signalId: string,
  options: { includeStopLoss?: boolean; includeTakeProfit?: boolean } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
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
  };

  if (options.includeStopLoss !== false) {
    payload.stop_loss = { type: "stop_market", trigger_price: "60900.0" };
  }

  if (options.includeTakeProfit !== false) {
    payload.take_profit = { type: "take_profit_market", trigger_price: "62100.0" };
  }

  return payload;
}

async function makeJournal(): Promise<{ journal: Journal; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "abi-create-signal-intent-"));
  return {
    journal: new Journal(join(directory, "journal.jsonl")),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
