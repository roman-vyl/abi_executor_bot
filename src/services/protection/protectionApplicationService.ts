import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import { correlationRecordKey, isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import type { ProtectionCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  internalErrorResult,
  positionNotOpenResult,
  serializeProtectionApplied,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { InstrumentTradingRulesProvider } from "../../exchange/instrumentTradingRulesProvider.js";
import { getLiveExecutionMode } from "../../execution/liveGuard.js";
import { confirmEntryPackage, isFillFactFinal } from "../entryPackage/packageConfirmation.js";
import type { OpenPositionResolutionService } from "../openPosition/openPositionResolutionService.js";
import type { DesiredProtectionState, ReconciliationOutcome } from "./nativeProtectionReconciliation.js";
import { computeSurrogateTakePrice, reconcileNativePartialProtection } from "./nativeProtectionReconciliation.js";

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
  tradingRules: InstrumentTradingRulesProvider;
};

// Executes an already-validated PUT .../protection command through one
// production lifecycle: durable-absence shortcut, active-membership and
// live-position checks, live guard, then exact-parent native Partial
// reconciliation with fresh read-back. Writes nothing to correlation.
export class ProtectionApplicationService {
  private readonly deps: ProtectionApplicationServiceDeps;

  constructor(deps: ProtectionApplicationServiceDeps) {
    this.deps = deps;
  }

  async apply(command: ProtectionCommand): Promise<PositionManagementHttpResult> {
    const key = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.applyLocked(command));
  }

  private async reconcileOwnProtection(command: ProtectionCommand, record: EntryPackageExecutionRecord): Promise<ReconciliationOutcome> {
    if (record.order_link_id === null || record.desired_entry === null) {
      return { kind: "fail_closed", reason: "attribution_lost" };
    }
    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      return { kind: "fail_closed", reason: "attribution_lost" };
    }

    const desiredResult = await resolveDesiredProtectionState({
      command,
      record,
      bybit: this.deps.bybit,
      tradingRules: this.deps.tradingRules,
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
    const activeSides = new Set(activeRecords.map((active) => active.desired_entry?.side ?? null));
    if (activeSides.size !== 1 || activeSides.has(null) || !activeSides.has(record.desired_entry?.side ?? null)) {
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

    if (!getLiveExecutionMode(this.deps.config).canExecuteLive) {
      return internalErrorResult();
    }

    const outcome = await this.reconcileOwnProtection(command, record);
    if (outcome.kind === "fail_closed") {
      return internalErrorResult();
    }

    return serializeProtectionApplied({
      strategyInstanceId: command.strategyInstanceId,
      tradeCycleId: command.tradeCycleId,
      acceptedStopPrice: command.stopPrice,
      acceptedTakePrice: command.takePrice,
      confirmedStopPrice: command.stopPrice,
      confirmedTakePrice: command.takePrice,
      verificationSucceeded: true,
    });
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
    // fail-closed outcome rather than reject the production reconciliation
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
