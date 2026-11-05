import type { CorrelationReplayResult } from "../correlation/entryPackageCorrelationRepository.js";
import { emitEvent } from "../observability/events.js";
import type { EntryPackageReadiness } from "./entryPackageReadiness.js";
import type { EntryPackageExecutionRecord } from "../correlation/entryPackageExecutionRecord.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import type { LinearPositionBindingPolicy } from "../domain/positionBindingPolicy.js";
import { assureConfiguredActiveBindings } from "./positionModeAssuranceSeams.js";

export type CorrelationReplayer = {
  replay(): Promise<CorrelationReplayResult>;
  // Closes admission intents left by a previous process; see
  // EntryPackageCorrelationRepository.closeLeftoverAdmissionIntents.
  closeLeftoverAdmissionIntents(): Promise<EntryPackageExecutionRecord[]>;
};

// Runs correlation-store replay with correlation_replay_*/readiness_*
// structured events around it, then flips readiness — same control flow
// as the original inline replay().then().catch() chain, just observable.
type ReplayReadiness = Pick<EntryPackageReadiness, "markReady" | "markNotReady">;
type BindingActivation = {
  bybit: BybitAdapter;
  linearPolicy: LinearPositionBindingPolicy;
  getActiveRecords(): EntryPackageExecutionRecord[];
};

export async function replayCorrelationStore(
  repository: CorrelationReplayer,
  readiness: ReplayReadiness,
  activation?: BindingActivation,
): Promise<void> {
  if (await replayLocalCorrelationStore(repository, readiness)) {
    await activateExecutionBindings(readiness, activation);
  }
}

// Local replay is performed once even when protected execution remains LOCKED.
// Authorization will later run only activateExecutionBindings, not this phase.
export async function replayLocalCorrelationStore(
  repository: CorrelationReplayer,
  readiness: ReplayReadiness,
): Promise<boolean> {
  emitEvent("info", "correlation_replay_started");
  let result: CorrelationReplayResult;
  try {
    result = await repository.replay();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "correlation replay failed";
    emitEvent("error", "correlation_replay_failed", { reason });
    readiness.markNotReady(reason);
    emitEvent("error", "readiness_failed", { reason });
    return false;
  }

  if (!result.ok) {
    emitEvent("error", "correlation_replay_failed", { reason: result.reason });
    readiness.markNotReady(result.reason);
    emitEvent("error", "readiness_failed", { reason: result.reason });
    return false;
  }
  emitEvent("info", "correlation_replay_succeeded");
  let closedAdmissions: EntryPackageExecutionRecord[];
  try {
    closedAdmissions = await repository.closeLeftoverAdmissionIntents();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "closing leftover admission intents failed";
    readiness.markNotReady(reason);
    emitEvent("error", "readiness_failed", { reason });
    return false;
  }
  for (const record of closedAdmissions) {
    emitEvent("warn", "entry_admission_rejected", {
      strategy_instance_id: record.strategy_instance_id,
      trade_cycle_id: record.trade_cycle_id,
      failure_stage: "startup_recovery",
    });
  }
  return true;
}

// Existing exchange assurance, separated from durable local startup changes.
export async function activateExecutionBindings(
  readiness: ReplayReadiness,
  activation?: BindingActivation,
): Promise<void> {
  if (activation !== undefined) {
    let assurance: Awaited<ReturnType<typeof assureConfiguredActiveBindings>>;
    try {
      assurance = await assureConfiguredActiveBindings({
        bybit: activation.bybit,
        activeRecords: activation.getActiveRecords(),
        linearPolicy: activation.linearPolicy,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "position mode assurance failed";
      readiness.markNotReady(reason);
      emitEvent("error", "readiness_failed", { reason });
      return;
    }
    if (!assurance.ok) {
      readiness.markNotReady(assurance.reason);
      emitEvent("error", "readiness_failed", { reason: assurance.reason });
      return;
    }
  }
  readiness.markReady();
  emitEvent("info", "readiness_ready");
}
