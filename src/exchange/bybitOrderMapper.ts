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
  takeProfit?: string;
  stopLoss?: string;
  tpTriggerBy?: string;
  slTriggerBy?: string;
  tpslMode?: "Full";
  tpOrderType?: "Market";
  slOrderType?: "Market";
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
  takeProfit?: string;
  stopLoss?: string;
  tpTriggerBy?: string;
  slTriggerBy?: string;
  tpslMode?: "Full";
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
  const createEntryOrder: BybitCreateOrderPayload = {
    category: config.bybitCategory,
    symbol: plan.entryOrder.symbol,
    side: mapSide(plan.entryOrder.side),
    orderType: "Market",
    qty: plan.entryOrder.qty,
    triggerPrice: plan.entryOrder.triggerPrice,
    triggerDirection: mapTriggerDirection(plan.entryOrder.triggerDirection),
    triggerBy: config.bybitTriggerBy,
    orderLinkId: plan.entryOrder.orderLinkId,
  };

  const amendEntryOrder: BybitAmendOrderPayload = {
    category: config.bybitCategory,
    symbol: plan.entryOrder.symbol,
    orderLinkId: plan.entryOrder.orderLinkId,
    triggerPrice: plan.entryOrder.triggerPrice,
    qty: plan.entryOrder.qty,
    triggerBy: config.bybitTriggerBy,
    stopLoss: "0",
    takeProfit: "0",
  };

  if (plan.protection.mode === "attached_full_position_market") {
    createEntryOrder.tpslMode = "Full";
    createEntryOrder.stopLoss = plan.protection.stopLoss.triggerPrice;
    createEntryOrder.slTriggerBy = plan.protection.stopLoss.triggerBy;
    createEntryOrder.slOrderType = plan.protection.stopLoss.orderType;

    amendEntryOrder.tpslMode = "Full";
    amendEntryOrder.stopLoss = plan.protection.stopLoss.triggerPrice;
    amendEntryOrder.slTriggerBy = plan.protection.stopLoss.triggerBy;

    if (plan.protection.takeProfit !== undefined) {
      createEntryOrder.takeProfit = plan.protection.takeProfit.triggerPrice;
      createEntryOrder.tpTriggerBy = plan.protection.takeProfit.triggerBy;
      createEntryOrder.tpOrderType = plan.protection.takeProfit.orderType;

      amendEntryOrder.takeProfit = plan.protection.takeProfit.triggerPrice;
      amendEntryOrder.tpTriggerBy = plan.protection.takeProfit.triggerBy;
    }
  }

  return {
    createEntryOrder,
    amendEntryOrder,
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
