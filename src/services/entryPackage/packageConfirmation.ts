import { setTimeout as sleep } from "node:timers/promises";

import { compareDecimal, subtractDecimal } from "../../domain/exactDecimal.js";
import type { EarlyExecutionObservation } from "../../correlation/entryPackageExecutionRecord.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type {
  BybitGetOrderByLinkIdPayload,
  BybitGetOrderHistoryPayload,
} from "../../exchange/bybitOrderMapper.js";
import type { BybitOrderView, ExpectedOrderIdentity } from "./orderQueryResponseDecoder.js";
import { decodeOrderQueryResponse } from "./orderQueryResponseDecoder.js";

// Starting point matches verifyPostCreateProtection.ts's existing
// bounded-retry mechanics (2 attempts / 300ms); tunable independently since
// this component's classification differs from protection read-back.
const CONFIRMATION_ATTEMPTS = 2;
const CONFIRMATION_RETRY_DELAY_MS = 300;

// Exported for reuse by entry-cycle-recovery-resolution, which composes its
// own order-side signal from these same status sets rather than inventing a
// second, independently-maintained classification.
export const LIVE_UNFILLED_STATUSES = new Set(["New", "Untriggered", "Triggered"]);
export const FILLED_STATUSES = new Set(["Filled"]);
export const PARTIAL_FILL_STATUSES = new Set(["PartiallyFilled"]);
export const TERMINAL_WITHOUT_FILL_STATUSES = new Set(["Rejected", "Deactivated", "Cancelled"]);

export type ExpectedPackageFields = {
  qty: string;
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
  // Found in an inconclusive state (quantity never matched, or a filled
  // order's quantity didn't plausibly correspond to our own command), or
  // at least one query in the budget threw.
  | { kind: "ambiguous" };

export type CancelConfirmationOutcome =
  | { kind: "cancelled_confirmed" }
  | { kind: "filled_before_cancel"; observation: EarlyExecutionObservation }
  | { kind: "ambiguous" };

// A REST query result is a genuine three-state outcome. Collapsing
// "queried and found nothing" and "the query itself failed" into a single
// undefined would make a transient network/auth failure indistinguishable
// from confirmed absence — which for confirmEntryPackageCancelled could
// fabricate entry_package_absent. query_failed must never be treated as
// evidence of anything.
type QueryResult =
  | { status: "found"; item: BybitOrderView }
  | { status: "not_found" }
  | { status: "query_failed" };

// Bounded identity/state confirmation for a just-sent create, or for
// revalidation of an already durable binding. The successful write itself
// proves Bybit accepted the command; the read-back proves that the same
// category/symbol/orderLinkId is now represented by a valid exchange order
// in the expected quantity and a recognized state. Bybit's returned price
// fields are still strictly decoded as exact decimals, but are authoritative
// exchange representation and are intentionally not compared with the raw
// Strategy Engine decimal text sent in the write.
export async function confirmEntryPackage(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
  expected: ExpectedPackageFields;
}): Promise<PackageConfirmationOutcome> {
  const realtimeIdentity: ExpectedOrderIdentity = input.getEntryOrderPayload;
  const historyIdentity: ExpectedOrderIdentity = input.getEntryOrderHistoryPayload;

  let sawQueryFailure = false;
  let sawInconclusiveFinding = false;

  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtime = await queryOrderView(
      () => input.bybit.getOrderByLinkId(input.getEntryOrderPayload),
      realtimeIdentity,
    );
    if (realtime.status === "query_failed") {
      sawQueryFailure = true;
    }

    if (realtime.status === "found") {
      const item = realtime.item;
      // Any found-but-not-yet-definitive realtime result (including an
      // unrecognized status, or a terminal status that intentionally falls
      // through to history below) marks this attempt inconclusive before
      // the history fallback runs. A positively-found order must never be
      // discarded into "not_found" solely because history later reports
      // clean-empty.
      sawInconclusiveFinding = true;

      if (FILLED_STATUSES.has(item.orderStatus)) {
        if (fillQuantityPlausible(item, input.expected)) {
          return { kind: "full_fill", observation: toObservation(item, input.expected.qty) };
        }
      } else if (PARTIAL_FILL_STATUSES.has(item.orderStatus)) {
        if (fillQuantityPlausible(item, input.expected)) {
          return { kind: "partial_fill", observation: toObservation(item, input.expected.qty) };
        }
      } else if (LIVE_UNFILLED_STATUSES.has(item.orderStatus)) {
        if (quantityMatches(item, input.expected)) {
          return { kind: "pending_confirmed" };
        }
        // Quantity not yet consistent — retry within the bounded window
        // rather than confirming a different-sized order.
        if (attempt < CONFIRMATION_ATTEMPTS - 1) {
          await sleep(CONFIRMATION_RETRY_DELAY_MS);
        }
        continue;
      }
      // A realtime item reporting a terminal or unrecognized status falls
      // through to the order-history fallback below.
    }

    const history = await queryOrderView(
      () => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload),
      historyIdentity,
    );
    if (history.status === "query_failed") {
      sawQueryFailure = true;
    }

    if (history.status === "found") {
      const item = history.item;
      const cumulativeFilledQty = item.cumExecQty !== "" ? item.cumExecQty : "0";
      const hasFilledQty = compareDecimal(cumulativeFilledQty, "0") > 0;

      if (hasFilledQty) {
        if (fillQuantityPlausible(item, input.expected)) {
          const observation = toObservation(item, input.expected.qty);
          return compareDecimal(cumulativeFilledQty, input.expected.qty) >= 0
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
  const realtimeIdentity: ExpectedOrderIdentity = input.getEntryOrderPayload;
  const historyIdentity: ExpectedOrderIdentity = input.getEntryOrderHistoryPayload;

  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const realtime = await queryOrderView(
      () => input.bybit.getOrderByLinkId(input.getEntryOrderPayload),
      realtimeIdentity,
    );

    if (realtime.status === "found" && hasFill(realtime.item)) {
      return { kind: "filled_before_cancel", observation: toObservation(realtime.item, input.desiredQty) };
    }

    const realtimeIsLive = realtime.status === "found" && LIVE_UNFILLED_STATUSES.has(realtime.item.orderStatus);
    if (!realtimeIsLive) {
      const history = await queryOrderView(
        () => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload),
        historyIdentity,
      );

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

// Close neutralization needs a strictly different question than
// confirmEntryPackageCancelled answers. That function folds any observed fill
// — full or partial — into "filled_before_cancel", correct for entry-package's
// own null-desired-entry (CANCEL) flow, which must refuse to fabricate absence
// once any fill is observed regardless of the order's own status. Close needs
// "can no further quantity fill," which for the order type ABI creates is
// answered by the order's own terminal-vs-live status alone: a terminal status
// (fully filled, or cancelled/rejected/deactivated) has no live remainder no
// matter how much quantity executed before it got there; only a live status
// (new/untriggered/triggered, or a still-open partially-filled state) can
// still add exposure. This reuses the same query/decode building blocks above
// rather than a second confirmation architecture, and does not change
// confirmEntryPackageCancelled or its callers.
export type EntryOrderTerminality = { kind: "terminal" } | { kind: "live" } | { kind: "ambiguous" };

function isTerminalOrderStatus(orderStatus: string): boolean {
  return FILLED_STATUSES.has(orderStatus) || TERMINAL_WITHOUT_FILL_STATUSES.has(orderStatus);
}

function isLiveOrderStatus(orderStatus: string): boolean {
  return LIVE_UNFILLED_STATUSES.has(orderStatus) || PARTIAL_FILL_STATUSES.has(orderStatus);
}

// Whether a trade cycle's own recorded fill facts (cumulative_filled_qty /
// avg_execution_price) are settled rather than a live snapshot. Bybit order
// statuses do not un-terminalize, so a terminal order_status makes the
// observation permanently final; a live order_status (including a still-open
// PartiallyFilled) means the entry order can still add exposure, so the
// recorded quantity/price must not be treated as authoritative without a
// fresh re-check. No separate durable finality flag is introduced — this
// derives the fact from the already-durable order_status.
export function isFillFactFinal(observation: EarlyExecutionObservation | null): boolean {
  return observation !== null && isTerminalOrderStatus(observation.order_status);
}

// Single fresh classification of the current entry order's terminal-vs-live
// status. Never sends a cancel itself — the caller decides whether and when
// to cancel, and checks the live-execution guard, exactly as every other
// exchange write in this codebase does at its own call site.
export async function classifyEntryOrderTerminality(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
}): Promise<EntryOrderTerminality> {
  const realtimeIdentity: ExpectedOrderIdentity = input.getEntryOrderPayload;
  const historyIdentity: ExpectedOrderIdentity = input.getEntryOrderHistoryPayload;

  const realtime = await queryOrderView(
    () => input.bybit.getOrderByLinkId(input.getEntryOrderPayload),
    realtimeIdentity,
  );

  if (realtime.status === "found") {
    if (isTerminalOrderStatus(realtime.item.orderStatus)) {
      return { kind: "terminal" };
    }
    if (isLiveOrderStatus(realtime.item.orderStatus)) {
      return { kind: "live" };
    }
    // An unrecognized realtime status falls through to history, the same
    // pattern confirmEntryPackage already uses for an inconclusive realtime
    // finding.
  }

  if (realtime.status === "query_failed") {
    return { kind: "ambiguous" };
  }

  const history = await queryOrderView(
    () => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload),
    historyIdentity,
  );

  if (history.status === "query_failed") {
    return { kind: "ambiguous" };
  }

  if (history.status === "found") {
    return isTerminalOrderStatus(history.item.orderStatus) ? { kind: "terminal" } : { kind: "ambiguous" };
  }

  if (realtime.status === "not_found") {
    // Genuinely absent from both realtime and history — the same
    // clean-absence condition confirmEntryPackageCancelled already treats
    // as confirmed non-live.
    return { kind: "terminal" };
  }

  // Realtime positively found the order in an unrecognized state, and
  // history cleanly reports it absent: a positively found order must never
  // be discarded as terminal solely because history is clean-empty.
  return { kind: "ambiguous" };
}

// Bounded re-classification after a cancel has already been sent for a
// live order — re-queries only, never resends anything. Reuses the same
// bounded-retry shape (attempt count and delay) confirmEntryPackage and
// confirmEntryPackageCancelled already use.
export async function confirmEntryOrderNeutralized(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
}): Promise<"neutralized" | "ambiguous"> {
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
    const classification = await classifyEntryOrderTerminality(input);
    if (classification.kind === "terminal") {
      return "neutralized";
    }

    if (attempt < CONFIRMATION_ATTEMPTS - 1) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  return "ambiguous";
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

function quantityMatches(item: BybitOrderView, expected: ExpectedPackageFields): boolean {
  return decimalEquals(item.qty, expected.qty);
}

// A filled/partially-filled order is only trusted as evidence that *our*
// command was applied if the quantity the exchange reports is consistent
// with it. An omitted qty remains admissible after a fill as before, because
// cumExecQty supplies the fill evidence; a present-and-different qty must
// never be waved through as our order. Price fields are exchange-owned after
// the write and therefore are validation inputs, not request-equality proof.
function fillQuantityPlausible(item: BybitOrderView, expected: ExpectedPackageFields): boolean {
  if (item.qty !== "" && !decimalEquals(item.qty, expected.qty)) {
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

async function queryOrderView(
  query: () => Promise<unknown>,
  expected: ExpectedOrderIdentity,
): Promise<QueryResult> {
  let response: unknown;
  try {
    response = await query();
  } catch {
    return { status: "query_failed" };
  }

  const decoded = decodeOrderQueryResponse({ response, expected });
  if (decoded.kind === "found") {
    return { status: "found", item: decoded.item };
  }
  if (decoded.kind === "not_found") {
    return { status: "not_found" };
  }
  // protocol_failure: a structurally malformed or identity-mismatched
  // response proves nothing, so it is folded into the same query_failed
  // bucket a transport exception lands in.
  return { status: "query_failed" };
}
