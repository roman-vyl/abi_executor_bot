import { setTimeout as sleep } from "node:timers/promises";

import { compareDecimal } from "../../domain/exactDecimal.js";
import type { RecoveryStateHttpResult } from "../../domain/entryCycleRecoveryApi.js";
import {
  entryOrderNotFoundResult,
  entryOrderLiveResult,
  internalErrorResult,
  positionOpenResult,
  terminalAfterFillResult,
  terminalWithoutFillResult,
  unknownTradeCycleBindingResult,
} from "../../domain/entryCycleRecoveryApi.js";
import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import { correlationRecordKey, isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import type { DesiredEntryDto } from "../../domain/entryPackageApi.js";
import type { BybitAdapter, BybitOrderSide, PositionQueryResult } from "../../exchange/bybitAdapter.js";
import type { BybitGetOrderByLinkIdPayload, BybitGetOrderHistoryPayload } from "../../exchange/bybitOrderMapper.js";
import {
  classifyEntryOrderForRecovery,
  classifyOwnCloseOrderOutcome,
  resolveFirstAttributableFillAtMs,
} from "../entryPackage/packageConfirmation.js";
import type { OwnCloseOrderOutcome, RecoveryEntryOrderSignal } from "../entryPackage/packageConfirmation.js";
import {
  AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS,
  AMBIGUOUS_CREATE_ABSENCE_RETRY_DELAY_MS,
  ambiguousCreateAbsenceCandidate,
  completedObservationIsFresh,
  observeAmbiguousCreateAbsenceAttempt,
} from "../entryPackage/ambiguousCreateAbsence.js";

// Same bounded-retry shape CloseApplicationService.verifyBothPostconditions
// already uses (3 attempts / 300ms) — no time-based recovery horizon of any
// kind, only a bound on how many times this one request re-queries before
// giving up and returning the safe-error response.
export type RecoveryQuery = {
  strategyInstanceId: string;
  tradeCycleId: string;
};

export type EntryCycleRecoveryResolutionServiceDeps = {
  correlationRepository: EntryPackageCorrelationRepository;
  bybit: BybitAdapter;
  // Used only to durably capture first_fill_at_ms exactly once, when
  // resolving position_open — the same shared instance
  // OpenPositionResolutionService/ProtectionApplicationService/
  // CloseApplicationService already use (abi-entry-cycle-recovery-
  // attribution-v1 design.md Decision 2).
  mutex: KeyedMutex;
};

// The order side of the recovery composition, distinct from
// packageConfirmation.ts's PackageConfirmationOutcome: recovery needs to
// know not just whether a fill was observed, but whether the order that
// carries it is still live or already terminal — a PartiallyFilled order is
// live evidence, a Filled (or history-terminal) order is terminal evidence,
// and neither is interchangeable with the other for this capability's own
// state grid. The two fill-carrying variants also carry this cycle's own
// averageEntryPrice/cumulativeFilledQty, read from the same already-fetched
// response — never a second query, and never sourced from the aggregate
// position (abi-entry-cycle-recovery-attribution-v1 design.md Decision 1).
type ResolvedOutcome =
  | { state: "entry_order_live" }
  | { state: "position_open"; averageEntryPrice: string }
  | { state: "terminal_without_fill" }
  | { state: "terminal_after_fill" };

// The aggregate physical position query's role, downgraded from "required
// positive agreement" to a narrow veto every state's own evidence can only
// be blocked by, never manufactured from (abi-entry-cycle-recovery-
// attribution-v1 design.md Decision 4d). "no_signal" deliberately collapses
// a genuinely flat aggregate and an inconclusive/failed query into one
// outcome: this capability's own "absence of evidence is never evidence of
// absence" rule already treats a query that merely fails to contradict as
// not a positive confirmation of anything.
type AggregateSanity = "opposite_side_contradiction" | "same_side_exists" | "no_signal";

// Resolves one Runtime-owned trade cycle's exchange ground truth for
// recovery purposes: entry_order_live, position_open, terminal_without_fill,
// or terminal_after_fill — or fails safe when it cannot positively establish
// one of those four from non-contradictory evidence. Read-only with respect
// to the exchange: never cancels, amends, or creates anything — the one
// durable write this capability performs (first_fill_at_ms's one-time
// capture) is ABI's own local correlation record, not an exchange side
// effect (abi-entry-cycle-recovery-attribution-v1 design.md, "never causes
// an exchange side effect" clarification).
//
// Every state's candidate resolves from this specific trade cycle's own
// durable/order/execution evidence — its own entry order and, once that
// order proves a fill, its own close order (Change 2's durable
// close_order_link_id, classified via the same exact-quantity-matching
// strictness CloseApplicationService already uses, through the shared
// classifyOwnCloseOrderOutcome primitive) — never from the aggregate
// physical position as a required, co-equal signal. The aggregate query is
// retained only as a narrow, per-state veto (design.md Decision 4).
export class EntryCycleRecoveryResolutionService {
  private readonly deps: EntryCycleRecoveryResolutionServiceDeps;

  constructor(deps: EntryCycleRecoveryResolutionServiceDeps) {
    this.deps = deps;
  }

  async resolve(query: RecoveryQuery): Promise<RecoveryStateHttpResult> {
    try {
      return await this.process(query);
    } catch {
      return internalErrorResult();
    }
  }

  private async process(query: RecoveryQuery): Promise<RecoveryStateHttpResult> {
    const record = this.deps.correlationRepository.get(query.strategyInstanceId, query.tradeCycleId);
    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    // A durably closed status is ABI's own previously confirmed fact — see
    // the class-level doc comment. Resolving directly from it, before ever
    // requiring order_link_id or querying Bybit, is what keeps a successful
    // cancel or entry-package outcome recoverable even when the caller lost
    // the original HTTP response.
    if (isDurablyClosedEntryPackageStatus(record.status)) {
      return record.status === "terminal_closed" ? terminalAfterFillResult() : terminalWithoutFillResult();
    }

    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      // The status above already ruled out every durably closed case — a
      // null order_link_id here means no order identity is bound for a
      // still-open, non-terminal status: there is nothing to query and no
      // positive evidence this capability can act on. Fails safe like any
      // other inconclusive attempt rather than inventing a fifth state.
      return internalErrorResult();
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      // Unreachable while a non-null order_link_id always carries a real
      // resolved category — re-verified independently rather than assumed,
      // mirroring CloseApplicationService's identical defensive check.
      return internalErrorResult();
    }

    const symbol = record.exchange_symbol;
    const getEntryOrderPayload: BybitGetOrderByLinkIdPayload = { category, symbol, orderLinkId, limit: "1" };
    const getEntryOrderHistoryPayload: BybitGetOrderHistoryPayload = { category, symbol, orderLinkId, limit: "1" };

    // Read once, before the loop: this field is immutable-once-set
    // (Change 2's own design), so re-reading it every attempt is
    // unnecessary — design.md Decision 4e.
    const closeOrderLinkId = record.close_order_link_id;
    const closeOrderAttempted = closeOrderLinkId !== null;

    const absenceCandidate = ambiguousCreateAbsenceCandidate(record);
    let cleanAbsenceAttempts = 0;
    let absenceTainted = false;

    for (let attempt = 0; attempt < AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS; attempt += 1) {
      const orderSignal = await classifyEntryOrderForRecovery({
        bybit: this.deps.bybit,
        getEntryOrderPayload,
        getEntryOrderHistoryPayload,
      });

      if (absenceCandidate !== undefined && orderSignal.kind === "not_found") {
        const attemptEvidence = await observeAmbiguousCreateAbsenceAttempt({
          bybit: this.deps.bybit,
          category,
          symbol,
          orderLinkId,
          desiredSide: absenceCandidate.desiredSide,
        });
        if (attemptEvidence === "clean_absent") {
          cleanAbsenceAttempts += 1;
        } else {
          absenceTainted = true;
        }
      } else {
        if (absenceCandidate !== undefined) {
          absenceTainted = true;
        }

        const closeOutcome = await this.classifyCloseOutcomeIfNeeded({
          orderSignal,
          closeOrderAttempted,
          closeOrderLinkId,
          category,
          symbol,
        });

        const positionQuery = await this.deps.bybit.queryPositionForInstrument({ category, symbol });

        const resolved = resolveRecoveryState({
          orderSignal,
          closeOutcome,
          closeOrderAttempted,
          positionQuery,
          desiredEntry: record.desired_entry,
        });

        if (resolved !== undefined) {
          return this.finalizeOutcome(resolved, record);
        }
      }

      if (attempt < AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS - 1) {
        await sleep(AMBIGUOUS_CREATE_ABSENCE_RETRY_DELAY_MS);
      }
    }

    if (
      absenceCandidate !== undefined &&
      !absenceTainted &&
      cleanAbsenceAttempts === AMBIGUOUS_CREATE_ABSENCE_ATTEMPTS &&
      (await completedObservationIsFresh({
        bybit: this.deps.bybit,
        bindingStartedAtMs: absenceCandidate.bindingStartedAtMs,
      }))
    ) {
      return entryOrderNotFoundResult();
    }

    return internalErrorResult();
  }

  // Issues the close-order check only when this attempt's own entry-order
  // signal is terminal_with_fill and a close was durably attempted for this
  // cycle — design.md Decision 4e. If the entry order's own
  // cumulativeFilledQty is empty or not strictly positive, there is no valid
  // expectedQty to check the close order against; this fails closed by
  // leaving closeOutcome undefined rather than calling
  // classifyOwnCloseOrderOutcome with an unusable value (design.md
  // Decision 3).
  private async classifyCloseOutcomeIfNeeded(input: {
    orderSignal: RecoveryEntryOrderSignal;
    closeOrderAttempted: boolean;
    closeOrderLinkId: string | null;
    category: "linear" | "spot";
    symbol: string;
  }): Promise<OwnCloseOrderOutcome | undefined> {
    if (input.orderSignal.kind !== "terminal_with_fill" || !input.closeOrderAttempted || input.closeOrderLinkId === null) {
      return undefined;
    }

    const expectedQty = input.orderSignal.cumulativeFilledQty;
    if (expectedQty === "" || compareDecimal(expectedQty, "0") <= 0) {
      return undefined;
    }

    return classifyOwnCloseOrderOutcome({
      bybit: this.deps.bybit,
      getCloseOrderPayload: { category: input.category, symbol: input.symbol, orderLinkId: input.closeOrderLinkId, limit: "1" },
      getCloseOrderHistoryPayload: { category: input.category, symbol: input.symbol, orderLinkId: input.closeOrderLinkId, limit: "1" },
      expectedQty,
    });
  }

  private async finalizeOutcome(
    outcome: ResolvedOutcome,
    record: EntryPackageExecutionRecord,
  ): Promise<RecoveryStateHttpResult> {
    if (outcome.state === "terminal_without_fill") {
      return terminalWithoutFillResult();
    }
    if (outcome.state === "terminal_after_fill") {
      return terminalAfterFillResult();
    }

    if (outcome.state === "entry_order_live") {
      // A binding left mid-amend by a pre-abi-entry-cycle-recovery-v1
      // version of this service (see LegacyEntryPackagePendingAction)
      // durably wrote its new desired_entry BEFORE the amend was sent,
      // while reusing the SAME order_link_id the prior desired_entry was
      // already bound to. If that amend's outcome went ambiguous, the live
      // order under that identity may still physically be the pre-amend
      // entry, not the stored desired_entry — so entry_order_live can never
      // safely report AppliedEntryPackage for such a record. Fails safe
      // instead; no legacy recovery state machine is introduced.
      if (record.pending_action === "amend" || record.pending_action === "cancel_and_create") {
        return internalErrorResult();
      }
      const desiredEntry = record.desired_entry;
      const calculatedQuantity = record.calculated_quantity;
      if (desiredEntry === null || calculatedQuantity === null) {
        return internalErrorResult();
      }
      return entryOrderLiveResult({ appliedDesiredEntry: desiredEntry, calculatedQuantity });
    }

    // position_open runs under the pair mutex, re-reading the record fresh
    // — a concurrent close or amend may have raced ahead since this
    // attempt's outer, unlocked read (abi-entry-cycle-recovery-attribution-
    // v1 design.md Decision 2, mirroring
    // OpenPositionResolutionService.resolveLiveQueryAdmissible).
    return this.resolvePositionOpenResult(record, outcome.averageEntryPrice);
  }

  private async resolvePositionOpenResult(
    record: EntryPackageExecutionRecord,
    averageEntryPrice: string,
  ): Promise<RecoveryStateHttpResult> {
    const key = correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id);
    return this.deps.mutex.withKeyLock(key, () => this.resolvePositionOpenResultLocked(record, averageEntryPrice));
  }

  private async resolvePositionOpenResultLocked(
    record: EntryPackageExecutionRecord,
    averageEntryPrice: string,
  ): Promise<RecoveryStateHttpResult> {
    const fresh = this.deps.correlationRepository.get(record.strategy_instance_id, record.trade_cycle_id);
    if (fresh === undefined) {
      return unknownTradeCycleBindingResult();
    }

    if (isDurablyClosedEntryPackageStatus(fresh.status)) {
      return fresh.status === "terminal_closed" ? terminalAfterFillResult() : terminalWithoutFillResult();
    }

    if (fresh.pending_action === "amend" || fresh.pending_action === "cancel_and_create") {
      return internalErrorResult();
    }

    const desiredEntry = fresh.desired_entry;
    const calculatedQuantity = fresh.calculated_quantity;
    if (desiredEntry === null || calculatedQuantity === null) {
      return internalErrorResult();
    }

    if (fresh.first_fill_at_ms !== null) {
      return positionOpenResult({
        appliedDesiredEntry: desiredEntry,
        calculatedQuantity,
        firstFillAtMs: fresh.first_fill_at_ms,
        averageEntryPrice,
      });
    }

    if (fresh.order_link_id === null || (fresh.exchange_category !== "linear" && fresh.exchange_category !== "spot")) {
      return internalErrorResult();
    }

    const captured = await resolveFirstAttributableFillAtMs({
      bybit: this.deps.bybit,
      category: fresh.exchange_category,
      symbol: fresh.exchange_symbol,
      orderLinkId: fresh.order_link_id,
    });

    if (captured.kind !== "found") {
      // "no_executions_found" (own evidence already proves a fill, so this
      // is a contradiction, never proof of no fill) or "ambiguous" — never
      // fabricated or omitted.
      return internalErrorResult();
    }

    try {
      await this.deps.correlationRepository.save({
        ...fresh,
        first_fill_at_ms: captured.firstFillAtMs,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // A durable-write failure (e.g. a disk error) does not convert an
      // otherwise-successful determination into an error response — the
      // freshly-captured value is still truthful in this moment. The next
      // resolve() retries the capture, since first_fill_at_ms was never
      // durably set.
    }

    return positionOpenResult({
      appliedDesiredEntry: desiredEntry,
      calculatedQuantity,
      firstFillAtMs: captured.firstFillAtMs,
      averageEntryPrice,
    });
  }
}

// Own evidence determines the candidate state; the aggregate physical
// position query can only veto a candidate own evidence already produced —
// it can never manufacture one own evidence does not support (design.md
// Decision 4b). entry_order_live/terminal_without_fill resolve from the
// own-order signal alone, vetoed only by a genuine opposite-side aggregate
// contradiction. position_open/terminal_after_fill resolve once the own
// entry order proves a fill: with no close ever durably attempted, the
// exposure is open (vetoed unless the aggregate confirms an existing
// same-side position); with a close durably attempted, this cycle's own
// close order's classified outcome is authoritative — an exact quantity
// match resolves terminal_after_fill with NO aggregate consultation at all
// (never overridden by a same-side sibling's own aggregate contribution), a
// confirmed zero fill resolves position_open (same veto as the
// no-close-attempted case), and a partial (quantity-mismatched) fill, or any
// not-yet-established close-order state, fails safe.
function resolveRecoveryState(input: {
  orderSignal: RecoveryEntryOrderSignal;
  closeOutcome: OwnCloseOrderOutcome | undefined;
  closeOrderAttempted: boolean;
  positionQuery: PositionQueryResult;
  desiredEntry: DesiredEntryDto | null;
}): ResolvedOutcome | undefined {
  const { orderSignal, closeOutcome, closeOrderAttempted, positionQuery, desiredEntry } = input;
  const aggregateSanity = classifyAggregateSanity(positionQuery, desiredEntry);

  if (orderSignal.kind === "live_unfilled") {
    // Defensive, expected unreachable: CloseApplicationService always
    // neutralizes the entry order (cancels and confirms terminal) before
    // ever dispatching a close order, so a durably-recorded close attempt
    // co-occurring with a still-live entry order is a structural
    // contradiction, not a state to interpret.
    if (closeOrderAttempted || aggregateSanity === "opposite_side_contradiction") {
      return undefined;
    }
    return { state: "entry_order_live" };
  }

  if (orderSignal.kind === "terminal_without_fill") {
    if (closeOrderAttempted || aggregateSanity === "opposite_side_contradiction") {
      return undefined;
    }
    return { state: "terminal_without_fill" };
  }

  if (orderSignal.kind === "live_with_fill" || orderSignal.kind === "terminal_with_fill") {
    if (!closeOrderAttempted) {
      if (aggregateSanity !== "same_side_exists") {
        return undefined;
      }
      return positionOpenOutcome(orderSignal.averageEntryPrice);
    }

    // A close cannot have been durably dispatched while the entry order
    // that funds it is still live — structural contradiction, no
    // close-order query is issued for this combination.
    if (orderSignal.kind === "live_with_fill") {
      return undefined;
    }

    if (closeOutcome === undefined) {
      return undefined;
    }

    if (closeOutcome.kind === "matched") {
      // This cycle's own two-order evidence chain (entry filled the
      // expected amount, close filled that same exact amount) is fully
      // self-contained — no aggregate read for this outcome at all
      // (design.md Decision 4c).
      return { state: "terminal_after_fill" };
    }
    if (closeOutcome.kind === "zero_fill") {
      if (aggregateSanity !== "same_side_exists") {
        return undefined;
      }
      return positionOpenOutcome(orderSignal.averageEntryPrice);
    }
    // "qty_mismatch" (a genuine, unresolved partial close — neither state
    // correctly describes it), "not_found", or "ambiguous": fails safe.
    return undefined;
  }

  // not_found / inconclusive
  return undefined;
}

// A fill-carrying order response may validly carry an empty average price
// (a transient Bybit omission, orderQueryResponseDecoder.ts's own
// tolerance) — this can never construct a valid position_open response,
// mirroring open-position-resolution's identical "a fill with no usable
// average price fails closed" requirement.
function positionOpenOutcome(averageEntryPrice: string): ResolvedOutcome | undefined {
  if (averageEntryPrice === "") {
    return undefined;
  }
  return { state: "position_open", averageEntryPrice };
}

function classifyAggregateSanity(positionQuery: PositionQueryResult, desiredEntry: DesiredEntryDto | null): AggregateSanity {
  if (positionQuery.kind !== "position") {
    return "no_signal";
  }
  return positionSideMatches(positionQuery.row.side, desiredEntry) ? "same_side_exists" : "opposite_side_contradiction";
}

function positionSideMatches(rowSide: BybitOrderSide, desiredEntry: DesiredEntryDto | null): boolean {
  if (desiredEntry === null) {
    return false;
  }

  return (rowSide === "Buy" && desiredEntry.side === "long") || (rowSide === "Sell" && desiredEntry.side === "short");
}
