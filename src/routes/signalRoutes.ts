import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import type { EntryOrderExecutionResult } from "../execution/execution.js";
import { executeEntryOrder } from "../execution/execution.js";
import { buildExecutionPlan } from "../domain/executionPlan.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { mapExecutionPlanToBybit } from "../exchange/bybitOrderMapper.js";
import { readJsonBody, writeJson } from "../app/http.js";
import { createPlannedIntentStatus } from "../domain/intents.js";
import type { Journal } from "../journal/journal.js";
import { calculatePositionSize } from "../risk/positionSizing.js";
import { checkSignalRisk } from "../risk/riskGuard.js";
import { parseSignalIntent } from "../domain/signals.js";

export async function handleSignalRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
}): Promise<boolean> {
  const { request, response, config, bybit, journal } = input;

  if (request.method !== "POST" || request.url !== "/signals") {
    return false;
  }

  try {
    const payload = await readJsonBody(request);
    const result = parseSignalIntent(payload, config);

    if (!result.ok) {
      await journal.appendEvent({
        eventType: "signal_rejected",
        payload: {
          error: result.error,
          body: payload,
        },
      });
      writeJson(response, 400, {
        error: result.error,
      });
      return true;
    }

    const riskDecision = checkSignalRisk(result.intent, config);
    if (!riskDecision.ok) {
      await journal.appendEvent({
        eventType: "signal_rejected",
        signalId: result.intent.signalId,
        payload: {
          error: riskDecision.error,
          intent: result.intent,
        },
      });
      writeJson(response, 400, {
        error: riskDecision.error,
      });
      return true;
    }

    if (await journal.hasSignal(result.intent.signalId)) {
      await journal.appendEvent({
        eventType: "duplicate_signal",
        signalId: result.intent.signalId,
        payload: {
          symbol: result.intent.symbol,
          side: result.intent.side,
        },
      });
      writeJson(response, 200, {
        status: "duplicate",
        signalId: result.intent.signalId,
      });
      return true;
    }

    const activeIntent = await journal.findActiveIntentByInstanceId(result.intent.instanceId);
    if (activeIntent !== null) {
      await journal.appendEvent({
        eventType: "signal_rejected",
        signalId: result.intent.signalId,
        payload: {
          error: "active_intent_exists",
          instanceId: result.intent.instanceId,
          existingSignalId: activeIntent.signalId,
        },
      });
      writeJson(response, 409, {
        error: "active_intent_exists",
        instanceId: result.intent.instanceId,
        existingSignalId: activeIntent.signalId,
      });
      return true;
    }

    const positionSize = calculatePositionSize(result.intent, config);
    const executionPlan = buildExecutionPlan(result.intent, positionSize);
    const bybitPayloads = mapExecutionPlanToBybit(config, executionPlan);
    const intentStatus = createPlannedIntentStatus(result.intent, executionPlan);

    await journal.appendEvent({
      eventType: "signal_received",
      signalId: result.intent.signalId,
      payload: result.intent,
    });

    await journal.appendEvent({
      eventType: "position_size_calculated",
      signalId: result.intent.signalId,
      payload: positionSize,
    });

    await journal.appendEvent({
      eventType: "execution_plan_created",
      signalId: result.intent.signalId,
      payload: executionPlan,
    });

    await journal.appendEvent({
      eventType: "intent_status_changed",
      signalId: result.intent.signalId,
      payload: intentStatus,
    });

    await journal.appendEvent({
      eventType: "bybit_entry_order_create_requested",
      signalId: result.intent.signalId,
      payload: bybitPayloads.createEntryOrder,
    });

    let entryExecution: EntryOrderExecutionResult;
    try {
      entryExecution = await executeEntryOrder({
        config,
        bybit,
        payload: bybitPayloads.createEntryOrder,
      });
    } catch (error) {
      const entryExecutionFailed = {
        status: "bybit_entry_order_create_failed",
        error: error instanceof Error ? error.message : "failed to create Bybit entry order",
      };

      await journal.appendEvent({
        eventType: "bybit_entry_order_create_failed",
        signalId: result.intent.signalId,
        payload: entryExecutionFailed,
      });

      writeJson(response, 502, {
        status: "bybit_entry_order_create_failed",
        signalId: result.intent.signalId,
        intentStatus,
        wouldCreateEntry: executionPlan.entryOrder,
        wouldCreateStopLossAfterFill: executionPlan.stopLossAfterFill,
        wouldCreateTakeProfitAfterFill: executionPlan.takeProfitAfterFill,
        wouldSendToBybit: {
          createEntryOrder: bybitPayloads.createEntryOrder,
        },
        entryExecution: entryExecutionFailed,
        sizingReason: executionPlan.sizingReason,
      });
      return true;
    }

    await journal.appendEvent({
      eventType:
        entryExecution.status === "skipped_live_execution"
          ? "bybit_entry_order_create_skipped"
          : "bybit_entry_order_create_accepted",
      signalId: result.intent.signalId,
      payload: entryExecution,
    });

    writeJson(response, 200, {
      status:
        entryExecution.status === "skipped_live_execution"
          ? "accepted_dry_run"
          : "accepted_live_entry_order_created",
      signalId: result.intent.signalId,
      intentStatus,
      wouldCreateEntry: executionPlan.entryOrder,
      wouldCreateStopLossAfterFill: executionPlan.stopLossAfterFill,
      wouldCreateTakeProfitAfterFill: executionPlan.takeProfitAfterFill,
      wouldSendToBybit: {
        createEntryOrder: bybitPayloads.createEntryOrder,
      },
      entryExecution,
      sizingReason: executionPlan.sizingReason,
    });
  } catch (error) {
    void journal.appendEvent({
      eventType: "signal_rejected",
      payload: {
        error: error instanceof Error ? error.message : "invalid request body",
      },
    });
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid request body",
    });
  }

  return true;
}
