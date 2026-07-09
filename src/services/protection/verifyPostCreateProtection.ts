import type { AbiConfig } from "../../config/config.js";
import type { BybitAdapter, BybitPosition } from "../../exchange/bybitAdapter.js";
import type { BybitGetOrderByLinkIdPayload, BybitMarketCloseOrderPayload } from "../../exchange/bybitOrderMapper.js";
import { mapPositionSideToCloseSide } from "../../exchange/bybitOrderMapper.js";
import { executeMarketCloseOrder } from "../../execution/execution.js";
import type { Journal } from "../../journal/journal.js";
import { decideProtectionCheck, isOpenPosition } from "./protectionDecision.js";
import {
  emptyProtectionCheckAttempts,
  type OperatorSafeError,
  type ProtectionCheckContext,
  type ProtectionCheckResult,
  type ProtectionPositionSnapshot,
} from "./protectionTypes.js";

const VERIFY_ATTEMPTS = 2;

export function createDryRunProtectionCheck(context: ProtectionCheckContext): ProtectionCheckResult {
  return decideProtectionCheck({
    context: {
      ...context,
      dryRun: true,
    },
    preCreatePosition: {
      queryOk: true,
      found: false,
    },
    attempts: emptyProtectionCheckAttempts(),
  });
}

export async function capturePreCreateProtectionSnapshot(input: {
  context: ProtectionCheckContext;
  bybit: BybitAdapter;
  journal: Journal;
}): Promise<ProtectionPositionSnapshot> {
  await input.journal.appendEvent({
    eventType: "protection_check_started",
    signalId: input.context.signalId,
    payload: {
      phase: "pre_create_position_snapshot",
      signal_id: input.context.signalId,
      instance_id: input.context.instanceId,
      symbol: input.context.symbol,
      orderLinkId: input.context.orderLinkId,
    },
  });

  try {
    return snapshotFromPosition(await input.bybit.getPosition(input.context.symbol));
  } catch (error) {
    const safeError = toOperatorSafeError(error, "pre_create_position_query");
    const result = decideProtectionCheck({
      context: input.context,
      preCreatePosition: {
        queryOk: false,
        found: false,
        error: safeError,
      },
      attempts: {
        ...emptyProtectionCheckAttempts(),
        positionQueries: 1,
      },
    });

    await appendProtectionFailure(input.journal, input.context.signalId, result);
    return {
      queryOk: false,
      found: false,
      error: safeError,
    };
  }
}

export async function verifyPostCreateProtection(input: {
  config: AbiConfig;
  bybit: BybitAdapter;
  journal: Journal;
  context: ProtectionCheckContext;
  getEntryOrderPayload: BybitGetOrderByLinkIdPayload;
  preCreatePosition: ProtectionPositionSnapshot;
}): Promise<ProtectionCheckResult> {
  await input.journal.appendEvent({
    eventType: "protection_check_started",
    signalId: input.context.signalId,
    payload: {
      phase: "post_create_verification",
      signal_id: input.context.signalId,
      instance_id: input.context.instanceId,
      symbol: input.context.symbol,
      orderLinkId: input.context.orderLinkId,
    },
  });

  const attempts = emptyProtectionCheckAttempts();

  let orderFound = false;
  let postCreatePosition: ProtectionPositionSnapshot = {
    queryOk: true,
    found: false,
  };

  try {
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      attempts.orderQueries += 1;
      orderFound = hasBybitListItems(await input.bybit.getOrderByLinkId(input.getEntryOrderPayload));

      attempts.positionQueries += 1;
      postCreatePosition = snapshotFromPosition(await input.bybit.getPosition(input.context.symbol));

      if (orderFound || isOpenPosition(postCreatePosition)) {
        break;
      }
    }
  } catch (error) {
    const result = decideProtectionCheck({
      context: input.context,
      preCreatePosition: input.preCreatePosition,
      postCreatePosition: {
        queryOk: false,
        found: false,
        error: toOperatorSafeError(error, "post_create_exchange_query"),
      },
      attempts,
    });
    await appendProtectionFailure(input.journal, input.context.signalId, result);
    return result;
  }

  let observedPrice: string | undefined;
  let priceError: OperatorSafeError | undefined;

  if (isOpenPosition(postCreatePosition) && input.context.protection.mode === "attached_full_position_market") {
    attempts.priceQueries += 1;
    try {
      observedPrice = await input.bybit.getMarketPrice(input.context.symbol);
    } catch (error) {
      priceError = toOperatorSafeError(error, "market_price_query");
    }
  }

  const decisionBeforeClose = decideProtectionCheck({
    context: input.context,
    preCreatePosition: input.preCreatePosition,
    orderFound,
    postCreatePosition,
    observedPrice,
    priceError,
    attempts,
  });

  if (decisionBeforeClose.action !== "close_position_market_reduce_only") {
    await appendProtectionCompletion(input.journal, input.context.signalId, decisionBeforeClose);
    if (decisionBeforeClose.status === "exchange_query_failed") {
      await appendProtectionFailure(input.journal, input.context.signalId, decisionBeforeClose);
    }
    return decisionBeforeClose;
  }

  attempts.emergencyCloseAttempts += 1;
  const closeOrder = buildEmergencyCloseOrder(input.config, input.context.symbol, postCreatePosition);

  try {
    const closeResult = await executeMarketCloseOrder({
      config: input.config,
      bybit: input.bybit,
      payload: closeOrder,
    });
    const finalResult = decideProtectionCheck({
      context: input.context,
      preCreatePosition: input.preCreatePosition,
      orderFound,
      postCreatePosition,
      observedPrice,
      attempts,
      emergencyClose: {
        attempted: true,
        accepted: closeResult.status === "bybit_market_close_order_accepted",
        order: closeOrder,
        bybitResponse:
          closeResult.status === "bybit_market_close_order_accepted" ? closeResult.bybitResponse : undefined,
        error:
          closeResult.status === "skipped_live_execution"
            ? { message: closeResult.mode.blockedReasons.join("; "), source: "live_guard" }
            : undefined,
      },
    });

    await input.journal.appendEvent({
      eventType: finalResult.status === "emergency_close_sent" ? "emergency_close_sent" : "emergency_close_failed",
      signalId: input.context.signalId,
      payload: finalResult,
    });

    if (finalResult.status === "emergency_close_failed") {
      await appendProtectionFailure(input.journal, input.context.signalId, finalResult);
    }
    await appendProtectionCompletion(input.journal, input.context.signalId, finalResult);
    return finalResult;
  } catch (error) {
    const finalResult = decideProtectionCheck({
      context: input.context,
      preCreatePosition: input.preCreatePosition,
      orderFound,
      postCreatePosition,
      observedPrice,
      attempts,
      emergencyClose: {
        attempted: true,
        accepted: false,
        order: closeOrder,
        error: toOperatorSafeError(error, "emergency_close"),
      },
    });

    await input.journal.appendEvent({
      eventType: "emergency_close_failed",
      signalId: input.context.signalId,
      payload: finalResult,
    });
    await appendProtectionFailure(input.journal, input.context.signalId, finalResult);
    await appendProtectionCompletion(input.journal, input.context.signalId, finalResult);
    return finalResult;
  }
}

export function resultForPreCreateSnapshotFailure(input: {
  context: ProtectionCheckContext;
  preCreatePosition: ProtectionPositionSnapshot;
}): ProtectionCheckResult {
  return decideProtectionCheck({
    context: input.context,
    preCreatePosition: input.preCreatePosition,
    attempts: {
      ...emptyProtectionCheckAttempts(),
      positionQueries: 1,
    },
  });
}

export function resultForPreExistingPosition(input: {
  context: ProtectionCheckContext;
  preCreatePosition: ProtectionPositionSnapshot;
}): ProtectionCheckResult {
  return decideProtectionCheck({
    context: input.context,
    preCreatePosition: input.preCreatePosition,
    attempts: {
      ...emptyProtectionCheckAttempts(),
      positionQueries: 1,
    },
  });
}

export async function appendProtectionCompletion(
  journal: Journal,
  signalId: string,
  result: ProtectionCheckResult,
): Promise<void> {
  await journal.appendEvent({
    eventType: "protection_check_completed",
    signalId,
    payload: result,
  });
}

function appendProtectionFailure(
  journal: Journal,
  signalId: string,
  result: ProtectionCheckResult,
): Promise<void> {
  return journal.appendEvent({
    eventType: "protection_check_failed",
    signalId,
    payload: result,
  }).then(() => undefined);
}

function snapshotFromPosition(position: BybitPosition | null): ProtectionPositionSnapshot {
  if (position === null || position.side === "None" || Number(position.size) <= 0) {
    return {
      queryOk: true,
      found: false,
      size: position?.size,
      side: position?.side,
      positionIdx: position?.positionIdx,
    };
  }

  return {
    queryOk: true,
    found: true,
    size: position.size,
    side: position.side,
    positionIdx: position.positionIdx,
  };
}

function buildEmergencyCloseOrder(
  config: AbiConfig,
  symbol: string,
  postCreatePosition: ProtectionPositionSnapshot,
): BybitMarketCloseOrderPayload {
  if (postCreatePosition.side !== "Buy" && postCreatePosition.side !== "Sell") {
    throw new Error("cannot close position without a Buy/Sell side");
  }

  if (postCreatePosition.size === undefined || Number(postCreatePosition.size) <= 0) {
    throw new Error("cannot close position without a positive size");
  }

  const closeOrder: BybitMarketCloseOrderPayload = {
    category: config.bybitCategory,
    symbol,
    side: mapPositionSideToCloseSide(postCreatePosition.side),
    orderType: "Market",
    qty: postCreatePosition.size,
    reduceOnly: true,
  };

  if (postCreatePosition.positionIdx !== undefined) {
    closeOrder.positionIdx = postCreatePosition.positionIdx;
  }

  return closeOrder;
}

function hasBybitListItems(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return false;
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return false;
  }

  const list = (result as Record<string, unknown>).list;
  return Array.isArray(list) && list.length > 0;
}

function toOperatorSafeError(error: unknown, source: string): OperatorSafeError {
  return {
    message: error instanceof Error ? error.message : "exchange query failed",
    source,
  };
}
