import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import { correlationRecordKey, isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import { classifyExactDecimalText } from "../../domain/entryPackageApi.js";
import type { ProtectionCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  internalErrorResult,
  isNumericallyEqualExactDecimal,
  positionNotOpenResult,
  serializeProtectionApplied,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter, ValidatedOpenPositionRow } from "../../exchange/bybitAdapter.js";
import { executeProtectionUpdate } from "../../execution/execution.js";
import type { OpenPositionResolutionService } from "../openPosition/openPositionResolutionService.js";

// Reuses the same bounded-retry shape packageConfirmation.ts already uses
// elsewhere in ABI: a small fixed number of fresh re-reads, never a repeated
// write.
const READ_BACK_ATTEMPTS = 2;
const READ_BACK_RETRY_DELAY_MS = 300;

export type ProtectionApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  // Serializes protection commands against entry-package commands for the
  // same pair — the identical instance and key space
  // EntryPackageApplicationService already uses. Not the scope-level lock:
  // protection only reads scope ownership, never claims or releases it.
  mutex: KeyedMutex;
  // Reused for the live-position gate so Bybit position-envelope validation,
  // category restriction, and side matching are defined exactly once.
  openPositionResolutionService: OpenPositionResolutionService;
};

type ReadBackMatch = {
  confirmedStopPrice: string;
  confirmedTakePrice: string | null;
};

// Executes an already-validated PUT .../protection command: durable-absence
// shortcut, independent scope-ownership re-verification, the shared
// live-position gate, the Bybit write, and a bounded read-back before
// reporting success. Writes nothing to the correlation store.
export class ProtectionApplicationService {
  private readonly deps: ProtectionApplicationServiceDeps;

  constructor(deps: ProtectionApplicationServiceDeps) {
    this.deps = deps;
  }

  async apply(command: ProtectionCommand): Promise<PositionManagementHttpResult> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.applyLocked(command));
  }

  private async applyLocked(command: ProtectionCommand): Promise<PositionManagementHttpResult> {
    try {
      return await this.process(command);
    } catch {
      return internalErrorResult();
    }
  }

  private async process(command: ProtectionCommand): Promise<PositionManagementHttpResult> {
    const record = this.deps.correlationRepository.get(command.strategyInstanceId, command.tradeCycleId);

    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    // A durably absent pair's scope may already belong to a different pair
    // — an ownership lookup must not run before this check.
    if (isDurablyClosedEntryPackageStatus(record.status)) {
      return positionNotOpenResult();
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      // Empty category on a non-durably-closed record contradicts the
      // correlation replay invariant; fail closed rather than call
      // findOwnerByScope with an invalid value.
      return internalErrorResult();
    }

    const owner = this.deps.correlationRepository.findOwnerByScope(category, record.exchange_symbol);
    if (
      owner === undefined ||
      owner.strategy_instance_id !== command.strategyInstanceId ||
      owner.trade_cycle_id !== command.tradeCycleId
    ) {
      // Should be unreachable while scope ownership is internally
      // consistent — re-verified independently rather than assumed.
      return internalErrorResult();
    }

    const determination = await this.deps.openPositionResolutionService.determine(record);

    if (determination.kind === "closed") {
      return positionNotOpenResult();
    }
    if (determination.kind === "unsupported_scope") {
      return unsupportedExchangeScopeResult();
    }
    if (determination.kind === "error") {
      return internalErrorResult();
    }

    const writeResult = await executeProtectionUpdate({
      config: this.deps.config,
      bybit: this.deps.bybit,
      payload: {
        category,
        symbol: record.exchange_symbol,
        stopLoss: command.stopPrice,
        // "0" is Bybit's own convention for "remove this leg" on
        // /v5/position/trading-stop.
        takeProfit: command.takePrice ?? "0",
      },
    });

    if (writeResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    return this.confirmByReadBack(command, category, record.exchange_symbol);
  }

  private async confirmByReadBack(
    command: ProtectionCommand,
    category: "linear" | "spot",
    symbol: string,
  ): Promise<PositionManagementHttpResult> {
    for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
      const queryResult = await this.deps.bybit.queryPositionForInstrument({ category, symbol });

      if (queryResult.kind === "position") {
        const match = evaluateReadBack(queryResult.row, command.stopPrice, command.takePrice);
        if (match !== undefined) {
          return serializeProtectionApplied({
            strategyInstanceId: command.strategyInstanceId,
            tradeCycleId: command.tradeCycleId,
            acceptedStopPrice: command.stopPrice,
            acceptedTakePrice: command.takePrice,
            confirmedStopPrice: match.confirmedStopPrice,
            confirmedTakePrice: match.confirmedTakePrice,
            verificationSucceeded: true,
          });
        }
      }

      if (attempt < READ_BACK_ATTEMPTS - 1) {
        await sleep(READ_BACK_RETRY_DELAY_MS);
      }
    }

    return internalErrorResult();
  }
}

// A confirmed leg reading as numeric zero satisfies an accepted
// take_price: null — Bybit reports an unset leg as a numeric zero (e.g.
// "0.00"), not necessarily the string the write used. Returns undefined
// when this attempt does not yet confirm the accepted values, so the caller
// can retry within its bounded budget.
function evaluateReadBack(
  row: Pick<ValidatedOpenPositionRow, "stopLoss" | "takeProfit">,
  acceptedStopPrice: string,
  acceptedTakePrice: string | null,
): ReadBackMatch | undefined {
  if (row.stopLoss === undefined || !isNumericallyEqualExactDecimal(row.stopLoss, acceptedStopPrice)) {
    return undefined;
  }

  if (acceptedTakePrice === null) {
    if (row.takeProfit === undefined || !classifyExactDecimalText(row.takeProfit).zero) {
      return undefined;
    }
    return { confirmedStopPrice: row.stopLoss, confirmedTakePrice: null };
  }

  if (row.takeProfit === undefined || !isNumericallyEqualExactDecimal(row.takeProfit, acceptedTakePrice)) {
    return undefined;
  }

  return { confirmedStopPrice: row.stopLoss, confirmedTakePrice: row.takeProfit };
}
