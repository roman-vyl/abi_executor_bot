import type { EntryOrderExecutionResult } from "../../execution/execution.js";
import { executeEntryOrder } from "../../execution/execution.js";
import { buildExecutionPlan } from "../../domain/executionPlan.js";
import { mapExecutionPlanToBybit } from "../../exchange/bybitOrderMapper.js";
import { createFailedToCreateEntryIntentStatus, createPlannedIntentStatus } from "../../domain/intents.js";
import { getLiveExecutionMode } from "../../execution/liveGuard.js";
import { calculatePositionSize } from "../../risk/positionSizing.js";
import { checkSignalRisk } from "../../risk/riskGuard.js";
import { parseSignalIntent } from "../../domain/signals.js";
import {
  appendProtectionCompletion,
  capturePreCreateProtectionSnapshot,
  createDryRunProtectionCheck,
  resultForPreCreateSnapshotFailure,
  resultForPreExistingPosition,
  verifyPostCreateProtection,
} from "../protection/verifyPostCreateProtection.js";
import type {
  ProtectionCheckContext,
  ProtectionCheckResult,
  ProtectionPositionSnapshot,
} from "../protection/protectionTypes.js";
import type {
  CreateSignalIntentDeps,
  CreateSignalIntentInput,
  CreateSignalIntentResult,
} from "./createSignalIntentTypes.js";

export async function createSignalIntent(
  input: CreateSignalIntentInput,
  deps: CreateSignalIntentDeps,
): Promise<CreateSignalIntentResult> {
  const { payload } = input;
  const { config, bybit, journal } = deps;
  const result = parseSignalIntent(payload, config);

  if (!result.ok) {
    await journal.appendEvent({
      eventType: "signal_rejected",
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
    return {
      statusCode: 400,
      body: {
        error: riskDecision.error,
      },
    };
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
    return {
      statusCode: 200,
      body: {
        status: "duplicate",
        signalId: result.intent.signalId,
      },
    };
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
    return {
      statusCode: 409,
      body: {
        error: "active_intent_exists",
        instanceId: result.intent.instanceId,
        existingSignalId: activeIntent.signalId,
      },
    };
  }

  const positionSize = calculatePositionSize(result.intent, config);
  const executionPlan = buildExecutionPlan(result.intent, positionSize, config.bybitTriggerBy);
  const bybitPayloads = mapExecutionPlanToBybit(config, executionPlan);
  const intentStatus = createPlannedIntentStatus(result.intent, executionPlan);
  const protectionContext: ProtectionCheckContext = {
    signalId: result.intent.signalId,
    instanceId: result.intent.instanceId,
    symbol: result.intent.symbol,
    side: result.intent.side,
    orderLinkId: executionPlan.entryOrder.orderLinkId,
    protection: executionPlan.protection,
    dryRun: config.dryRun,
  };

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

  const liveMode = getLiveExecutionMode(config);
  let preCreatePosition: ProtectionPositionSnapshot | undefined;

  if (liveMode.canExecuteLive) {
    preCreatePosition = await capturePreCreateProtectionSnapshot({
      context: protectionContext,
      bybit,
      journal,
    });

    if (!preCreatePosition.queryOk) {
      const failedIntentStatus = createFailedToCreateEntryIntentStatus(
        result.intent.signalId,
        result.intent.instanceId,
      );
      const protectionCheck = resultForPreCreateSnapshotFailure({
        context: protectionContext,
        preCreatePosition,
      });

      await appendProtectionCompletion(journal, result.intent.signalId, protectionCheck);
      await journal.appendEvent({
        eventType: "intent_status_changed",
        signalId: result.intent.signalId,
        payload: failedIntentStatus,
      });

      return {
        statusCode: 502,
        body: {
          status: "protection_check_failed",
          signalId: result.intent.signalId,
          intentStatus: failedIntentStatus,
          wouldCreateEntry: executionPlan.entryOrder,
          wouldUseProtection: executionPlan.protection,
          wouldSendToBybit: {
            createEntryOrder: bybitPayloads.createEntryOrder,
          },
          protectionCheck,
          sizingReason: executionPlan.sizingReason,
        },
      };
    }
  }

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
    const failedIntentStatus = createFailedToCreateEntryIntentStatus(
      result.intent.signalId,
      result.intent.instanceId,
    );
    const entryExecutionFailed = {
      status: "bybit_entry_order_create_failed",
      error: error instanceof Error ? error.message : "failed to create Bybit entry order",
    };

    await journal.appendEvent({
      eventType: "intent_status_changed",
      signalId: result.intent.signalId,
      payload: failedIntentStatus,
    });

    await journal.appendEvent({
      eventType: "bybit_entry_order_create_failed",
      signalId: result.intent.signalId,
      payload: entryExecutionFailed,
    });

    return {
      statusCode: 502,
      body: {
        status: "bybit_entry_order_create_failed",
        signalId: result.intent.signalId,
        intentStatus: failedIntentStatus,
        wouldCreateEntry: executionPlan.entryOrder,
        wouldUseProtection: executionPlan.protection,
        wouldSendToBybit: {
          createEntryOrder: bybitPayloads.createEntryOrder,
        },
        entryExecution: entryExecutionFailed,
        sizingReason: executionPlan.sizingReason,
      },
    };
  }

  let protectionCheck: ProtectionCheckResult | undefined;
  if (entryExecution.status === "skipped_live_execution" && config.dryRun) {
    protectionCheck = createDryRunProtectionCheck(protectionContext);
    await appendProtectionCompletion(journal, result.intent.signalId, protectionCheck);
  } else if (entryExecution.status === "bybit_entry_order_create_accepted" && preCreatePosition !== undefined) {
    if (isOpenPreCreatePosition(preCreatePosition)) {
      protectionCheck = resultForPreExistingPosition({
        context: protectionContext,
        preCreatePosition,
      });
      await appendProtectionCompletion(journal, result.intent.signalId, protectionCheck);
    } else {
      protectionCheck = await verifyPostCreateProtection({
        config,
        bybit,
        journal,
        context: protectionContext,
        getEntryOrderPayload: bybitPayloads.getEntryOrder,
        preCreatePosition,
      });
    }
  }

  await journal.appendEvent({
    eventType:
      entryExecution.status === "skipped_live_execution"
        ? "bybit_entry_order_create_skipped"
        : "bybit_entry_order_create_accepted",
    signalId: result.intent.signalId,
    payload: entryExecution,
  });

  return {
    statusCode: 200,
    body: {
      status:
        entryExecution.status === "skipped_live_execution"
          ? "accepted_dry_run"
          : "accepted_live_entry_order_created",
      signalId: result.intent.signalId,
      intentStatus,
      wouldCreateEntry: executionPlan.entryOrder,
      wouldUseProtection: executionPlan.protection,
      wouldSendToBybit: {
        createEntryOrder: bybitPayloads.createEntryOrder,
      },
      entryExecution,
      ...(protectionCheck === undefined ? {} : { protectionCheck }),
      sizingReason: executionPlan.sizingReason,
    },
  };
}

function isOpenPreCreatePosition(snapshot: ProtectionPositionSnapshot): boolean {
  return snapshot.found && snapshot.size !== undefined && Number(snapshot.size) > 0;
}
