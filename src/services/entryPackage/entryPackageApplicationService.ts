import { setTimeout as sleep } from "node:timers/promises";

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
import { positionScopeKey } from "../../domain/positionScope.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { EntryPackageOrderPayloads } from "../../exchange/bybitOrderMapper.js";
import { mapEntryPackageToBybit, readBybitOrderId } from "../../exchange/bybitOrderMapper.js";
import type { ExchangeInstrumentCategory, ExchangeInstrumentResolver } from "../../exchange/exchangeInstrumentResolver.js";
import { cancelEntryOrder, executeEntryOrder } from "../../execution/execution.js";
import type { PositionSizeCalculator } from "../../risk/positionSizeCalculator.js";
import type { PackageConfirmationOutcome } from "./packageConfirmation.js";
import {
  classifyEntryOrderForRecovery,
  classifyEntryOrderTerminality,
  confirmEntryPackage,
  confirmEntryPackageCancelled,
} from "./packageConfirmation.js";
import {
  AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS,
  AMBIGUOUS_CREATE_ABSENCE_RETRY_DELAY_MS,
  ambiguousCreateAbsenceCandidate,
  completedObservationIsFresh,
  observeAmbiguousCreateAbsenceAttempt,
} from "./ambiguousCreateAbsence.js";

export type EntryPackageApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  positionSizeCalculator: PositionSizeCalculator;
  // Serializes commands for one (strategy_instance_id, trade_cycle_id)
  // pair. Held for the entire process() call — see `apply()`.
  mutex: KeyedMutex;
  // Serializes acquisition of one physical position scope (category +
  // symbol) across *different* pairs. A distinct instance/keyspace from
  // `mutex` above, never the other way around: `mutex` (pair-lock) is
  // always acquired first/outer by `apply()`; `scopeMutex` is only ever
  // acquired second/inner, inside `createOrder()`, and only briefly around
  // the ownership check + durable claim write — never across a Bybit call
  // or a confirmation retry. No code path acquires `mutex` while holding
  // `scopeMutex`. This fixed ordering is what makes the two locks
  // deadlock-free by construction; preserve it if either lock's call sites
  // ever change.
  scopeMutex: KeyedMutex;
  // Resolves a Runtime ticker into its Bybit exchange instrument identity
  // (symbol, category, product). Only ever called for a new generation
  // (createOrder) — every other branch reuses the identity already stored
  // on the correlation record instead of re-resolving.
  exchangeInstrumentResolver: ExchangeInstrumentResolver;
};

// Orchestrates APPLY / REPLACE / CANCEL / confirm-absent for a validated
// entry-package command. Owns nothing else: the HTTP route only calls this
// service and never touches correlation state, Bybit, or the mutex directly.
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

    // A trade cycle that close handling has terminally closed is not downgraded
    // back to absent by a cancel-intent request — that would strip the
    // resurrection protection its terminal_closed status exists to provide
    // for the same pair. No order exists to cancel either way, so this only
    // ever acknowledges absence.
    if (record.status === "terminal_closed") {
      return this.absentResult(command);
    }

    const ambiguousCreateCandidate = ambiguousCreateAbsenceCandidate(record);
    if (ambiguousCreateCandidate !== undefined) {
      return this.revalidateAmbiguousCreateBeforeCancel(command, record, ambiguousCreateCandidate);
    }

    if (record.status === "terminal_unfilled" || record.order_link_id === null) {
      await this.persistTransitionToAbsent(record);
      return this.absentResult(command);
    }

    return this.revalidateBeforeCancel(command, record);
  }

  private async revalidateAmbiguousCreateBeforeCancel(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
    candidate: NonNullable<ReturnType<typeof ambiguousCreateAbsenceCandidate>>,
  ): Promise<EntryPackageHttpResult> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const symbol = record.exchange_symbol;
    const category = requireCategory(record.exchange_category);
    const getEntryOrderPayload = { category, symbol, orderLinkId, limit: "1" as const };
    const getEntryOrderHistoryPayload = { category, symbol, orderLinkId, limit: "1" as const };
    let cleanAbsenceAttempts = 0;
    let absenceTainted = false;

    for (let attempt = 0; attempt < AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS; attempt += 1) {
      const orderSignal = await classifyEntryOrderForRecovery({
        bybit: this.deps.bybit,
        getEntryOrderPayload,
        getEntryOrderHistoryPayload,
      });

      if (orderSignal.kind === "live_unfilled") {
        return this.cancelLiveOrder(command, record);
      }
      if (orderSignal.kind === "terminal_without_fill") {
        return this.confirmCancelOutcomeAndPersist(command, record);
      }
      if (orderSignal.kind === "live_with_fill" || orderSignal.kind === "terminal_with_fill") {
        // The positive fill observation permanently supersedes absence for
        // this request. A follow-up query may confirm and persist the fill,
        // but may never turn a vanished row into EntryPackageAbsent.
        return this.confirmCancelOutcomeAndPersist(command, record, false);
      }
      if (orderSignal.kind === "not_found") {
        const attemptEvidence = await observeAmbiguousCreateAbsenceAttempt({
          bybit: this.deps.bybit,
          category,
          symbol,
          orderLinkId,
          desiredSide: candidate.desiredSide,
        });
        if (attemptEvidence === "clean_absent") {
          cleanAbsenceAttempts += 1;
        } else {
          absenceTainted = true;
        }
      } else {
        absenceTainted = true;
      }

      if (attempt < AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS - 1) {
        await sleep(AMBIGUOUS_CREATE_ABSENCE_RETRY_DELAY_MS);
      }
    }

    if (
      absenceTainted ||
      cleanAbsenceAttempts !== AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS ||
      !(await completedObservationIsFresh({
        bybit: this.deps.bybit,
        bindingStartedAtMs: candidate.bindingStartedAtMs,
      }))
    ) {
      return internalErrorResult();
    }

    await this.persistAmbiguousCreateAbsence(record);
    return this.absentResult(command);
  }

  // Preflight for a null-desired-entry (cancel-intent) PUT against a binding
  // that isn't already known-absent or terminal-without-fill: queries the
  // exchange's current state before resending anything, so a repeat PUT
  // never blindly resends `cancelEntryOrder` to an order it can already
  // prove is no longer there to cancel. Only the non-mutating classification
  // query runs here — the actual cancel dispatch (cancelLiveOrder) fires
  // only when the order is confirmed still live.
  private async revalidateBeforeCancel(
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
    const getEntryOrderPayload = { category, symbol, orderLinkId, limit: "1" as const };
    const getEntryOrderHistoryPayload = { category, symbol, orderLinkId, limit: "1" as const };

    const classification = await classifyEntryOrderTerminality({
      bybit: this.deps.bybit,
      getEntryOrderPayload,
      getEntryOrderHistoryPayload,
    });

    if (classification.kind === "ambiguous") {
      await this.deps.correlationRepository.save({
        ...record,
        status: "unknown",
        updated_at: new Date().toISOString(),
      });
      return internalErrorResult();
    }

    if (classification.kind === "live") {
      return this.cancelLiveOrder(command, record);
    }

    // Already confirmed to have no live remainder — record the outcome
    // (cancelled, or a fill discovered instead) without resending a
    // redundant cancel command.
    return this.confirmCancelOutcomeAndPersist(command, record);
  }

  private async handleNonNullDesiredEntry(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord | undefined,
  ): Promise<EntryPackageHttpResult> {
    if (record === undefined) {
      return this.createOrder(command, desiredEntry, undefined, 1);
    }

    if (record.status === "terminal_unfilled" || record.status === "terminal_closed") {
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

    // Any other non-null desired-entry change against a live/confirmed
    // binding is served exclusively by CANCEL: no in-place amend, no atomic
    // cancel-and-create. ABI cancels the existing order and returns
    // entry_package_absent; a new desired entry is only applied by a later,
    // independent PUT for a trade cycle with no existing binding.
    return this.cancelLiveOrder(command, record);
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
      // A new generation never inherits a stale close-order identity from
      // an earlier one — see abi-pair-scoped-close-execution-v1's design.md
      // Decision 3 for why this explicit reset (not a spread of
      // priorRecord) is what makes that guarantee hold by construction.
      close_order_link_id: null,
      close_order_id: null,
      // Same reasoning as close_order_link_id/close_order_id above: a new
      // generation's own first fill (if any) has not been observed yet —
      // abi-pair-scoped-open-position-resolution-v1's design.md Decision 6.
      first_fill_at_ms: null,
      generation,
      status: "pending_create",
      early_execution_observation: null,
      binding_history: priorRecord?.binding_history ?? [],
      pending_action: "create",
      current_binding_started_at: currentBindingStartedAt,
    };

    // Scope-level guard: whichever pair reaches this scope's provisional
    // write first durably claims it. The scope lock is held only for the
    // ownership check + this one write, never across the Bybit call below;
    // holding it across external I/O would block unrelated pairs that only
    // need to prove or claim the same physical scope.
    const claim = await this.deps.scopeMutex.withKeyLock(
      positionScopeKey(identity.category, identity.symbol),
      async (): Promise<"claimed" | "conflict"> => {
        const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(identity.category, identity.symbol);
        const classification = classifyScopeAdmission(activeRecords, command, desiredEntry.side);

        // TEMPORARY, per abi-same-side-virtual-exposure-ownership-v1 (Change 5):
        // entry-package's own entry-order creation attaches position-level
        // tpslMode: "Full" protection (bybitOrderMapper.ts) — a second
        // same-side owner's own entry order would silently clobber the first
        // owner's protection the instant it is placed, before pair-owned
        // protection (Changes 6-8) exists to prevent that. Real same-side
        // admission is therefore gated here until Change 8 (once pair-owned
        // protection has replaced position-level TP/SL writes) removes this
        // block and lets `classification` decide admission on its own — every
        // outcome but "empty" conflicts for now, including "same_side".
        if (classification !== "empty") {
          return "conflict";
        }

        // Durable write before any exchange call: ABI must persist the
        // intended binding and scope ownership before causing an external
        // side effect. This write both claims the scope (via the repository's
        // live byScope update) and remains the pre-exchange-call record — no
        // separate reservation write is introduced.
        await this.deps.correlationRepository.save(provisional);
        return "claimed";
      },
    );

    if (claim === "conflict") {
      // Another pair already holds this physical scope and has not
      // durably proven it no longer can. Fail closed before any exchange
      // write; no correlation write happens for this attempt, and no new
      // public error code is introduced for this internal ownership conflict.
      return internalErrorResult();
    }

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
      expected: {
        qty: record.calculated_quantity ?? "0",
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
    // A legacy "amend"/"cancel_and_create" pending_action (see
    // LegacyEntryPackagePendingAction) is never safe to resend as CREATE:
    // the stored desired_entry may already describe a replacement B while
    // the physical order the exchange genuinely has no record of could
    // still have been the old A under a different identity. Only the two
    // pending_action values current code ever writes are eligible to
    // resend; a legacy binding instead falls through to
    // persistConfirmationOutcome's "not_found"/"ambiguous" branch, which
    // records status "unknown" and fails safe rather than resending or
    // fabricating success.
    return (
      confirmation.kind === "not_found" &&
      record.status !== "applied" &&
      (record.pending_action === "create" || record.pending_action === "cancel")
    );
  }

  private async resendPendingAction(
    command: EntryPackageCommand,
    desiredEntry: DesiredEntryDto,
    record: EntryPackageExecutionRecord,
  ): Promise<EntryPackageHttpResult> {
    // Either a genuine create retry, or a stale "cancel" pending_action left
    // over from an interrupted CANCEL that a subsequent non-null PUT has now
    // superseded — in both cases the exchange confirmed nothing exists, and
    // the current request wants an order to exist, so (re)creating at the
    // already-reserved generation is correct. Physical replace is CANCEL-only
    // now, so create is the only command this ever resends.
    return this.createOrder(command, desiredEntry, record, record.generation > 0 ? record.generation : 1);
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
      expected: {
        qty: updated.calculated_quantity ?? "0",
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

    const provisional: EntryPackageExecutionRecord = {
      ...record,
      status: "pending_cancel",
      pending_action: "cancel",
      updated_at: new Date().toISOString(),
    };
    await this.deps.correlationRepository.save(provisional);

    let cancelResult;
    try {
      cancelResult = await cancelEntryOrder({ config: this.deps.config, bybit: this.deps.bybit, payload: cancelPayload });
    } catch {
      // A thrown exception here means we genuinely don't know whether Bybit
      // received and applied the cancel — "unknown", not a silently dropped
      // pending state, matching createOrder's catch block. pending_action
      // stays "cancel" so a subsequent PUT can safely resend it.
      await this.deps.correlationRepository.save({
        ...provisional,
        status: "unknown",
        updated_at: new Date().toISOString(),
      });
      return internalErrorResult();
    }

    if (cancelResult.status === "skipped_live_execution") {
      return internalErrorResult();
    }

    return this.confirmCancelOutcomeAndPersist(command, provisional);
  }

  // Read-only re-classification of a cancel-intent binding's true exchange
  // outcome (cancelled vs. a fill discovered instead vs. still inconclusive)
  // — shared by cancelLiveOrder (after it has just sent a cancel) and
  // revalidateBeforeCancel's already-terminal branch (which never sends a
  // cancel at all, since the preflight query already proved nothing is left
  // to cancel).
  private async confirmCancelOutcomeAndPersist(
    command: EntryPackageCommand,
    record: EntryPackageExecutionRecord,
    allowCleanAbsence = true,
  ): Promise<EntryPackageHttpResult> {
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      await this.persistTransitionToAbsent(record);
      return this.absentResult(command);
    }

    const symbol = record.exchange_symbol;
    const category = requireCategory(record.exchange_category);

    const confirmation = await confirmEntryPackageCancelled({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category, symbol, orderLinkId, limit: "1" },
      getEntryOrderHistoryPayload: { category, symbol, orderLinkId, limit: "1" },
      desiredQty: record.calculated_quantity ?? "0",
    });

    const now = new Date().toISOString();

    if (confirmation.kind === "cancelled_confirmed") {
      if (!allowCleanAbsence) {
        await this.deps.correlationRepository.save({ ...record, status: "unknown", updated_at: now });
        return internalErrorResult();
      }
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
      expected: {
        qty: record.calculated_quantity ?? "0",
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
      close_order_link_id: null,
      close_order_id: null,
      first_fill_at_ms: null,
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

  private async persistAmbiguousCreateAbsence(record: EntryPackageExecutionRecord): Promise<void> {
    const now = new Date().toISOString();
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

function isOwnedBySamePair(owner: EntryPackageExecutionRecord, command: EntryPackageCommand): boolean {
  return owner.strategy_instance_id === command.strategyInstanceId && owner.trade_cycle_id === command.tradeCycleId;
}

// The real, permanent classification createOrder()'s scope-claim guard is
// built on (abi-same-side-virtual-exposure-ownership-v1 design.md
// Decision 1) — exported so it can be proven correct in isolation, against
// synthetic multi-owner fixtures, independent of the temporary production
// guard the caller currently wraps it in (see createOrder()). Excludes the
// requesting pair's own active record first: without this, a pair's own
// retry would otherwise be compared against itself once more than one
// active record can exist for a scope, which is exactly the self-conflict
// bug the architecture review found in the old findOwnerByScope()-based
// check. A `null` desired_entry on any other active record is a structural
// contradiction no current write path produces — classified as "corrupt"
// rather than silently excluded or guessed through.
export type ScopeAdmissionClassification = "empty" | "same_side" | "opposite_side" | "corrupt";

export function classifyScopeAdmission(
  activeRecords: EntryPackageExecutionRecord[],
  command: EntryPackageCommand,
  requestedSide: DesiredEntryDto["side"],
): ScopeAdmissionClassification {
  const otherActiveRecords = activeRecords.filter((record) => !isOwnedBySamePair(record, command));

  for (const other of otherActiveRecords) {
    if (other.desired_entry === null) {
      return "corrupt";
    }
  }

  if (otherActiveRecords.length === 0) {
    return "empty";
  }

  const allSameSide = otherActiveRecords.every((other) => other.desired_entry?.side === requestedSide);
  return allSameSide ? "same_side" : "opposite_side";
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
