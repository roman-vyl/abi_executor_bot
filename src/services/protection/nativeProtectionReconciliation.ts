import { ceilToStep, compareDecimal, floorToStep, multiplyDecimal } from "../../domain/exactDecimal.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import { FILLED_STATUSES, TERMINAL_WITHOUT_FILL_STATUSES } from "../entryPackage/packageConfirmation.js";
import type { AttachedProtectionLeg } from "./nativeProtectionAttribution.js";
import { resolveOwnAttachedProtection } from "./nativeProtectionAttribution.js";

// Surrogate-TAKE distance from the stable planned_entry_price reference, as
// a fraction of that price (design.md Decision 5). Carries no exchange-
// validity claim: task 0's closed Bybit Demo evidence showed
// CurrentOrderPriceLimitsProvider's buyLimit/sellLimit do not constrain a
// native Partial TP triggerPrice amend, and no other proven boundary source
// exists for this V1 — validity is enforced only by Bybit's own amend-time
// acceptance or rejection (Decision 7's amend_rejected path).
export const SURROGATE_TAKE_DISTANCE_RATIO = 0.5;

// Exact-decimal-text multipliers derived from SURROGATE_TAKE_DISTANCE_RATIO
// (1 + ratio for long, 1 - ratio for short) — kept as literal exact-decimal
// strings, not computed from the numeric constant above, so the multiply
// itself never passes through binary floating point.
const LONG_SURROGATE_MULTIPLIER = "1.5";
const SHORT_SURROGATE_MULTIPLIER = "0.5";

export type DesiredProtectionLeg = {
  triggerPrice: string;
  qty: string;
};

export type DesiredProtectionState = {
  stop: DesiredProtectionLeg;
  take: DesiredProtectionLeg; // always present — surrogate when the command's take_price is null
};

export type ReconciliationOutcome =
  | { kind: "already_satisfied" }
  | { kind: "reconciled" }
  | { kind: "fail_closed"; reason: ReconciliationFailureReason };

export type ReconciliationFailureReason =
  | "attribution_lost" // resolveOwnAttachedProtection no longer returns attributed for this parent
  | "ambiguous_attribution" // resolveOwnAttachedProtection returned ambiguous (any of its 6 reasons)
  | "amend_rejected" // Bybit rejected an amend call
  | "amend_race" // fresh evidence right before amend no longer matches what triggered the amend
  | "read_back_mismatch" // post-amend fresh read-back does not match desired state
  // Caller-surfaced (design.md Decisions 4/5/11) — never produced inside
  // reconcileNativePartialProtection itself, which only ever consumes an
  // already-resolved DesiredProtectionState. Widened onto this same union
  // so ProtectionApplicationService.reconcileNativePartial() has exactly
  // one failure vocabulary to report through, rather than a parallel one.
  | "no_authoritative_qty" // resolveCurrentOwnFilledQty could not obtain any own fill evidence
  | "trading_rules_unavailable"; // InstrumentTradingRulesProvider.getRules() threw on the null-take path

// Deterministic surrogate TAKE price for a trade cycle whose desired
// take_price is null (design.md Decision 5, task 0 evidence folded in):
// derived from this cycle's own immutable planned_entry_price, never from
// current market price. Tick-normalized, side-aware (far above for long,
// far below for short). No clamp step and no exchange dependency — task 0's
// closed Bybit Demo evidence ruled out CurrentOrderPriceLimitsProvider's
// buyLimit/sellLimit as an applicable bound for a native Partial TP
// triggerPrice amend, and no other proven boundary source exists for this
// V1. Validity is enforced only by Bybit's own amend-time acceptance or
// rejection (Decision 7's amend_rejected path) — this function is total
// over its typed inputs and never fails.
export function computeSurrogateTakePrice(input: {
  plannedEntryPrice: string;
  side: "long" | "short";
  tickSize: string;
}): string {
  const { plannedEntryPrice, side, tickSize } = input;

  const raw =
    side === "long"
      ? multiplyDecimal(plannedEntryPrice, LONG_SURROGATE_MULTIPLIER)
      : multiplyDecimal(plannedEntryPrice, SHORT_SURROGATE_MULTIPLIER);

  return side === "long" ? ceilToStep(raw, tickSize) : floorToStep(raw, tickSize);
}

type WritePlanCall = { role: "stop" | "take"; orderId: string; triggerPrice?: string; qty?: string };

// design.md Decision 6's full eight-case matrix: qty (whenever it changes)
// travels only in the STOP leg's call, never TAKE's; each leg's call, when
// issued, always carries its own triggerPrice when that leg's trigger
// changed. At most two calls total.
function buildWritePlan(actual: { stop: AttachedProtectionLeg; take: AttachedProtectionLeg }, desired: DesiredProtectionState): WritePlanCall[] {
  const stopTriggerChanged = compareDecimal(actual.stop.triggerPrice, desired.stop.triggerPrice) !== 0;
  const takeTriggerChanged = compareDecimal(actual.take.triggerPrice, desired.take.triggerPrice) !== 0;
  const qtyChanged = compareDecimal(actual.stop.qty, desired.stop.qty) !== 0;

  const calls: WritePlanCall[] = [];

  if (stopTriggerChanged || qtyChanged) {
    const call: WritePlanCall = { role: "stop", orderId: actual.stop.orderId };
    if (stopTriggerChanged) {
      call.triggerPrice = desired.stop.triggerPrice;
    }
    if (qtyChanged) {
      call.qty = desired.stop.qty;
    }
    calls.push(call);
  }

  if (takeTriggerChanged) {
    calls.push({ role: "take", orderId: actual.take.orderId, triggerPrice: desired.take.triggerPrice });
  }

  return calls;
}

function matchesDesired(actual: { stop: AttachedProtectionLeg; take: AttachedProtectionLeg }, desired: DesiredProtectionState): boolean {
  return (
    compareDecimal(actual.stop.triggerPrice, desired.stop.triggerPrice) === 0 &&
    compareDecimal(actual.stop.qty, desired.stop.qty) === 0 &&
    compareDecimal(actual.take.triggerPrice, desired.take.triggerPrice) === 0 &&
    compareDecimal(actual.take.qty, desired.take.qty) === 0
  );
}

// Reconciles a trade cycle's actually attributable native Partial
// protection children toward a desired protection state, using only
// in-place amend — never create, never cancel (design.md Decisions 1, 6,
// 7, 9). No internal retry loop, no caching, no durable read/write: one
// reconciliation attempt per call; the caller owns retry/error-mapping
// policy, mirroring resolveOwnAttachedProtection()'s own shape. Not wired
// to any production-decision path — see ProtectionApplicationService's
// reconcileNativePartial(), the only intended future caller.
export async function reconcileNativePartialProtection(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
  desired: DesiredProtectionState;
}): Promise<ReconciliationOutcome> {
  const { bybit, category, symbol, entryOrderLinkId, desired } = input;

  const initial = await resolveOwnAttachedProtection({ bybit, category, symbol, entryOrderLinkId });

  if (initial.kind === "none") {
    return { kind: "fail_closed", reason: "attribution_lost" };
  }
  if (initial.kind === "ambiguous") {
    return { kind: "fail_closed", reason: "ambiguous_attribution" };
  }

  // initial.kind === "attributed" — resolveOwnAttachedProtection() is
  // status-agnostic (a terminal historical pair still classifies
  // "attributed"), so a terminal leg must never be read as active,
  // satisfied coverage, and must never be planned into an amend either —
  // fail closed immediately, before already_satisfied and before any
  // write-plan is built, zero amendOrder calls. No create/cancel/
  // replacement is attempted to work around it.
  if (hasTerminalLeg(initial)) {
    return { kind: "fail_closed", reason: "amend_race" };
  }

  if (matchesDesired(initial, desired)) {
    return { kind: "already_satisfied" };
  }

  const writePlan = buildWritePlan(initial, desired);

  for (const call of writePlan) {
    let response: unknown;
    try {
      response = await bybit.amendOrder({
        category,
        symbol,
        orderId: call.orderId,
        ...(call.triggerPrice !== undefined ? { triggerPrice: call.triggerPrice } : {}),
        ...(call.qty !== undefined ? { qty: call.qty } : {}),
      });
    } catch {
      return { kind: "fail_closed", reason: "amend_rejected" };
    }

    if (!isAcknowledged(response)) {
      return { kind: "fail_closed", reason: "amend_rejected" };
    }
  }

  const readBack = await resolveOwnAttachedProtection({ bybit, category, symbol, entryOrderLinkId });

  if (readBack.kind !== "attributed") {
    // Any mismatch against the desired state is read_back_mismatch by
    // default (design.md Decision 7 step 3) — including the pair no
    // longer classifying cleanly as attributed at all.
    return { kind: "fail_closed", reason: "read_back_mismatch" };
  }

  if (!matchesDesired(readBack, desired)) {
    // Distinguishes the narrower amend_race case (design.md Decision 7
    // step 4): the read-back still attributes both legs, but one of them
    // now independently reports a terminal orderStatus that step 1 did
    // not — the amend raced that leg's own lifecycle transition, rather
    // than being cleanly rejected or simply producing wrong values.
    if (hasTerminalLeg(readBack)) {
      return { kind: "fail_closed", reason: "amend_race" };
    }
    return { kind: "fail_closed", reason: "read_back_mismatch" };
  }

  // triggerPrice/qty numerically matching desired is not sufficient — a
  // leg that independently transitioned to terminal in the same window is
  // not live coverage, even when its last-known values happen to match
  // (finding #1). Same amend_race reason as the mismatch case above: this
  // is still the amend racing that leg's own lifecycle transition, just
  // one where the stale values happened to coincide with desired.
  if (hasTerminalLeg(readBack)) {
    return { kind: "fail_closed", reason: "amend_race" };
  }

  return { kind: "reconciled" };
}

function hasTerminalLeg(pair: { stop: AttachedProtectionLeg; take: AttachedProtectionLeg }): boolean {
  return isTerminalOrderStatus(pair.stop.orderStatus) || isTerminalOrderStatus(pair.take.orderStatus);
}

function isTerminalOrderStatus(orderStatus: string): boolean {
  return FILLED_STATUSES.has(orderStatus) || TERMINAL_WITHOUT_FILL_STATUSES.has(orderStatus);
}

function isAcknowledged(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("retCode" in response)) {
    return false;
  }
  const retCode = (response as Record<string, unknown>).retCode;
  return retCode === 0;
}
