import { setTimeout as sleep } from "node:timers/promises";

import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { AbiConfig } from "../../config/config.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import { correlationRecordKey } from "../../correlation/entryPackageExecutionRecord.js";
import type { CloseCommand, PositionManagementHttpResult } from "../../domain/positionManagementApi.js";
import {
  internalErrorResult,
  serializeTradeCycleClosed,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/positionManagementApi.js";
import type { BybitAdapter } from "../../exchange/bybitAdapter.js";
import type { BybitMarketCloseOrderPayload } from "../../exchange/bybitOrderMapper.js";
import { mapPositionSideToCloseSide } from "../../exchange/bybitOrderMapper.js";
import { cancelEntryOrder, executeMarketCloseOrder } from "../../execution/execution.js";
import { classifyEntryOrderTerminality, confirmEntryOrderNeutralized } from "../entryPackage/packageConfirmation.js";

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

// Executes an already-validated DELETE .../open-position command: classify
// the pair, neutralize its current entry order, close the actual live
// remainder, verify both postconditions fresh, and durably terminalize as
// terminal_closed before releasing the pair's physical scope.
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

    const owner = this.deps.correlationRepository.findOwnerByScope(category, record.exchange_symbol);
    if (
      owner === undefined ||
      owner.strategy_instance_id !== command.strategyInstanceId ||
      owner.trade_cycle_id !== command.tradeCycleId
    ) {
      return internalErrorResult();
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
