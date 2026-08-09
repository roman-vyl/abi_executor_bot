import type { CorrelationReplayResult } from "../correlation/entryPackageCorrelationRepository.js";
import { emitEvent } from "../observability/events.js";
import type { EntryPackageReadiness } from "./entryPackageReadiness.js";

export type CorrelationReplayer = {
  replay(): Promise<CorrelationReplayResult>;
};

// Runs correlation-store replay with correlation_replay_*/readiness_*
// structured events around it, then flips readiness — same control flow
// as the original inline replay().then().catch() chain, just observable.
export async function replayCorrelationStore(
  repository: CorrelationReplayer,
  readiness: Pick<EntryPackageReadiness, "markReady" | "markNotReady">,
): Promise<void> {
  emitEvent("info", "correlation_replay_started");

  let result: CorrelationReplayResult;
  try {
    result = await repository.replay();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "correlation replay failed";
    emitEvent("error", "correlation_replay_failed", { reason });
    readiness.markNotReady(reason);
    emitEvent("error", "readiness_failed", { reason });
    return;
  }

  if (result.ok) {
    emitEvent("info", "correlation_replay_succeeded");
    readiness.markReady();
    emitEvent("info", "readiness_ready");
    return;
  }

  emitEvent("error", "correlation_replay_failed", { reason: result.reason });
  readiness.markNotReady(result.reason);
  emitEvent("error", "readiness_failed", { reason: result.reason });
}
