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
  sharedScopeProtectionUnsupportedResult,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter, ValidatedOpenPositionRow } from "../../exchange/bybitAdapter.js";
import { executeProtectionUpdate } from "../../execution/execution.js";
import { getLiveExecutionMode } from "../../execution/liveGuard.js";
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
// live-position gate, and either an already-satisfied short-circuit (no
// exchange write) or the Bybit write followed by a bounded read-back,
// before reporting success. Writes nothing to the correlation store.
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

    // Multi-owner-aware re-verification (abi-same-side-virtual-exposure-
    // ownership-v1): findOwnerByScope()'s single-pointer answer cannot
    // represent more than one active owner, so it is no longer a valid
    // primitive for this check — findActiveRecordsForScope() is.
    const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, record.exchange_symbol);
    const selfIsActive = activeRecords.some(
      (active) =>
        active.strategy_instance_id === command.strategyInstanceId && active.trade_cycle_id === command.tradeCycleId,
    );
    if (!selfIsActive) {
      // Unreachable by construction: findActiveRecordsForScope() is scanned
      // using this same record's own exchange_category/exchange_symbol, so
      // a non-durably-closed record with a valid category always finds
      // itself. Kept as defensive verification rather than an assumption —
      // the same discipline this codebase applies to every other
      // "structurally impossible, verify anyway" check.
      return internalErrorResult();
    }
    if (activeRecords.length > 1) {
      // This scope currently has more than one active owner — PUT
      // .../protection's single position-level write cannot be safely
      // attributed to just one of them. Fails closed before the
      // live-position check and before any exchange call. Structurally
      // unreachable in production today: EntryPackageApplicationService's
      // own admission guard never lets a second active owner come to exist
      // (abi-same-side-virtual-exposure-ownership-v1) — this check is real
      // and tested ahead of the change that will eventually make it
      // reachable, not something protection itself needs to gate further.
      return sharedScopeProtectionUnsupportedResult();
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

    // Already-satisfied short-circuit: the same live-position query that
    // just confirmed the position is open also reports its current
    // stop/take. If that already numerically matches what's requested,
    // no exchange write is needed or attempted — reuses the identical
    // match/zero-leg semantics the post-write read-back uses below, so
    // there is exactly one definition of "matches the request".
    const alreadySatisfied = evaluateReadBack(
      { stopLoss: determination.confirmedStopLoss, takeProfit: determination.confirmedTakeProfit },
      command.stopPrice,
      command.takePrice,
    );

    if (alreadySatisfied !== undefined) {
      // The already-satisfied path must not bypass the live-execution
      // guard: if live writes are currently disallowed, this endpoint
      // must still fail closed rather than hand back a real-looking
      // acknowledgement of exchange state.
      if (!getLiveExecutionMode(this.deps.config).canExecuteLive) {
        return internalErrorResult();
      }

      return serializeProtectionApplied({
        strategyInstanceId: command.strategyInstanceId,
        tradeCycleId: command.tradeCycleId,
        acceptedStopPrice: command.stopPrice,
        acceptedTakePrice: command.takePrice,
        confirmedStopPrice: alreadySatisfied.confirmedStopPrice,
        confirmedTakePrice: alreadySatisfied.confirmedTakePrice,
        verificationSucceeded: true,
      });
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
