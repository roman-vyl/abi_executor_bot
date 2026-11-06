import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import { positionBindingGeometry, resolveRecordPhysicalPositionBinding } from "../../correlation/entryPackageExecutionRecord.js";
import { addDecimal, compareDecimal } from "../../domain/exactDecimal.js";
import { encodeBybitPositionIdx } from "../../exchange/bybitOrderMapper.js";
import type { ExchangeFactsStore } from "../../exchangeFacts/exchangeFactsStore.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import { resolveFirstAttributableFillAtMs, type FirstAttributableFillResolution } from "../entryPackage/packageConfirmation.js";
import { noteDiagnostic } from "../../observability/diagnostics.js";

// Constructed only from the same existing own-order observation that proved
// terminality and its final cumulative quantity. Never from SQLite or ACK.
export type EntryFillProof = {
  entryTerminal: boolean;
  cumulativeFilledQty: string;
  entryOrderId: string | null;
};
export type FirstFillFactsReader = Pick<ExchangeFactsStore, "readLinkForOrder" | "readFactsForOrder"> & { readonly category: string };
export const FIRST_FILL_READ_LIMIT = 1000;
export type LocalFirstFillResult =
  | { kind: "verified"; firstFillAtMs: number }
  | { kind: "unavailable"; reason: string };
const unavailable = (reason: string): LocalFirstFillResult => ({ kind: "unavailable", reason });
const positiveDecimal = (v: unknown): v is string =>
  typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v) && compareDecimal(v, "0") > 0;

// Synchronous, bounded reads through the owner's already-open store. A full
// LIMIT is conservatively unproven, even if its visible prefix sums correctly.
// Catching an I/O exception is NOT a deadline for synchronous better-sqlite3.
export function verifyLocalFirstFill(
  record: EntryPackageExecutionRecord,
  proof: EntryFillProof | undefined,
  reader: FirstFillFactsReader | undefined,
): LocalFirstFillResult {
  if (!proof?.entryTerminal || !proof.entryOrderId || !record.order_link_id || !reader) return unavailable("ineligible");
  try {
    if (reader.category !== record.exchange_category) return unavailable("store_category_mismatch");
    if (!positiveDecimal(proof.cumulativeFilledQty)) return unavailable("invalid_cumulative_quantity");
    const physical = resolveRecordPhysicalPositionBinding(record);
    if (!physical || !record.desired_entry) return unavailable("missing_binding");
    const positionIdx = encodeBybitPositionIdx(positionBindingGeometry(physical));
    const link = reader.readLinkForOrder(proof.entryOrderId);
    if (!link || link.orderId !== proof.entryOrderId || link.orderLinkId !== record.order_link_id ||
        link.strategyInstanceId !== record.strategy_instance_id || link.tradeCycleId !== record.trade_cycle_id ||
        link.generation !== record.generation || link.role !== "entry" || link.parentOrderLinkId !== null) return unavailable("link_mismatch");
    const facts = reader.readFactsForOrder(proof.entryOrderId, FIRST_FILL_READ_LIMIT);
    if (facts.length >= FIRST_FILL_READ_LIMIT) return unavailable("read_limit");
    const executions = new Map<string, { time: number; qty: string }>();
    for (const fact of facts) {
      if (fact.kind !== "execution") continue;
      const raw: unknown = JSON.parse(fact.rawJson);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailable("malformed_execution");
      const r = raw as Record<string, unknown>;
      const side = record.desired_entry.side === "long" ? "Buy" : "Sell";
      if (fact.orderId !== proof.entryOrderId || fact.orderLinkId !== record.order_link_id ||
          fact.symbol !== record.exchange_symbol || fact.execType !== "Trade" ||
          r.orderId !== fact.orderId || r.orderLinkId !== fact.orderLinkId || r.symbol !== fact.symbol ||
          r.execType !== fact.execType || r.execId !== fact.execId || r.side !== side ||
          (r.category !== undefined && r.category !== record.exchange_category) ||
          (r.positionIdx !== undefined && r.positionIdx !== positionIdx) ||
          !fact.execId || fact.parentOrderLinkId !== null ||
          typeof r.execTime !== "string" || !/^\d+$/.test(r.execTime) || !positiveDecimal(r.execQty)) return unavailable("execution_mismatch");
      const time = Number(r.execTime);
      if (!Number.isSafeInteger(time) || time <= 0 || time !== fact.exchangeTimeMs) return unavailable("invalid_time");
      const prev = executions.get(fact.execId);
      if (prev && (prev.time !== time || compareDecimal(prev.qty, r.execQty) !== 0)) return unavailable("conflicting_exec_id");
      executions.set(fact.execId, { time, qty: r.execQty });
    }
    let sum = "0";
    let first = Infinity;
    for (const { qty, time } of executions.values()) { sum = addDecimal(sum, qty); first = Math.min(first, time); }
    if (!executions.size || compareDecimal(sum, proof.cumulativeFilledQty) !== 0) return unavailable("incomplete_quantity");
    return { kind: "verified", firstFillAtMs: first };
  } catch { return unavailable("read_or_decode_failed"); }
}

// The shared REST-first policy for open-position and both recovery branches.
export async function captureFirstFill(input: {
  bybit: BybitAdapter;
  record: EntryPackageExecutionRecord;
  proof?: EntryFillProof;
  reader?: FirstFillFactsReader;
}): Promise<FirstAttributableFillResolution> {
  const { record } = input;
  if (record.first_fill_at_ms !== null) return { kind: "found", firstFillAtMs: record.first_fill_at_ms };
  if (!record.order_link_id) return { kind: "ambiguous" };
  const rest = await resolveFirstAttributableFillAtMs({
    bybit: input.bybit, category: record.exchange_category, symbol: record.exchange_symbol, orderLinkId: record.order_link_id,
  });
  if (rest.kind === "found") return rest;
  const local = verifyLocalFirstFill(record, input.proof, input.reader);
  noteDiagnostic(`first fill local ${local.kind === "verified" ? "verified" : local.reason}`);
  return local.kind === "verified" ? { kind: "found", firstFillAtMs: local.firstFillAtMs } : rest;
}
