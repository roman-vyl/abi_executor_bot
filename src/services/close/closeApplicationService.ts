import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import { correlationRecordKey } from "../../correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../domain/entryPackageOrderIdentity.js";
import { compareDecimal } from "../../domain/exactDecimal.js";
import type { CloseCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  closeExecutionIncompleteResult,
  internalErrorResult,
  serializeTradeCycleClosed,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { BybitMarketCloseOrderPayload } from "../../exchange/bybitOrderMapper.js";
import { readBybitOrderId } from "../../exchange/bybitOrderMapper.js";
import { cancelEntryOrder, executeMarketCloseOrder } from "../../execution/execution.js";
import {
  classifyEntryOrderTerminality,
  classifyOwnCloseOrderOutcome,
  confirmEntryOrderNeutralized,
  confirmEntryPackage,
  FILLED_STATUSES,
  TERMINAL_WITHOUT_FILL_STATUSES,
} from "../entryPackage/packageConfirmation.js";
import type { AttachedProtectionResolution } from "../protection/nativeProtectionAttribution.js";
import { resolveOwnAttachedProtection } from "../protection/nativeProtectionAttribution.js";

const BOUNDED_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

type ProtectionNeutralizationProof = {
  expectedStopOrderId: string | null;
  expectedTakeOrderId: string | null;
  cleanAbsenceAllowed: boolean;
};

export type CloseApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  mutex: KeyedMutex;
};

// One close algorithm for every owner count. The safety ordering is strict:
// entry neutralization -> final own exposure -> exact own protection
// neutralization -> aggregate veto -> stable own close -> fresh terminal
// verification. No market-close write is reachable while own protection is
// active, ambiguous, or not freshly confirmed neutralized.
export class CloseApplicationService {
  private readonly deps: CloseApplicationServiceDeps;

  constructor(deps: CloseApplicationServiceDeps) {
    this.deps = deps;
  }

  async apply(command: CloseCommand): Promise<PositionManagementHttpResult> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.applyLocked(command));
  }

  private async applyLocked(command: CloseCommand): Promise<PositionManagementHttpResult> {
    try {
      return await this.process(command);
    } catch {
      return internalErrorResult();
    }
  }

  private async process(command: CloseCommand): Promise<PositionManagementHttpResult> {
    const record = this.deps.correlationRepository.get(command.strategyInstanceId, command.tradeCycleId);
    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    if (record.status === "terminal_closed") {
      return closedResult(command);
    }

    if (record.status === "absent" || record.status === "terminal_unfilled") {
      return this.persistTerminal(command, record);
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      return internalErrorResult();
    }
    if (category !== "linear") {
      return unsupportedExchangeScopeResult();
    }

    const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, record.exchange_symbol);
    const selfKey = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    if (!activeRecords.some((active) => correlationRecordKey(active.strategy_instance_id, active.trade_cycle_id) === selfKey)) {
      return internalErrorResult();
    }
    const activeSides = new Set(activeRecords.map((active) => active.desired_entry?.side ?? null));
    if (activeSides.size !== 1 || activeSides.has(null) || record.desired_entry === null || !activeSides.has(record.desired_entry.side)) {
      return internalErrorResult();
    }

    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const symbol = record.exchange_symbol;
    const entryQuery = { category, symbol, orderLinkId, limit: "1" as const };
    if (!(await this.neutralizeEntry(entryQuery))) {
      return internalErrorResult();
    }

    const ownExposure = await this.resolveOwnExposure(record);
    if (ownExposure === undefined) {
      return internalErrorResult();
    }

    // MASTER-PLAN SAFETY GATE: protection is neutralized before aggregate
    // inspection, close identity recovery, dispatch, or resend.
    const protectionProof = await this.neutralizeOwnProtection(category, symbol, orderLinkId, ownExposure);
    if (protectionProof === undefined) {
      return internalErrorResult();
    }

    if (!(await this.aggregateIsCompatible(record, ownExposure))) {
      return internalErrorResult();
    }

    if (compareDecimal(ownExposure, "0") === 0) {
      if (!(await this.verifyTerminalPostconditions(record, ownExposure, protectionProof))) {
        return internalErrorResult();
      }
      return this.persistTerminal(command, record);
    }

    return this.closePositiveExposure(command, record, ownExposure, protectionProof);
  }

  private async neutralizeEntry(entryQuery: {
    category: "linear";
    symbol: string;
    orderLinkId: string;
    limit: "1";
  }): Promise<boolean> {
    const initial = await classifyEntryOrderTerminality({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
    });

    if (initial.kind === "terminal") {
      return true;
    }

    const cancelResult = await cancelEntryOrder({
      config: this.deps.config,
      bybit: this.deps.bybit,
      payload: {
        category: entryQuery.category,
        symbol: entryQuery.symbol,
        orderLinkId: entryQuery.orderLinkId,
      },
    });
    if (cancelResult.status === "skipped_live_execution" || !isAcknowledged(cancelResult.bybitResponse)) {
      return false;
    }

    const outcome = await confirmEntryOrderNeutralized({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
    });
    return outcome !== "ambiguous";
  }

  private async resolveOwnExposure(record: EntryPackageExecutionRecord): Promise<string | undefined> {
    const calculatedQuantity = record.calculated_quantity;
    const orderLinkId = record.order_link_id;
    const category = record.exchange_category;
    if (calculatedQuantity === null || orderLinkId === null || (category !== "linear" && category !== "spot")) {
      return undefined;
    }

    const confirmation = await confirmEntryPackage({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category, symbol: record.exchange_symbol, orderLinkId, limit: "1" },
      getEntryOrderHistoryPayload: { category, symbol: record.exchange_symbol, orderLinkId, limit: "1" },
      expected: { qty: calculatedQuantity },
    });

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      return confirmation.observation.cumulative_filled_qty;
    }
    if (confirmation.kind === "terminal_without_fill") {
      return "0";
    }
    return undefined;
  }

  private async neutralizeOwnProtection(
    category: "linear",
    symbol: string,
    entryOrderLinkId: string,
    ownExposure: string,
  ): Promise<ProtectionNeutralizationProof | undefined> {
    let resolution = await resolveOwnAttachedProtection({ bybit: this.deps.bybit, category, symbol, entryOrderLinkId });
    let expectedStopOrderId: string | null = null;
    let expectedTakeOrderId: string | null = null;
    let cleanAbsenceAllowed = compareDecimal(ownExposure, "0") === 0;

    for (let attempt = 0; attempt < BOUNDED_ATTEMPTS; attempt += 1) {
      if (resolution.kind === "none") {
        return cleanAbsenceAllowed
          ? { expectedStopOrderId, expectedTakeOrderId, cleanAbsenceAllowed: true }
          : undefined;
      }
      if (resolution.kind === "ambiguous") {
        return undefined;
      }

      if (expectedStopOrderId === null && expectedTakeOrderId === null) {
        expectedStopOrderId = resolution.stop.orderId;
        expectedTakeOrderId = resolution.take.orderId;
      } else if (
        resolution.stop.orderId !== expectedStopOrderId ||
        resolution.take.orderId !== expectedTakeOrderId
      ) {
        return undefined;
      }

      const active = [resolution.stop, resolution.take].find((leg) => !isTerminalOrderStatus(leg.orderStatus));
      if (active === undefined) {
        return {
          expectedStopOrderId,
          expectedTakeOrderId,
          cleanAbsenceAllowed: true,
        };
      }

      const cancelResult = await cancelEntryOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: { category, symbol, orderId: active.orderId },
      });
      if (cancelResult.status === "skipped_live_execution" || !isAcknowledged(cancelResult.bybitResponse)) {
        return undefined;
      }
      // The pair was freshly and exactly attributed before this accepted
      // cancel. A subsequent clean `none` is therefore caller-justified
      // safe absence: realtime proves neither child is active, while the
      // terminal history rows may still be in Bybit's propagation gap.
      cleanAbsenceAllowed = true;

      if (attempt < BOUNDED_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
        resolution = await resolveOwnAttachedProtection({ bybit: this.deps.bybit, category, symbol, entryOrderLinkId });
      }
    }

    return undefined;
  }

  private async aggregateIsCompatible(record: EntryPackageExecutionRecord, ownExposure: string): Promise<boolean> {
    const result = await this.deps.bybit.queryPositionForInstrument({ category: "linear", symbol: record.exchange_symbol });
    const ownIsZero = compareDecimal(ownExposure, "0") === 0;

    if (result.kind === "failure") {
      return false;
    }
    if (result.kind === "no_position") {
      return ownIsZero;
    }

    const expectedSide = record.desired_entry?.side === "long" ? "Buy" : "Sell";
    if (result.row.side !== expectedSide) {
      return false;
    }
    if (ownIsZero) {
      return true;
    }
    return compareDecimal(result.row.size, ownExposure) >= 0;
  }

  private async closePositiveExposure(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    ownExposure: string,
    protectionProof: ProtectionNeutralizationProof,
  ): Promise<PositionManagementHttpResult> {
    let current = record;

    if (current.close_order_link_id === null) {
      const dispatched = await this.dispatchCloseOrder(command, current, ownExposure);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      current = dispatched;
    }

    const closeOrderLinkId = current.close_order_link_id;
    if (closeOrderLinkId === null) {
      return internalErrorResult();
    }

    const outcome = await this.resolveCloseOrderOutcome("linear", current.exchange_symbol, closeOrderLinkId, ownExposure);
    if (outcome === "incomplete") {
      return closeExecutionIncompleteResult();
    }
    if (outcome === "ambiguous") {
      return internalErrorResult();
    }
    if (outcome === "not_found") {
      const dispatched = await this.dispatchCloseOrder(command, current, ownExposure);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      const resentOutcome = await this.resolveCloseOrderOutcome(
        "linear",
        current.exchange_symbol,
        closeOrderLinkId,
        ownExposure,
      );
      if (resentOutcome === "incomplete") {
        return closeExecutionIncompleteResult();
      }
      if (resentOutcome !== "matched") {
        return internalErrorResult();
      }
      current = dispatched;
    }

    if (!(await this.verifyTerminalPostconditions(current, ownExposure, protectionProof))) {
      return internalErrorResult();
    }
    return this.persistTerminal(command, current);
  }

  private async dispatchCloseOrder(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    ownExposure: string,
  ): Promise<EntryPackageExecutionRecord | undefined> {
    const closeOrderLinkId =
      record.close_order_link_id ??
      buildEntryPackageOrderLinkId(command.strategyInstanceId, command.tradeCycleId, "close", record.generation);

    let current = record;
    if (record.close_order_link_id === null) {
      current = { ...record, close_order_link_id: closeOrderLinkId, close_order_id: null };
      await this.deps.correlationRepository.save(current);
    }

    const closePayload: BybitMarketCloseOrderPayload = {
      category: "linear",
      symbol: record.exchange_symbol,
      side: record.desired_entry?.side === "long" ? "Sell" : "Buy",
      orderType: "Market",
      qty: ownExposure,
      reduceOnly: true,
      positionIdx: 0,
      orderLinkId: closeOrderLinkId,
    };

    let result;
    try {
      result = await executeMarketCloseOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: closePayload });
    } catch {
      return undefined;
    }
    if (result.status === "skipped_live_execution") {
      return undefined;
    }

    return { ...current, close_order_id: readBybitOrderId(result.bybitResponse) };
  }

  private async resolveCloseOrderOutcome(
    category: "linear",
    symbol: string,
    closeOrderLinkId: string,
    ownExposure: string,
  ): Promise<"matched" | "incomplete" | "not_found" | "ambiguous"> {
    const query = { category, symbol, orderLinkId: closeOrderLinkId, limit: "1" as const };

    for (let attempt = 0; attempt < BOUNDED_ATTEMPTS; attempt += 1) {
      const outcome = await classifyOwnCloseOrderOutcome({
        bybit: this.deps.bybit,
        getCloseOrderPayload: query,
        getCloseOrderHistoryPayload: query,
        expectedQty: ownExposure,
      });

      if (outcome.kind === "matched") {
        return "matched";
      }
      if (outcome.kind === "zero_fill" || outcome.kind === "qty_mismatch") {
        return "incomplete";
      }
      if (outcome.kind === "not_found") {
        return "not_found";
      }
      if (attempt < BOUNDED_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
    return "ambiguous";
  }

  private async verifyTerminalPostconditions(
    record: EntryPackageExecutionRecord,
    ownExposure: string,
    protectionProof: ProtectionNeutralizationProof,
  ): Promise<boolean> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return false;
    }
    const entryQuery = {
      category: "linear" as const,
      symbol: record.exchange_symbol,
      orderLinkId,
      limit: "1" as const,
    };

    for (let attempt = 0; attempt < BOUNDED_ATTEMPTS; attempt += 1) {
      const entry = await classifyEntryOrderTerminality({
        bybit: this.deps.bybit,
        getEntryOrderPayload: entryQuery,
        getEntryOrderHistoryPayload: entryQuery,
      });
      const protection = await resolveOwnAttachedProtection({
        bybit: this.deps.bybit,
        category: "linear",
        symbol: record.exchange_symbol,
        entryOrderLinkId: orderLinkId,
      });

      let closeMatched = compareDecimal(ownExposure, "0") === 0;
      if (!closeMatched && record.close_order_link_id !== null) {
        closeMatched =
          (await this.resolveCloseOrderOutcome(
            "linear",
            record.exchange_symbol,
            record.close_order_link_id,
            ownExposure,
          )) === "matched";
      }

      if (entry.kind === "terminal" && protectionMatchesProof(protection, protectionProof) && closeMatched) {
        return true;
      }
      if (attempt < BOUNDED_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async persistTerminal(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
  ): Promise<PositionManagementHttpResult> {
    await this.deps.correlationRepository.save({
      ...record,
      status: "terminal_closed",
      pending_action: null,
      updated_at: new Date().toISOString(),
    });
    return closedResult(command);
  }
}

function protectionMatchesProof(
  resolution: AttachedProtectionResolution,
  proof: ProtectionNeutralizationProof,
): boolean {
  if (resolution.kind === "none") {
    return proof.cleanAbsenceAllowed;
  }
  if (resolution.kind === "ambiguous") {
    return false;
  }
  return (
    proof.expectedStopOrderId !== null &&
    proof.expectedTakeOrderId !== null &&
    resolution.stop.orderId === proof.expectedStopOrderId &&
    resolution.take.orderId === proof.expectedTakeOrderId &&
    isTerminalOrderStatus(resolution.stop.orderStatus) &&
    isTerminalOrderStatus(resolution.take.orderStatus)
  );
}

function isTerminalOrderStatus(orderStatus: string): boolean {
  return FILLED_STATUSES.has(orderStatus) || TERMINAL_WITHOUT_FILL_STATUSES.has(orderStatus);
}

function isAcknowledged(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    "retCode" in response &&
    (response as Record<string, unknown>).retCode === 0
  );
}

function closedResult(command: CloseCommand): PositionManagementHttpResult {
  return serializeTradeCycleClosed({
    strategyInstanceId: command.strategyInstanceId,
    tradeCycleId: command.tradeCycleId,
    positionZeroVerified: true,
    noAttributedActiveOrdersVerified: true,
    correlationCompleteAndConsistent: true,
  });
}
