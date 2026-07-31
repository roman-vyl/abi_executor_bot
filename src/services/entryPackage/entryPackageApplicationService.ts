import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type {
  BindingHistoryEndReason,
  BindingHistoryEntry,
  EntryPackageExecutionRecord,
} from "../../correlation/entryPackageExecutionRecord.js";
import { correlationRecordKey } from "../../correlation/entryPackageExecutionRecord.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type { DesiredEntryDto, EntryPackageCommand, EntryPackageHttpResult } from "../../domain/entryPackageApi.js";
import {
  internalErrorResult,
  serializeAbsentEntryPackage,
  serializeAppliedEntryPackage,
} from "../../domain/entryPackageApi.js";
import { buildEntryPackageOrderLinkId } from "../../domain/entryPackageOrderIdentity.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { EntryPackageOrderPayloads } from "../../exchange/bybitOrderMapper.js";
import { mapEntryPackageToBybit } from "../../exchange/bybitOrderMapper.js";
import { amendEntryOrder, cancelEntryOrder, executeEntryOrder } from "../../execution/execution.js";
import type { PositionSizeCalculator } from "../../risk/positionSizeCalculator.js";
import { confirmEntryPackage, confirmEntryPackageCancelled } from "./packageConfirmation.js";

export type EntryPackageApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  positionSizeCalculator: PositionSizeCalculator;
  mutex: KeyedMutex;
  // Resolves a Runtime ticker to a Bybit symbol. Structurally identical to
  // the prerequisite change's ExchangeSymbolResolver.resolve(ticker), but
  // this change does not define or implement that resolver in production
  // (design.md Decision 9, non-goal). The composition root must supply a
  // real implementation once abi-exchange-instrument-identity-v1 lands;
  // until then this dependency is the one remaining piece blocking real
  // Bybit calls for any ticker (tasks.md 0.1 / 5.3).
  resolveSymbol: (ticker: string) => string;
};

// Orchestrates APPLY / REPLACE / CANCEL / confirm-absent for a validated
// entry-package command (design.md §11). Owns nothing else: the HTTP route
// only calls this service and never touches correlation state, Bybit, or
// the mutex directly.
export class EntryPackageApplicationService {
  private readonly deps: EntryPackageApplicationServiceDeps;

  constructor(deps: EntryPackageApplicationServiceDeps) {
    this.deps = deps;
  }

  async apply(command: EntryPackageCommand): Promise<EntryPackageHttpResult> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.applyLocked(command));
  }

  private async applyLocked(command: EntryPackageCommand): Promise<EntryPackageHttpResult> {
    try {
      return await this.process(command);
    } catch {
      return internalErrorResult();
    }
  }

  private async process(command: EntryPackageCommand): Promise<EntryPackageHttpResult> {
    const record = this.deps.correlationRepository.get(command.strategyInstanceId, command.tradeCycleId);

    if (record !== undefined && record.ticker !== command.ticker) {
      return internalErrorResult();
    }

    if (command.desiredEntry === null) {
      return this.handleNullDesiredEntry(command, record);
    }

    return this.handleNonNullDesiredEntry(command, command.desiredEntry, record);
  }

  private async handleNullDesiredEntry(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord | undefined,
  ): Promise<EntryPackageHttpResult> {
    if (record === undefined) {
      await this.persistAbsentNoHistory(command);
      return this.absentResult(command);
    }

    if (record.status === "absent") {
      return this.absentResult(command);
    }

    if (record.status === "terminal_unfilled" || record.order_link_id === null) {
      await this.persistTransitionToAbsent(record);
      return this.absentResult(command);
    }

    return this.cancelLiveOrder(command, record);
  }

  private async handleNonNullDesiredEntry(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord | undefined,
  ): Promise<EntryPackageHttpResult> {
    if (record === undefined) {
      return this.createOrder(command, desiredEntry, undefined, 1);
    }

    if (record.status === "terminal_unfilled") {
      return internalErrorResult();
    }

    if (record.status === "absent") {
      return this.createOrder(command, desiredEntry, record, record.generation + 1);
    }

    if (record.desired_entry !== null && isMetadataOnlyChange(record.desired_entry, desiredEntry)) {
      return this.metadataOnlyUpdate(command, desiredEntry, record);
    }

    if (record.desired_entry !== null && isIdenticalDesiredEntry(record.desired_entry, desiredEntry)) {
      return this.repeatPutRevalidate(command, record);
    }

    if (record.order_link_id === null) {
      // Nothing was ever actually dispatched (e.g. a crashed first attempt)
      // — retry as a fresh create at the already-reserved generation.
      return this.createOrder(command, desiredEntry, record, record.generation > 0 ? record.generation : 1);
    }

    if (record.desired_entry !== null && record.desired_entry.side !== desiredEntry.side) {
      return this.replaceCancelAndCreate(command, desiredEntry, record);
    }

    return this.replaceAmend(command, desiredEntry, record);
  }

  private async createOrder(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    priorRecord: EntryPackageExecutionRecord | undefined,
    generation: number,
  ): Promise<EntryPackageHttpResult> {
    const resolvedSymbol = this.deps.resolveSymbol(command.ticker);
    const orderLinkId = buildEntryPackageOrderLinkId(
      command.strategyInstanceId,
      command.tradeCycleId,
      "entry",
      generation,
    );

    let calculatedQuantity: string;
    try {
      calculatedQuantity = await this.deps.positionSizeCalculator.calculate(
        command.ticker,
        desiredEntry.planned_entry_price,
        desiredEntry.initial_stop_price,
        command.riskMultiplier,
        { resolvedSymbol },
      );
    } catch {
      return internalErrorResult();
    }

    const now = new Date().toISOString();
    const provisional: EntryPackageExecutionRecord = {
      strategy_instance_id: command.strategyInstanceId,
      trade_cycle_id: command.tradeCycleId,
      ticker: command.ticker,
      exchange_symbol: resolvedSymbol,
      created_at: priorRecord?.created_at ?? now,
      updated_at: now,
      desired_entry: desiredEntry,
      risk_multiplier: command.riskMultiplier,
      calculated_quantity: calculatedQuantity,
      order_link_id: orderLinkId,
      order_id: null,
      generation,
      status: "pending_create",
      early_execution_observation: null,
      binding_history: priorRecord?.binding_history ?? [],
    };

    // Durable write before any exchange call (design.md §11 step 4d).
    await this.deps.correlationRepository.save(provisional);

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: resolvedSymbol,
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: calculatedQuantity,
      orderLinkId,
    });

    let executionResult;
    try {
      executionResult = await executeEntryOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: payloads.createEntryOrder,
      });
    } catch {
      await this.deps.correlationRepository.save({
        ...provisional,
        status: "create_failed",
        updated_at: new Date().toISOString(),
      });
      return internalErrorResult();
    }

    if (executionResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    const orderId = readBybitOrderId(executionResult.bybitResponse);
    const withOrderId: EntryPackageExecutionRecord = { ...provisional, order_id: orderId };

    return this.confirmAndFinalize(command, withOrderId, payloads, desiredEntry);
  }

  private async replaceAmend(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    const resolvedSymbol = this.deps.resolveSymbol(command.ticker);

    let calculatedQuantity: string;
    try {
      calculatedQuantity = await this.deps.positionSizeCalculator.calculate(
        command.ticker,
        desiredEntry.planned_entry_price,
        desiredEntry.initial_stop_price,
        command.riskMultiplier,
        { resolvedSymbol },
      );
    } catch {
      return internalErrorResult();
    }

    const now = new Date().toISOString();
    const provisional: EntryPackageExecutionRecord = {
      ...record,
      exchange_symbol: resolvedSymbol,
      desired_entry: desiredEntry,
      risk_multiplier: command.riskMultiplier,
      calculated_quantity: calculatedQuantity,
      status: "pending_replace",
      updated_at: now,
    };
    await this.deps.correlationRepository.save(provisional);

    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: resolvedSymbol,
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: calculatedQuantity,
      orderLinkId,
    });

    let executionResult;
    try {
      executionResult = await amendEntryOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: payloads.amendEntryOrder,
      });
    } catch {
      await this.deps.correlationRepository.save({
        ...provisional,
        status: "create_failed",
        updated_at: new Date().toISOString(),
      });
      return internalErrorResult();
    }

    if (executionResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    return this.confirmAndFinalize(command, provisional, payloads, desiredEntry);
  }

  private async replaceCancelAndCreate(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const cancelPayload = {
      category: this.deps.config.bybitCategory,
      symbol: record.exchange_symbol,
      orderLinkId,
    };

    await this.deps.correlationRepository.save({
      ...record,
      status: "pending_replace",
      updated_at: new Date().toISOString(),
    });

    let cancelResult;
    try {
      cancelResult = await cancelEntryOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: cancelPayload });
    } catch {
      return internalErrorResult();
    }

    if (cancelResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    const now = new Date().toISOString();
    const recordAfterCancel: EntryPackageExecutionRecord = {
      ...record,
      binding_history: [...record.binding_history, closeBindingFrom(record, "replaced", now)],
      updated_at: now,
    };

    return this.createOrder(command, desiredEntry, recordAfterCancel, record.generation + 1);
  }

  private async repeatPutRevalidate(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    const desiredEntry = record.desired_entry;
    if (desiredEntry === null) {
      return internalErrorResult();
    }

    if (record.order_link_id === null) {
      // Nothing was ever actually dispatched — retry as a fresh create at
      // the already-reserved generation (spec: retries reuse identity).
      return this.createOrder(command, desiredEntry, record, record.generation > 0 ? record.generation : 1);
    }

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: record.exchange_symbol,
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: record.calculated_quantity ?? "0",
      orderLinkId: record.order_link_id,
    });

    return this.confirmAndFinalize(command, record, payloads, desiredEntry);
  }

  private async metadataOnlyUpdate(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    const now = new Date().toISOString();
    const updated: EntryPackageExecutionRecord = {
      ...record,
      desired_entry: desiredEntry,
      risk_multiplier: command.riskMultiplier,
      updated_at: now,
    };
    await this.deps.correlationRepository.save(updated);

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: updated.exchange_symbol,
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: updated.calculated_quantity ?? "0",
      orderLinkId: updated.order_link_id ?? "",
    });

    return this.confirmAndFinalize(command, updated, payloads, desiredEntry);
  }

  private async cancelLiveOrder(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      await this.persistTransitionToAbsent(record);
      return this.absentResult(command);
    }

    const symbol = record.exchange_symbol;
    const cancelPayload = { category: this.deps.config.bybitCategory, symbol, orderLinkId };

    await this.deps.correlationRepository.save({
      ...record,
      status: "pending_cancel",
      updated_at: new Date().toISOString(),
    });

    let cancelResult;
    try {
      cancelResult = await cancelEntryOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: cancelPayload });
    } catch {
      return internalErrorResult();
    }

    if (cancelResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    const confirmation = await confirmEntryPackageCancelled({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category: this.deps.config.bybitCategory, symbol, orderLinkId, limit: "1" },
      getEntryOrderHistoryPayload: { category: this.deps.config.bybitCategory, symbol, orderLinkId, limit: "1" },
      desiredQty: record.calculated_quantity ?? "0",
    });

    const now = new Date().toISOString();

    if (confirmation.kind === "cancelled_confirmed") {
      await this.deps.correlationRepository.save({
        ...record,
        desired_entry: null,
        order_link_id: null,
        order_id: null,
        status: "absent",
        updated_at: now,
        binding_history: [...record.binding_history, closeBindingFrom(record, "cancelled", now)],
      });
      return this.absentResult(command);
    }

    if (confirmation.kind === "filled_before_cancel") {
      // A position now exists on the exchange; returning absent would be a
      // fabricated success, and the caller's own null intent cannot be
      // truthfully satisfied. Record the truth, fail safely.
      await this.deps.correlationRepository.save({
        ...record,
        status: "applied",
        early_execution_observation: confirmation.observation,
        updated_at: now,
      });
      return internalErrorResult();
    }

    await this.deps.correlationRepository.save({ ...record, status: "unknown", updated_at: now });
    return internalErrorResult();
  }

  private async confirmAndFinalize(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
    payloads: EntryPackageOrderPayloads,
    desiredEntry: DesiredEntryDto,
  ): Promise<EntryPackageHttpResult> {
    const confirmation = await confirmEntryPackage({
      bybit: this.deps.bybit,
      getEntryOrderPayload: payloads.getEntryOrder,
      getEntryOrderHistoryPayload: payloads.getEntryOrderHistory,
      desired: {
        triggerPrice: desiredEntry.planned_entry_price,
        qty: record.calculated_quantity ?? "0",
        stopLoss: desiredEntry.initial_stop_price,
        takeProfit: desiredEntry.initial_take_price,
      },
    });

    const now = new Date().toISOString();

    if (confirmation.kind === "pending_confirmed") {
      await this.deps.correlationRepository.save({ ...record, status: "applied", updated_at: now });
      return this.appliedResult(command, desiredEntry, record.calculated_quantity ?? "");
    }

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      await this.deps.correlationRepository.save({
        ...record,
        status: "applied",
        early_execution_observation: confirmation.observation,
        updated_at: now,
      });
      return this.appliedResult(command, desiredEntry, record.calculated_quantity ?? "");
    }

    if (confirmation.kind === "terminal_without_fill") {
      await this.deps.correlationRepository.save({
        ...record,
        status: "terminal_unfilled",
        updated_at: now,
        binding_history: [...record.binding_history, closeBindingFrom(record, "exchange_terminal", now)],
      });
      return internalErrorResult();
    }

    await this.deps.correlationRepository.save({ ...record, status: "unknown", updated_at: now });
    return internalErrorResult();
  }

  private async persistAbsentNoHistory(command: EntryPackageCommand): Promise<void> {
    const now = new Date().toISOString();
    await this.deps.correlationRepository.save({
      strategy_instance_id: command.strategyInstanceId,
      trade_cycle_id: command.tradeCycleId,
      ticker: command.ticker,
      exchange_symbol: "",
      created_at: now,
      updated_at: now,
      desired_entry: null,
      risk_multiplier: command.riskMultiplier,
      calculated_quantity: null,
      order_link_id: null,
      order_id: null,
      generation: 0,
      status: "absent",
      early_execution_observation: null,
      binding_history: [],
    });
  }

  private async persistTransitionToAbsent(record: EntryPackageExecutionRecord): Promise<void> {
    await this.deps.correlationRepository.save({
      ...record,
      desired_entry: null,
      order_link_id: null,
      order_id: null,
      status: "absent",
      updated_at: new Date().toISOString(),
    });
  }

  private absentResult(command: EntryPackageCommand): EntryPackageHttpResult {
    return serializeAbsentEntryPackage({
      strategyInstanceId: command.strategyInstanceId,
      tradeCycleId: command.tradeCycleId,
    });
  }

  private appliedResult(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    calculatedQuantity: string,
  ): EntryPackageHttpResult {
    return serializeAppliedEntryPackage({
      strategyInstanceId: command.strategyInstanceId,
      tradeCycleId: command.tradeCycleId,
      completePackageApplied: true,
      appliedDesiredEntry: desiredEntry,
      calculatedQuantity,
    });
  }
}

function isIdenticalDesiredEntry(a: DesiredEntryDto, b: DesiredEntryDto): boolean {
  return (
    a.side === b.side &&
    a.planned_entry_price === b.planned_entry_price &&
    a.initial_stop_price === b.initial_stop_price &&
    a.initial_take_price === b.initial_take_price &&
    a.source_plan_bar_open_time_ms === b.source_plan_bar_open_time_ms &&
    a.locked_exit_profile === b.locked_exit_profile
  );
}

function isMetadataOnlyChange(a: DesiredEntryDto, b: DesiredEntryDto): boolean {
  const coreUnchanged =
    a.side === b.side &&
    a.planned_entry_price === b.planned_entry_price &&
    a.initial_stop_price === b.initial_stop_price &&
    a.initial_take_price === b.initial_take_price;

  const metadataChanged =
    a.source_plan_bar_open_time_ms !== b.source_plan_bar_open_time_ms || a.locked_exit_profile !== b.locked_exit_profile;

  return coreUnchanged && metadataChanged;
}

function closeBindingFrom(
  record: EntryPackageExecutionRecord,
  endReason: NonNullable<BindingHistoryEndReason>,
  endedAt: string,
): BindingHistoryEntry {
  return {
    order_link_id: record.order_link_id ?? "",
    order_id: record.order_id,
    generation: record.generation,
    role: "entry",
    exchange_symbol: record.exchange_symbol,
    // Approximation: this schema does not track a dedicated per-binding
    // start timestamp, so the record's last-known updated_at is used as a
    // reasonable proxy for when the now-ending binding was last active.
    started_at: record.updated_at,
    ended_at: endedAt,
    end_reason: endReason,
  };
}

function readBybitOrderId(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return null;
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("orderId" in result)) {
    return null;
  }

  const orderId = (result as Record<string, unknown>).orderId;
  return typeof orderId === "string" && orderId !== "" ? orderId : null;
}
