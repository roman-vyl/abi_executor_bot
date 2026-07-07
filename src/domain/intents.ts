import type { ExecutionPlan } from "./executionPlan.js";
import type { SignalIntent } from "./signals.js";

export type IntentStatus = PlannedIntentStatus | CancelledIntentStatus | FailedToCreateEntryIntentStatus;

export type PlannedIntentStatus = {
  intentId: string;
  instanceId: string;
  status: "planned";
  entry: "planned";
  protection: "waiting_for_entry_fill";
  position: "not_open";
};

export type CancelledIntentStatus = {
  intentId: string;
  instanceId: string;
  status: "cancelled";
  entry: "cancelled";
  protection: "not_created";
  position: "not_open";
};

export type FailedToCreateEntryIntentStatus = {
  intentId: string;
  instanceId: string;
  status: "failed_to_create_entry";
  entry: "failed_to_create";
  protection: "not_created";
  position: "not_open";
};

export function createPlannedIntentStatus(intent: SignalIntent, executionPlan: ExecutionPlan): IntentStatus {
  void executionPlan;

  return {
    intentId: intent.signalId,
    instanceId: intent.instanceId,
    status: "planned",
    entry: "planned",
    protection: "waiting_for_entry_fill",
    position: "not_open",
  };
}

export function createCancelledIntentStatus(intentId: string, instanceId: string): IntentStatus {
  return {
    intentId,
    instanceId,
    status: "cancelled",
    entry: "cancelled",
    protection: "not_created",
    position: "not_open",
  };
}

export function createFailedToCreateEntryIntentStatus(intentId: string, instanceId: string): IntentStatus {
  return {
    intentId,
    instanceId,
    status: "failed_to_create_entry",
    entry: "failed_to_create",
    protection: "not_created",
    position: "not_open",
  };
}
