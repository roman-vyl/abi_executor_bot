import type { DesiredEntryDto } from "../domain/entryPackageApi.js";

export type EntryPackageExecutionStatus =
  | "pending_create"
  | "applied"
  | "pending_replace"
  | "pending_cancel"
  | "absent"
  | "create_failed"
  | "unknown"
  | "terminal_unfilled";

export type EarlyExecutionObservation = {
  order_status: string;
  cumulative_filled_qty: string;
  remaining_qty: string;
  avg_execution_price?: string;
  observed_at: string;
};

export type BindingHistoryEndReason = "replaced" | "cancelled" | "superseded" | "exchange_terminal" | null;

export type BindingHistoryEntry = {
  order_link_id: string;
  order_id: string | null;
  generation: number;
  role: "entry";
  exchange_symbol: string;
  started_at: string;
  ended_at: string | null;
  end_reason: BindingHistoryEndReason;
};

export type EntryPackageExecutionRecord = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  ticker: string;
  exchange_symbol: string;
  created_at: string;
  updated_at: string;
  desired_entry: DesiredEntryDto | null;
  risk_multiplier: string;
  calculated_quantity: string | null;
  order_link_id: string | null;
  order_id: string | null;
  generation: number;
  status: EntryPackageExecutionStatus;
  early_execution_observation: EarlyExecutionObservation | null;
  binding_history: BindingHistoryEntry[];
};

// Opaque path identifiers may contain any decoded character, so the
// composite key is built from a JSON array rather than a delimited string
// to avoid collisions such as ("a/b", "c") vs ("a", "b/c").
export function correlationRecordKey(strategyInstanceId: string, tradeCycleId: string): string {
  return JSON.stringify([strategyInstanceId, tradeCycleId]);
}
