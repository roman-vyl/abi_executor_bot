import { buildOrderLinkId } from "./orderIdentity.js";
import type { PositionSize } from "../risk/positionSizing.js";
import type { SignalIntent } from "./signals.js";

export type ExecutionPlan = {
  entryOrder: {
    orderLinkId: string;
    type: "stop_market";
    symbol: string;
    side: "long" | "short";
    triggerPrice: string;
    triggerDirection: "rises_to" | "falls_to";
    qty: string;
  };
  protection: Protection;
  sizingReason: string;
};

export type Protection =
  | {
      mode: "none";
    }
  | {
      mode: "attached_full_position_market";
      stopLoss: ProtectionLeg;
      takeProfit?: ProtectionLeg;
    };

export type ProtectionLeg = {
  triggerPrice: string;
  triggerBy: string;
  orderType: "Market";
};

export function buildExecutionPlan(
  intent: SignalIntent,
  positionSize: PositionSize,
  protectionTriggerBy: string,
): ExecutionPlan {
  return {
    entryOrder: {
      orderLinkId: buildOrderLinkId(intent.instanceId, "entry"),
      type: "stop_market",
      symbol: intent.symbol,
      side: intent.side,
      triggerPrice: intent.entry.triggerPrice,
      triggerDirection: intent.entry.triggerDirection,
      qty: positionSize.qty,
    },
    protection: buildProtection(intent, protectionTriggerBy),
    sizingReason: positionSize.reason,
  };
}

function buildProtection(intent: SignalIntent, triggerBy: string): Protection {
  if (intent.stopLoss === undefined) {
    return { mode: "none" };
  }

  const stopLoss: ProtectionLeg = {
    triggerPrice: intent.stopLoss.triggerPrice,
    triggerBy,
    orderType: "Market",
  };

  if (intent.takeProfit === undefined) {
    return {
      mode: "attached_full_position_market",
      stopLoss,
    };
  }

  return {
    mode: "attached_full_position_market",
    stopLoss,
    takeProfit: {
      triggerPrice: intent.takeProfit.triggerPrice,
      triggerBy,
      orderType: "Market",
    },
  };
}
