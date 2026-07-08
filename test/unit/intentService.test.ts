import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { makeTestConfig } from "../fixtures/config.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { buildExecutionPlan } from "../../src/domain/executionPlan.js";
import { createCancelledIntentStatus, createPlannedIntentStatus } from "../../src/domain/intents.js";
import type { SignalIntent } from "../../src/domain/signals.js";
import { Journal } from "../../src/journal/journal.js";
import { cancelIntent, getEntryOrder, updateIntent } from "../../src/services/intentService.js";

test("cancelIntent cancels a planned intent in dry-run without calling Bybit", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);

    await seedPlannedIntent(journal, intent, plan);

    const result = await cancelIntent({
      signalId: intent.signalId,
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "cancelled");
    assert.equal(bybit.cancelOrderCalls.length, 0);

    const statusEvent = await journal.findLastEvent({
      signalId: intent.signalId,
      eventType: "intent_status_changed",
    });
    assert.equal((statusEvent?.payload as { status: string }).status, "cancelled");

    const skippedEvent = await journal.findLastEvent({
      signalId: intent.signalId,
      eventType: "bybit_entry_order_cancel_skipped",
    });
    assert.equal((skippedEvent?.payload as { status: string }).status, "skipped_live_execution");
  } finally {
    await cleanup();
  }
});

test("updateIntent rejects a cancelled intent", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();

    await journal.appendEvent({
      eventType: "signal_received",
      signalId: intent.signalId,
      payload: intent,
    });
    await journal.appendEvent({
      eventType: "intent_status_changed",
      signalId: intent.signalId,
      payload: createCancelledIntentStatus(intent.signalId, intent.instanceId),
    });

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({ triggerPrice: "61300.0" }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.body, {
      error: "cancelled_intent_cannot_be_updated",
      signalId: intent.signalId,
    });
    assert.equal(bybit.amendOrderCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("updateIntent rejects changing instance_id for an existing intent", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);

    await seedPlannedIntent(journal, intent, plan);

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({
        instanceId: "ema500-touch:BTCUSDT:1h",
        triggerPrice: "61300.0",
      }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, {
      error: "body instance_id must match existing instance_id",
    });
    assert.equal(bybit.amendOrderCalls.length, 0);

    const rejectedEvent = await journal.findLastEvent({
      signalId: intent.signalId,
      eventType: "signal_update_rejected",
    });
    assert.equal((rejectedEvent?.payload as { error: string }).error, "body instance_id must match existing instance_id");
  } finally {
    await cleanup();
  }
});

test("updateIntent amends a planned intent in dry-run without calling Bybit", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);

    await seedPlannedIntent(journal, intent, plan);

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({ triggerPrice: "61300.0" }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "updated_dry_run");
    assert.equal(bybit.amendOrderCalls.length, 0);

    const body = result.body as {
      wouldUseProtection: { mode: string; stopLoss: { triggerPrice: string }; takeProfit: { triggerPrice: string } };
      wouldSendToBybit: { amendEntryOrder: { triggerPrice: string; stopLoss: string; takeProfit: string } };
    };
    assert.equal(body.wouldUseProtection.mode, "attached_full_position_market");
    assert.equal(body.wouldUseProtection.stopLoss.triggerPrice, "60900.0");
    assert.equal(body.wouldUseProtection.takeProfit.triggerPrice, "62100.0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.triggerPrice, "61300.0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.stopLoss, "60900.0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.takeProfit, "62100.0");
    assert.equal("wouldUseStopLossAfterFill" in (result.body as object), false);
    assert.equal("wouldUseTakeProfitAfterFill" in (result.body as object), false);

    const updatedPlan = await journal.findLastEvent({
      signalId: intent.signalId,
      eventType: "execution_plan_updated",
    });
    assert.equal((updatedPlan?.payload as { entryOrder: { triggerPrice: string } }).entryOrder.triggerPrice, "61300.0");
  } finally {
    await cleanup();
  }
});

test("updateIntent clears take profit when PUT keeps stop loss only", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);
    await seedPlannedIntent(journal, intent, plan);

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({ triggerPrice: "61300.0", includeTakeProfit: false }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 200);
    const body = result.body as {
      wouldUseProtection: { mode: string; stopLoss: { triggerPrice: string }; takeProfit?: unknown };
      wouldSendToBybit: { amendEntryOrder: { stopLoss: string; takeProfit: string } };
    };
    assert.equal(body.wouldUseProtection.mode, "attached_full_position_market");
    assert.equal(body.wouldUseProtection.stopLoss.triggerPrice, "60900.0");
    assert.equal(body.wouldUseProtection.takeProfit, undefined);
    assert.equal(body.wouldSendToBybit.amendEntryOrder.stopLoss, "60900.0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.takeProfit, "0");
  } finally {
    await cleanup();
  }
});

test("updateIntent clears all protection when PUT is entry-only", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);
    await seedPlannedIntent(journal, intent, plan);

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({ triggerPrice: "61300.0", includeStopLoss: false, includeTakeProfit: false }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 200);
    const body = result.body as {
      wouldUseProtection: { mode: string };
      wouldSendToBybit: { amendEntryOrder: { stopLoss: string; takeProfit: string } };
    };
    assert.deepEqual(body.wouldUseProtection, { mode: "none" });
    assert.equal(body.wouldSendToBybit.amendEntryOrder.stopLoss, "0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.takeProfit, "0");
  } finally {
    await cleanup();
  }
});

test("updateIntent failure response reports the desired protection", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
    });
    const bybit = new FailingAmendBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);
    await seedPlannedIntent(journal, intent, plan);

    const result = await updateIntent({
      signalId: intent.signalId,
      payload: makeBbbPayload({ triggerPrice: "61300.0" }),
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 502);
    const body = result.body as {
      status: string;
      wouldUseProtection: { mode: string };
      wouldSendToBybit: { amendEntryOrder: { stopLoss: string; takeProfit: string } };
    };
    assert.equal(body.status, "bybit_entry_order_amend_failed");
    assert.equal(body.wouldUseProtection.mode, "attached_full_position_market");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.stopLoss, "60900.0");
    assert.equal(body.wouldSendToBybit.amendEntryOrder.takeProfit, "62100.0");
  } finally {
    await cleanup();
  }
});

test("getEntryOrder returns skipped_bybit_query without credentials", async () => {
  const { journal, cleanup } = await makeJournal();
  try {
    const config = makeTestConfig();
    const bybit = new FakeBybitAdapter();
    const intent = makeIntent();
    const plan = buildExecutionPlan(intent, { qty: config.fixedSmokeQty, reason: "test" }, config.bybitTriggerBy);

    await seedPlannedIntent(journal, intent, plan);

    const result = await getEntryOrder({
      signalId: intent.signalId,
      config,
      bybit,
      journal,
    });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { status: string }).status, "skipped_bybit_query");
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  } finally {
    await cleanup();
  }
});

async function makeJournal(): Promise<{ journal: Journal; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "abi-intent-service-"));
  return {
    journal: new Journal(join(directory, "journal.jsonl")),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function seedPlannedIntent(
  journal: Journal,
  intent: SignalIntent,
  plan: ReturnType<typeof buildExecutionPlan>,
): Promise<void> {
  await journal.appendEvent({
    eventType: "signal_received",
    signalId: intent.signalId,
    payload: intent,
  });
  await journal.appendEvent({
    eventType: "execution_plan_created",
    signalId: intent.signalId,
    payload: plan,
  });
  await journal.appendEvent({
    eventType: "intent_status_changed",
    signalId: intent.signalId,
    payload: createPlannedIntentStatus(intent, plan),
  });
}

function makeIntent(overrides: Partial<SignalIntent> = {}): SignalIntent {
  return {
    signalId: "sig-service-unit-001",
    instanceId: "ema200-touch:BTCUSDT:1h",
    strategyId: "ema200-touch",
    symbol: "BTCUSDT",
    side: "long",
    entry: {
      type: "stop_market",
      triggerPrice: "61234.5",
      triggerDirection: "rises_to",
    },
    stopLoss: {
      type: "stop_market",
      triggerPrice: "60880.0",
    },
    takeProfit: {
      type: "take_profit_market",
      triggerPrice: "62000.0",
    },
    ...overrides,
  };
}

function makeBbbPayload(input: {
  instanceId?: string;
  triggerPrice: string;
  includeStopLoss?: boolean;
  includeTakeProfit?: boolean;
}): object {
  const payload: Record<string, unknown> = {
    signal_id: "sig-service-unit-001",
    instance_id: input.instanceId ?? "ema200-touch:BTCUSDT:1h",
    strategy_id: "ema200-touch",
    symbol: "BTCUSDT",
    side: "long",
    entry: {
      type: "stop_market",
      trigger_price: input.triggerPrice,
      trigger_direction: "rises_to",
    },
  };

  if (input.includeStopLoss !== false) {
    payload.stop_loss = {
      type: "stop_market",
      trigger_price: "60900.0",
    };
  }

  if (input.includeTakeProfit !== false) {
    payload.take_profit = {
      type: "take_profit_market",
      trigger_price: "62100.0",
    };
  }

  return payload;
}

class FailingAmendBybitAdapter extends FakeBybitAdapter {
  override async amendOrder(payload: Parameters<FakeBybitAdapter["amendOrder"]>[0]): Promise<unknown> {
    this.amendOrderCalls.push(payload);
    throw new Error("Bybit rejected amend");
  }
}
