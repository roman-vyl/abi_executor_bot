import { compareDecimal } from "../../domain/exactDecimal.js";
import type { CurrentOrderPriceLimits, OrderPriceLimitsProtocolFailureReason } from "./types.js";

export type DecodedOrderPriceLimits =
  | { ok: true; limits: CurrentOrderPriceLimits }
  | { ok: false; reason: OrderPriceLimitsProtocolFailureReason };

export function decodeOrderPriceLimitsResponse(input: {
  response: unknown;
  expectedSymbol: string;
}): DecodedOrderPriceLimits {
  const { response, expectedSymbol } = input;

  if (typeof response !== "object" || response === null) {
    return { ok: false, reason: "malformed_envelope" };
  }

  const envelope = response as Record<string, unknown>;
  if (
    envelope.retCode !== 0 ||
    typeof envelope.retMsg !== "string" ||
    !isPositiveSafeInteger(envelope.time) ||
    typeof envelope.result !== "object" ||
    envelope.result === null
  ) {
    return { ok: false, reason: "malformed_envelope" };
  }

  const result = envelope.result as Record<string, unknown>;
  if (result.symbol !== expectedSymbol) {
    return { ok: false, reason: "symbol_mismatch" };
  }

  const buyLimit = result.buyLmt;
  if (typeof buyLimit !== "string" || !isPositiveExactDecimal(buyLimit)) {
    return { ok: false, reason: "invalid_buy_limit" };
  }

  const sellLimit = result.sellLmt;
  if (typeof sellLimit !== "string" || !isPositiveExactDecimal(sellLimit)) {
    return { ok: false, reason: "invalid_sell_limit" };
  }

  const observedAtMs = parseCanonicalPositiveSafeInteger(result.ts);
  if (observedAtMs === undefined) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  return { ok: true, limits: { buyLimit, sellLimit, observedAtMs } };
}

function isPositiveExactDecimal(value: string): boolean {
  try {
    return compareDecimal(value, "0") > 0;
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCanonicalPositiveSafeInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

