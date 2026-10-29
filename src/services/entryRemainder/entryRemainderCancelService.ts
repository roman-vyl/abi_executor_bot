import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import {
  correlationRecordKey,
  positionBindingGeometry,
  resolveRecordPhysicalPositionBinding,
} from "../../correlation/entryPackageExecutionRecord.js";
import type { PositionBindingGeometry } from "../../domain/positionScope.js";
import type {
  EntryRemainderCancelCommand,
  EntryRemainderCancelStatus,
  PositionManagementHttpResult,
} from "../../domain/positionManagementApi.js";
import {
  entryNotFilledResult,
  internalErrorResult,
  serializeEntryRemainderCancel,
  unknownTradeCycleBindingResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import { cancelEntryOrder } from "../../execution/execution.js";
import {
  classifyEntryOrderForRecovery,
  classifyEntryOrderTerminality,
  confirmEntryOrderNeutralized,
} from "../entryPackage/packageConfirmation.js";

export type EntryRemainderCancelServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  mutex: KeyedMutex;
};

type EntryQuery = {
  category: "linear";
  symbol: string;
  orderLinkId: string;
  limit: "1";
};

// Ends the unfilled remainder of an already filled entry order
// (abi-entry-remainder-cancel-v1): the same classify -> cancel -> confirm
// steps close uses to neutralize the entry, and nothing after them. Never
// reads or closes the position, never touches the native SL/TP children,
// never writes the correlation record.
export class EntryRemainderCancelService {
  private readonly deps: EntryRemainderCancelServiceDeps;

  constructor(deps: EntryRemainderCancelServiceDeps) {
    this.deps = deps;
  }

  async apply(command: EntryRemainderCancelCommand): Promise<PositionManagementHttpResult> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, async () => {
      try {
        return await this.process(command);
      } catch {
        return internalErrorResult();
      }
    });
  }

  private async process(command: EntryRemainderCancelCommand): Promise<PositionManagementHttpResult> {
    const record = this.deps.correlationRepository.get(command.strategyInstanceId, command.tradeCycleId);
    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }
    if (record.first_fill_at_ms === null) {
      return entryNotFilledResult();
    }
    if (record.status === "terminal_closed") {
      // Close proved the entry terminal before this write.
      return this.answer(command, "entry_order_already_terminal", null);
    }

    const orderLinkId = record.order_link_id;
    const physicalBinding = resolveRecordPhysicalPositionBinding(record);
    if (orderLinkId === null || record.exchange_category !== "linear" || physicalBinding === undefined) {
      return internalErrorResult();
    }
    const binding = positionBindingGeometry(physicalBinding);
    const entryQuery: EntryQuery = { category: "linear", symbol: record.exchange_symbol, orderLinkId, limit: "1" };

    const initial = await classifyEntryOrderTerminality({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
      binding,
    });
    if (initial.kind === "ambiguous") {
      return internalErrorResult();
    }
    if (initial.kind === "terminal") {
      return this.answerWithExecutedQuantity(command, "entry_order_already_terminal", entryQuery, binding);
    }

    const cancelResult = await cancelEntryOrder({
      config: this.deps.config,
      bybit: this.deps.bybit,
      payload: { category: entryQuery.category, symbol: entryQuery.symbol, orderLinkId },
    });
    if (cancelResult.status === "skipped_live_execution" || !isAcknowledged(cancelResult.bybitResponse)) {
      return internalErrorResult();
    }

    const outcome = await confirmEntryOrderNeutralized({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
      binding,
    });
    if (outcome !== "neutralized") {
      return internalErrorResult();
    }
    return this.answerWithExecutedQuantity(command, "entry_remainder_cancelled", entryQuery, binding);
  }

  // The terminal order's own executed quantity, read once more. An order the
  // exchange no longer returns at all is answered with null; any other
  // reading that does not show a terminal fill fails closed.
  private async answerWithExecutedQuantity(
    command: EntryRemainderCancelCommand,
    status: EntryRemainderCancelStatus,
    entryQuery: EntryQuery,
    binding: PositionBindingGeometry,
  ): Promise<PositionManagementHttpResult> {
    const signal = await classifyEntryOrderForRecovery({
      bybit: this.deps.bybit,
      getEntryOrderPayload: entryQuery,
      getEntryOrderHistoryPayload: entryQuery,
      binding,
    });
    if (signal.kind === "terminal_with_fill") {
      return this.answer(command, status, signal.cumulativeFilledQty);
    }
    if (signal.kind === "not_found") {
      return this.answer(command, status, null);
    }
    return internalErrorResult();
  }

  private answer(
    command: EntryRemainderCancelCommand,
    status: EntryRemainderCancelStatus,
    executedQuantity: string | null,
  ): PositionManagementHttpResult {
    return serializeEntryRemainderCancel({
      strategyInstanceId: command.strategyInstanceId,
      tradeCycleId: command.tradeCycleId,
      status,
      executedQuantity,
    });
  }
}

function isAcknowledged(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    "retCode" in response &&
    (response as Record<string, unknown>).retCode === 0
  );
}
