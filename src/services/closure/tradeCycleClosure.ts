import { setTimeout as sleep } from "node:timers/promises";

import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import { addDecimal, compareDecimal } from "../../domain/exactDecimal.js";
import type { PositionBindingGeometry } from "../../domain/positionScope.js";
import type { TradeCycleClosure } from "../../domain/tradeCycleClosure.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import {
  classifyOwnCloseOrderOutcome,
  FILLED_STATUSES,
  LIVE_UNFILLED_STATUSES,
  PARTIAL_FILL_STATUSES,
  TERMINAL_WITHOUT_FILL_STATUSES,
} from "../entryPackage/packageConfirmation.js";
import { decodeExecutionListResponsePage } from "../entryPackage/executionListResponseDecoder.js";
import type {
  AttachedProtectionLeg,
  AttachedProtectionResolution,
  HistoryScan,
} from "../protection/nativeProtectionAttribution.js";

// abi-trade-cycle-closure-confirmation-v1. Completion of a cycle is proven
// only by full execution of an order ABI attributes to that exact pair:
// its own native protection child (by parentOrderLinkId) or its own close
// order (by close_order_link_id). The aggregate position, its size change,
// receipt of a Close command, and an accepted cancel are never proof.

export type { TradeCycleClosure };

// D1. Exactly one class per attribution result.
export type ProtectionClass =
  | { kind: "active"; anyLegFilled: false }
  | { kind: "neutralized"; anyLegFilled: false }
  | { kind: "completed"; anyLegFilled: true; reason: "stop_loss" | "take_profit"; orderId: string }
  | { kind: "partial_or_contradictory"; anyLegFilled: boolean }
  // Never proof of anything. anyLegFilled keeps an execution that was seen
  // on an own leg even when the class itself could not be established.
  | { kind: "unknown"; anyLegFilled: boolean };

export type CycleCompletionProof =
  | { kind: "completed"; closure: TradeCycleClosure }
  | { kind: "not_completed" }
  | { kind: "contradictory" };

export type OwnCloseOrderFate =
  | { kind: "matched"; orderId: string }
  | { kind: "incomplete"; executed: boolean }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

const BOUNDED_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;
const EXECUTION_LIST_LIMIT = "50";
const EXECUTION_LIST_PAGE_CAP = 10;

// The lifetime window of the cycle's own orders for the bounded history read:
// first fill when stored, else the record's creation. Undefined only for an
// unreadable creation time, which the caller reads as the single-page query.
export function historyScanFor(record: EntryPackageExecutionRecord): HistoryScan | undefined {
  if (record.first_fill_at_ms !== null && record.first_fill_at_ms !== undefined) {
    return { cycleStartMs: record.first_fill_at_ms };
  }
  const created = Date.parse(record.created_at);
  return Number.isNaN(created) ? undefined : { cycleStartMs: created };
}

export async function classifyOwnProtection(input: {
  bybit: BybitAdapter;
  category: "linear";
  symbol: string;
  resolution: AttachedProtectionResolution;
  ownExposure: string;
}): Promise<ProtectionClass> {
  const { resolution, ownExposure } = input;

  if (resolution.kind === "none") {
    // Not proof of absence while the cycle holds exposure: history lag and
    // the 50-row symbol history page can both hide the children.
    return compareDecimal(ownExposure, "0") === 0
      ? { kind: "neutralized", anyLegFilled: false }
      : { kind: "unknown", anyLegFilled: false };
  }
  if (resolution.kind === "ambiguous") {
    // abi-protection-history-bounded-lookup-v1 D3: one filled own leg proves
    // completion when the whole cycle lifetime was read and no other own
    // order is live. The cancelled opposite leg stays in Bybit history only
    // for a limited time, so it may be gone. The aggregate position is not a
    // condition: a sibling's position in the same scope must not hide this
    // cycle's own exit.
    if (resolution.reason === "partial_pair" && resolution.historyComplete === true && resolution.singleLeg !== undefined) {
      return classifySingleFilledLeg(input.bybit, input.category, input.symbol, resolution.singleLeg, ownExposure);
    }
    return { kind: "unknown", anyLegFilled: resolution.ownFillObserved === true };
  }

  const legs = [resolution.stop, resolution.take];
  // INVARIANT: once any own leg shows an execution, every class returned
  // below carries anyLegFilled: true. An unreadable execution list, an API
  // error or a decoder failure only makes the fill unprovable, never absent.
  const anyLegFilled = legs.some(legShowsFill);

  // Bybit reports cumExecQty on every order row; a row without it cannot
  // show how much the leg executed, so the whole result is not usable.
  if (legs.some((leg) => !isExactDecimal(leg.cumExecQty))) {
    return { kind: "unknown", anyLegFilled };
  }

  if (!anyLegFilled) {
    if (legs.some((leg) => LIVE_UNFILLED_STATUSES.has(leg.orderStatus))) {
      return { kind: "active", anyLegFilled: false };
    }
    if (legs.every((leg) => TERMINAL_WITHOUT_FILL_STATUSES.has(leg.orderStatus))) {
      return { kind: "neutralized", anyLegFilled: false };
    }
    return { kind: "unknown", anyLegFilled: false };
  }

  const filledLegs = legs.filter(legShowsFill);
  if (filledLegs.length > 1) {
    return { kind: "partial_or_contradictory", anyLegFilled: true };
  }

  const filled = filledLegs[0];
  const other = filled === resolution.stop ? resolution.take : resolution.stop;
  if (
    compareDecimal(ownExposure, "0") <= 0 ||
    !FILLED_STATUSES.has(filled.orderStatus) ||
    !isZeroDecimal(filled.leavesQty) ||
    compareDecimal(filled.cumExecQty, ownExposure) !== 0 ||
    !TERMINAL_WITHOUT_FILL_STATUSES.has(other.orderStatus)
  ) {
    return { kind: "partial_or_contradictory", anyLegFilled: true };
  }

  const executed = await sumOwnLegExecutions(input.bybit, input.category, input.symbol, filled);
  if (executed === undefined) {
    return { kind: "unknown", anyLegFilled: true };
  }
  if (compareDecimal(executed, ownExposure) !== 0) {
    return { kind: "partial_or_contradictory", anyLegFilled: true };
  }

  return {
    kind: "completed",
    anyLegFilled: true,
    reason: filled.role === "stop" ? "stop_loss" : "take_profit",
    orderId: filled.orderId,
  };
}

async function classifySingleFilledLeg(
  bybit: BybitAdapter,
  category: "linear",
  symbol: string,
  leg: AttachedProtectionLeg,
  ownExposure: string,
): Promise<ProtectionClass> {
  const anyLegFilled = legShowsFill(leg);
  if (
    !anyLegFilled ||
    !isExactDecimal(leg.cumExecQty) ||
    compareDecimal(ownExposure, "0") <= 0 ||
    !FILLED_STATUSES.has(leg.orderStatus) ||
    !isZeroDecimal(leg.leavesQty) ||
    compareDecimal(leg.cumExecQty, ownExposure) !== 0
  ) {
    return { kind: "unknown", anyLegFilled };
  }
  const executed = await sumOwnLegExecutions(bybit, category, symbol, leg);
  if (executed === undefined) {
    return { kind: "unknown", anyLegFilled: true };
  }
  if (compareDecimal(executed, ownExposure) !== 0) {
    return { kind: "unknown", anyLegFilled: true };
  }
  return {
    kind: "completed",
    anyLegFilled: true,
    reason: leg.role === "stop" ? "stop_loss" : "take_profit",
    orderId: leg.orderId,
  };
}

function legShowsFill(leg: AttachedProtectionLeg): boolean {
  if (FILLED_STATUSES.has(leg.orderStatus) || PARTIAL_FILL_STATUSES.has(leg.orderStatus)) {
    return true;
  }
  return isExactDecimal(leg.cumExecQty) && compareDecimal(leg.cumExecQty, "0") > 0;
}

// Sum of the filled leg's own Trade executions, keyed on the child's own
// orderId (its orderLinkId is empty). undefined when the list cannot be
// read completely.
async function sumOwnLegExecutions(
  bybit: BybitAdapter,
  category: "linear",
  symbol: string,
  leg: AttachedProtectionLeg,
): Promise<string | undefined> {
  let total = "0";
  let cursor: string | undefined;

  for (let page = 0; page < EXECUTION_LIST_PAGE_CAP; page += 1) {
    let response: unknown;
    try {
      response = await bybit.getExecutionList({
        category,
        symbol,
        orderId: leg.orderId,
        limit: EXECUTION_LIST_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch {
      return undefined;
    }

    const decoded = decodeExecutionListResponsePage({ response, expected: { category, symbol } });
    if (decoded.kind === "protocol_failure") {
      return undefined;
    }
    for (const execution of decoded.executions) {
      if (execution.execQty === "") {
        return undefined;
      }
      total = addDecimal(total, execution.execQty);
    }

    if (decoded.nextCursor === "") {
      return total;
    }
    cursor = decoded.nextCursor;
  }

  return undefined;
}

// Bounded re-read of this cycle's own close order fate against Q.
// `not_found` is returned only when every attempt of the bounded window
// answered a clean not_found: one empty read can be propagation lag of an
// order Bybit already accepted, and a resend under the same orderLinkId is
// not deduplicated by Bybit once the first order has filled (linear
// orderLinkId may be reused after Filled/Cancelled).
export async function resolveOwnCloseOrderFate(input: {
  bybit: BybitAdapter;
  category: "linear";
  symbol: string;
  closeOrderLinkId: string;
  ownExposure: string;
  binding: PositionBindingGeometry;
}): Promise<OwnCloseOrderFate> {
  const query = { category: input.category, symbol: input.symbol, orderLinkId: input.closeOrderLinkId, limit: "1" as const };
  let sawAmbiguous = false;

  for (let attempt = 0; attempt < BOUNDED_ATTEMPTS; attempt += 1) {
    const outcome = await classifyOwnCloseOrderOutcome({
      bybit: input.bybit,
      getCloseOrderPayload: query,
      getCloseOrderHistoryPayload: query,
      expectedQty: input.ownExposure,
      binding: input.binding,
    });

    if (outcome.kind === "matched") {
      return { kind: "matched", orderId: outcome.orderId };
    }
    if (outcome.kind === "zero_fill") {
      return { kind: "incomplete", executed: false };
    }
    if (outcome.kind === "qty_mismatch") {
      return { kind: "incomplete", executed: true };
    }
    if (outcome.kind !== "not_found") {
      sawAmbiguous = true;
    }
    if (attempt < BOUNDED_ATTEMPTS - 1) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  return sawAmbiguous ? { kind: "ambiguous" } : { kind: "not_found" };
}

// D2. The entry order must already be proven terminal by the caller.
export async function proveOwnCycleCompletion(input: {
  bybit: BybitAdapter;
  record: EntryPackageExecutionRecord;
  ownExposure: string;
  entryTerminal: boolean;
  protection: ProtectionClass;
  binding: PositionBindingGeometry;
}): Promise<CycleCompletionProof> {
  const { record, protection } = input;
  if (!input.entryTerminal || record.order_link_id === null) {
    return { kind: "not_completed" };
  }

  let close: OwnCloseOrderFate | { kind: "none" } = { kind: "none" };
  if (record.close_order_link_id !== null && compareDecimal(input.ownExposure, "0") > 0) {
    close = await resolveOwnCloseOrderFate({
      bybit: input.bybit,
      category: "linear",
      symbol: record.exchange_symbol,
      closeOrderLinkId: record.close_order_link_id,
      ownExposure: input.ownExposure,
      binding: input.binding,
    });
  }

  const closeExecuted = close.kind === "matched" || (close.kind === "incomplete" && close.executed);
  if (protection.anyLegFilled && closeExecuted) {
    return { kind: "contradictory" };
  }
  if (protection.kind === "partial_or_contradictory") {
    return { kind: "contradictory" };
  }

  if (close.kind === "matched") {
    if (close.orderId === "" || record.close_order_link_id === null) {
      return { kind: "not_completed" };
    }
    return {
      kind: "completed",
      closure: {
        strategy_instance_id: record.strategy_instance_id,
        trade_cycle_id: record.trade_cycle_id,
        reason: "runtime_signal",
        order_id: close.orderId,
        order_link_id: record.close_order_link_id,
        parent_order_link_id: null,
      },
    };
  }

  if (protection.kind === "completed") {
    return {
      kind: "completed",
      closure: protectionClosure(record, protection),
    };
  }

  return { kind: "not_completed" };
}

export function protectionClosure(
  record: EntryPackageExecutionRecord,
  protection: Extract<ProtectionClass, { kind: "completed" }>,
): TradeCycleClosure {
  if (record.order_link_id === null) {
    throw new Error("protection closure needs the entry orderLinkId");
  }
  return {
    strategy_instance_id: record.strategy_instance_id,
    trade_cycle_id: record.trade_cycle_id,
    reason: protection.reason,
    order_id: protection.orderId,
    order_link_id: null,
    parent_order_link_id: record.order_link_id,
  };
}

// D3. The answer a terminal_closed record gives with no exchange call.
// Records written before this change carry no closure fields: a close
// whose own order identity is stored still answers runtime_signal.
export function storedClosure(record: EntryPackageExecutionRecord): TradeCycleClosure | null {
  if (record.status !== "terminal_closed") {
    return null;
  }

  const reason = record.closure_reason ?? null;
  const orderId = record.closure_order_id ?? null;
  if (reason !== null && orderId !== null) {
    return {
      strategy_instance_id: record.strategy_instance_id,
      trade_cycle_id: record.trade_cycle_id,
      reason,
      order_id: orderId,
      order_link_id: record.closure_order_link_id ?? null,
      parent_order_link_id: record.closure_parent_order_link_id ?? null,
    };
  }

  if (reason === null && record.close_order_link_id !== null && isNonEmpty(record.close_order_id)) {
    return {
      strategy_instance_id: record.strategy_instance_id,
      trade_cycle_id: record.trade_cycle_id,
      reason: "runtime_signal",
      order_id: record.close_order_id,
      order_link_id: record.close_order_link_id,
      parent_order_link_id: null,
    };
  }

  return null;
}

// The one record shape for a durable completion: terminal_closed and the
// closure fields in the same save. Leaving the active statuses is what
// releases the physical scope, so this is written only after proof.
export function terminalClosedRecord(
  record: EntryPackageExecutionRecord,
  closure: TradeCycleClosure | null,
): EntryPackageExecutionRecord {
  return {
    ...record,
    status: "terminal_closed",
    pending_action: null,
    closure_reason: closure?.reason ?? null,
    closure_order_id: closure?.order_id ?? null,
    closure_order_link_id: closure?.order_link_id ?? null,
    closure_parent_order_link_id: closure?.parent_order_link_id ?? null,
    updated_at: new Date().toISOString(),
  };
}

function isNonEmpty(value: string | null): value is string {
  return value !== null && value !== "";
}

function isExactDecimal(text: string): boolean {
  if (text === "") {
    return false;
  }
  try {
    compareDecimal(text, "0");
    return true;
  } catch {
    return false;
  }
}

function isZeroDecimal(text: string): boolean {
  return isExactDecimal(text) && compareDecimal(text, "0") === 0;
}
