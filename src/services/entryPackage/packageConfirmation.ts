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
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtimeItem = await tryReadOrderView(() => input.bybit.getOrderByLinkId(input.getEntryOrderPayload));

    if (realtimeItem !== undefined) {
      if (FILLED_STATUSES.has(realtimeItem.orderStatus)) {
        return { kind: "full_fill", observation: toObservation(realtimeItem, input.desired.qty) };
      }

      if (PARTIAL_FILL_STATUSES.has(realtimeItem.orderStatus)) {
        return { kind: "partial_fill", observation: toObservation(realtimeItem, input.desired.qty) };
      }

      if (LIVE_UNFILLED_STATUSES.has(realtimeItem.orderStatus)) {
        if (fieldsMatch(realtimeItem, input.desired)) {
          return { kind: "pending_confirmed" };
        }
        // Fields not yet consistent (e.g. an amend still propagating) —
        // retry within the bounded window rather than confirming early.
        if (attempt < CONFIRMATION_ATTEMPTS - 1) {
          await sleep(CONFIRMATION_RETRY_DELAY_MS);
        }
        continue;
      }
      // A realtime item reporting a terminal status falls through to the
      // order-history fallback below (design.md §10).
    }

    const historyItem = await tryReadOrderView(() =>
      input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload),
    );

    if (historyItem !== undefined) {
      const cumulativeFilledQty = historyItem.cumExecQty !== "" ? historyItem.cumExecQty : "0";
      const hasFill = compareDecimal(cumulativeFilledQty, "0") > 0;

      if (hasFill) {
        const observation = toObservation(historyItem, input.desired.qty);
        return compareDecimal(cumulativeFilledQty, input.desired.qty) >= 0
          ? { kind: "full_fill", observation }
          : { kind: "partial_fill", observation };
      }

      if (TERMINAL_WITHOUT_FILL_STATUSES.has(historyItem.orderStatus)) {
        return { kind: "terminal_without_fill" };
      }
    }

    if (attempt < CONFIRMATION_ATTEMPTS - 1) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  return { kind: "ambiguous" };
}

// Confirms a cancel: absence from realtime, or a terminal-without-fill
// status from either query, both count as a confirmed cancellation. A fill
// observed during cancellation is reported distinctly — it must never be
// reported as cancelled_confirmed, since a position now exists on the
// exchange rather than nothing being live.
export async function confirmEntryPackageCancelled(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
  desiredQty: string;
}): Promise<CancelConfirmationOutcome> {
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtimeItem = await tryReadOrderView(() => input.bybit.getOrderByLinkId(input.getEntryOrderPayload));

    if (realtimeItem !== undefined && hasFill(realtimeItem)) {
      return { kind: "filled_before_cancel", observation: toObservation(realtimeItem, input.desiredQty) };
    }

    if (realtimeItem === undefined || TERMINAL_WITHOUT_FILL_STATUSES.has(realtimeItem.orderStatus)) {
      const historyItem = await tryReadOrderView(() =>
        input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload),
      );

      if (historyItem !== undefined && hasFill(historyItem)) {
        return { kind: "filled_before_cancel", observation: toObservation(historyItem, input.desiredQty) };
      }

      if (historyItem === undefined || TERMINAL_WITHOUT_FILL_STATUSES.has(historyItem.orderStatus)) {
        return { kind: "cancelled_confirmed" };
      }
    }

    if (attempt < CONFIRMATION_ATTEMPTS - 1) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  return { kind: "ambiguous" };
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

async function tryReadOrderView(query: () => Promise<unknown>): Promise<BybitOrderView | undefined> {
  let response: unknown;
  try {
    response = await query();
  } catch {
    return undefined;
  }

  return readOrderViewFromBybitList(response);
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
