import { mapExecutionPlanToBybit } from "../../exchange/bybitOrderMapper.js";
import type { Journal } from "../../journal/journal.js";
import { isExecutionPlan } from "../../journal/journalPayloads.js";
import { badSignalId, type IntentServiceInput, type ServiceResponse } from "./common.js";

export async function getEntryOrder(input: IntentServiceInput): Promise<ServiceResponse> {
  const { signalId, config, bybit, journal } = input;

  if (signalId.trim() === "") {
    return badSignalId();
  }

  const latestExecutionPlanEvent =
    (await journal.findLastEvent({ signalId, eventType: "execution_plan_updated" })) ??
    (await journal.findLastEvent({ signalId, eventType: "execution_plan_created" }));

  if (latestExecutionPlanEvent === null || !isExecutionPlan(latestExecutionPlanEvent.payload)) {
    return {
      statusCode: 404,
      body: {
        error: "execution_plan_not_found",
        signalId,
      },
    };
  }

  const bybitPayloads = mapExecutionPlanToBybit(config, latestExecutionPlanEvent.payload);

  if (config.bybitApiKey === "" || config.bybitApiSecret === "") {
    return {
      statusCode: 200,
      body: {
        status: "skipped_bybit_query",
        signalId,
        entryOrder: latestExecutionPlanEvent.payload.entryOrder,
        wouldQueryBybit: bybitPayloads.getEntryOrder,
        reason: "BYBIT_API_KEY and BYBIT_API_SECRET are required",
      },
    };
  }

  try {
    const bybitResponse = await bybit.getOrderByLinkId(bybitPayloads.getEntryOrder);
    return {
      statusCode: 200,
      body: {
        status: "ok",
        signalId,
        entryOrder: latestExecutionPlanEvent.payload.entryOrder,
        queryBybit: bybitPayloads.getEntryOrder,
        bybitResponse,
      },
    };
  } catch (error) {
    return {
      statusCode: 502,
      body: {
        status: "bybit_entry_order_query_failed",
        signalId,
        queryBybit: bybitPayloads.getEntryOrder,
        error: error instanceof Error ? error.message : "failed to query Bybit entry order",
      },
    };
  }
}

export async function getIntentStatus(input: {
  signalId: string;
  journal: Journal;
}): Promise<ServiceResponse> {
  const { signalId, journal } = input;

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

    return {
      statusCode: 200,
      body: {
        signalId,
        intentStatus: event.payload,
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        error: error instanceof Error ? error.message : "failed to read intent status",
      },
    };
  }
}
