import type { AbiConfig } from "../config/config.js";
import {
  mapPositionSideToCloseSide,
  type BybitCancelAllOrdersPayload,
  type BybitMarketCloseOrderPayload,
} from "../exchange/bybitOrderMapper.js";

export function buildAccountQuery(config: AbiConfig, symbol: string | undefined): Record<string, string> {
  if (symbol !== undefined && symbol.trim() !== "") {
    return {
      category: config.bybitCategory,
      symbol: symbol.trim().toUpperCase(),
    };
  }

  return {
    category: config.bybitCategory,
    settleCoin: config.bybitSettleCoin,
  };
}

export function buildCancelAllOrdersPayload(
  config: AbiConfig,
  symbol: string | undefined,
): BybitCancelAllOrdersPayload {
  if (symbol !== undefined && symbol.trim() !== "") {
    return {
      category: config.bybitCategory,
      symbol: symbol.trim().toUpperCase(),
    };
  }

  return {
    category: config.bybitCategory,
    settleCoin: config.bybitSettleCoin,
  };
}

export function buildMarketCloseOrdersFromPositions(
  config: AbiConfig,
  positionsResponse: unknown,
): BybitMarketCloseOrderPayload[] {
  const positions = readBybitList(positionsResponse);
  const closeOrders: BybitMarketCloseOrderPayload[] = [];

  for (const position of positions) {
    const symbol = readObjectString(position, "symbol");
    const side = readObjectString(position, "side");
    const size = readObjectString(position, "size");
    const positionIdx = readObjectNumber(position, "positionIdx");

    if (symbol === "" || size === "" || Number(size) <= 0) {
      continue;
    }

    if (side !== "Buy" && side !== "Sell") {
      continue;
    }

    const closeOrder: BybitMarketCloseOrderPayload = {
      category: config.bybitCategory,
      symbol,
      side: mapPositionSideToCloseSide(side),
      orderType: "Market",
      qty: size,
      reduceOnly: true,
    };

    if (positionIdx !== undefined) {
      closeOrder.positionIdx = positionIdx;
    }

    closeOrders.push(closeOrder);
  }

  return closeOrders;
}

function readBybitList(response: unknown): unknown[] {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return [];
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return [];
  }

  const list = (result as Record<string, unknown>).list;
  return Array.isArray(list) ? list : [];
}

function readObjectString(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null || !(key in payload)) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readObjectNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== "object" || payload === null || !(key in payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
