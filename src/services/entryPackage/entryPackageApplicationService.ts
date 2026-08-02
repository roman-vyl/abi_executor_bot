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
import type { ExchangeInstrumentCategory, ExchangeInstrumentResolver } from "../../exchange/exchangeInstrumentResolver.js";
import { amendEntryOrder, cancelEntryOrder, executeEntryOrder } from "../../execution/execution.js";
import type { PositionSizeCalculator } from "../../risk/positionSizeCalculator.js";
import type { PackageConfirmationOutcome } from "./packageConfirmation.js";
import { confirmEntryPackage, confirmEntryPackageCancelled } from "./packageConfirmation.js";

export type EntryPackageApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  positionSizeCalculator: PositionSizeCalculator;
  mutex: KeyedMutex;
  // Resolves a Runtime ticker into its Bybit exchange instrument identity
  // (symbol, category, product). Only ever called for a new generation
  // (createOrder) — every other branch reuses the identity already stored
  // on the correlation record instead of re-resolving.
  exchangeInstrumentResolver: ExchangeInstrumentResolver;
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
    const identity = this.deps.exchangeInstrumentResolver.resolve(command.ticker);
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
        { resolvedSymbol: identity.symbol, resolvedCategory: identity.category },
      );
    } catch {
      return internalErrorResult();
    }

    const now = new Date().toISOString();
    // If this is a retry of the same not-yet-confirmed binding (same
    // generation as priorRecord), preserve the binding's real start time
    // rather than resetting it on every retry attempt.
    const isRetryOfSameBinding = priorRecord !== undefined && priorRecord.generation === generation;
    const currentBindingStartedAt = isRetryOfSameBinding
      ? priorRecord.current_binding_started_at ?? priorRecord.updated_at
      : now;

    const provisional: EntryPackageExecutionRecord = {
      strategy_instance_id: command.strategyInstanceId,
      trade_cycle_id: command.tradeCycleId,
      ticker: command.ticker,
      exchange_symbol: identity.symbol,
      exchange_category: identity.category,
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
      pending_action: "create",
      current_binding_started_at: currentBindingStartedAt,
    };

    // Durable write before any exchange call (design.md §11 step 4d).
    await this.deps.correlationRepository.save(provisional);

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: identity.symbol,
      category: identity.category,
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
      // A thrown exception here means we genuinely don't know whether
      // Bybit received and applied the command — "unknown", not a
      // definitive "create_failed", so a later retry still resends rather
      // than being permanently written off.
      await this.deps.correlationRepository.save({
        ...provisional,
        status: "unknown",
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
    // Amend targets the SAME physical order as record.order_link_id, which
    // was created under record.exchange_symbol/exchange_category —
    // re-resolving the ticker here could target a different instrument than
    // the live order actually lives under (e.g. if resolution changes over
    // time).
    const symbol = record.exchange_symbol;
    const category = requireCategory(record.exchange_category);

    let calculatedQuantity: string;
    try {
      calculatedQuantity = await this.deps.positionSizeCalculator.calculate(
        command.ticker,
        desiredEntry.planned_entry_price,
        desiredEntry.initial_stop_price,
        command.riskMultiplier,
        { resolvedSymbol: symbol, resolvedCategory: category },
      );
    } catch {
      return internalErrorResult();
    }

    const now = new Date().toISOString();
    const provisional: EntryPackageExecutionRecord = {
      ...record,
      desired_entry: desiredEntry,
      risk_multiplier: command.riskMultiplier,
      calculated_quantity: calculatedQuantity,
      status: "pending_replace",
      pending_action: "amend",
      updated_at: now,
    };
    await this.deps.correlationRepository.save(provisional);

    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol,
      category,
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
        status: "unknown",
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

    const symbol = record.exchange_symbol;
    const category = requireCategory(record.exchange_category);
    const cancelPayload = { category, symbol, orderLinkId };

    await this.deps.correlationRepository.save({
      ...record,
      status: "pending_replace",
      pending_action: "cancel_and_create",
      updated_at: new Date().toISOString(),
    });

    let cancelResult;
    try {
      cancelResult = await cancelEntryOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: cancelPayload });
    } catch {
      await this.deps.correlationRepository.save({
        ...record,
        status: "unknown",
        pending_action: "cancel_and_create",
        updated_at: new Date().toISOString(),
      });
      return internalErrorResult();
    }

    if (cancelResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    // The old order must be confirmed gone before a new (opposite-side)
    // order is created — a bare cancel acceptance from the REST call does
    // not prove the old order is no longer live, and creating a second
    // order while the first might still trigger would risk two live
    // positions simultaneously.
    const confirmation = await confirmEntryPackageCancelled({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category, symbol, orderLinkId, limit: "1" },
      getEntryOrderHistoryPayload: { category, symbol, orderLinkId, limit: "1" },
      desiredQty: record.calculated_quantity ?? "0",
    });

    const now = new Date().toISOString();

    if (confirmation.kind === "cancelled_confirmed") {
      const recordAfterCancel: EntryPackageExecutionRecord = {
        ...record,
        binding_history: [...record.binding_history, closeBindingFrom(record, "replaced", now)],
        updated_at: now,
      };
      return this.createOrder(command, desiredEntry, recordAfterCancel, record.generation + 1);
    }

    if (confirmation.kind === "filled_before_cancel") {
      // The old order actually filled despite the cancel attempt. Creating
      // a new, opposite-side order now would risk two live positions;
      // record the truth and fail safely instead.
      await this.deps.correlationRepository.save({
        ...record,
        status: "applied",
        pending_action: null,
        early_execution_observation: confirmation.observation,
        updated_at: now,
      });
      return internalErrorResult();
    }

    // ambiguous: cancellation not confirmed. Do not create a second order
    // while the old one's true state is unknown; pending_action stays
    // "cancel_and_create" so a subsequent PUT can safely retry.
    await this.deps.correlationRepository.save({ ...record, status: "unknown", updated_at: now });
    return internalErrorResult();
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
      return this.createOrder(command, desiredEntry, record, record.generation > 0 ? record.generation : 1);
    }

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: record.exchange_symbol,
      category: requireCategory(record.exchange_category),
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: record.calculated_quantity ?? "0",
      orderLinkId: record.order_link_id,
    });

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

    if (this.shouldResendPendingAction(record, confirmation)) {
      // The previous attempt's outcome was never durably confirmed, and
      // the exchange genuinely has no record of it anywhere (not merely a
      // query error) — safe to resend the in-flight action, reusing the
      // already-reserved identity rather than generating a new one (spec:
      // retries reuse identity).
      return this.resendPendingAction(command, desiredEntry, record);
    }

    return this.persistConfirmationOutcome(command, record, desiredEntry, confirmation);
  }

  private shouldResendPendingAction(
    record: EntryPackageExecutionRecord,
    confirmation: PackageConfirmationOutcome,
  ): boolean {
    return confirmation.kind === "not_found" && record.status !== "applied" && record.pending_action !== null;
  }

  private async resendPendingAction(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    switch (record.pending_action) {
      case "amend":
        return this.replaceAmend(command, desiredEntry, record);
      case "cancel_and_create":
        return this.replaceCancelAndCreate(command, desiredEntry, record);
      case "cancel":
      case "create":
      default:
        // Either a genuine create retry, or a stale "cancel" pending_action
        // left over from an interrupted CANCEL that a subsequent non-null
        // PUT has now superseded — in both cases the exchange confirmed
        // nothing exists, and the current request wants an order to exist,
        // so (re)creating at the already-reserved generation is correct.
        return this.createOrder(command, desiredEntry, record, record.generation > 0 ? record.generation : 1);
    }
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

    if (updated.order_link_id === null) {
      return this.createOrder(command, desiredEntry, updated, updated.generation > 0 ? updated.generation : 1);
    }

    const payloads = mapEntryPackageToBybit(this.deps.config, {
      symbol: updated.exchange_symbol,
      category: requireCategory(updated.exchange_category),
      side: desiredEntry.side,
      plannedEntryPrice: desiredEntry.planned_entry_price,
      initialStopPrice: desiredEntry.initial_stop_price,
      initialTakePrice: desiredEntry.initial_take_price,
      qty: updated.calculated_quantity ?? "0",
      orderLinkId: updated.order_link_id,
    });

    const confirmation = await confirmEntryPackage({
      bybit: this.deps.bybit,
      getEntryOrderPayload: payloads.getEntryOrder,
      getEntryOrderHistoryPayload: payloads.getEntryOrderHistory,
      desired: {
        triggerPrice: desiredEntry.planned_entry_price,
        qty: updated.calculated_quantity ?? "0",
        stopLoss: desiredEntry.initial_stop_price,
        takeProfit: desiredEntry.initial_take_price,
      },
    });

    if (this.shouldResendPendingAction(updated, confirmation)) {
      return this.resendPendingAction(command, desiredEntry, updated);
    }

    return this.persistConfirmationOutcome(command, updated, desiredEntry, confirmation);
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
    const category = requireCategory(record.exchange_category);
    const cancelPayload = { category, symbol, orderLinkId };

    await this.deps.correlationRepository.save({
      ...record,
      status: "pending_cancel",
      pending_action: "cancel",
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
      getEntryOrderPayload: { category, symbol, orderLinkId, limit: "1" },
      getEntryOrderHistoryPayload: { category, symbol, orderLinkId, limit: "1" },
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
        pending_action: null,
        current_binding_started_at: null,
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
        pending_action: null,
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

    return this.persistConfirmationOutcome(command, record, desiredEntry, confirmation);
  }

  private async persistConfirmationOutcome(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
    desiredEntry: DesiredEntryDto,
    confirmation: PackageConfirmationOutcome,
  ): Promise<EntryPackageHttpResult> {
    const now = new Date().toISOString();

    if (confirmation.kind === "pending_confirmed") {
      await this.deps.correlationRepository.save({
        ...record,
        risk_multiplier: command.riskMultiplier,
        status: "applied",
        pending_action: null,
        updated_at: now,
      });
      return this.appliedResult(command, desiredEntry, record.calculated_quantity ?? "");
    }

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      await this.deps.correlationRepository.save({
        ...record,
        risk_multiplier: command.riskMultiplier,
        status: "applied",
        pending_action: null,
        early_execution_observation: confirmation.observation,
        updated_at: now,
      });
      return this.appliedResult(command, desiredEntry, record.calculated_quantity ?? "");
    }

    if (confirmation.kind === "terminal_without_fill") {
      await this.deps.correlationRepository.save({
        ...record,
        risk_multiplier: command.riskMultiplier,
        status: "terminal_unfilled",
        pending_action: null,
        updated_at: now,
        binding_history: [...record.binding_history, closeBindingFrom(record, "exchange_terminal", now)],
      });
      return internalErrorResult();
    }

    // "not_found" or "ambiguous": stays unresolved. pending_action is left
    // untouched (carried via the spread) so a future repeat PUT can decide
    // whether it's safe to resend.
    await this.deps.correlationRepository.save({
      ...record,
      risk_multiplier: command.riskMultiplier,
      status: "unknown",
      updated_at: now,
    });
    return internalErrorResult();
  }

  private async persistAbsentNoHistory(command: EntryPackageCommand): Promise<void> {
    const now = new Date().toISOString();
    await this.deps.correlationRepository.save({
      strategy_instance_id: command.strategyInstanceId,
      trade_cycle_id: command.tradeCycleId,
      ticker: command.ticker,
      exchange_symbol: "",
      exchange_category: "",
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
      pending_action: null,
      current_binding_started_at: null,
    });
  }

  private async persistTransitionToAbsent(record: EntryPackageExecutionRecord): Promise<void> {
    await this.deps.correlationRepository.save({
      ...record,
      desired_entry: null,
      order_link_id: null,
      order_id: null,
      status: "absent",
      pending_action: null,
      current_binding_started_at: null,
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
    exchange_category: requireCategory(record.exchange_category),
    started_at: record.current_binding_started_at ?? record.updated_at,
    ended_at: endedAt,
    end_reason: endReason,
  };
}

// record.exchange_category is "" only for a record that has never had a
// real binding (persistAbsentNoHistory); every call site here only reads it
// once order_link_id is known non-null, i.e. a binding was actually
// created, so it must be "linear" or "spot". Anything else (including "")
// reaching here is stored-state corruption — fail closed rather than
// silently defaulting to a category that could send the wrong Bybit
// request for the actual instrument.
function requireCategory(value: ExchangeInstrumentCategory | ""): ExchangeInstrumentCategory {
  if (value === "linear" || value === "spot") {
    return value;
  }

  throw new Error(`Invalid stored exchange category: ${JSON.stringify(value)}`);
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
