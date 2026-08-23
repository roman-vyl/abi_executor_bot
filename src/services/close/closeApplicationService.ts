import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../correlation/entryPackageExecutionRecord.js";
import { correlationRecordKey } from "../../correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../domain/entryPackageOrderIdentity.js";
import { decimalEquals } from "../../domain/exactDecimal.js";
import type { CloseCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  closeExecutionIncompleteResult,
  internalErrorResult,
  serializeTradeCycleClosed,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { BybitMarketCloseOrderPayload } from "../../exchange/bybitOrderMapper.js";
import { mapPositionSideToCloseSide, readBybitOrderId } from "../../exchange/bybitOrderMapper.js";
import { cancelEntryOrder, executeMarketCloseOrder } from "../../execution/execution.js";
import { classifyEntryOrderTerminality, confirmEntryOrderNeutralized, confirmEntryPackage } from "../entryPackage/packageConfirmation.js";

// Bounded final verification that the live position has settled at zero
// after a close order — a market close, unlike a position-level protection
// write, is not guaranteed to settle by the time the placement call
// returns. Each attempt also re-checks entry-order terminality; that fact is
// monotonic once established, so this is a cheap single re-check per attempt,
// not a second bounded sub-loop.
const FINAL_VERIFY_ATTEMPTS = 3;
const FINAL_VERIFY_RETRY_DELAY_MS = 300;

export type CloseApplicationServiceDeps = {
  config: AbiConfig;
  bybit: BybitAdapter;
  correlationRepository: EntryPackageCorrelationRepository;
  // The same per-pair lock entry-package and protection already use. Not the
  // scope-level lock: this service never claims a scope, only releases its
  // own pair's, as a side effect of the durable terminal write.
  mutex: KeyedMutex;
};

// Executes an already-validated POST .../close command (exposure_fraction
// "1" — see positionManagementApi.ts): classify the pair, neutralize its
// current entry order, close its resolved exposure, verify fresh, and
// durably terminalize as terminal_closed before releasing the pair's
// physical scope (or, for a scope shared with other active cycles, its own
// membership in that scope's active-owner set).
//
// Single-owner (findActiveRecordsForScope returns exactly this pair's own
// record — today's only production-reachable state) is handled entirely by
// processSingleOwnerClose(), byte-for-byte unchanged from this capability's
// original close-execution behavior. Multi-owner (more than one active
// record — reachable today only via synthetically seeded correlation state,
// pending abi-same-side-virtual-exposure-ownership-v1) is handled by
// processMultiOwnerClose(), which dispatches its own reduce-only order under
// a stable, attributable identity (close_order_link_id) durably recorded
// before the exchange call, and gates success on that order's own confirmed
// execution — never on a live-aggregate-position comparison, which cannot
// distinguish this request's own effect from a sibling record's concurrent
// activity. See docs/virtual-exposure-ownership-delivery-plan.md Change 2
// and its OpenSpec (abi-pair-scoped-close-execution-v1) for the full design.
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

    // Already the permanent, non-resurrectable state this pipeline exists
    // to produce — a pure no-write, no-exchange-call shortcut.
    if (record.status === "terminal_closed") {
      return closedResult(command);
    }

    // absent and terminal_unfilled both already durably prove zero exposure
    // and no live order, but neither itself durably records that Runtime
    // asked to end the trade cycle via a close request — entry-package
    // execution's own null-desired-entry handling can otherwise resurrect
    // either one with a later entry. No exchange call is needed to justify
    // the promotion; the write itself is not optional.
    if (record.status === "absent" || record.status === "terminal_unfilled") {
      await this.deps.correlationRepository.save({
        ...record,
        status: "terminal_closed",
        pending_action: null,
        updated_at: new Date().toISOString(),
      });
      return closedResult(command);
    }

    const category = record.exchange_category;
    if (category !== "linear" && category !== "spot") {
      // Unreachable while correlation replay's scope invariant holds —
      // re-verified independently rather than assumed, mirroring
      // protectionApplicationService's identical defensive check.
      return internalErrorResult();
    }

    // Ownership reconfirmation is against the scope's currently active
    // records (virtual-exposure-state's findActiveRecordsForScope), not
    // findOwnerByScope/byScope: byScope is a single pointer per scope and
    // cannot represent more than one active owner, so it cannot correctly
    // answer "is this pair one of this scope's active owners" once more
    // than one exists (today only via synthetic fixtures). A record
    // reaching this point is already known non-durably-closed, so its own
    // membership is guaranteed by construction; the check is retained as a
    // defensive assertion (mirrors this method's own category re-check
    // above), and its count is what the next branch decides on.
    const activeRecords = this.deps.correlationRepository.findActiveRecordsForScope(category, record.exchange_symbol);
    const selfKey = correlationRecordKey(command.strategyInstanceId, command.tradeCycleId);
    const selfIsActive = activeRecords.some(
      (active) => correlationRecordKey(active.strategy_instance_id, active.trade_cycle_id) === selfKey,
    );
    if (!selfIsActive) {
      return internalErrorResult();
    }

    if (activeRecords.length > 1) {
      // Defensive: same-side-only is the claim policy's own invariant
      // (unchanged by this pipeline) — unreachable in production until
      // abi-same-side-virtual-exposure-ownership-v1 activates multi-owner,
      // re-verified rather than assumed, same style as the checks above.
      const sides = new Set(activeRecords.map((active) => active.desired_entry?.side ?? null));
      if (sides.size > 1) {
        return internalErrorResult();
      }
    }

    if (category !== "linear") {
      return unsupportedExchangeScopeResult();
    }

    // A non-durably-closed record is always expected to carry a current
    // entry order identity — a missing one here is contradictory correlation,
    // not "nothing to neutralize".
    const orderLinkId = record.order_link_id;
    if (orderLinkId === null) {
      return internalErrorResult();
    }

    const symbol = record.exchange_symbol;
    const getEntryOrderPayload = { category, symbol, orderLinkId, limit: "1" as const };
    const getEntryOrderHistoryPayload = { category, symbol, orderLinkId, limit: "1" as const };

    const initialTerminality = await classifyEntryOrderTerminality({
      bybit: this.deps.bybit,
      getEntryOrderPayload,
      getEntryOrderHistoryPayload,
    });

    if (initialTerminality.kind !== "terminal") {
      const cancelResult = await cancelEntryOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: { category, symbol, orderLinkId },
      });

      if (cancelResult.status === "skipped_live_execution") {
        return internalErrorResult();
      }

      const neutralizationOutcome = await confirmEntryOrderNeutralized({
        bybit: this.deps.bybit,
        getEntryOrderPayload,
        getEntryOrderHistoryPayload,
      });

      if (neutralizationOutcome === "ambiguous") {
        return internalErrorResult();
      }
    }

    if (activeRecords.length > 1) {
      return this.processMultiOwnerClose(command, record, category, symbol);
    }

    // Single-owner: unchanged from this capability's original behavior.
    // reduceOnly qty is always the live aggregate's exact current size,
    // never a quantity ABI itself calculated or recorded.
    const positionQuery = await this.deps.bybit.queryPositionForInstrument({ category, symbol });
    if (positionQuery.kind === "failure") {
      return internalErrorResult();
    }

    if (positionQuery.kind === "position") {
      const row = positionQuery.row;
      const closePayload: BybitMarketCloseOrderPayload = {
        category,
        symbol,
        side: mapPositionSideToCloseSide(row.side),
        orderType: "Market",
        qty: row.size,
        reduceOnly: true,
        positionIdx: 0,
      };

      const closeResult = await executeMarketCloseOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: closePayload,
      });

      if (closeResult.status === "skipped_live_execution") {
        return internalErrorResult();
      }
    }

    const verified = await this.verifyBothPostconditions({ category, symbol, getEntryOrderPayload, getEntryOrderHistoryPayload });
    if (!verified) {
      return internalErrorResult();
    }

    await this.deps.correlationRepository.save({
      ...record,
      status: "terminal_closed",
      pending_action: null,
      updated_at: new Date().toISOString(),
    });

    return closedResult(command);
  }

  private async verifyBothPostconditions(input: {
    category: "linear";
    symbol: string;
    getEntryOrderPayload: Parameters<typeof classifyEntryOrderTerminality>[0]["getEntryOrderPayload"];
    getEntryOrderHistoryPayload: Parameters<typeof classifyEntryOrderTerminality>[0]["getEntryOrderHistoryPayload"];
  }): Promise<boolean> {
    for (let attempt = 0; attempt < FINAL_VERIFY_ATTEMPTS; attempt += 1) {
      // Sequential, not concurrent: every other Bybit call in this pipeline
      // is already sequential, and there is no efficiency requirement here
      // that would justify two in-flight requests against the exchange at
      // once.
      const positionQuery = await this.deps.bybit.queryPositionForInstrument({
        category: input.category,
        symbol: input.symbol,
      });
      const terminality = await classifyEntryOrderTerminality({
        bybit: this.deps.bybit,
        getEntryOrderPayload: input.getEntryOrderPayload,
        getEntryOrderHistoryPayload: input.getEntryOrderHistoryPayload,
      });

      if (positionQuery.kind === "no_position" && terminality.kind === "terminal") {
        return true;
      }

      if (attempt < FINAL_VERIFY_ATTEMPTS - 1) {
        await sleep(FINAL_VERIFY_RETRY_DELAY_MS);
      }
    }

    return false;
  }

  // Multi-owner close: Step 1 (ensure a close order is dispatched for this
  // generation — a no-op if one already is) always falls straight through
  // into Step 2 (always resolve and gate on the dispatched identity's own
  // fate) within this same request — the two are sequential steps of one
  // flow, not alternate branches a request selects between once. See
  // abi-pair-scoped-close-execution-v1 design.md Decision 4 for the full
  // crash-window analysis this structure satisfies.
  private async processMultiOwnerClose(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    category: "linear",
    symbol: string,
  ): Promise<PositionManagementHttpResult> {
    let current = record;

    if (current.close_order_link_id === null) {
      const resolvedQty = await this.resolveOwnExposure(current);
      if (resolvedQty === undefined) {
        return internalErrorResult();
      }

      // The entry order is terminal and immutable, so a zero-exposure
      // outcome is stable across any number of retries — this cycle
      // contributed nothing to close, and no identity is ever needed for it.
      if (resolvedQty === "0") {
        return this.finalizeMultiOwnerClose(command, current);
      }

      const dispatched = await this.dispatchMultiOwnerCloseOrder(command, current, category, symbol, resolvedQty);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      current = dispatched;
    }

    return this.resolveMultiOwnerCloseFate(command, current, category, symbol);
  }

  // Resolves the requested cycle's own currently-owned exposure from its
  // own entry order's fill facts. Transient/read-only: the result is used
  // only in memory for this request and is never written to
  // early_execution_observation — close is not one of virtual-exposure-
  // state's existing durable observation-writing points. Returns undefined
  // on any contradiction or inconclusive exchange answer (internal_error).
  private async resolveOwnExposure(record: EntryPackageExecutionRecord): Promise<string | undefined> {
    const calculatedQuantity = record.calculated_quantity;
    const orderLinkId = record.order_link_id;
    const category = record.exchange_category;
    if (calculatedQuantity === null || orderLinkId === null || (category !== "linear" && category !== "spot")) {
      return undefined;
    }

    const symbol = record.exchange_symbol;
    const confirmation = await confirmEntryPackage({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category, symbol, orderLinkId, limit: "1" as const },
      getEntryOrderHistoryPayload: { category, symbol, orderLinkId, limit: "1" as const },
      expected: { qty: calculatedQuantity },
    });

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      return confirmation.observation.cumulative_filled_qty;
    }
    if (confirmation.kind === "terminal_without_fill") {
      return "0";
    }
    // "not_found" / "ambiguous" / "pending_confirmed": unreachable in
    // practice (this is always called after neutralization has already
    // confirmed the entry order terminal), but not assumed away.
    return undefined;
  }

  // Computes this generation's close-order identity if `record` doesn't
  // already carry one, durably records it before the exchange call, and
  // sends the reduce-only close order. Reused both for a fresh dispatch and
  // for the one case proven safe to resend under the same identity (a
  // fresh query finding it genuinely never created). Returns the updated
  // record, or undefined on any failure (the durable identity write, once
  // made, is never reverted on failure — the caller's next attempt resolves
  // its fate via resolveMultiOwnerCloseFate rather than blindly resending).
  private async dispatchMultiOwnerCloseOrder(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    category: "linear",
    symbol: string,
    resolvedQty: string,
  ): Promise<EntryPackageExecutionRecord | undefined> {
    const positionQuery = await this.deps.bybit.queryPositionForInstrument({ category, symbol });
    if (positionQuery.kind !== "position") {
      // A query failure, or a live aggregate that has already gone to zero
      // while this cycle's own resolved exposure is still positive, is an
      // unexplained pre-dispatch contradiction either way.
      return undefined;
    }

    const closeOrderLinkId =
      record.close_order_link_id ??
      buildEntryPackageOrderLinkId(command.strategyInstanceId, command.tradeCycleId, "close", record.generation);

    let current: EntryPackageExecutionRecord = {
      ...record,
      close_order_link_id: closeOrderLinkId,
      close_order_id: null,
    };
    await this.deps.correlationRepository.save(current);

    const closePayload: BybitMarketCloseOrderPayload = {
      category,
      symbol,
      side: mapPositionSideToCloseSide(positionQuery.row.side),
      orderType: "Market",
      qty: resolvedQty,
      reduceOnly: true,
      positionIdx: 0,
      orderLinkId: closeOrderLinkId,
    };

    let closeResult;
    try {
      closeResult = await executeMarketCloseOrder({
        config: this.deps.config,
        bybit: this.deps.bybit,
        payload: closePayload,
      });
    } catch {
      // close_order_link_id is already durably recorded above and is left
      // exactly as it is — the next attempt resolves its fate rather than
      // resending blindly.
      return undefined;
    }

    if (closeResult.status === "skipped_live_execution") {
      return undefined;
    }

    current = { ...current, close_order_id: readBybitOrderId(closeResult.bybitResponse) };
    return current;
  }

  // Always resolves and gates on the dispatched close order's own fate —
  // run unconditionally, whether the identity was just dispatched in this
  // same request or found already dispatched from an earlier one.
  private async resolveMultiOwnerCloseFate(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
    category: "linear",
    symbol: string,
  ): Promise<PositionManagementHttpResult> {
    const closeOrderLinkId = record.close_order_link_id;
    if (closeOrderLinkId === null) {
      return internalErrorResult();
    }

    const resolvedQty = await this.resolveOwnExposure(record);
    if (resolvedQty === undefined || resolvedQty === "0") {
      // The entry order's fill facts are immutable once final — a
      // zero/undefined re-resolution here contradicts the positive value
      // that caused a close order to be dispatched for this generation in
      // the first place.
      return internalErrorResult();
    }

    const outcome = await this.resolveCloseOrderOutcome(category, symbol, closeOrderLinkId, resolvedQty);

    if (outcome === "matched") {
      return this.finalizeMultiOwnerClose(command, record);
    }

    if (outcome === "incomplete") {
      return closeExecutionIncompleteResult();
    }

    if (outcome === "not_found") {
      // Genuinely never created — the one case proven safe to resend under
      // the same identity (shouldResendPendingAction's identical precedent
      // for entry). Re-resolves fate after the resend rather than assuming
      // success.
      const dispatched = await this.dispatchMultiOwnerCloseOrder(command, record, category, symbol, resolvedQty);
      if (dispatched === undefined) {
        return internalErrorResult();
      }
      return this.resolveMultiOwnerCloseFate(command, dispatched, category, symbol);
    }

    return internalErrorResult();
  }

  // Bounded resolution of one close order's own fate, keyed by its own
  // identity — never by the live aggregate. "partial_fill" from
  // confirmEntryPackage alone is ambiguous between "still live, may yet
  // fill more" and "terminal, filled less than requested" (it can be
  // produced by either a live PartiallyFilled realtime read or a history
  // record of a since-terminalized order); classifyEntryOrderTerminality is
  // consulted to disambiguate before treating a shortfall as final.
  private async resolveCloseOrderOutcome(
    category: "linear",
    symbol: string,
    closeOrderLinkId: string,
    resolvedQty: string,
  ): Promise<"matched" | "incomplete" | "not_found" | "ambiguous"> {
    const getCloseOrderPayload = { category, symbol, orderLinkId: closeOrderLinkId, limit: "1" as const };
    const getCloseOrderHistoryPayload = { category, symbol, orderLinkId: closeOrderLinkId, limit: "1" as const };

    for (let attempt = 0; attempt < FINAL_VERIFY_ATTEMPTS; attempt += 1) {
      const terminality = await classifyEntryOrderTerminality({
        bybit: this.deps.bybit,
        getEntryOrderPayload: getCloseOrderPayload,
        getEntryOrderHistoryPayload: getCloseOrderHistoryPayload,
      });

      if (terminality.kind === "terminal") {
        const confirmation = await confirmEntryPackage({
          bybit: this.deps.bybit,
          getEntryOrderPayload: getCloseOrderPayload,
          getEntryOrderHistoryPayload: getCloseOrderHistoryPayload,
          expected: { qty: resolvedQty },
        });

        if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
          return decimalEquals(confirmation.observation.cumulative_filled_qty, resolvedQty) ? "matched" : "incomplete";
        }
        if (confirmation.kind === "terminal_without_fill") {
          return "incomplete";
        }
        if (confirmation.kind === "not_found") {
          return "not_found";
        }
        // "ambiguous" despite terminal classification (e.g. a query failure
        // within confirmEntryPackage's own bounded window): retry the
        // outer loop rather than giving up on the first blip.
      }
      // terminality "live" or "ambiguous": retry within the bounded window.

      if (attempt < FINAL_VERIFY_ATTEMPTS - 1) {
        await sleep(FINAL_VERIFY_RETRY_DELAY_MS);
      }
    }

    return "ambiguous";
  }

  private async finalizeMultiOwnerClose(
    command: CloseCommand,
    record: EntryPackageExecutionRecord,
  ): Promise<PositionManagementHttpResult> {
    await this.deps.correlationRepository.save({
      ...record,
      status: "terminal_closed",
      pending_action: null,
      updated_at: new Date().toISOString(),
    });
    return closedResult(command);
  }
}

function closedResult(command: CloseCommand): PositionManagementHttpResult {
  return serializeTradeCycleClosed({
    strategyInstanceId: command.strategyInstanceId,
    tradeCycleId: command.tradeCycleId,
    positionZeroVerified: true,
    noAttributedActiveOrdersVerified: true,
    correlationCompleteAndConsistent: true,
  });
}
