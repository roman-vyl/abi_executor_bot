import type { AbiConfig } from "../config/config.js";
import type { ExecutionPlan } from "../domain/executionPlan.js";

export type BybitOrderSide = "Buy" | "Sell";
export type BybitTriggerDirection = 1 | 2;

export type BybitCreateOrderPayload = {
  category: string;
  symbol: string;
  side: BybitOrderSide;
  orderType: "Market";
  qty: string;
  triggerPrice: string;
  triggerDirection: BybitTriggerDirection;
  triggerBy: string;
  orderLinkId: string;
};

export type BybitMarketCloseOrderPayload = {
  category: string;
  symbol: string;
  side: BybitOrderSide;
  orderType: "Market";
  qty: string;
  reduceOnly: true;
  positionIdx?: number;
};

export type BybitAmendOrderPayload = {
  category: string;
  symbol: string;
  orderLinkId: string;
  triggerPrice: string;
  qty: string;
  triggerBy: string;
};

export type BybitCancelOrderPayload = {
  category: string;
  symbol: string;
  orderLinkId: string;
};

export type BybitCancelAllOrdersPayload = {
  category: string;
  symbol?: string;
  settleCoin?: string;
};

export type BybitGetOrderByLinkIdPayload = {
  category: string;
  symbol: string;
  orderLinkId: string;
  limit: "1";
};

export type BybitExecutionPayloads = {
  createEntryOrder: BybitCreateOrderPayload;
  amendEntryOrder: BybitAmendOrderPayload;
  cancelEntryOrder: BybitCancelOrderPayload;
  getEntryOrder: BybitGetOrderByLinkIdPayload;
};

export function mapExecutionPlanToBybit(config: AbiConfig, plan: ExecutionPlan): BybitExecutionPayloads {
  return {
    createEntryOrder: {
      category: config.bybitCategory,
      symbol: plan.entryOrder.symbol,
      side: mapSide(plan.entryOrder.side),
      orderType: "Market",
      qty: plan.entryOrder.qty,
      triggerPrice: plan.entryOrder.triggerPrice,
      triggerDirection: mapTriggerDirection(plan.entryOrder.triggerDirection),
      triggerBy: config.bybitTriggerBy,
      orderLinkId: plan.entryOrder.orderLinkId,
    },
    amendEntryOrder: {
      category: config.bybitCategory,
      symbol: plan.entryOrder.symbol,
      orderLinkId: plan.entryOrder.orderLinkId,
      triggerPrice: plan.entryOrder.triggerPrice,
      qty: plan.entryOrder.qty,
      triggerBy: config.bybitTriggerBy,
    },
    cancelEntryOrder: {
      category: config.bybitCategory,
      symbol: plan.entryOrder.symbol,
      orderLinkId: plan.entryOrder.orderLinkId,
    },
    getEntryOrder: {
      category: config.bybitCategory,
      symbol: plan.entryOrder.symbol,
      orderLinkId: plan.entryOrder.orderLinkId,
      limit: "1",
    },
  };
}

function mapSide(side: "long" | "short"): BybitOrderSide {
  return side === "long" ? "Buy" : "Sell";
}

export function mapPositionSideToCloseSide(side: string): BybitOrderSide {
  return side === "Buy" ? "Sell" : "Buy";
}

function mapTriggerDirection(direction: "rises_to" | "falls_to"): BybitTriggerDirection {
  return direction === "rises_to" ? 1 : 2;
}
