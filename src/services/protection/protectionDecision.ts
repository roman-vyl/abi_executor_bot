import type {
  EmergencyCloseMetadata,
  OperatorSafeError,
  ProtectionCheckAction,
  ProtectionCheckContext,
  ProtectionCheckResult,
  ProtectionCheckStatus,
  ProtectionDecisionInput,
  ProtectionPositionSnapshot,
} from "./protectionTypes.js";

export function decideProtectionCheck(input: ProtectionDecisionInput): ProtectionCheckResult {
  const { context, preCreatePosition, postCreatePosition } = input;
  const stopLoss = readStopLoss(context);

  if (context.dryRun) {
    return buildResult(input, {
      status: "not_run_dry_run",
      action: "none",
      reason: "Dry-run mode does not query exchange state or send emergency close orders.",
    });
  }

  if (!preCreatePosition.queryOk) {
    return buildResult(input, {
      status: "exchange_query_failed",
      action: "none",
      reason: "Pre-create position snapshot failed; live create must not be sent without an attribution baseline.",
      error: preCreatePosition.error,
    });
  }

  if (isOpenPosition(preCreatePosition)) {
    return buildResult(input, {
      status: "pre_existing_position_found",
      action: "none",
      reason: "A position was already open before create, so emergency close cannot be safely attributed to the just-created entry.",
    });
  }

  if (postCreatePosition !== undefined && !postCreatePosition.queryOk) {
    return buildResult(input, {
      status: "exchange_query_failed",
      action: "none",
      reason: "Post-create position query failed; Abi will not close blindly.",
      error: postCreatePosition.error,
    });
  }

  if (postCreatePosition !== undefined && isOpenPosition(postCreatePosition)) {
    if (stopLoss === undefined) {
      return buildResult(input, {
        status: "position_open_no_stop_requested",
        action: "none",
        reason: "A new position is open, but the intent did not request a stop loss.",
      });
    }

    if (input.priceError !== undefined) {
      return buildResult(input, {
        status: "exchange_query_failed",
        action: "none",
        reason: "Market price query failed; Abi will not close blindly.",
        error: input.priceError,
      });
    }

    if (input.observedPrice === undefined || !isFiniteNumberString(input.observedPrice)) {
      return buildResult(input, {
        status: "unsafe_manual_required",
        action: "none",
        reason: "A new protected position is open, but the observed price is unavailable or invalid.",
      });
    }

    if (hasStopBreached(context.side, input.observedPrice, stopLoss)) {
      if (input.emergencyClose?.attempted === true) {
        return buildResult(input, {
          status: input.emergencyClose.accepted ? "emergency_close_sent" : "emergency_close_failed",
          action: "close_position_market_reduce_only",
          reason: input.emergencyClose.accepted
            ? "Requested stop was already breached, and a guarded reduce-only market close was sent."
            : "Requested stop was already breached, but the guarded reduce-only market close failed.",
          error: input.emergencyClose.error,
          emergencyCloseOrder: {
            sent: input.emergencyClose.accepted,
            order: input.emergencyClose.order,
            bybitResponse: input.emergencyClose.bybitResponse,
          },
        });
      }

      return buildResult(input, {
        status: "position_open_stop_breached",
        action: "close_position_market_reduce_only",
        reason: "A newly opened position has already breached the requested stop.",
      });
    }

    return buildResult(input, {
      status: "position_open_stop_not_breached",
      action: "none",
      reason: "Observed price has not crossed the requested stop; this does not prove exchange-side protection is active.",
    });
  }

  return buildResult(input, {
    status: input.orderFound === true ? "pending_order_verified" : "pending_order_not_found",
    action: "none",
    reason:
      input.orderFound === true
        ? "Pending entry order was found and no open position was observed."
        : "No pending entry order or open position was found after bounded verification.",
  });
}

export function isOpenPosition(snapshot: ProtectionPositionSnapshot): boolean {
  return snapshot.found && snapshot.size !== undefined && Number(snapshot.size) > 0;
}

function hasStopBreached(side: "long" | "short", observedPrice: string, stopLoss: string): boolean {
  const observed = Number(observedPrice);
  const stop = Number(stopLoss);

  if (!Number.isFinite(observed) || !Number.isFinite(stop)) {
    return false;
  }

  return side === "long" ? observed <= stop : observed >= stop;
}

function readStopLoss(context: ProtectionCheckContext): string | undefined {
  return context.protection.mode === "attached_full_position_market"
    ? context.protection.stopLoss.triggerPrice
    : undefined;
}

function buildResult(
  input: ProtectionDecisionInput,
  details: {
    status: ProtectionCheckStatus;
    action: ProtectionCheckAction;
    reason: string;
    error?: OperatorSafeError;
    emergencyCloseOrder?: EmergencyCloseMetadata;
  },
): ProtectionCheckResult {
  const { context, preCreatePosition, postCreatePosition } = input;

  return {
    status: details.status,
    action: details.action,
    signal_id: context.signalId,
    instance_id: context.instanceId,
    symbol: context.symbol,
    side: context.side,
    orderLinkId: context.orderLinkId,
    requestedProtection: context.protection,
    preCreatePositionFound: isOpenPosition(preCreatePosition),
    preCreatePositionSize: preCreatePosition.size,
    preCreatePositionSide: preCreatePosition.side,
    orderFound: input.orderFound,
    postCreatePositionFound:
      postCreatePosition === undefined ? undefined : isOpenPosition(postCreatePosition),
    postCreatePositionSize: postCreatePosition?.size,
    postCreatePositionSide: postCreatePosition?.side,
    stopLoss: readStopLoss(context),
    observedPrice: input.observedPrice,
    reason: details.reason,
    attempts: input.attempts,
    emergencyCloseOrder: details.emergencyCloseOrder,
    error: details.error,
  };
}

function isFiniteNumberString(value: string): boolean {
  return Number.isFinite(Number(value));
}
