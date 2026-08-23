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
  | "terminal_unfilled"
  | "terminal_closed";

// The one domain fact both open-position resolution (its `durably_closed`
// bucket) and physical-scope release share: a binding in any of these
// statuses is durably proven to admit no position and no order that
// could still produce one, without needing a live exchange query. Shared
// here rather than left as independently-maintained sets. `terminal_closed`
// additionally means the trade cycle was explicitly and provably ended by a
// close request — unlike `absent` and `terminal_unfilled`, entry-package
// execution never lets it be resurrected by a later entry-package request
// for the same pair.
export function isDurablyClosedEntryPackageStatus(
  status: EntryPackageExecutionStatus,
): status is "absent" | "terminal_unfilled" | "terminal_closed" {
  return status === "absent" || status === "terminal_unfilled" || status === "terminal_closed";
}

// Which external command was last dispatched (or is about to be) for the
// record's current binding, so a repeat PUT arriving after a crash or an
// inconclusive confirmation knows exactly what to resend rather than only
// being able to re-query. null once the current binding's outcome is
// definitively known (applied, terminal_unfilled, or absent). These are the
// only values current write paths ever produce.
export type EntryPackagePendingAction = "create" | "cancel";

// Historical pending_action values a durable store may still contain from
// before abi-entry-cycle-recovery-v1 removed in-place amend and atomic
// cancel-and-create. No write path in this codebase produces these anymore
// — they exist solely so replay of an existing store does not fail
// readiness against records written by an earlier version of this service.
// An ambiguous legacy "amend" is inherently unsafe to resend as CREATE: the
// stored desired_entry may already describe a replacement B while the
// physical order on the exchange could still be the old A, so no current
// code path infers or resends anything from these values — see
// shouldResendPendingAction in entryPackageApplicationService.ts, the one
// place that reads pending_action to decide whether to resend.
export type LegacyEntryPackagePendingAction = "amend" | "cancel_and_create";

export type StoredEntryPackagePendingAction = EntryPackagePendingAction | LegacyEntryPackagePendingAction;

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
  // The close operation's own attributable order identity for this
  // generation — independent of order_link_id/order_id above, which name
  // the entry order. Non-null once a close order has been dispatched for
  // this generation (abi-pair-scoped-close-execution-v1); null while none
  // has, and reset to null only by a fresh generation's provisional
  // record (a new generation can never begin while a close identity for
  // the prior one is unresolved — see that change's design.md). close_order_id
  // is audit-only: every lookup keys on close_order_link_id, mirroring how
  // order_id is never used for lookup either.
  close_order_link_id: string | null;
  close_order_id: string | null;
  generation: number;
  status: EntryPackageExecutionStatus;
  early_execution_observation: EarlyExecutionObservation | null;
  binding_history: BindingHistoryEntry[];
  // Widened to also accept legacy values on read/replay — see
  // StoredEntryPackagePendingAction. Current write paths only ever
  // construct "create" | "cancel" | null literals.
  pending_action: StoredEntryPackagePendingAction | null;
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
  "terminal_closed",
]);

// Includes the legacy values (see LegacyEntryPackagePendingAction) so replay
// accepts records written before amend/cancel-and-create were removed.
const PENDING_ACTIONS: ReadonlySet<StoredEntryPackagePendingAction> = new Set([
  "create",
  "cancel",
  "amend",
  "cancel_and_create",
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
    // Unlike order_link_id/order_id above, these two tolerate the key being
    // entirely absent (undefined), not just null: they did not exist on
    // durable rows written before abi-pair-scoped-close-execution-v1
    // shipped, and this codebase has no schema-migration subsystem to
    // backfill them. replay() normalizes a missing key to null before this
    // function runs (see entryPackageCorrelationRepository.ts), so this
    // tolerance is defense-in-depth for any other caller, not the only
    // safeguard against a stray `undefined` reaching close-execution logic
    // that assumes `string | null`.
    (record.close_order_link_id === undefined ||
      record.close_order_link_id === null ||
      typeof record.close_order_link_id === "string") &&
    (record.close_order_id === undefined ||
      record.close_order_id === null ||
      typeof record.close_order_id === "string") &&
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
        PENDING_ACTIONS.has(record.pending_action as StoredEntryPackagePendingAction))) &&
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
