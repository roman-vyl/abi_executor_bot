import type { ExecutionPlan } from "../domain/executionPlan.js";

export function isCancelledStatus(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "status" in payload &&
    payload.status === "cancelled"
  );
}

export function isExecutionPlan(payload: unknown): payload is ExecutionPlan {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "entryOrder" in payload &&
    typeof payload.entryOrder === "object" &&
    payload.entryOrder !== null &&
    "orderLinkId" in payload.entryOrder &&
    typeof payload.entryOrder.orderLinkId === "string" &&
    "symbol" in payload.entryOrder &&
    typeof payload.entryOrder.symbol === "string" &&
    "protection" in payload &&
    isProtection(payload.protection)
  );
}

function isProtection(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("mode" in payload)) {
    return false;
  }

  if (payload.mode === "none") {
    return true;
  }

  return (
    payload.mode === "attached_full_position_market" &&
    "stopLoss" in payload &&
    isProtectionLeg(payload.stopLoss) &&
    (!("takeProfit" in payload) || payload.takeProfit === undefined || isProtectionLeg(payload.takeProfit))
  );
}

function isProtectionLeg(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "triggerPrice" in payload &&
    typeof payload.triggerPrice === "string" &&
    "triggerBy" in payload &&
    typeof payload.triggerBy === "string" &&
    "orderType" in payload &&
    payload.orderType === "Market"
  );
}

export function readPayloadString(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null || !(key in payload)) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : "";
}
