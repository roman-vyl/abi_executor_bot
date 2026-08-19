import { ceilToStep, compareDecimal, floorToStep } from "../../domain/exactDecimal.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { InstrumentTradingRulesProvider } from "../../exchange/instrumentTradingRulesProvider.js";
import { FILLED_STATUSES, TERMINAL_WITHOUT_FILL_STATUSES } from "../entryPackage/packageConfirmation.js";
import type { AttachedProtectionLeg } from "./nativeProtectionAttribution.js";
import { resolveOwnAttachedProtection } from "./nativeProtectionAttribution.js";

// Preferred surrogate-TAKE distance from the stable planned_entry_price
// reference, as a fraction of that price (design.md Decision 5). Only a
// preference, not a claim of exchange validity on its own — the computed
// candidate is always clamped into the instrument's own decoded
// minPrice/maxPrice bounds afterward, which is what actually makes the
// result exchange-valid by construction.
export const SURROGATE_TAKE_DISTANCE_RATIO = 0.5;

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
  | "surrogate_unrepresentable"; // computeSurrogateTakePrice found no room for a distinct surrogate

// Given a target price computed from a stable reference (never current
// market price), pulls it back to the nearest tick-valid price still
// inside [minPrice, maxPrice] when it falls outside that range. Returns
// err("surrogate_unrepresentable") only when the clamped result would
// coincide with the reference price itself — no room exists for any
// distinct dormant surrogate on this instrument's current bounds
// (design.md Decision 5).
export function clampToInstrumentBounds(input: {
  candidate: string;
  reference: string;
  minPrice: string;
  maxPrice: string;
  tickSize: string;
  side: "long" | "short";
}): { ok: true; price: string } | { ok: false; reason: "surrogate_unrepresentable" } {
  const { candidate, reference, minPrice, maxPrice, tickSize, side } = input;

  let clamped: string;
  if (side === "long") {
    if (compareDecimal(candidate, maxPrice) <= 0) {
      return { ok: true, price: candidate };
    }
    clamped = floorToStep(maxPrice, tickSize);
  } else {
    if (compareDecimal(candidate, minPrice) >= 0) {
      return { ok: true, price: candidate };
    }
    clamped = ceilToStep(minPrice, tickSize);
  }

  if (compareDecimal(clamped, reference) === 0) {
    return { ok: false, reason: "surrogate_unrepresentable" };
  }
  return { ok: true, price: clamped };
}

// Deterministic surrogate TAKE price for a trade cycle whose desired
// take_price is null (design.md Decision 5): derived from this cycle's own
// immutable planned_entry_price, never from current market price. Tick-
// normalized, side-aware (far above for long, far below for short), and
// clamped into the instrument's own decoded price bounds so the result is
// exchange-valid by construction. Pure, total over its typed inputs (no
// throwing arithmetic given syntactically valid exact-decimal inputs).
export function computeSurrogateTakePrice(input: {
  plannedEntryPrice: string;
  side: "long" | "short";
  tickSize: string;
  minPrice: string;
  maxPrice: string;
}): { ok: true; price: string } | { ok: false; reason: "surrogate_unrepresentable" } {
  const { plannedEntryPrice, side, tickSize, minPrice, maxPrice } = input;

  const raw =
    side === "long"
      ? multiplyByRatio(plannedEntryPrice, 1 + SURROGATE_TAKE_DISTANCE_RATIO)
      : multiplyByRatio(plannedEntryPrice, 1 - SURROGATE_TAKE_DISTANCE_RATIO);

  const candidate = side === "long" ? ceilToStep(raw, tickSize) : floorToStep(raw, tickSize);

  return clampToInstrumentBounds({
    candidate,
    reference: plannedEntryPrice,
    minPrice,
    maxPrice,
    tickSize,
    side,
  });
}

// Multiplies an exact-decimal-text price by a fixed-precision ratio without
// going through binary floating point for the exact-decimal operand — the
// ratio itself (a fixed program constant, not exchange or user input) is
// converted through Number, which is exact for the two-decimal-digit ratios
// this module uses (1.5 and 0.5).
function multiplyByRatio(valueText: string, ratio: number): string {
  const ratioText = ratio.toFixed(4);
  const [ratioInt, ratioFrac = ""] = ratioText.split(".");
  const ratioUnscaled = BigInt(ratioInt + ratioFrac);
  const ratioScale = ratioFrac.length;

  const parsed = parseForMultiply(valueText);
  const productUnscaled = parsed.unscaled * ratioUnscaled;
  const productScale = parsed.scale + ratioScale;

  return formatForMultiply(productUnscaled, productScale);
}

// Minimal local exact-decimal parse/format, mirroring exactDecimal.ts's own
// internal shape closely enough for this module's narrow multiply need,
// without reaching into that file's non-exported internals.
function parseForMultiply(text: string): { unscaled: bigint; scale: number } {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (match === null) {
    throw new Error(`not a supported exact-decimal string for multiply: ${text}`);
  }
  const negative = match[1] === "-";
  const integerPart = match[2] ?? "";
  const fractionPart = match[3] ?? "";
  const unscaled = BigInt((integerPart || "0") + fractionPart);
  return { unscaled: negative ? -unscaled : unscaled, scale: fractionPart.length };
}

function formatForMultiply(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const abs = negative ? -unscaled : unscaled;
  const sign = negative ? "-" : "";
  if (scale === 0) {
    return `${sign}${abs.toString()}`;
  }
  const digits = abs.toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - scale);
  const fractionPart = digits.slice(digits.length - scale);
  return `${sign}${integerPart}.${fractionPart}`;
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
  tradingRules: InstrumentTradingRulesProvider;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
  side: "long" | "short";
  desired: DesiredProtectionState;
}): Promise<ReconciliationOutcome> {
  const { bybit, category, symbol, entryOrderLinkId, desired } = input;
  void input.tradingRules;
  void input.side;

  const initial = await resolveOwnAttachedProtection({ bybit, category, symbol, entryOrderLinkId });

  if (initial.kind === "none") {
    return { kind: "fail_closed", reason: "attribution_lost" };
  }
  if (initial.kind === "ambiguous") {
    return { kind: "fail_closed", reason: "ambiguous_attribution" };
  }

  // initial.kind === "attributed"
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
    if (isTerminalOrderStatus(readBack.stop.orderStatus) || isTerminalOrderStatus(readBack.take.orderStatus)) {
      return { kind: "fail_closed", reason: "amend_race" };
    }
    return { kind: "fail_closed", reason: "read_back_mismatch" };
  }

  return { kind: "reconciled" };
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
