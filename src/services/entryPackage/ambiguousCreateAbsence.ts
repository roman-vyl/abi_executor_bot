import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import type { DesiredEntryDto } from "../../domain/entryPackageApi.js";
import type { BybitAdapter, BybitOrderSide } from "../../exchange/bybitAdapter.js";
import { resolveFirstAttributableFillAtMs } from "./packageConfirmation.js";

export const AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS = 3;
export const AMBIGUOUS_CREATE_ABSENCE_RETRY_DELAY_MS = 300;
export const BYBIT_TRUSTWORTHY_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AmbiguousCreateAbsenceCandidate = {
  bindingStartedAtMs: number;
  desiredSide: DesiredEntryDto["side"];
};

export function ambiguousCreateAbsenceCandidate(
  record: EntryPackageExecutionRecord,
): AmbiguousCreateAbsenceCandidate | undefined {
  if (
    (record.status !== "pending_create" && record.status !== "unknown") ||
    record.pending_action !== "create" ||
    record.desired_entry === null ||
    record.order_link_id === null ||
    record.order_link_id.length === 0 ||
    record.early_execution_observation !== null ||
    record.first_fill_at_ms !== null ||
    record.close_order_link_id !== null ||
    record.close_order_id !== null ||
    record.current_binding_started_at === null
  ) {
    return undefined;
  }

  const bindingStartedAtMs = parseCanonicalIsoTimestamp(record.current_binding_started_at);
  if (bindingStartedAtMs === undefined) {
    return undefined;
  }

  return { bindingStartedAtMs, desiredSide: record.desired_entry.side };
}

export async function observeAmbiguousCreateAbsenceAttempt(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  orderLinkId: string;
  desiredSide: DesiredEntryDto["side"];
}): Promise<"clean_absent" | "tainted"> {
  const executionEvidence = await resolveFirstAttributableFillAtMs({
    bybit: input.bybit,
    category: input.category,
    symbol: input.symbol,
    orderLinkId: input.orderLinkId,
  });
  if (executionEvidence.kind !== "no_executions_found") {
    return "tainted";
  }

  let positionEvidence;
  try {
    positionEvidence = await input.bybit.queryPositionForInstrument({
      category: input.category,
      symbol: input.symbol,
    });
  } catch {
    return "tainted";
  }

  if (positionEvidence.kind === "failure") {
    return "tainted";
  }
  if (positionEvidence.kind === "no_position") {
    return "clean_absent";
  }

  return positionSideMatches(positionEvidence.row.side, input.desiredSide)
    ? "clean_absent"
    : "tainted";
}

export async function completedObservationIsFresh(input: {
  bybit: BybitAdapter;
  bindingStartedAtMs: number;
}): Promise<boolean> {
  let response: unknown;
  try {
    response = await input.bybit.getServerTime();
  } catch {
    return false;
  }

  const serverNowMs = decodeBybitServerTimeMs(response);
  if (serverNowMs === undefined) {
    return false;
  }

  const ageMs = serverNowMs - input.bindingStartedAtMs;
  return ageMs >= 0 && ageMs < BYBIT_TRUSTWORTHY_EVIDENCE_WINDOW_MS;
}

export function decodeBybitServerTimeMs(response: unknown): number | undefined {
  if (!isRecord(response) || response.retCode !== 0 || !isRecord(response.result)) {
    return undefined;
  }

  const timeSecond = response.result.timeSecond;
  if (typeof timeSecond !== "string" || !/^(0|[1-9][0-9]*)$/.test(timeSecond)) {
    return undefined;
  }

  const seconds = Number(timeSecond);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    return undefined;
  }

  return seconds * 1000;
}

function parseCanonicalIsoTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  try {
    return new Date(parsed).toISOString() === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function positionSideMatches(rowSide: BybitOrderSide, desiredSide: DesiredEntryDto["side"]): boolean {
  return (rowSide === "Buy" && desiredSide === "long") || (rowSide === "Sell" && desiredSide === "short");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
