import { setTimeout as sleep } from "node:timers/promises";

import { compareDecimal } from "../../domain/exactDecimal.js";
import type { RecoveryStateHttpResult } from "../../domain/entryCycleRecoveryApi.js";
import {
  entryOrderLiveResult,
  internalErrorResult,
  positionOpenResult,
  terminalAfterFillResult,
  terminalWithoutFillResult,
  unknownTradeCycleBindingResult,
} from "../../domain/entryCycleRecoveryApi.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import type { BybitAdapter, PositionQueryResult } from "../../exchange/bybitAdapter.js";
import type { BybitGetOrderByLinkIdPayload, BybitGetOrderHistoryPayload } from "../../exchange/bybitOrderMapper.js";
import {
  FILLED_STATUSES,
  LIVE_UNFILLED_STATUSES,
  PARTIAL_FILL_STATUSES,
  TERMINAL_WITHOUT_FILL_STATUSES,
} from "../entryPackage/packageConfirmation.js";
import type { BybitOrderView, ExpectedOrderIdentity } from "../entryPackage/orderQueryResponseDecoder.js";
import { decodeOrderQueryResponse } from "../entryPackage/orderQueryResponseDecoder.js";

// Same bounded-retry shape CloseApplicationService.verifyBothPostconditions
// already uses (3 attempts / 300ms) — no time-based recovery horizon of any
// kind, only a bound on how many times this one request re-queries before
// giving up and returning the safe-error response.
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_RETRY_DELAY_MS = 300;

export type RecoveryQuery = {
  strategyInstanceId: string;
  tradeCycleId: string;
};

export type EntryCycleRecoveryResolutionServiceDeps = {
  correlationRepository: EntryPackageCorrelationRepository;
  bybit: BybitAdapter;
};

// The order side of the recovery composition, distinct from
// packageConfirmation.ts's PackageConfirmationOutcome: recovery needs to
// know not just whether a fill was observed, but whether the order that
// carries it is still live or already terminal — a PartiallyFilled order is
// live evidence, a Filled (or history-terminal) order is terminal evidence,
// and neither is interchangeable with the other for this capability's
// dual-positive-confirmation rule.
type OrderRecoverySignal =
  | { kind: "live_unfilled" }
  | { kind: "live_with_fill" }
  | { kind: "terminal_with_fill" }
  | { kind: "terminal_without_fill" }
  | { kind: "not_found" }
  | { kind: "inconclusive" };

type ResolvedOutcome =
  | { state: "entry_order_live" }
  | { state: "position_open"; firstFillAtMs: number; averageEntryPrice: string }
  | { state: "terminal_without_fill" }
  | { state: "terminal_after_fill" };

// Resolves one Runtime-owned trade cycle's exchange ground truth for
// recovery purposes: entry_order_live, position_open, terminal_without_fill,
// or terminal_after_fill — or fails safe when it cannot positively establish
// one of those four from non-contradictory evidence. Read-only: never
// cancels, amends, or creates anything.
export class EntryCycleRecoveryResolutionService {
  private readonly deps: EntryCycleRecoveryResolutionServiceDeps;

  constructor(deps: EntryCycleRecoveryResolutionServiceDeps) {
    this.deps = deps;
  }

  async resolve(query: RecoveryQuery): Promise<RecoveryStateHttpResult> {
    try {
      return await this.process(query);
    } catch {
      return internalErrorResult();
    }
  }

  private async process(query: RecoveryQuery): Promise<RecoveryStateHttpResult> {
    const record = this.deps.correlationRepository.get(query.strategyInstanceId, query.tradeCycleId);
    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      // No order identity is bound (never dispatched, or already durably
      // resolved to absent) — there is nothing to query and no positive
      // evidence this capability can act on. Fails safe like any other
      // inconclusive attempt rather than inventing a fifth state.
      return internalErrorResult();
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      // Unreachable while a non-null order_link_id always carries a real
      // resolved category — re-verified independently rather than assumed,
      // mirroring CloseApplicationService's identical defensive check.
      return internalErrorResult();
    }

    const symbol = record.exchange_symbol;
    const getEntryOrderPayload: BybitGetOrderByLinkIdPayload = { category, symbol, orderLinkId, limit: "1" };
    const getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload = { category, symbol, orderLinkId, limit: "1" };

    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
      const orderSignal = await classifyOrderForRecovery({
        bybit: this.deps.bybit,
        getEntryOrderPayload,
        getEntryOrderHistoryPayload,
      });
      const positionQuery = await this.deps.bybit.queryPositionForInstrument({ category, symbol });

      const resolved = resolveRecoveryState(orderSignal, positionQuery);
      if (resolved !== undefined) {
        return this.toHttpResult(resolved, record);
      }

      if (attempt < RECOVERY_ATTEMPTS - 1) {
        await sleep(RECOVERY_RETRY_DELAY_MS);
      }
    }

    return internalErrorResult();
  }

  private toHttpResult(outcome: ResolvedOutcome, record: EntryPackageExecutionRecord): RecoveryStateHttpResult {
    if (outcome.state === "terminal_without_fill") {
      return terminalWithoutFillResult();
    }
    if (outcome.state === "terminal_after_fill") {
      return terminalAfterFillResult();
    }

    // entry_order_live and position_open both carry the applied entry
    // package — a non-null order_link_id always means a real binding was
    // created with its desired entry and calculated quantity persisted
    // together; a missing one here is contradictory correlation state, not
    // a case to guess through.
    const desiredEntry = record.desired_entry;
    const calculatedQuantity = record.calculated_quantity;
    if (desiredEntry === null || calculatedQuantity === null) {
      return internalErrorResult();
    }

    if (outcome.state === "entry_order_live") {
      return entryOrderLiveResult({ appliedDesiredEntry: desiredEntry, calculatedQuantity });
    }

    return positionOpenResult({
      appliedDesiredEntry: desiredEntry,
      calculatedQuantity,
      firstFillAtMs: outcome.firstFillAtMs,
      averageEntryPrice: outcome.averageEntryPrice,
    });
  }
}

// Neither signal alone ever resolves a state: position_open,
// terminal_after_fill, and terminal_without_fill all require the order
// query's finding AND the position query's confirmation to positively
// agree. Every combination not explicitly matched below — including a
// clean-but-empty result everywhere, a position query that merely fails to
// contradict rather than positively confirming flat, and any contradictory
// pairing — falls through to `undefined`, the caller's signal to fail safe.
function resolveRecoveryState(
  orderSignal: OrderRecoverySignal,
  positionQuery: PositionQueryResult,
): ResolvedOutcome | undefined {
  const positionOpen = positionQuery.kind === "position";
  const positionFlat = positionQuery.kind === "no_position";

  if (orderSignal.kind === "live_unfilled" && positionFlat) {
    return { state: "entry_order_live" };
  }

  if ((orderSignal.kind === "live_with_fill" || orderSignal.kind === "terminal_with_fill") && positionOpen) {
    const row = (positionQuery as Extract<PositionQueryResult, { kind: "position" }>).row;
    return { state: "position_open", firstFillAtMs: row.openTime, averageEntryPrice: row.avgPrice };
  }

  if (orderSignal.kind === "terminal_with_fill" && positionFlat) {
    return { state: "terminal_after_fill" };
  }

  if (orderSignal.kind === "terminal_without_fill" && positionFlat) {
    return { state: "terminal_without_fill" };
  }

  return undefined;
}

// Single-pass realtime-then-history classification of the order side of the
// recovery question, reusing packageConfirmation.ts's own status sets and
// its documented priority (a positive fill finding is checked before a
// terminal-without-fill finding, exactly as confirmEntryPackage already
// does). Never retries internally — the caller's own bounded loop is the
// only retry boundary, matching classifyEntryOrderTerminality's shape.
async function classifyOrderForRecovery(input: {
  bybit: BybitAdapter;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload;
}): Promise<OrderRecoverySignal> {
  const realtimeIdentity: ExpectedOrderIdentity = input.getEntryOrderPayload;
  const realtime = await queryOrder(() => input.bybit.getOrderByLinkId(input.getEntryOrderPayload), realtimeIdentity);

  if (realtime.status === "query_failed") {
    return { kind: "inconclusive" };
  }

  if (realtime.status === "found") {
    const orderStatus = realtime.item.orderStatus;
    if (FILLED_STATUSES.has(orderStatus)) {
      return { kind: "terminal_with_fill" };
    }
    if (PARTIAL_FILL_STATUSES.has(orderStatus)) {
      return { kind: "live_with_fill" };
    }
    if (LIVE_UNFILLED_STATUSES.has(orderStatus)) {
      return { kind: "live_unfilled" };
    }
    // An unrecognized or terminal-without-fill realtime status falls
    // through to the order-history query below, the same pattern
    // confirmEntryPackage and classifyEntryOrderTerminality already use.
  }

  const historyIdentity: ExpectedOrderIdentity = input.getEntryOrderHistoryPayload;
  const history = await queryOrder(() => input.bybit.getOrderHistory(input.getEntryOrderHistoryPayload), historyIdentity);

  if (history.status === "query_failed") {
    return { kind: "inconclusive" };
  }

  if (history.status === "found") {
    const item = history.item;
    const cumulativeFilledQty = item.cumExecQty !== "" ? item.cumExecQty : "0";
    const hasFilledQty = compareDecimal(cumulativeFilledQty, "0") > 0;

    // history-endpoint items always left the realtime order book already —
    // any fill found here is necessarily on an order with no live
    // remainder, exactly as confirmEntryPackage's own history branch treats
    // any hasFilledQty finding as a fill outcome without re-checking status.
    if (hasFilledQty) {
      return { kind: "terminal_with_fill" };
    }
    if (TERMINAL_WITHOUT_FILL_STATUSES.has(item.orderStatus)) {
      return { kind: "terminal_without_fill" };
    }
    return { kind: "inconclusive" };
  }

  if (realtime.status === "not_found") {
    // Genuinely absent from both realtime and history.
    return { kind: "not_found" };
  }

  // Realtime positively found the order in an unrecognized state, and
  // history cleanly reports it absent: a positively found order must never
  // be discarded solely because history is clean-empty.
  return { kind: "inconclusive" };
}

type OrderQueryResult =
  | { status: "found"; item: BybitOrderView }
  | { status: "not_found" }
  | { status: "query_failed" };

async function queryOrder(query: () => Promise<unknown>, expected: ExpectedOrderIdentity): Promise<OrderQueryResult> {
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
  return { status: "query_failed" };
}
