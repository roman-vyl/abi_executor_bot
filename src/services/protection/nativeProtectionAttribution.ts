import { compareDecimal } from "../../domain/exactDecimal.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { PositionBindingGeometry } from "../../domain/positionScope.js";
import { encodeBybitPositionIdx } from "../../exchange/bybitOrderMapper.js";
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
  // "" when Bybit omits it; read only by closure proof.
  cumExecQty: string;
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
  | {
      kind: "ambiguous";
      reason: AttachedProtectionAmbiguousReason;
      // Present only when at least one decoded row attributed to this entry
      // by parentOrderLinkId already shows an execution (cumExecQty > 0, or
      // a Filled / PartiallyFilled status). An observed own fill is a fact
      // closure proof must never lose because the pair could not be
      // classified (abi-trade-cycle-closure-confirmation-v1).
      ownFillObserved?: true;
      // abi-protection-history-bounded-lookup-v1: present only on
      // partial_pair, when exactly one own leg was found by a scan that read
      // the cycle's whole lifetime (and every page of the active orders).
      // The other leg can then only be one that already left the history.
      singleLeg?: AttachedProtectionLeg;
      historyComplete?: true;
    };

// The cycle's lifetime window for a bounded historical read. `cycleStartMs`
// is the first-fill time (the record's creation time when no fill time is
// stored); `nowMs` is injectable for tests.
export type HistoryScan = { cycleStartMs: number; nowMs?: number };

// Bybit: endTime - startTime <= 7 days. One second less keeps the bound
// strict whatever rounding Bybit applies.
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 1000;
export const HISTORY_START_MARGIN_MS = 60 * 1000;
// These caps limit exchange requests only; they promise no depth of history.
export const HISTORY_MAX_PAGES = 200;
export const HISTORY_MAX_WINDOWS = 8;
const HISTORY_PAGE_LIMIT = "50";

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
  binding?: PositionBindingGeometry;
  // Absent: the two single-page queries every caller made before. Present:
  // the history is read over the cycle's lifetime (open-position lookup and
  // Close only).
  historyScan?: HistoryScan;
}): Promise<AttachedProtectionResolution> {
  if (input.historyScan !== undefined) {
    return resolveWithHistoryScan({ ...input, historyScan: input.historyScan });
  }
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
    expected: { category: input.category, symbol: input.symbol, binding: input.binding },
  });
  const decodedHistory = decodeChildOrderListResponse({
    response: historyResponse,
    expected: { category: input.category, symbol: input.symbol, binding: input.binding },
  });

  if (decodedRealtime.kind === "protocol_failure" || decodedHistory.kind === "protocol_failure") {
    return { kind: "ambiguous", reason: "query_failed" };
  }

  return finishResolution({
    category: input.category,
    entryOrderLinkId: input.entryOrderLinkId,
    binding: input.binding,
    realtimeItems: decodedRealtime.items,
    historyItems: decodedHistory.items,
  });
}

// Attribution and classification over everything read, shared by the
// single-page and the scanned read.
function finishResolution(input: {
  category: "linear" | "spot";
  entryOrderLinkId: string;
  binding?: PositionBindingGeometry;
  realtimeItems: BybitChildOrderCandidate[];
  historyItems: BybitChildOrderCandidate[];
  complete?: boolean;
}): AttachedProtectionResolution {
  const ownRealtimeCandidates = input.realtimeItems.filter(
    (candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId,
  );
  const ownHistoryCandidates = input.historyItems.filter(
    (candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId,
  );

  const ownFillObserved = [...ownRealtimeCandidates, ...ownHistoryCandidates].some(candidateShowsFill);
  const ambiguous = (
    reason: AttachedProtectionAmbiguousReason,
    extra: { singleLeg?: AttachedProtectionLeg; historyComplete?: true } = {},
  ): AttachedProtectionResolution =>
    ownFillObserved
      ? { kind: "ambiguous", reason, ownFillObserved: true, ...extra }
      : { kind: "ambiguous", reason, ...extra };

  if (input.binding !== undefined) {
    const expectedPositionIdx = encodeBybitPositionIdx(input.binding);
    // The predecessor contract requires this ordering: exact-parent first,
    // then physical binding. A valid foreign owner in the opposite hedge
    // slot is not evidence for this owner and is not a protocol failure.
    if (
      [...ownRealtimeCandidates, ...ownHistoryCandidates].some(
        (candidate) => candidate.positionIdx !== expectedPositionIdx,
      )
    ) {
      return ambiguous("query_failed");
    }
  }

  const deduped = dedupeByOrderId(ownRealtimeCandidates, ownHistoryCandidates);
  if (deduped.kind === "inconsistent") {
    return ambiguous("inconsistent_duplicate");
  }

  const classified = classify(deduped.items);
  if (classified.kind !== "ambiguous") {
    return classified;
  }
  if (classified.reason === "partial_pair" && input.complete === true && deduped.items.length === 1) {
    return ambiguous("partial_pair", { singleLeg: toLegFromRole(deduped.items[0]), historyComplete: true });
  }
  return ambiguous(classified.reason);
}

// Reads the active orders once and the history over the cycle's lifetime:
// windows of at most 7 days, newest first, the cursor followed inside each.
// Two stop rules (design D2): a pair of own legs may end the read early; one
// leg or none never does, so a single-leg result is only ever produced after
// the whole lifetime was read. Any cap, failed page, malformed page or stuck
// cursor is query_failed, never "none".
async function resolveWithHistoryScan(input: {
  bybit: BybitAdapter;
  category: "linear" | "spot";
  symbol: string;
  entryOrderLinkId: string;
  binding?: PositionBindingGeometry;
  historyScan: HistoryScan;
}): Promise<AttachedProtectionResolution> {
  const expected = { category: input.category, symbol: input.symbol, binding: input.binding };
  const failed: AttachedProtectionResolution = { kind: "ambiguous", reason: "query_failed" };

  let decodedRealtime: ReturnType<typeof decodeChildOrderListResponse>;
  try {
    decodedRealtime = decodeChildOrderListResponse({
      response: await input.bybit.getActiveOrders({ symbol: input.symbol }),
      expected,
    });
  } catch {
    return failed;
  }
  if (decodedRealtime.kind === "protocol_failure") {
    return failed;
  }
  // A further page of active orders could hide a live own leg; a response
  // without the cursor field cannot show that there is none.
  const realtimeComplete = decodedRealtime.nextPageCursor === "";

  const nowMs = input.historyScan.nowMs ?? Date.now();
  const scanStartMs = Math.min(input.historyScan.cycleStartMs - HISTORY_START_MARGIN_MS, nowMs - 1);
  const historyItems: BybitChildOrderCandidate[] = [];
  const attributed = () => {
    const own = historyItems.filter((candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId);
    const ownRealtime = decodedRealtime.items.filter(
      (candidate) => candidate.parentOrderLinkId === input.entryOrderLinkId,
    );
    const deduped = dedupeByOrderId(ownRealtime, own);
    return deduped.kind === "ok" && classify(deduped.items).kind === "attributed";
  };

  let pages = 0;
  let windows = 0;
  let windowEnd = nowMs;
  let readToCycleStart = false;
  while (!readToCycleStart) {
    if (windows >= HISTORY_MAX_WINDOWS) {
      return failed;
    }
    windows += 1;
    const windowStart = Math.max(scanStartMs, windowEnd - HISTORY_WINDOW_MS);
    let cursor: string | undefined;
    do {
      if (pages >= HISTORY_MAX_PAGES) {
        return failed;
      }
      pages += 1;
      let decoded: ReturnType<typeof decodeChildOrderListResponse>;
      try {
        decoded = decodeChildOrderListResponse({
          response: await input.bybit.getOrderHistoryForSymbol({
            category: input.category,
            symbol: input.symbol,
            limit: HISTORY_PAGE_LIMIT,
            startTime: windowStart,
            endTime: windowEnd,
            ...(cursor !== undefined ? { cursor } : {}),
          }),
          expected,
        });
      } catch {
        return failed;
      }
      if (decoded.kind === "protocol_failure" || decoded.nextPageCursor === undefined) {
        return failed;
      }
      historyItems.push(...decoded.items);
      if (attributed()) {
        return finishResolution({
          category: input.category,
          entryOrderLinkId: input.entryOrderLinkId,
          binding: input.binding,
          realtimeItems: decodedRealtime.items,
          historyItems,
        });
      }
      if (decoded.nextPageCursor !== "" && decoded.nextPageCursor === cursor) {
        return failed;
      }
      cursor = decoded.nextPageCursor === "" ? undefined : decoded.nextPageCursor;
    } while (cursor !== undefined);

    readToCycleStart = windowStart <= scanStartMs;
    windowEnd = windowStart;
  }

  return finishResolution({
    category: input.category,
    entryOrderLinkId: input.entryOrderLinkId,
    binding: input.binding,
    realtimeItems: decodedRealtime.items,
    historyItems,
    complete: realtimeComplete,
  });
}

function toLegFromRole(candidate: BybitChildOrderCandidate): AttachedProtectionLeg {
  return toLeg(candidate, candidate.stopOrderType === STOP_LEG_STOP_ORDER_TYPE ? "stop" : "take");
}

const FILL_STATUSES = new Set(["Filled", "PartiallyFilled"]);

function candidateShowsFill(candidate: BybitChildOrderCandidate): boolean {
  if (FILL_STATUSES.has(candidate.orderStatus)) {
    return true;
  }
  try {
    return candidate.cumExecQty !== "" && compareDecimal(candidate.cumExecQty, "0") > 0;
  } catch {
    return false;
  }
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
  return a.stopOrderType === b.stopOrderType && decimalEquals(a.qty, b.qty) && a.positionIdx === b.positionIdx;
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
    cumExecQty: candidate.cumExecQty,
  };
}
