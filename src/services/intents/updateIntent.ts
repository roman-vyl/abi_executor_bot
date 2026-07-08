import type { EntryOrderAmendExecutionResult } from "../../execution/execution.js";
import { amendEntryOrder } from "../../execution/execution.js";
import { buildExecutionPlan } from "../../domain/executionPlan.js";
import { mapExecutionPlanToBybit } from "../../exchange/bybitOrderMapper.js";
import { createPlannedIntentStatus } from "../../domain/intents.js";
import { isCancelledStatus, readPayloadString } from "../../journal/journalPayloads.js";
import { calculatePositionSize } from "../../risk/positionSizing.js";
import { checkSignalRisk } from "../../risk/riskGuard.js";
import { parseSignalIntent } from "../../domain/signals.js";
import { badSignalId, type IntentServiceInput, type ServiceResponse } from "./common.js";

export async function updateIntent(
  input: IntentServiceInput & {
    payload: unknown;
  },
): Promise<ServiceResponse> {
  const { signalId, payload, config, bybit, journal } = input;

  if (signalId.trim() === "") {
    return badSignalId();
  }

  try {
    const currentStatusEvent = await journal.findLastEvent({
      signalId,
      eventType: "intent_status_changed",
    });

    if (currentStatusEvent === null) {
      return {
        statusCode: 404,
        body: {
          error: "intent_not_found",
          signalId,
        },
      };
    }

    if (isCancelledStatus(currentStatusEvent.payload)) {
      return {
        statusCode: 409,
        body: {
          error: "cancelled_intent_cannot_be_updated",
          signalId,
        },
      };
    }

    const result = parseSignalIntent(payload, config);
    if (!result.ok) {
      await journal.appendEvent({
        eventType: "signal_update_rejected",
        signalId,
        payload: {
          error: result.error,
          body: payload,
        },
      });
      return {
        statusCode: 400,
        body: {
          error: result.error,
        },
      };
    }

    if (result.intent.signalId !== signalId) {
      await journal.appendEvent({
        eventType: "signal_update_rejected",
        signalId,
        payload: {
          error: "body signal_id must match URL signal_id",
          body: payload,
        },
      });
      return {
        statusCode: 400,
        body: {
          error: "body signal_id must match URL signal_id",
        },
      };
    }

    const originalIntentEvent =
      (await journal.findLastEvent({ signalId, eventType: "signal_updated" })) ??
      (await journal.findLastEvent({ signalId, eventType: "signal_received" }));

    if (originalIntentEvent !== null) {
      const originalInstanceId = readPayloadString(originalIntentEvent.payload, "instanceId");
      if (originalInstanceId !== "" && originalInstanceId !== result.intent.instanceId) {
        await journal.appendEvent({
          eventType: "signal_update_rejected",
          signalId,
          payload: {
            error: "body instance_id must match existing instance_id",
            body: payload,
          },
        });
        return {
          statusCode: 400,
          body: {
            error: "body instance_id must match existing instance_id",
          },
        };
      }
    }

    const riskDecision = checkSignalRisk(result.intent, config);
    if (!riskDecision.ok) {
      await journal.appendEvent({
        eventType: "signal_update_rejected",
        signalId,
        payload: {
          error: riskDecision.error,
          intent: result.intent,
        },
      });
      return {
        statusCode: 400,
        body: {
          error: riskDecision.error,
        },
      };
    }

    const positionSize = calculatePositionSize(result.intent, config);
    const executionPlan = buildExecutionPlan(result.intent, positionSize, config.bybitTriggerBy);
    const bybitPayloads = mapExecutionPlanToBybit(config, executionPlan);
    const intentStatus = createPlannedIntentStatus(result.intent, executionPlan);

    await journal.appendEvent({
      eventType: "bybit_entry_order_amend_requested",
      signalId,
      payload: bybitPayloads.amendEntryOrder,
    });

    let entryAmendExecution: EntryOrderAmendExecutionResult;
    try {
      entryAmendExecution = await amendEntryOrder({
        config,
        bybit,
        payload: bybitPayloads.amendEntryOrder,
      });
    } catch (error) {
      const entryAmendExecutionFailed = {
        status: "bybit_entry_order_amend_failed",
        error: error instanceof Error ? error.message : "failed to amend Bybit entry order",
      };

      await journal.appendEvent({
        eventType: "bybit_entry_order_amend_failed",
        signalId,
        payload: entryAmendExecutionFailed,
      });

      return {
        statusCode: 502,
        body: {
          status: "bybit_entry_order_amend_failed",
          signalId,
          intentStatus,
          wouldAmendEntry: executionPlan.entryOrder,
          wouldUseProtection: executionPlan.protection,
          wouldSendToBybit: {
            amendEntryOrder: bybitPayloads.amendEntryOrder,
          },
          entryAmendExecution: entryAmendExecutionFailed,
          sizingReason: executionPlan.sizingReason,
        },
      };
    }

    await journal.appendEvent({
      eventType:
        entryAmendExecution.status === "skipped_live_execution"
          ? "bybit_entry_order_amend_skipped"
          : "bybit_entry_order_amend_accepted",
      signalId,
      payload: entryAmendExecution,
    });

    await journal.appendEvent({
      eventType: "signal_updated",
      signalId,
      payload: result.intent,
    });

    await journal.appendEvent({
      eventType: "position_size_calculated",
      signalId,
      payload: positionSize,
    });

    await journal.appendEvent({
      eventType: "execution_plan_updated",
      signalId,
      payload: executionPlan,
    });

    await journal.appendEvent({
      eventType: "intent_status_changed",
      signalId,
      payload: intentStatus,
    });

    return {
      statusCode: 200,
      body: {
        status:
          entryAmendExecution.status === "skipped_live_execution"
            ? "updated_dry_run"
            : "updated_live_entry_order_amended",
        signalId,
        intentStatus,
        wouldAmendEntry: executionPlan.entryOrder,
        wouldUseProtection: executionPlan.protection,
        wouldSendToBybit: {
          amendEntryOrder: bybitPayloads.amendEntryOrder,
        },
        entryAmendExecution,
        sizingReason: executionPlan.sizingReason,
      },
    };
  } catch (error) {
    void journal.appendEvent({
      eventType: "signal_update_rejected",
      signalId,
      payload: {
        error: error instanceof Error ? error.message : "invalid request body",
      },
    });
    return {
      statusCode: 400,
      body: {
        error: error instanceof Error ? error.message : "invalid request body",
      },
    };
  }
}
