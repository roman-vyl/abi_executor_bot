import type { DesiredEntryDto } from "../domain/entryPackageApi.js";
import type { ExchangeInstrumentCategory } from "../exchange/exchangeInstrumentResolver.js";

export type EntryPackageExecutionStatus =
  | "pending_create"
  | "applied"
  | "pending_replace"
  | "pending_cancel"
  | "absent"
  | "create_failed"
  | "unknown"
  | "terminal_unfilled";

// The one domain fact both open-position resolution (its `durably_closed`
// bucket) and physical-scope release share: a binding in either of these
// two statuses is durably proven to admit no position and no order that
// could still produce one, without needing a live exchange query. Shared
// here rather than left as two independently-maintained two-element sets
// (position-scope-exclusivity design.md Decision 10).
export function isDurablyClosedEntryPackageStatus(
  status: EntryPackageExecutionStatus,
): status is "absent" | "terminal_unfilled" {
  return status === "absent" || status === "terminal_unfilled";
}

// Which external command was last dispatched (or is about to be) for the
// record's current binding, so a repeat PUT arriving after a crash or an
// inconclusive confirmation knows exactly what to resend rather than only
// being able to re-query. null once the current binding's outcome is
// definitively known (applied, terminal_unfilled, or absent).
export type EntryPackagePendingAction = "create" | "amend" | "cancel_and_create" | "cancel";

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
  exchange_category: ExchangeInstrumentCategory;
  started_at: string;
  ended_at: string | null;
  end_reason: BindingHistoryEndReason;
};

export type EntryPackageExecutionRecord = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  ticker: string;
  exchange_symbol: string;
  // "" only for a record that has never had a real binding (persistAbsentNoHistory) —
  // every binding that has actually gone through createOrder stores "linear" or "spot".
  exchange_category: ExchangeInstrumentCategory | "";
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
  pending_action: EntryPackagePendingAction | null;
  // When the current top-level binding (order_link_id/order_id/generation)
  // was established, tracked separately from updated_at (which advances on
  // every unrelated revalidation) so a later binding_history entry's
  // started_at reflects the binding's real lifetime, not the record's most
  // recent write.
  current_binding_started_at: string | null;
};

// Opaque path identifiers may contain any decoded character, so the
// composite key is built from a JSON array rather than a delimited string
// to avoid collisions such as ("a/b", "c") vs ("a", "b/c").
export function correlationRecordKey(strategyInstanceId: string, tradeCycleId: string): string {
  return JSON.stringify([strategyInstanceId, tradeCycleId]);
}

const STATUSES: ReadonlySet<EntryPackageExecutionStatus> = new Set([
  "pending_create",
  "applied",
  "pending_replace",
  "pending_cancel",
  "absent",
  "create_failed",
  "unknown",
  "terminal_unfilled",
]);

const PENDING_ACTIONS: ReadonlySet<EntryPackagePendingAction> = new Set([
  "create",
  "amend",
  "cancel_and_create",
  "cancel",
]);

const END_REASONS: ReadonlySet<Exclude<BindingHistoryEndReason, null>> = new Set([
  "replaced",
  "cancelled",
  "superseded",
  "exchange_terminal",
]);

// Top-level exchange_category additionally allows "" (a record that has
// never had a real binding); a binding_history entry always describes a
// binding that was actually created, so "" is never valid there.
const RECORD_CATEGORIES: ReadonlySet<ExchangeInstrumentCategory | ""> = new Set(["", "linear", "spot"]);
const BINDING_CATEGORIES: ReadonlySet<ExchangeInstrumentCategory> = new Set(["linear", "spot"]);

// A syntactically-valid JSON line that does not actually conform to the
// record shape (e.g. from a future schema migration bug, or partial
// corruption that still happens to parse) must not be silently accepted
// into readiness-gated state. Every replayed line is checked against this
// before being indexed.
export function isValidEntryPackageExecutionRecord(value: unknown): value is EntryPackageExecutionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.strategy_instance_id) &&
    isNonEmptyString(record.trade_cycle_id) &&
    isNonEmptyString(record.ticker) &&
    typeof record.exchange_symbol === "string" &&
    typeof record.exchange_category === "string" &&
    RECORD_CATEGORIES.has(record.exchange_category as ExchangeInstrumentCategory | "") &&
    isNonEmptyString(record.created_at) &&
    isNonEmptyString(record.updated_at) &&
    (record.desired_entry === null || isValidDesiredEntry(record.desired_entry)) &&
    typeof record.risk_multiplier === "string" &&
    (record.calculated_quantity === null || typeof record.calculated_quantity === "string") &&
    (record.order_link_id === null || typeof record.order_link_id === "string") &&
    (record.order_id === null || typeof record.order_id === "string") &&
    typeof record.generation === "number" &&
    Number.isInteger(record.generation) &&
    record.generation >= 0 &&
    typeof record.status === "string" &&
    STATUSES.has(record.status as EntryPackageExecutionStatus) &&
    (record.early_execution_observation === null ||
      isValidEarlyExecutionObservation(record.early_execution_observation)) &&
    Array.isArray(record.binding_history) &&
    record.binding_history.every(isValidBindingHistoryEntry) &&
    (record.pending_action === null ||
      (typeof record.pending_action === "string" &&
        PENDING_ACTIONS.has(record.pending_action as EntryPackagePendingAction))) &&
    (record.current_binding_started_at === null || typeof record.current_binding_started_at === "string")
  );
}

function isValidDesiredEntry(value: unknown): value is DesiredEntryDto {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (entry.side === "long" || entry.side === "short") &&
    typeof entry.source_plan_bar_open_time_ms === "number" &&
    typeof entry.planned_entry_price === "string" &&
    typeof entry.initial_stop_price === "string" &&
    typeof entry.initial_take_price === "string" &&
    typeof entry.locked_exit_profile === "string"
  );
}

function isValidEarlyExecutionObservation(value: unknown): value is EarlyExecutionObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const observation = value as Record<string, unknown>;
  return (
    typeof observation.order_status === "string" &&
    typeof observation.cumulative_filled_qty === "string" &&
    typeof observation.remaining_qty === "string" &&
    (observation.avg_execution_price === undefined || typeof observation.avg_execution_price === "string") &&
    typeof observation.observed_at === "string"
  );
}

function isValidBindingHistoryEntry(value: unknown): value is BindingHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.order_link_id === "string" &&
    (entry.order_id === null || typeof entry.order_id === "string") &&
    typeof entry.generation === "number" &&
    entry.role === "entry" &&
    typeof entry.exchange_symbol === "string" &&
    typeof entry.exchange_category === "string" &&
    BINDING_CATEGORIES.has(entry.exchange_category as ExchangeInstrumentCategory) &&
    typeof entry.started_at === "string" &&
    (entry.ended_at === null || typeof entry.ended_at === "string") &&
    (entry.end_reason === null ||
      (typeof entry.end_reason === "string" &&
        END_REASONS.has(entry.end_reason as Exclude<BindingHistoryEndReason, null>)))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
