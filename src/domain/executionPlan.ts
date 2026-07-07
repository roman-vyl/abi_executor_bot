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
  stopLossAfterFill: {
    orderLinkId: string;
    type: "stop_market";
    symbol: string;
    side: "long" | "short";
    triggerPrice: string;
    qty: string;
  };
  takeProfitAfterFill: {
    orderLinkId: string;
    type: "take_profit_market";
    symbol: string;
    side: "long" | "short";
    triggerPrice: string;
    qty: string;
  };
  sizingReason: string;
};

export function buildExecutionPlan(intent: SignalIntent, positionSize: PositionSize): ExecutionPlan {
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
    stopLossAfterFill: {
      orderLinkId: buildOrderLinkId(intent.instanceId, "sl"),
      type: "stop_market",
      symbol: intent.symbol,
      side: oppositeSide(intent.side),
      triggerPrice: intent.stopLoss.triggerPrice,
      qty: positionSize.qty,
    },
    takeProfitAfterFill: {
      orderLinkId: buildOrderLinkId(intent.instanceId, "tp"),
      type: "take_profit_market",
      symbol: intent.symbol,
      side: oppositeSide(intent.side),
      triggerPrice: intent.takeProfit.triggerPrice,
      qty: positionSize.qty,
    },
    sizingReason: positionSize.reason,
  };
}

function oppositeSide(side: "long" | "short"): "long" | "short" {
  return side === "long" ? "short" : "long";
}
