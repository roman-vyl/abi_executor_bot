import { createHash } from "node:crypto";

// Deduplication keys of the exchange facts store, dedup_key_version 1
// (abi-exchange-facts-sqlite-foundation-v1, design D4). Changing anything
// here changes stored keys: it needs a new DEDUP_KEY_VERSION and a migration.

// The order-state fields whose change must never be deduplicated away. A
// fixed list, not the whole record: WS and REST send the same state with
// different field sets, and the same snapshot from both must give one key.
export const ORDER_STATE_FINGERPRINT_FIELDS = [
  "orderStatus",
  "qty",
  "price",
  "triggerPrice",
  "takeProfit",
  "stopLoss",
  "tpLimitPrice",
  "slLimitPrice",
  "triggerBy",
  "tpTriggerBy",
  "slTriggerBy",
  "leavesQty",
  "cumExecQty",
  "cumExecValue",
  "cumExecFee",
  "avgPrice",
  "cancelType",
  "rejectReason",
] as const;

const FIELD_SEPARATOR = "\u001f";
const PLAIN_DECIMAL = /^-?\d+(\.\d*)?$/;

// Only for hashing: "3.8180" and "3.818" are the same state, "0.00" is "0".
// A missing field, null and "" are the same. raw_json is never normalized.
export function normalizeFingerprintValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value);
  if (!PLAIN_DECIMAL.test(text) || !text.includes(".")) {
    return text;
  }

  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

export function orderStateDedupKey(record: Record<string, unknown>, orderId: string, updatedTime: string): string {
  const fingerprint = ORDER_STATE_FINGERPRINT_FIELDS.map((field) => normalizeFingerprintValue(record[field])).join(
    FIELD_SEPARATOR,
  );
  const digest = createHash("sha256").update(fingerprint, "utf8").digest("hex");
  return `order:${orderId}:${updatedTime}:${digest}`;
}

export function executionDedupKey(execId: string): string {
  return `exec:${execId}`;
}
