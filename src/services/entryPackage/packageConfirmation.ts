import { setTimeout as sleep } from "node:timers/promises";

import { compareDecimal, subtractDecimal } from "../../domain/exactDecimal.js";
import type { EarlyExecutionObservation } from "../../correlation/entryPackageExecutionRecord.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type {
  BybitGetOrderByLinkIdPayload,
  BybitGetOrderHistoryPayload,
} from "../../exchange/bybitOrderMapper.js";

// Starting point matches verifyPostCreateProtection.ts's existing
// bounded-retry mechanics (2 attempts / 300ms); tunable independently since
// this component's classification differs (design.md §10).
const CONFIRMATION_ATTEMPTS = 2;
const CONFIRMATION_RETRY_DELAY_MS = 300;

const LIVE_UNFILLED_STATUSES = new Set(["New", "Untriggered", "Triggered"]);
const FILLED_STATUSES = new Set(["Filled"]);
const PARTIAL_FILL_STATUSES = new Set(["PartiallyFilled"]);
const TERMINAL_WITHOUT_FILL_STATUSES = new Set(["Rejected", "Deactivated", "Cancelled"]);

export type DesiredPackageFields = {
  triggerPrice: string;
  qty: string;
  stopLoss: string;
  takeProfit: string;
};

export type PackageConfirmationOutcome =
  | { kind: "pending_confirmed" }
  | { kind: "full_fill"; observation: EarlyExecutionObservation }
  | { kind: "partial_fill"; observation: EarlyExecutionObservation }
  | { kind: "terminal_without_fill" }
  // Genuinely absent from both realtime and history, every query in the
  // bounded budget answering cleanly (no network/parse errors). Distinct
  // from "ambiguous" because it is the one outcome safe to treat as
  // grounds for resending a create (nothing found anywhere, confidently).
  | { kind: "not_found" }
  // Found in an inconclusive state (fields never matched, or a filled
  // order's fields didn't plausibly correspond to our own desired
  // package), or at least one query in the budget threw.
  | { kind: "ambiguous" };

export type CancelConfirmationOutcome =
  | { kind: "cancelled_confirmed" }
  | { kind: "filled_before_cancel"; observation: EarlyExecutionObservation }
  | { kind: "ambiguous" };

type BybitOrderView = {
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  stopLoss: string;
  takeProfit: string;
  cumExecQty: string;
  avgPrice: string;
};

// A REST query result is a genuine three-state outcome. Collapsing
// "queried and found nothing" and "the query itself failed" into a single
// undefined, as an earlier version of this module did, made a transient
// network/auth failure indistinguishable from confirmed absence — which for
// confirmEntryPackageCancelled meant a timeout could fabricate
// entry_package_absent. query_failed must never be treated as evidence of
// anything.
type QueryResult =
  | { status: "found"; item: BybitOrderView }
  | { status: "not_found" }
  | { status: "query_failed" };

// Bounded field-accuracy confirmation for a just-sent create/amend. Never
// returns success on partial confirmation (audit §26); on full or partial
// fill it returns only an aggregate observation, never a reconstructed fill
// history (design.md §10).
export async function confirmEntryPackage(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
  desired: DesiredPackageFields;
}): Promise<PackageConfirmationOutcome> {
  let sawQueryFailure = false;
  let sawInconclusiveFinding = false;

  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtime = await queryOrderView(() => input.bybit.getOrderByLinkId(input.getEntryOrderPayload));
    if (realtime.status === "query_failed") {
      sawQueryFailure = true;
    }

    if (realtime.status === "found") {
      const item = realtime.item;

      if (FILLED_STATUSES.has(item.orderStatus)) {
        if (fillFieldsPlausible(item, input.desired)) {
          return { kind: "full_fill", observation: toObservation(item, input.desired.qty) };
        }
        sawInconclusiveFinding = true;
      } else if (PARTIAL_FILL_STATUSES.has(item.orderStatus)) {
        if (fillFieldsPlausible(item, input.desired)) {
          return { kind: "partial_fill", observation: toObservation(item, input.desired.qty) };
        }
        sawInconclusiveFinding = true;
      } else if (LIVE_UNFILLED_STATUSES.has(item.orderStatus)) {
        if (fieldsMatch(item, input.desired)) {
          return { kind: "pending_confirmed" };
        }
        // Fields not yet consistent (e.g. an amend still propagating) —
        // retry within the bounded window rather than confirming early.
        sawInconclusiveFinding = true;
        if (attempt < CONFIRMATION_ATTEMPTS - 1) {
          await sleep(CONFIRMATION_RETRY_DELAY_MS);
        }
        continue;
      }
      // A realtime item reporting a terminal status falls through to the
      // order-history fallback below (design.md §10).
    }

    const history = await queryOrderView(() => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload));
    if (history.status === "query_failed") {
      sawQueryFailure = true;
    }

    if (history.status === "found") {
      const item = history.item;
      const cumulativeFilledQty = item.cumExecQty !== "" ? item.cumExecQty : "0";
      const hasFilledQty = compareDecimal(cumulativeFilledQty, "0") > 0;

      if (hasFilledQty) {
        if (fillFieldsPlausible(item, input.desired)) {
          const observation = toObservation(item, input.desired.qty);
          return compareDecimal(cumulativeFilledQty, input.desired.qty) >= 0
            ? { kind: "full_fill", observation }
            : { kind: "partial_fill", observation };
        }
        sawInconclusiveFinding = true;
      } else if (TERMINAL_WITHOUT_FILL_STATUSES.has(item.orderStatus)) {
        return { kind: "terminal_without_fill" };
      } else {
        sawInconclusiveFinding = true;
      }
    }

    if (attempt < CONFIRMATION_ATTEMPTS - 1) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  if (sawQueryFailure || sawInconclusiveFinding) {
    return { kind: "ambiguous" };
  }

  return { kind: "not_found" };
}

// Confirms a cancel: absence from realtime, or a terminal-without-fill
// status from either query, both count as a confirmed cancellation — but
// only when every query involved answered cleanly. A query_failed must
// never be treated as evidence of absence: a hung/erroring REST call must
// not be able to fabricate entry_package_absent. A fill observed during
// cancellation is reported distinctly — it must never be reported as
// cancelled_confirmed, since a position now exists on the exchange rather
// than nothing being live.
export async function confirmEntryPackageCancelled(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
  desiredQty: string;
}): Promise<CancelConfirmationOutcome> {
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtime = await queryOrderView(() => input.bybit.getOrderByLinkId(input.getEntryOrderPayload));

    if (realtime.status === "found" && hasFill(realtime.item)) {
      return { kind: "filled_before_cancel", observation: toObservation(realtime.item, input.desiredQty) };
    }

    const realtimeIsLive = realtime.status === "found" && LIVE_UNFILLED_STATUSES.has(realtime.item.orderStatus);
    if (!realtimeIsLive) {
      const history = await queryOrderView(() => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload));

      if (history.status === "found" && hasFill(history.item)) {
        return { kind: "filled_before_cancel", observation: toObservation(history.item, input.desiredQty) };
      }

      if (confirmsAbsenceOrTerminal(realtime) && confirmsAbsenceOrTerminal(history)) {
        return { kind: "cancelled_confirmed" };
      }
    }

    if (attempt < CONFIRMATION_ATTEMPTS - 1) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  return { kind: "ambiguous" };
}

function confirmsAbsenceOrTerminal(result: QueryResult): boolean {
  if (result.status === "not_found") {
    return true;
  }
  if (result.status === "found") {
    return TERMINAL_WITHOUT_FILL_STATUSES.has(result.item.orderStatus);
  }
  // query_failed proves nothing.
  return false;
}

function hasFill(item: BybitOrderView): boolean {
  if (FILLED_STATUSES.has(item.orderStatus) || PARTIAL_FILL_STATUSES.has(item.orderStatus)) {
    return true;
  }
  return item.cumExecQty !== "" && compareDecimal(item.cumExecQty, "0") > 0;
}

function fieldsMatch(item: BybitOrderView, desired: DesiredPackageFields): boolean {
  return (
    decimalEquals(item.triggerPrice, desired.triggerPrice) &&
    decimalEquals(item.qty, desired.qty) &&
    decimalEquals(item.stopLoss, desired.stopLoss) &&
    decimalEquals(item.takeProfit, desired.takeProfit)
  );
}

// A filled/partially-filled order is only trusted as evidence that *our*
// desired package was applied if every field the exchange did report is
// consistent with it. Fields the exchange omits (e.g. stopLoss/takeProfit
// may move to position-level after a fill on some venues) are not treated
// as a mismatch — but a present-and-different qty or triggerPrice must
// never be waved through as a successful application of a different
// package (field-level accuracy, not merely order existence).
function fillFieldsPlausible(item: BybitOrderView, desired: DesiredPackageFields): boolean {
  if (item.qty !== "" && !decimalEquals(item.qty, desired.qty)) {
    return false;
  }
  if (item.triggerPrice !== "" && !decimalEquals(item.triggerPrice, desired.triggerPrice)) {
    return false;
  }
  if (item.stopLoss !== "" && !decimalEquals(item.stopLoss, desired.stopLoss)) {
    return false;
  }
  if (item.takeProfit !== "" && !decimalEquals(item.takeProfit, desired.takeProfit)) {
    return false;
  }
  return true;
}

function decimalEquals(a: string, b: string): boolean {
  if (a === "" || b === "") {
    return false;
  }
  try {
    return compareDecimal(a, b) === 0;
  } catch {
    return false;
  }
}

function toObservation(item: BybitOrderView, desiredQty: string): EarlyExecutionObservation {
  const cumulativeFilledQty = item.cumExecQty !== "" ? item.cumExecQty : "0";
  const remainingQty =
    compareDecimal(desiredQty, cumulativeFilledQty) > 0
      ? subtractDecimal(desiredQty, cumulativeFilledQty)
      : "0";

  const observation: EarlyExecutionObservation = {
    order_status: item.orderStatus,
    cumulative_filled_qty: cumulativeFilledQty,
    remaining_qty: remainingQty,
    observed_at: new Date().toISOString(),
  };

  if (item.avgPrice !== "" && compareDecimal(item.avgPrice, "0") > 0) {
    observation.avg_execution_price = item.avgPrice;
  }

  return observation;
}

async function queryOrderView(query: () => Promise<unknown>): Promise<QueryResult> {
  let response: unknown;
  try {
    response = await query();
  } catch {
    return { status: "query_failed" };
  }

  const item = readOrderViewFromBybitList(response);
  return item === undefined ? { status: "not_found" } : { status: "found", item };
}

function readOrderViewFromBybitList(response: unknown): BybitOrderView | undefined {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return undefined;
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return undefined;
  }

  const list = (result as Record<string, unknown>).list;
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }

  const item = list[0];
  if (typeof item !== "object" || item === null) {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  return {
    orderStatus: readString(record, "orderStatus"),
    triggerPrice: readString(record, "triggerPrice"),
    qty: readString(record, "qty"),
    stopLoss: readString(record, "stopLoss"),
    takeProfit: readString(record, "takeProfit"),
    cumExecQty: readString(record, "cumExecQty"),
    avgPrice: readString(record, "avgPrice"),
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
