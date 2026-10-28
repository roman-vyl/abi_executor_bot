import type { AbiConfig } from "../config/config.js";
import { mapEntryOrderSemantics } from "../domain/entryOrderSemantics.js";
import { ceilToStep, floorToStep } from "../domain/exactDecimal.js";
import type { PositionBindingGeometry, PositionDirection } from "../domain/positionScope.js";
export type { PositionBindingGeometry } from "../domain/positionScope.js";

export type BybitOrderSide = "Buy" | "Sell";
export type BybitTriggerDirection = 1 | 2;

export type BybitPositionIdx = 0 | 1 | 2;

// This is the sole encoding boundary for Bybit's numeric position slots.
// Foundation-only: production order builders continue their existing
// one-way behavior until the later execution and lifecycle cutovers.
export function encodeBybitPositionIdx(binding: PositionBindingGeometry): BybitPositionIdx {
  if (binding.mode === "one_way") {
    return 0;
  }
  return binding.direction === "long" ? 1 : 2;
}

export type BybitCreateOrderPayload = {
  category: string;
  symbol: string;
  side: BybitOrderSide;
  orderType: "Market" | "Limit";
  qty: string;
  // Only on the touch_trigger limit entry (abi-touch-trigger-limit-entry-v1).
  price?: string;
  timeInForce?: "GTC";
  // Present only on the conditional ema_anchor entry; touch_trigger market and
  // limit entries omit all three (abi-touch-trigger-market-entry-v1).
  triggerPrice?: string;
  triggerDirection?: BybitTriggerDirection;
  triggerBy?: string;
  orderLinkId: string;
  takeProfit?: string;
  stopLoss?: string;
  tpTriggerBy?: string;
  slTriggerBy?: string;
  tpslMode?: "Partial";
  tpOrderType?: "Market";
  slOrderType?: "Market";
  positionIdx?: BybitPositionIdx;
};

export type BybitMarketCloseOrderPayload = {
  category: string;
  symbol: string;
  side: BybitOrderSide;
  orderType: "Market";
  qty: string;
  reduceOnly: true;
  positionIdx?: BybitPositionIdx;
  // Only the multi-owner close path (abi-pair-scoped-close-execution-v1)
  // sets this — a stable, attributable identity so a crash/retry can
  // resolve this specific close order's own fate before ever sending a
  // second one. The single-owner path's payload construction is unchanged
  // and omits it entirely.
  orderLinkId?: string;
};

export type BybitCancelOrderPayload =
  | { category: string; symbol: string; orderLinkId: string; orderId?: never }
  | { category: string; symbol: string; orderId: string; orderLinkId?: never };

// Scoped by orderId, never orderLinkId — a native Partial protection
// child's own orderLinkId is confirmed empty
// (abi-native-partial-protection-attribution-v1 design.md Decision 0,
// fact 2), so orderId is the only usable identity for amending it
// (abi-native-partial-protection-lifecycle-v1 design.md Decision 2).
export type BybitAmendOrderPayload = {
  category: string;
  symbol: string;
  orderId: string;
  triggerPrice?: string;
  qty?: string;
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
  // abi-protection-history-bounded-lookup-v1: a window of at most 7 days and
  // the cursor Bybit returned for the previous page of the same window.
  startTime?: number;
  endTime?: number;
  cursor?: string;
};

// Exactly one of orderLinkId / orderId, never both: Bybit's own documented
// parameter-priority rule for this endpoint is orderId > orderLinkId >
// symbol > baseCoin — sending both would let orderId silently override the
// intended filter. Own entry and close orders are keyed on orderLinkId. A
// native protection child has an empty orderLinkId, so closure proof
// (abi-trade-cycle-closure-confirmation-v1 D1) keys it on the child's own
// orderId, read from an attribution already made by parentOrderLinkId.
export type BybitGetExecutionListPayload = {
  category: string;
  symbol: string;
  limit: string;
  cursor?: string;
} & ({ orderLinkId: string; orderId?: never } | { orderId: string; orderLinkId?: never });

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
  binding?: PositionBindingGeometry;
  // touch_trigger limit only: planned_entry_price already aligned to the
  // instrument tickSize by the caller (alignEntryLimitPrice).
  entryLimitPrice?: string;
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
  const shape = entryOrderShape(config);
  if (shape === "limit" && input.entryLimitPrice === undefined) {
    throw new Error("touch_trigger limit entry requires an aligned entry limit price");
  }

  const createEntryOrder: BybitCreateOrderPayload = {
    category: input.category,
    symbol: input.symbol,
    side: semantics.exchangeSide,
    orderType: shape === "limit" ? "Limit" : "Market",
    qty: input.qty,
    ...(shape === "limit" ? { price: input.entryLimitPrice, timeInForce: "GTC" as const } : {}),
    ...(shape === "conditional"
      ? {
          triggerPrice: input.plannedEntryPrice,
          triggerDirection: mapTriggerDirection(semantics.triggerDirection),
          triggerBy: config.bybitTriggerBy,
        }
      : {}),
    orderLinkId: input.orderLinkId,
    tpslMode: "Partial",
    stopLoss: input.initialStopPrice,
    slTriggerBy: config.bybitTriggerBy,
    slOrderType: "Market",
    takeProfit: input.initialTakePrice,
    tpTriggerBy: config.bybitTriggerBy,
    tpOrderType: "Market",
  };

  // Preserve one-way payloads exactly. An explicit durable hedge binding is
  // the only input that opts into the exchange-private 1/2 encoding.
  if (input.binding?.mode === "hedge") {
    createEntryOrder.positionIdx = encodeBybitPositionIdx(input.binding);
  }

  return { createEntryOrder, ...mapEntryPackageQueryPayloads(input) };
}

// The cancel/query half of mapEntryPackageToBybit, for paths that never send
// a create (repeat-PUT revalidation, metadata-only update) and so need no
// entry limit price.
export function mapEntryPackageQueryPayloads(input: {
  symbol: string;
  category: "linear" | "spot";
  orderLinkId: string;
}): Omit<EntryPackageOrderPayloads, "createEntryOrder"> {
  return {
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

// Aligns planned_entry_price to the tickSize grid for a touch_trigger limit
// entry: an on-grid price is kept, otherwise a long rounds up and a short
// rounds down (a slightly worse price for a better fill chance), no offset.
export function alignEntryLimitPrice(plannedEntryPrice: string, tickSize: string, side: "long" | "short"): string {
  return side === "long" ? ceilToStep(plannedEntryPrice, tickSize) : floorToStep(plannedEntryPrice, tickSize);
}

export function mapPositionSideToCloseSide(side: string): BybitOrderSide {
  return side === "Buy" ? "Sell" : "Buy";
}

export function mapBindingAwareMarketCloseOrder(input: {
  category: "linear";
  symbol: string;
  entrySide: PositionDirection;
  qty: string;
  orderLinkId: string;
  binding: PositionBindingGeometry;
}): BybitMarketCloseOrderPayload {
  return {
    category: input.category,
    symbol: input.symbol,
    side: input.entrySide === "long" ? "Sell" : "Buy",
    orderType: "Market",
    qty: input.qty,
    reduceOnly: true,
    positionIdx: encodeBybitPositionIdx(input.binding),
    orderLinkId: input.orderLinkId,
  };
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

// ema_anchor keeps the conditional Market entry. touch_trigger sends no
// exchange trigger (Engine already confirmed the signal at the touch-bar
// close): a plain Market, or a GTC Limit at the aligned planned price.
export function entryOrderShape(config: AbiConfig): "conditional" | "market" | "limit" {
  if (config.liveEntryMode === "ema_anchor") {
    return "conditional";
  }
  if (config.touchTriggerEntryOrderType === "market" || config.touchTriggerEntryOrderType === "limit") {
    return config.touchTriggerEntryOrderType;
  }
  throw new Error(`touch_trigger entry order type ${String(config.touchTriggerEntryOrderType)} is not supported`);
}

function mapTriggerDirection(direction: "rises_to" | "falls_to"): BybitTriggerDirection {
  return direction === "rises_to" ? 1 : 2;
}
