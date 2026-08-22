import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import { isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import { closeBindingFrom } from "../entryPackage/entryPackageApplicationService.js";

// Recovery Convergence (abi-entry-cycle-recovery-convergence-v1): given an
// outcome Recovery Resolution has already positively proven, and the
// current correlation record, decide whether the durable record's status
// (and, where specified, pending_action and related fields) should
// converge toward that proven outcome, or remain unchanged. Deliberately
// pure — no HTTP, no Bybit adapter, no mutex, no repository access, and no
// internal clock read (`now` is supplied by the caller). The application
// layer (EntryCycleRecoveryResolutionService) is solely responsible for
// acquiring the pair mutex, re-reading the record fresh under it, checking
// binding continuity against the record the outcome was resolved against,
// and applying any returned patch.
export type RecoveryConvergenceOutcome =
  | { state: "entry_order_live" }
  | { state: "position_open" }
  | { state: "terminal_without_fill" }
  | { state: "terminal_after_fill" }
  | { state: "entry_order_not_found" };

export type ConvergenceDecision =
  | { kind: "no_change" }
  | { kind: "converge"; patch: Partial<EntryPackageExecutionRecord> };

export function evaluateRecoveryConvergence(
  outcome: RecoveryConvergenceOutcome,
  record: EntryPackageExecutionRecord,
  now: string,
): ConvergenceDecision {
  // A durably closed record is never converged — Resolution itself never
  // reaches this policy for one (it answers directly from the status), but
  // this stays defensive-pure rather than assuming the caller's own guard.
  if (isDurablyClosedEntryPackageStatus(record.status)) {
    return { kind: "no_change" };
  }

  switch (outcome.state) {
    case "entry_order_live":
    case "position_open":
      return convergeToApplied(record, now);
    case "terminal_without_fill":
      return convergeToTerminalUnfilled(record, now);
    case "terminal_after_fill":
      return convergeToTerminalClosed(record, now);
    case "entry_order_not_found":
      return convergeToAbsent(record, now);
    default:
      return exhaustive(outcome);
  }
}

// entry_order_live / position_open both carry AppliedEntryPackage: this
// cycle's own desired_entry is genuinely live on the exchange. Eligible
// only when no in-flight pending_action other than "create" is outstanding
// (a "cancel" intent, or a legacy "amend"/"cancel_and_create", is left to
// its own dedicated corrective/refusal path — never silently overridden),
// and only when order_id is already durably known (a pending_create record,
// whose order_id is always null until confirmed, is symmetrically excluded
// from both outcomes — see design.md's open question on extending
// RecoveryEntryOrderSignal to carry orderId, deliberately deferred).
function convergeToApplied(record: EntryPackageExecutionRecord, now: string): ConvergenceDecision {
  if (record.pending_action !== null && record.pending_action !== "create") {
    return { kind: "no_change" };
  }
  if (record.order_id === null) {
    return { kind: "no_change" };
  }
  if (record.status === "applied" && record.pending_action === null) {
    return { kind: "no_change" };
  }

  const patch: Partial<EntryPackageExecutionRecord> = { status: "applied", updated_at: now };
  if (record.pending_action === "create") {
    patch.pending_action = null;
  }
  return { kind: "converge", patch };
}

// terminal_without_fill proves this cycle's own entry order is terminal
// with zero cumulative fill. Same in-flight-pending_action eligibility as
// convergeToApplied (a "cancel" intent is left to its own dedicated
// confirmation path). Reuses entry-package-execution's own existing
// closeBindingFrom construction for the appended binding_history entry —
// never a second, divergent shape.
function convergeToTerminalUnfilled(record: EntryPackageExecutionRecord, now: string): ConvergenceDecision {
  if (record.pending_action !== null && record.pending_action !== "create") {
    return { kind: "no_change" };
  }
  if (record.status === "terminal_unfilled") {
    return { kind: "no_change" };
  }

  return {
    kind: "converge",
    patch: {
      status: "terminal_unfilled",
      pending_action: null,
      updated_at: now,
      binding_history: [...record.binding_history, closeBindingFrom(record, "exchange_terminal", now)],
    },
  };
}

// terminal_after_fill proves this cycle's own entry filled and its own
// close order's confirmed fill exactly matches. Reachable in practice only
// with pending_action already null (a close identity coexisting with any
// in-flight pending_action is a structural contradiction Resolution itself
// does not model) — any non-null pending_action fails closed defensively.
// Reuses close-execution's own existing terminal-closed write shape
// (status + pending_action only, no binding_history append — close-
// execution's own persistTerminal() does not append one either).
function convergeToTerminalClosed(record: EntryPackageExecutionRecord, now: string): ConvergenceDecision {
  if (record.pending_action !== null) {
    return { kind: "no_change" };
  }
  if (record.status === "terminal_closed") {
    return { kind: "no_change" };
  }

  return {
    kind: "converge",
    patch: { status: "terminal_closed", pending_action: null, updated_at: now },
  };
}

// entry_order_not_found's own eligibility is already fully gated upstream
// (status in {pending_create, unknown}, pending_action exactly "create", no
// durable fill/close/observation evidence — abi-entry-order-not-found-
// recovery-v1). Convergence here only defines the durable target, reusing
// entry-package-execution's own existing successful-CANCEL/ambiguous-
// create-absence write shape exactly (status:"absent", identity cleared,
// binding_history closed with end_reason "cancelled") — never a second,
// divergent shape.
function convergeToAbsent(record: EntryPackageExecutionRecord, now: string): ConvergenceDecision {
  if (record.status === "absent") {
    return { kind: "no_change" };
  }

  return {
    kind: "converge",
    patch: {
      desired_entry: null,
      order_link_id: null,
      order_id: null,
      status: "absent",
      pending_action: null,
      current_binding_started_at: null,
      updated_at: now,
      binding_history: [...record.binding_history, closeBindingFrom(record, "cancelled", now)],
    },
  };
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled RecoveryConvergenceOutcome: ${JSON.stringify(value)}`);
}
