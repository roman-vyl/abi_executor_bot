import type { EntryOrderCancelExecutionResult } from "../../execution/execution.js";
import { cancelEntryOrder } from "../../execution/execution.js";
import { mapExecutionPlanToBybit } from "../../exchange/bybitOrderMapper.js";
import { createCancelledIntentStatus } from "../../domain/intents.js";
import { isExecutionPlan, readPayloadString } from "../../journal/journalPayloads.js";
import { badSignalId, type IntentServiceInput, type ServiceResponse } from "./common.js";

export async function cancelIntent(input: IntentServiceInput): Promise<ServiceResponse> {
  const { signalId, config, bybit, journal } = input;

  if (signalId.trim() === "") {
    return badSignalId();
  }

  try {
    const event = await journal.findLastEvent({
      signalId,
      eventType: "intent_status_changed",
    });

    if (event === null) {
      return {
        statusCode: 404,
        body: {
          error: "intent_not_found",
          signalId,
        },
      };
    }

    const originalIntentEvent =
      (await journal.findLastEvent({ signalId, eventType: "signal_updated" })) ??
      (await journal.findLastEvent({ signalId, eventType: "signal_received" }));
    const instanceId = originalIntentEvent === null ? "" : readPayloadString(originalIntentEvent.payload, "instanceId");
    const intentStatus = createCancelledIntentStatus(signalId, instanceId);
    const latestExecutionPlanEvent =
      (await journal.findLastEvent({ signalId, eventType: "execution_plan_updated" })) ??
      (await journal.findLastEvent({ signalId, eventType: "execution_plan_created" }));

    if (latestExecutionPlanEvent === null || !isExecutionPlan(latestExecutionPlanEvent.payload)) {
      return {
        statusCode: 409,
        body: {
          error: "execution_plan_not_found",
          signalId,
        },
      };
    }

    const bybitPayloads = mapExecutionPlanToBybit(config, latestExecutionPlanEvent.payload);

    await journal.appendEvent({
      eventType: "bybit_entry_order_cancel_requested",
      signalId,
      payload: bybitPayloads.cancelEntryOrder,
    });

    let entryCancelExecution: EntryOrderCancelExecutionResult;
    try {
      entryCancelExecution = await cancelEntryOrder({
        config,
        bybit,
        payload: bybitPayloads.cancelEntryOrder,
      });
    } catch (error) {
      const entryCancelExecutionFailed = {
        status: "bybit_entry_order_cancel_failed",
        error: error instanceof Error ? error.message : "failed to cancel Bybit entry order",
      };

      await journal.appendEvent({
        eventType: "bybit_entry_order_cancel_failed",
        signalId,
        payload: entryCancelExecutionFailed,
      });

      return {
        statusCode: 502,
        body: {
          status: "bybit_entry_order_cancel_failed",
          signalId,
          entryCancelExecution: entryCancelExecutionFailed,
        },
      };
    }

    await journal.appendEvent({
      eventType:
        entryCancelExecution.status === "skipped_live_execution"
          ? "bybit_entry_order_cancel_skipped"
          : "bybit_entry_order_cancel_accepted",
      signalId,
      payload: entryCancelExecution,
    });

    await journal.appendEvent({
      eventType: "intent_status_changed",
      signalId,
      payload: intentStatus,
    });

    return {
      statusCode: 200,
      body: {
        status: "cancelled",
        signalId,
        intentStatus,
        wouldCancelEntry: latestExecutionPlanEvent.payload.entryOrder,
        wouldSendToBybit: {
          cancelEntryOrder: bybitPayloads.cancelEntryOrder,
        },
        entryCancelExecution,
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        error: error instanceof Error ? error.message : "failed to cancel intent",
      },
    };
  }
}
