import type { AbiConfig } from "../config/config.js";
import { mapEntryOrderSemantics } from "../domain/entryOrderSemantics.js";
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

export type BybitGetOrderHistoryPayload = {
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

export type EntryPackageOrderInput = {
  // Already-resolved Bybit symbol — never a raw Runtime ticker.
  symbol: string;
  side: "long" | "short";
  plannedEntryPrice: string;
  initialStopPrice: string;
  initialTakePrice: string;
  qty: string;
  orderLinkId: string;
};

export type EntryPackageOrderPayloads = {
  createEntryOrder: BybitCreateOrderPayload;
  amendEntryOrder: BybitAmendOrderPayload;
  cancelEntryOrder: BybitCancelOrderPayload;
  getEntryOrder: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistory: BybitGetOrderHistoryPayload;
};

// Builds Bybit create/amend/cancel/query payloads for the entry-package
// execution flow. Reuses EntryOrderSemanticsMapper for the side/trigger-
// direction table and this file's own mapTriggerDirection numeric encoding;
// deliberately does not call or modify mapExecutionPlanToBybit or
// ExecutionPlan, which remain the legacy signal/intent contour's own path
// (docs/LEGACY_SIGNAL_INTENT_DISPOSITION.md). The entry-package contract
// always supplies initial_take_price (unlike the legacy optional take
// profit), so takeProfit is always populated here.
export function mapEntryPackageToBybit(
  config: AbiConfig,
  input: EntryPackageOrderInput,
): EntryPackageOrderPayloads {
  const semantics = mapEntryOrderSemantics(input.side);
  const triggerDirection = mapTriggerDirection(semantics.triggerDirection);

  const createEntryOrder: BybitCreateOrderPayload = {
    category: config.bybitCategory,
    symbol: input.symbol,
    side: semantics.exchangeSide,
    orderType: "Market",
    qty: input.qty,
    triggerPrice: input.plannedEntryPrice,
    triggerDirection,
    triggerBy: config.bybitTriggerBy,
    orderLinkId: input.orderLinkId,
    tpslMode: "Full",
    stopLoss: input.initialStopPrice,
    slTriggerBy: config.bybitTriggerBy,
    slOrderType: "Market",
    takeProfit: input.initialTakePrice,
    tpTriggerBy: config.bybitTriggerBy,
    tpOrderType: "Market",
  };

  const amendEntryOrder: BybitAmendOrderPayload = {
    category: config.bybitCategory,
    symbol: input.symbol,
    orderLinkId: input.orderLinkId,
    triggerPrice: input.plannedEntryPrice,
    qty: input.qty,
    triggerBy: config.bybitTriggerBy,
    tpslMode: "Full",
    stopLoss: input.initialStopPrice,
    slTriggerBy: config.bybitTriggerBy,
    takeProfit: input.initialTakePrice,
    tpTriggerBy: config.bybitTriggerBy,
  };

  return {
    createEntryOrder,
    amendEntryOrder,
    cancelEntryOrder: {
      category: config.bybitCategory,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
    },
    getEntryOrder: {
      category: config.bybitCategory,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
      limit: "1",
    },
    getEntryOrderHistory: {
      category: config.bybitCategory,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
      limit: "1",
    },
  };
}

export function mapPositionSideToCloseSide(side: string): BybitOrderSide {
  return side === "Buy" ? "Sell" : "Buy";
}

function mapTriggerDirection(direction: "rises_to" | "falls_to"): BybitTriggerDirection {
  return direction === "rises_to" ? 1 : 2;
}
