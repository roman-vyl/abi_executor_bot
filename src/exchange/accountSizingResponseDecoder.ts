import { compareDecimal } from "../domain/exactDecimal.js";

// Pure decoders for the two account reads risk sizing makes on every entry.
// Each returns null for anything it cannot use, so the caller fails closed
// instead of sizing from a guessed value.

// `GET /v5/account/info` → `result.marginMode` exactly as Bybit sent it.
export function decodeAccountMarginMode(response: unknown): string | null {
  const result = readResult(response);
  if (result === null) {
    return null;
  }
  const marginMode = result.marginMode;
  return typeof marginMode === "string" && marginMode !== "" ? marginMode : null;
}

// `GET /v5/account/wallet-balance` → the account-level `totalWalletBalance`
// of the single account row. Exact-decimal text; zero or negative is
// returned as is (the caller declines on it), malformed text is null.
export function decodeTotalWalletBalance(response: unknown): string | null {
  const result = readResult(response);
  if (result === null || !Array.isArray(result.list) || result.list.length !== 1) {
    return null;
  }
  const row = result.list[0];
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const value = (row as Record<string, unknown>).totalWalletBalance;
  if (typeof value !== "string") {
    return null;
  }
  try {
    compareDecimal(value, "0");
  } catch {
    return null;
  }
  return value;
}

function readResult(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const result = (response as Record<string, unknown>).result;
  return typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
}
