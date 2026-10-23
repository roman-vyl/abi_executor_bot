import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import {
  correlationRecordKey,
  positionBindingGeometry,
  resolveRecordPhysicalPositionBinding,
} from "../../correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../domain/entryPackageOrderIdentity.js";
import { compareDecimal } from "../../domain/exactDecimal.js";
import { instrumentPositionScope, type PositionBindingGeometry } from "../../domain/positionScope.js";
import type { CloseCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  closeExecutionIncompleteResult,
  internalErrorResult,
  serializeTradeCycleClosed,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import { mapBindingAwareMarketCloseOrder, readBybitOrderId } from "../../exchange/bybitOrderMapper.js";
import { cancelEntryOrder, executeMarketCloseOrder } from "../../execution/execution.js";
import {
  classifyEntryOrderTerminality,
  confirmEntryOrderNeutralized,
  confirmEntryPackage,
  LIVE_UNFILLED_STATUSES,
  resolveFirstAttributableFillAtMs,
} from "../entryPackage/packageConfirmation.js";
import type { AttachedProtectionResolution } from "../protection/nativeProtectionAttribution.js";
import { resolveOwnAttachedProtection } from "../protection/nativeProtectionAttribution.js";
import type { ProtectionClass, TradeCycleClosure } from "../closure/tradeCycleClosure.js";
import {
  classifyOwnProtection,
  historyScanFor,
  proveOwnCycleCompletion,
  resolveOwnCloseOrderFate,
  storedClosure,
  terminalClosedRecord,
} from "../closure/tradeCycleClosure.js";

const BOUNDED_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

// The exact own protection pair seen when the cycle's protection was proven
// neutralized; null ids when nothing was ever attached (zero own exposure).
type ProtectionNeutralizationProof = {
  expectedStopOrderId: string | null;
  expectedTakeOrderId: string | null;
};

type ProtectionNeutralization =
  | { kind: "neutralized"; proof: ProtectionNeutralizationProof }
  | { kind: "completed"; closure: TradeCycleClosure }
  | { kind: "failed" };

export type CloseApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  mutex: KeyedMutex;
};

// One close algorithm for every owner count. The safety ordering is strict
// (abi-trade-cycle-closure-confirmation-v1 D5): entry neutralization ->
// final own exposure -> first completion proof -> protection class gate ->
// exact own protection neutralization, re-resolved -> aggregate veto ->
// stable own close -> fresh terminal verification. No market-close write is
// reachable while own protection is active, unknown, shows any fill, or is
// not freshly confirmed neutralized, nor after any own order of this cycle
// has been proven to complete it.
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
      return closedResult(command, storedClosure(record));
    }

    if (record.status === "absent" || record.status === "terminal_unfilled") {
      return this.persistTerminal(command, record, null);
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      return internalErrorResult();
    }
    if (category !== "linear") {
      return unsupportedExchangeScopeResult();
    }

    const physicalBinding = resolveRecordPhysicalPositionBinding(record);
    if (physicalBinding === undefined) {
      return internalErrorResult();
    }
    const binding = positionBindingGeometry(physicalBinding);
    const allInstrumentRecords = this.deps.correlationRepository.findActiveRecordsForInstrumentScope(
      instrumentPositionScope(category, record.exchange_symbol),
    );
    if (allInstrumentRecords.some((active) => active.position_binding_mode !== record.position_binding_mode)) {
      return internalErrorResult();
    }
    const activeRecords = physicalBinding.mode === "one_way"
      ? allInstrumentRecords
      : this.deps.correlationRepository.findActiveRecordsForDirectionalSlot(physicalBinding.slot);
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
    if (!(await this.neutralizeEntry(entryQuery, binding))) {
      return internalErrorResult();
    }

    const ownExposure = await this.resolveOwnExposure(record);
    if (ownExposure === undefined) {
      return internalErrorResult();
    }

    // D5 step 4: first proof. Nothing that can change exposure has run yet.
    const initialProtection = await this.classifyProtection(record, orderLinkId, ownExposure, binding);
    const firstProof = await proveOwnCycleCompletion({
      bybit: this.deps.bybit,
      record,
      ownExposure,
      entryTerminal: true,
      protection: initialProtection.protectionClass,
      binding,
    });
    if (firstProof.kind === "completed") {
      return this.persistTerminal(command, record, firstProof.closure);
    }
    if (firstProof.kind === "contradictory") {
      return internalErrorResult();
    }

    // D5 steps 5-6, MASTER-PLAN SAFETY GATE: protection is proven
    // neutralized before aggregate inspection, close identity recovery,
    // dispatch, or resend.
    const neutralization = await this.neutralizeOwnProtection(record, orderLinkId, ownExposure, binding, initialProtection);
    if (neutralization.kind === "failed") {
      return internalErrorResult();
    }
    if (neutralization.kind === "completed") {
      return this.persistTerminal(command, record, neutralization.closure);
    }
    const protectionProof = neutralization.proof;

    if (!(await this.aggregateIsCompatible(record, ownExposure))) {
      return internalErrorResult();
    }

    if (compareDecimal(ownExposure, "0") === 0) {
      if (!(await this.verifyTerminalPostconditions(record, ownExposure, protectionProof))) {
        return internalErrorResult();
      }
      return this.persistTerminal(command, record, null);
    }

    return this.closePositiveExposure(command, record, ownExposure, protectionProof);
  }

  private async neutralizeEntry(entryQuery: {
    category: "linear";
    symbol: string;
    orderLinkId: string;
    limit: "1";
  }, binding: PositionBindingGeometry): Promise<boolean> {
    const initial = await classifyEntryOrderTerminality({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
      binding,
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
      binding,
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
      expected: {
        qty: calculatedQuantity,
        binding: positionBindingGeometry(requirePhysicalBinding(record)),
      },
    });

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      return confirmation.observation.cumulative_filled_qty;
    }
    if (confirmation.kind === "terminal_without_fill") {
      return "0";
    }
    return undefined;
  }

  private async classifyProtection(
    record: EntryPackageExecutionRecord,
    entryOrderLinkId: string,
    ownExposure: string,
    binding: PositionBindingGeometry,
  ): Promise<{ resolution: AttachedProtectionResolution; protectionClass: ProtectionClass }> {
    const resolution = await resolveOwnAttachedProtection({
      bybit: this.deps.bybit,
      category: "linear",
      symbol: record.exchange_symbol,
      entryOrderLinkId,
      binding,
      historyScan: historyScanFor(record),
    });
    const protectionClass = await classifyOwnProtection({
      bybit: this.deps.bybit,
      category: "linear",
      symbol: record.exchange_symbol,
      resolution,
      ownExposure,
    });
    return { resolution, protectionClass };
  }

  // D5 steps 5-6. An accepted cancel is never proof that a leg did not
  // fill: after cancels the pair is re-resolved and must be the same pair in
  // class neutralized. A leg found filled here closed the cycle during
  // neutralization. `none` after a cancel is never accepted.
  private async neutralizeOwnProtection(
    record: EntryPackageExecutionRecord,
    entryOrderLinkId: string,
    ownExposure: string,
    binding: PositionBindingGeometry,
    initial: { resolution: AttachedProtectionResolution; protectionClass: ProtectionClass },
  ): Promise<ProtectionNeutralization> {
    const { resolution, protectionClass } = initial;
    if (protectionClass.kind === "neutralized") {
      return {
        kind: "neutralized",
        proof: resolution.kind === "attributed"
          ? { expectedStopOrderId: resolution.stop.orderId, expectedTakeOrderId: resolution.take.orderId }
          : { expectedStopOrderId: null, expectedTakeOrderId: null },
      };
    }
    if (protectionClass.kind !== "active" || resolution.kind !== "attributed") {
      return { kind: "failed" };
    }

    const expectedStopOrderId = resolution.stop.orderId;
    const expectedTakeOrderId = resolution.take.orderId;
    let current: AttachedProtectionResolution = resolution;

    for (let attempt = 0; attempt < BOUNDED_ATTEMPTS; attempt += 1) {
      if (current.kind !== "attributed") {
        return { kind: "failed" };
      }
      // One exact child cancel per round: Bybit deactivates the coupled
      // sibling itself, and the fresh re-read decides what is still live.
      const live = [current.stop, current.take].find((leg) => LIVE_UNFILLED_STATUSES.has(leg.orderStatus));
      if (live !== undefined) {
        const cancelResult = await cancelEntryOrder({
          config: this.deps.config,
          bybit: this.deps.bybit,
          payload: { category: "linear", symbol: record.exchange_symbol, orderId: live.orderId },
        });
        if (cancelResult.status === "skipped_live_execution") {
          return { kind: "failed" };
        }
        // A rejected cancel may mean the leg just executed: the
        // re-resolution below decides, never the cancel answer.
      }

      await sleep(RETRY_DELAY_MS);
      const next = await this.classifyProtection(record, entryOrderLinkId, ownExposure, binding);
      if (next.resolution.kind !== "attributed") {
        return { kind: "failed" };
      }
      if (next.resolution.stop.orderId !== expectedStopOrderId || next.resolution.take.orderId !== expectedTakeOrderId) {
        return { kind: "failed" };
      }

      if (next.protectionClass.kind === "neutralized") {
        return { kind: "neutralized", proof: { expectedStopOrderId, expectedTakeOrderId } };
      }
      if (next.protectionClass.kind === "completed") {
        const proof = await proveOwnCycleCompletion({
          bybit: this.deps.bybit,
          record,
          ownExposure,
          entryTerminal: true,
          protection: next.protectionClass,
          binding,
        });
        return proof.kind === "completed" ? { kind: "completed", closure: proof.closure } : { kind: "failed" };
      }
      if (next.protectionClass.kind !== "active") {
        return { kind: "failed" };
      }
      current = next.resolution;
    }

    return { kind: "failed" };
  }

  private async aggregateIsCompatible(record: EntryPackageExecutionRecord, ownExposure: string): Promise<boolean> {
    const result = await this.deps.bybit.queryPositionForInstrument({
      category: "linear",
      symbol: record.exchange_symbol,
      binding: positionBindingGeometry(requirePhysicalBinding(record)),
    });
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
    // Set when this request itself dispatched and Bybit acknowledged the
    // order: a not_found right after it is propagation lag, never absence.
    let acknowledgedThisRequest = false;

    if (current.close_order_link_id === null) {
      const dispatched = await this.dispatchCloseOrder(command, current, ownExposure);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      current = dispatched.record;
      acknowledgedThisRequest = dispatched.acknowledged;
    }

    const closeOrderLinkId = current.close_order_link_id;
    if (closeOrderLinkId === null) {
      return internalErrorResult();
    }

    let outcome = await this.resolveCloseOrderOutcome(current, closeOrderLinkId, ownExposure);
    if (outcome.kind === "not_found") {
      // Resend under the same identity only with proof the identity never
      // reached Bybit: no acknowledged dispatch in this request, a full
      // bounded window of clean not_found, and no own execution at all.
      if (acknowledgedThisRequest || !(await this.closeIdentityNeverExecuted(current, closeOrderLinkId))) {
        return internalErrorResult();
      }
      const dispatched = await this.dispatchCloseOrder(command, current, ownExposure);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      current = dispatched.record;
      outcome = await this.resolveCloseOrderOutcome(current, closeOrderLinkId, ownExposure);
      if (outcome.kind === "not_found") {
        return internalErrorResult();
      }
    }
    if (outcome.kind === "incomplete") {
      return closeExecutionIncompleteResult();
    }
    if (outcome.kind !== "matched") {
      return internalErrorResult();
    }

    // order_id comes from the close order's own read-back row; the id from
    // the dispatch answer names the same order when the row omits it.
    const closeOrderId = outcome.orderId !== "" ? outcome.orderId : current.close_order_id;
    if (closeOrderId === null || closeOrderId === "") {
      return internalErrorResult();
    }

    if (!(await this.verifyTerminalPostconditions(current, ownExposure, protectionProof))) {
      return internalErrorResult();
    }
    return this.persistTerminal(command, { ...current, close_order_id: closeOrderId }, {
      strategy_instance_id: current.strategy_instance_id,
      trade_cycle_id: current.trade_cycle_id,
      reason: "runtime_signal",
      order_id: closeOrderId,
      order_link_id: closeOrderLinkId,
      parent_order_link_id: null,
    });
  }

  private async dispatchCloseOrder(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    ownExposure: string,
  ): Promise<{ record: EntryPackageExecutionRecord; acknowledged: boolean } | undefined> {
    const closeOrderLinkId =
      record.close_order_link_id ??
      buildEntryPackageOrderLinkId(command.strategyInstanceId, command.tradeCycleId, "close", record.generation);

    let current = record;
    if (record.close_order_link_id === null) {
      current = { ...record, close_order_link_id: closeOrderLinkId, close_order_id: null };
      await this.deps.correlationRepository.save(current);
    }

    if (record.desired_entry === null) {
      return undefined;
    }
    const closePayload = mapBindingAwareMarketCloseOrder({
      category: "linear",
      symbol: record.exchange_symbol,
      entrySide: record.desired_entry.side,
      qty: ownExposure,
      orderLinkId: closeOrderLinkId,
      binding: positionBindingGeometry(requirePhysicalBinding(record)),
    });

    let result;
    try {
      result = await executeMarketCloseOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: closePayload });
    } catch {
      return undefined;
    }
    if (result.status === "skipped_live_execution") {
      return undefined;
    }

    return {
      record: { ...current, close_order_id: readBybitOrderId(result.bybitResponse) },
      acknowledged: isAcknowledged(result.bybitResponse),
    };
  }

  // The own close identity has no execution at all: the complete paged
  // execution list for that orderLinkId is empty.
  private async closeIdentityNeverExecuted(record: EntryPackageExecutionRecord, closeOrderLinkId: string): Promise<boolean> {
    const executions = await resolveFirstAttributableFillAtMs({
      bybit: this.deps.bybit,
      category: "linear",
      symbol: record.exchange_symbol,
      orderLinkId: closeOrderLinkId,
    });
    return executions.kind === "no_executions_found";
  }

  private resolveCloseOrderOutcome(record: EntryPackageExecutionRecord, closeOrderLinkId: string, ownExposure: string) {
    return resolveOwnCloseOrderFate({
      bybit: this.deps.bybit,
      category: "linear",
      symbol: record.exchange_symbol,
      closeOrderLinkId,
      ownExposure,
      binding: positionBindingGeometry(requirePhysicalBinding(record)),
    });
  }

  // D5 step 9: own entry terminal, the same own protection pair in class
  // neutralized (not merely terminal: a filled leg is never absence), and
  // the own close order matched for Q.
  private async verifyTerminalPostconditions(
    record: EntryPackageExecutionRecord,
    ownExposure: string,
    protectionProof: ProtectionNeutralizationProof,
  ): Promise<boolean> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return false;
    }
    const binding = positionBindingGeometry(requirePhysicalBinding(record));
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
        binding,
      });
      const protection = await this.classifyProtection(record, orderLinkId, ownExposure, binding);

      let closeMatched = compareDecimal(ownExposure, "0") === 0;
      if (!closeMatched && record.close_order_link_id !== null) {
        closeMatched =
          (await this.resolveCloseOrderOutcome(record, record.close_order_link_id, ownExposure)).kind === "matched";
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

  // D3: terminal_closed and the closure fields in one save, only after
  // proof; leaving the active statuses is what releases the physical scope.
  private async persistTerminal(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    closure: TradeCycleClosure | null,
  ): Promise<PositionManagementHttpResult> {
    await this.deps.correlationRepository.save(terminalClosedRecord(record, closure));
    return closedResult(command, closure);
  }
}

function protectionMatchesProof(
  protection: { resolution: AttachedProtectionResolution; protectionClass: ProtectionClass },
  proof: ProtectionNeutralizationProof,
): boolean {
  if (protection.protectionClass.kind !== "neutralized") {
    return false;
  }
  const { resolution } = protection;
  if (resolution.kind === "none") {
    return proof.expectedStopOrderId === null && proof.expectedTakeOrderId === null;
  }
  return (
    resolution.kind === "attributed" &&
    resolution.stop.orderId === proof.expectedStopOrderId &&
    resolution.take.orderId === proof.expectedTakeOrderId
  );
}

function requirePhysicalBinding(record: EntryPackageExecutionRecord) {
  const binding = resolveRecordPhysicalPositionBinding(record);
  if (binding === undefined) {
    throw new Error("record has no usable physical position binding");
  }
  return binding;
}

function isAcknowledged(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    "retCode" in response &&
    (response as Record<string, unknown>).retCode === 0
  );
}

function closedResult(command: CloseCommand, closure: TradeCycleClosure | null): PositionManagementHttpResult {
  return serializeTradeCycleClosed({
    strategyInstanceId: command.strategyInstanceId,
    tradeCycleId: command.tradeCycleId,
    positionZeroVerified: true,
    noAttributedActiveOrdersVerified: true,
    correlationCompleteAndConsistent: true,
    closure,
  });
}
