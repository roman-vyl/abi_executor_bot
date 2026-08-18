import type { AbiConfig } from "../config/config.js";
import { mapEntryOrderSemantics } from "../domain/entryOrderSemantics.js";

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
  // "Partial" widened in for abi-native-partial-protection-attribution-v1 —
  // BybitCreateOrderPayload construction under "Partial" exists
  // (buildPartialProtectionEntryOrderPayload below) but is not called by
  // mapEntryPackageToBybit(); production entry create keeps sending "Full"
  // until abi-native-partial-protection-cutover-v1.
  tpslMode?: "Full" | "Partial";
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
  // Only the multi-owner close path (abi-pair-scoped-close-execution-v1)
  // sets this — a stable, attributable identity so a crash/retry can
  // resolve this specific close order's own fate before ever sending a
  // second one. The single-owner path's payload construction is unchanged
  // and omits it entirely.
  orderLinkId?: string;
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

// Deliberately no orderLinkId field — a distinct, narrower type from
// BybitGetOrderHistoryPayload rather than making that one's orderLinkId
// optional, so a symbol-wide scan (this) and a single-order lookup (that)
// can never be confused at the type level
// (abi-native-partial-protection-attribution-v1 design.md Decision 4).
export type BybitGetOrderHistoryForSymbolPayload = {
  category: string;
  symbol: string;
  limit: string;
};

// Deliberately no orderId field: Bybit's own documented parameter-priority
// rule for this endpoint is orderId > orderLinkId > symbol > baseCoin —
// sending both would let orderId silently override the intended filter.
// order_id is this codebase's established "audit only, never used for
// lookup" field everywhere else; this endpoint gets the same treatment.
export type BybitGetExecutionListPayload = {
  category: string;
  symbol: string;
  orderLinkId: string;
  limit: string;
  cursor?: string;
};

export type EntryPackageOrderInput = {
  // Already-resolved Bybit symbol — never a raw Runtime ticker.
  symbol: string;
  // The resolved (or, for an existing binding, stored) exchange instrument
  // identity's category — never the global Bybit category configuration.
  category: "linear" | "spot";
  side: "long" | "short";
  plannedEntryPrice: string;
  initialStopPrice: string;
  initialTakePrice: string;
  qty: string;
  orderLinkId: string;
};

export type EntryPackageOrderPayloads = {
  createEntryOrder: BybitCreateOrderPayload;
  cancelEntryOrder: BybitCancelOrderPayload;
  getEntryOrder: BybitGetOrderByLinkIdPayload;
  getEntryOrderHistory: BybitGetOrderHistoryPayload;
};

// Builds Bybit create/cancel/query payloads for the entry-package
// execution flow. Reuses EntryOrderSemanticsMapper for the side/trigger-
// direction table and this file's own mapTriggerDirection numeric encoding.
// The entry-package contract always supplies initial_take_price, so
// takeProfit is always populated here.
export function mapEntryPackageToBybit(
  config: AbiConfig,
  input: EntryPackageOrderInput,
): EntryPackageOrderPayloads {
  const semantics = mapEntryOrderSemantics(input.side);
  const triggerDirection = mapTriggerDirection(semantics.triggerDirection);

  const createEntryOrder: BybitCreateOrderPayload = {
    category: input.category,
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

  return {
    createEntryOrder,
    cancelEntryOrder: {
      category: input.category,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
    },
    getEntryOrder: {
      category: input.category,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
      limit: "1",
    },
    getEntryOrderHistory: {
      category: input.category,
      symbol: input.symbol,
      orderLinkId: input.orderLinkId,
      limit: "1",
    },
  };
}

// Builds the tpslMode: "Partial" variant of the entry create payload —
// otherwise identical to mapEntryPackageToBybit()'s own createEntryOrder
// construction, reusing the same semantics/trigger-direction mapping. A
// deliberately separate function, not a flag inside mapEntryPackageToBybit()
// itself, so a reviewer can see without running anything that production's
// call to mapEntryPackageToBybit() is untouched: nothing in
// EntryPackageApplicationService calls this function yet — wiring it into
// createOrder()'s production path is abi-native-partial-protection-cutover-v1's
// job, not this one's (abi-native-partial-protection-attribution-v1
// design.md Decision 6).
export function buildPartialProtectionEntryOrderPayload(
  config: AbiConfig,
  input: EntryPackageOrderInput,
): BybitCreateOrderPayload {
  const semantics = mapEntryOrderSemantics(input.side);
  const triggerDirection = mapTriggerDirection(semantics.triggerDirection);

  return {
    category: input.category,
    symbol: input.symbol,
    side: semantics.exchangeSide,
    orderType: "Market",
    qty: input.qty,
    triggerPrice: input.plannedEntryPrice,
    triggerDirection,
    triggerBy: config.bybitTriggerBy,
    orderLinkId: input.orderLinkId,
    tpslMode: "Partial",
    stopLoss: input.initialStopPrice,
    slTriggerBy: config.bybitTriggerBy,
    slOrderType: "Market",
    takeProfit: input.initialTakePrice,
    tpTriggerBy: config.bybitTriggerBy,
    tpOrderType: "Market",
  };
}

export function mapPositionSideToCloseSide(side: string): BybitOrderSide {
  return side === "Buy" ? "Sell" : "Buy";
}

// Reads Bybit's own assigned orderId out of a create-order response.
// Generic to any /v5/order/create call (entry, or a multi-owner close order)
// — nothing here is specific to which kind of order was created.
export function readBybitOrderId(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return null;
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("orderId" in result)) {
    return null;
  }

  const orderId = (result as Record<string, unknown>).orderId;
  return typeof orderId === "string" && orderId !== "" ? orderId : null;
}

function mapTriggerDirection(direction: "rises_to" | "falls_to"): BybitTriggerDirection {
  return direction === "rises_to" ? 1 : 2;
}
