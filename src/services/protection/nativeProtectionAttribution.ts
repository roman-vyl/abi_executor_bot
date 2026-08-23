import { compareDecimal } from "../../domain/exactDecimal.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { BybitChildOrderCandidate } from "../entryPackage/orderQueryResponseDecoder.js";
import { decodeChildOrderListResponse } from "../entryPackage/orderQueryResponseDecoder.js";

// Confirmed against real Bybit Demo responses
// (abi-native-partial-protection-attribution-v1 design.md Decision 0,
// facts 3-4) — the sole role discriminator. createType is corroborating
// evidence only and is never read for classification itself.
const STOP_LEG_STOP_ORDER_TYPE = "PartialStopLoss";
const TAKE_LEG_STOP_ORDER_TYPE = "PartialTakeProfit";

export type AttachedProtectionLeg = {
  role: "stop" | "take";
  orderId: string;
  orderStatus: string;
  triggerPrice: string;
  qty: string;
  leavesQty: string;
};

export type AttachedProtectionAmbiguousReason =
  | "extra_candidates"
  | "duplicate_role"
  | "unclassified_role"
  | "partial_pair"
  | "inconsistent_duplicate"
  // Not itself a shape-of-evidence ambiguity — a query the primitive could
  // not complete (transport failure or a protocol_failure decode) is folded
  // into the same fail-closed "ambiguous" outcome the rest of this codebase
  // already uses for query failures (e.g. classifyEntryOrderTerminality's
  // own "ambiguous" on a query_failed realtime/history result,
  // packageConfirmation.ts), rather than inventing a parallel error channel
  // this primitive's own design (Decision 1) did not originally enumerate.
  | "query_failed";

export type AttachedProtectionResolution =
  | { kind: "none" }
  | { kind: "attributed"; stop: AttachedProtectionLeg; take: AttachedProtectionLeg }
  | { kind: "ambiguous"; reason: AttachedProtectionAmbiguousReason };

// Pure, query-driven, fail-closed classification of one trade cycle's own
// Bybit-native attached protection children (materialized under
// tpslMode: "Partial"), attributed exclusively through the confirmed
// parentOrderLinkId field — never side/price/timing, never a child's own
// orderLinkId (confirmed observed empty on every native child).
//
// No caching, no durable read/write, no internal bounded retry: one fresh
// pair of queries per call. This primitive answers only "what did I find" —
// it takes no "was this entry mapped Partial" or "is fill final" input, and
// a "none"/"partial_pair" result is not proof of absence given the
// confirmed history propagation lag (Decision 0, fact 8). Interpreting any
// of that, and any retry cadence around it, belongs entirely to the caller
// (abi-native-partial-protection-lifecycle-v1's own operations) — see
// design.md Decision 5.
export async function resolveOwnAttachedProtection(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
}): Promise<AttachedProtectionResolution> {
  let realtimeResponse: unknown;
  let historyResponse: unknown;
  try {
    // Sequential, not concurrent — mirrors every other multi-query Bybit
    // pipeline in this codebase (e.g. CloseApplicationService.verifyBothPostconditions),
    // none of which run two in-flight exchange requests at once without a
    // demonstrated need to.
    realtimeResponse = await input.bybit.getActiveOrders({ symbol: input.symbol });
    historyResponse = await input.bybit.getOrderHistoryForSymbol({
      category: input.category,
      symbol: input.symbol,
      limit: "50",
    });
  } catch {
    return { kind: "ambiguous", reason: "query_failed" };
  }

  const decodedRealtime = decodeChildOrderListResponse({
    response: realtimeResponse,
    expected: { category: input.category, symbol: input.symbol },
  });
  const decodedHistory = decodeChildOrderListResponse({
    response: historyResponse,
    expected: { category: input.category, symbol: input.symbol },
  });

  if (decodedRealtime.kind === "protocol_failure" || decodedHistory.kind === "protocol_failure") {
    return { kind: "ambiguous", reason: "query_failed" };
  }

  const ownRealtimeCandidates = decodedRealtime.items.filter(
    (candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId,
  );
  const ownHistoryCandidates = decodedHistory.items.filter(
    (candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId,
  );

  const deduped = dedupeByOrderId(ownRealtimeCandidates, ownHistoryCandidates);
  if (deduped.kind === "inconsistent") {
    return { kind: "ambiguous", reason: "inconsistent_duplicate" };
  }

  return classify(deduped.items);
}

// Merges realtime and history candidates by orderId — the only reliable
// per-child identity (Decision 0, fact 2) — so the same underlying child
// observed in both query sources during the realtime/history transition
// window is never double-counted as two candidates (fact 7). History is
// preferred on a consistent overwrite (more authoritative for a terminal
// leg's own status/leavesQty than a realtime snapshot); a disagreement on
// stopOrderType or qty between the two sources for the same orderId is
// reported as inconsistent, never silently resolved by preferring one
// source over the other.
function dedupeByOrderId(
  realtimeCandidates: BybitChildOrderCandidate[],
  historyCandidates: BybitChildOrderCandidate[],
): { kind: "ok"; items: BybitChildOrderCandidate[] } | { kind: "inconsistent" } {
  const byOrderId = new Map<string, BybitChildOrderCandidate>();

  for (const candidate of realtimeCandidates) {
    byOrderId.set(candidate.orderId, candidate);
  }

  for (const candidate of historyCandidates) {
    const existing = byOrderId.get(candidate.orderId);
    if (existing !== undefined && !isConsistentDuplicate(existing, candidate)) {
      return { kind: "inconsistent" };
    }
    byOrderId.set(candidate.orderId, candidate);
  }

  return { kind: "ok", items: [...byOrderId.values()] };
}

function isConsistentDuplicate(a: BybitChildOrderCandidate, b: BybitChildOrderCandidate): boolean {
  return a.stopOrderType === b.stopOrderType && decimalEquals(a.qty, b.qty);
}

function decimalEquals(a: string, b: string): boolean {
  if (a === "" || b === "") {
    return a === b;
  }
  try {
    return compareDecimal(a, b) === 0;
  } catch {
    return false;
  }
}

// Total over every reachable (stopCount, takeCount) shape after dedup:
// (0,0) -> none; (1,1) -> attributed; exactly one of (1,0)/(0,1) -> partial_pair;
// exactly one role duplicated -> duplicate_role; both roles duplicated ->
// extra_candidates. Any candidate whose stopOrderType is not one of the two
// known role values fails the whole result closed as unclassified_role
// before role counts are even considered — never silently dropped, since
// dropping it could turn a real duplicate/three-candidate situation into a
// false "clean pair" (design.md Decision 3).
function classify(candidates: BybitChildOrderCandidate[]): AttachedProtectionResolution {
  const unclassified = candidates.filter(
    (candidate) =>
      candidate.stopOrderType !== STOP_LEG_STOP_ORDER_TYPE && candidate.stopOrderType !== TAKE_LEG_STOP_ORDER_TYPE,
  );
  if (unclassified.length > 0) {
    return { kind: "ambiguous", reason: "unclassified_role" };
  }

  const stopCandidates = candidates.filter((candidate) => candidate.stopOrderType === STOP_LEG_STOP_ORDER_TYPE);
  const takeCandidates = candidates.filter((candidate) => candidate.stopOrderType === TAKE_LEG_STOP_ORDER_TYPE);

  if (stopCandidates.length > 1 && takeCandidates.length > 1) {
    return { kind: "ambiguous", reason: "extra_candidates" };
  }
  if (stopCandidates.length > 1 || takeCandidates.length > 1) {
    return { kind: "ambiguous", reason: "duplicate_role" };
  }

  if (stopCandidates.length === 0 && takeCandidates.length === 0) {
    return { kind: "none" };
  }

  if (stopCandidates.length === 1 && takeCandidates.length === 1) {
    return {
      kind: "attributed",
      stop: toLeg(stopCandidates[0], "stop"),
      take: toLeg(takeCandidates[0], "take"),
    };
  }

  return { kind: "ambiguous", reason: "partial_pair" };
}

function toLeg(candidate: BybitChildOrderCandidate, role: "stop" | "take"): AttachedProtectionLeg {
  return {
    role,
    orderId: candidate.orderId,
    orderStatus: candidate.orderStatus,
    triggerPrice: candidate.triggerPrice,
    qty: candidate.qty,
    leavesQty: candidate.leavesQty,
  };
}
