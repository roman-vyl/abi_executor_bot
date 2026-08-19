import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import { correlationRecordKey, isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
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
import type { InstrumentTradingRulesProvider } from "../../exchange/instrumentTradingRulesProvider.js";
import { executeProtectionUpdate } from "../../execution/execution.js";
import { getLiveExecutionMode } from "../../execution/liveGuard.js";
import { confirmEntryPackage, isFillFactFinal } from "../entryPackage/packageConfirmation.js";
import type { OpenPositionResolutionService } from "../openPosition/openPositionResolutionService.js";
import type { DesiredProtectionState, ReconciliationOutcome } from "./nativeProtectionReconciliation.js";
import { computeSurrogateTakePrice, reconcileNativePartialProtection } from "./nativeProtectionReconciliation.js";

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
  // Only consumed by reconcileNativePartial() (this change's own
  // non-production-decision method) — process()/apply() never reads this.
  // Optional so every existing caller/test constructing
  // ProtectionApplicationServiceDeps without it keeps compiling unchanged.
  tradingRules?: InstrumentTradingRulesProvider;
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

  // Additive, non-production-decision sibling to apply()/process() (design.md
  // Decision 11): reuses the same per-pair mutex.withKeyLock discipline, but
  // reconciles this cycle's desired protection state against its actually
  // attributable native Partial protection children via in-place amend only
  // (nativeProtectionReconciliation.ts), never through
  // /v5/position/trading-stop. process()/apply() are not modified or called
  // from here, and nothing in this codebase's production paths calls this
  // method — it exists for this change's own tests, and
  // abi-native-partial-protection-cutover-v1's future production wiring.
  async reconcileNativePartial(command: ProtectionCommand): Promise<ReconciliationOutcome> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.reconcileNativePartialLocked(command));
  }

  private async reconcileNativePartialLocked(command: ProtectionCommand): Promise<ReconciliationOutcome> {
    const record = this.deps.correlationRepository.get(command.strategyInstanceId, command.tradeCycleId);
    if (
      record === undefined ||
      record.order_link_id === null ||
      record.desired_entry === null ||
      (record.exchange_category !== "linear" && record.exchange_category !== "spot") ||
      this.deps.tradingRules === undefined
    ) {
      return { kind: "fail_closed", reason: "attribution_lost" };
    }
    const category = record.exchange_category;
    const tradingRules = this.deps.tradingRules;

    const desiredResult = await resolveDesiredProtectionState({
      command,
      record,
      bybit: this.deps.bybit,
      tradingRules,
    });

    if (!desiredResult.ok) {
      return { kind: "fail_closed", reason: desiredResult.reason };
    }

    return reconcileNativePartialProtection({
      bybit: this.deps.bybit,
      category,
      symbol: record.exchange_symbol,
      entryOrderLinkId: record.order_link_id,
      desired: desiredResult.desired,
    });
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

export type QtyResolutionFailure = "no_authoritative_qty";

// Resolves this cycle's own currently known filled quantity, deliberately
// without gating on isFillFactFinal (design.md Decision 4): a live partial
// fill is an immediately usable, equally authoritative protection target,
// not a lesser one. Reuses the record's own already-final
// early_execution_observation without an exchange call when available;
// otherwise issues a fresh confirmEntryPackage() call and accepts either
// partial_fill or full_fill as authoritative. Every other outcome
// (pending_confirmed/terminal_without_fill/not_found/ambiguous) fails
// closed rather than falling back to "0".
export async function resolveCurrentOwnFilledQty(input: {
  record: EntryPackageExecutionRecord;
  bybit: BybitAdapter;
}): Promise<{ ok: true; qty: string } | { ok: false; reason: QtyResolutionFailure }> {
  const { record, bybit } = input;

  if (record.early_execution_observation !== null && isFillFactFinal(record.early_execution_observation)) {
    return { ok: true, qty: record.early_execution_observation.cumulative_filled_qty };
  }

  const category = record.exchange_category;
  if (
    record.order_link_id === null ||
    (category !== "linear" && category !== "spot")
  ) {
    return { ok: false, reason: "no_authoritative_qty" };
  }

  const outcome = await confirmEntryPackage({
    bybit,
    getEntryOrderPayload: {
      category,
      symbol: record.exchange_symbol,
      orderLinkId: record.order_link_id,
      limit: "1",
    },
    getEntryOrderHistoryPayload: {
      category,
      symbol: record.exchange_symbol,
      orderLinkId: record.order_link_id,
      limit: "1",
    },
    expected: { qty: record.calculated_quantity ?? "0" },
  });

  if (outcome.kind === "partial_fill" || outcome.kind === "full_fill") {
    return { ok: true, qty: outcome.observation.cumulative_filled_qty };
  }

  // pending_confirmed | terminal_without_fill | not_found | ambiguous
  return { ok: false, reason: "no_authoritative_qty" };
}

export type DesiredProtectionStateResolutionFailure = "no_authoritative_qty" | "trading_rules_unavailable";

// Resolves a ProtectionCommand plus this cycle's own correlation record into
// a full DesiredProtectionState (design.md Decision 4/5): qty from
// resolveCurrentOwnFilledQty (fail-closed propagated), stop.triggerPrice
// from command.stopPrice, take.triggerPrice from command.takePrice when
// non-null, else a computed, tick-normalized surrogate anchored to this
// cycle's own immutable desired_entry.planned_entry_price (no
// exchange-bound clamp — task 0 evidence, design.md Decision 5). Both legs
// always carry the same qty.
export async function resolveDesiredProtectionState(input: {
  command: ProtectionCommand;
  record: EntryPackageExecutionRecord;
  bybit: BybitAdapter;
  tradingRules: InstrumentTradingRulesProvider;
}): Promise<{ ok: true; desired: DesiredProtectionState } | { ok: false; reason: DesiredProtectionStateResolutionFailure }> {
  const { command, record, bybit, tradingRules } = input;

  const qtyResult = await resolveCurrentOwnFilledQty({ record, bybit });
  if (!qtyResult.ok) {
    return { ok: false, reason: qtyResult.reason };
  }

  if (record.desired_entry === null) {
    return { ok: false, reason: "no_authoritative_qty" };
  }
  const category = record.exchange_category;
  if (category !== "linear" && category !== "spot") {
    return { ok: false, reason: "no_authoritative_qty" };
  }

  let takeTriggerPrice: string;
  if (command.takePrice !== null) {
    takeTriggerPrice = command.takePrice;
  } else {
    // getRules() throws on a transport/decode failure (see
    // BybitInstrumentTradingRulesProvider) — this is an ordinary reconciler
    // dependency failure, not a bug, so it must resolve to a typed
    // fail-closed outcome rather than reject reconcileNativePartial()'s
    // returned Promise.
    let rules: Awaited<ReturnType<InstrumentTradingRulesProvider["getRules"]>>;
    try {
      rules = await tradingRules.getRules(record.exchange_symbol, category);
    } catch {
      return { ok: false, reason: "trading_rules_unavailable" };
    }
    takeTriggerPrice = computeSurrogateTakePrice({
      plannedEntryPrice: record.desired_entry.planned_entry_price,
      side: record.desired_entry.side,
      tickSize: rules.tickSize,
    });
  }

  return {
    ok: true,
    desired: {
      stop: { triggerPrice: command.stopPrice, qty: qtyResult.qty },
      take: { triggerPrice: takeTriggerPrice, qty: qtyResult.qty },
    },
  };
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
